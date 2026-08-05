/**
 * Forward geocoding via OpenStreetMap's Nominatim API — converts a free-text
 * place name (e.g. "Munnar, Kerala") into { lat, lng }.
 *
 * Nominatim's usage policy caps requests at 1/sec and requires a descriptive
 * User-Agent, so this module:
 *   - caches results in-memory (place name -> coords) to avoid repeat lookups
 *   - queues requests so they never fire more than 1/sec
 *   - never throws — callers get { lat: null, lng: null, ... } on failure so
 *     trip creation is never blocked by a flaky/rate-limited geocode call
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'GoVIBE-AI/1.0 (trip planning app)';
const MIN_REQUEST_GAP_MS = 1000; // Nominatim policy: max 1 request/sec
const REQUEST_TIMEOUT_MS = 5000;

const cache = new Map(); // normalized place name -> { lat, lng, display_name, source }
let lastRequestAt = 0;
let queue = Promise.resolve(); // serializes outgoing requests to respect the rate limit

function normalize(placeName) {
  return placeName.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function waitForRateLimit() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_GAP_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_GAP_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

async function fetchFromNominatim(placeName) {
  const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(placeName)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
    const data = await res.json();
    if (!data?.length) return null;
    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
      display_name: data[0].display_name,
      source: 'nominatim',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function geocodePlace(placeName) {
  if (!placeName || !placeName.trim()) {
    return { lat: null, lng: null, display_name: null, source: 'skipped_empty' };
  }

  const key = normalize(placeName);
  if (cache.has(key)) return cache.get(key);

  const result = await (queue = queue.then(async () => {
    await waitForRateLimit();
    try {
      const found = await fetchFromNominatim(placeName);
      return found || { lat: null, lng: null, display_name: null, source: 'not_found' };
    } catch (err) {
      console.error(`[geocoding] Failed to geocode "${placeName}":`, err.message);
      return { lat: null, lng: null, display_name: null, source: 'geocode_failed' };
    }
  }));

  cache.set(key, result);
  return result;
}

export async function geocodeFields(fields) {
  const entries = Object.entries(fields).filter(([, value]) => value);
  const results = {};
  for (const [key, value] of entries) {
    results[key] = await geocodePlace(value);
  }
  return results;
}

// ============================================================
// Autocomplete — powers the LocationAutocomplete frontend component.
// ============================================================
// Separate from geocodePlace() above (which wants exactly one best match
// for trip creation) because autocomplete wants several ranked candidates
// as the user types. Both share the same rate-limiter queue, in-memory
// cache, and User-Agent so we stay well within Nominatim's usage policy
// even with two call sites hitting it.

const AUTOCOMPLETE_CACHE_TTL_MS = 5 * 60 * 1000; // suggestions can go stale faster than a resolved geocode
const autocompleteCache = new Map(); // "query:limit" -> { expiresAt, results }

/** Nominatim's addresstype/class/type fields map onto pill labels the UI can show without the frontend needing to know Nominatim's taxonomy. */
function humanizePlaceType(item) {
  const key = item.addresstype || item.type || item.class;
  const MAP = {
    city: 'City', town: 'Town', village: 'Village', hamlet: 'Village',
    state: 'State', country: 'Country', suburb: 'Neighborhood', neighbourhood: 'Neighborhood',
    aerodrome: 'Airport', airport: 'Airport',
    railway: 'Railway station', station: 'Railway/Transit station',
    bus_station: 'Bus station',
    tourism: 'Landmark', attraction: 'Landmark', museum: 'Landmark', monument: 'Landmark',
    hotel: 'Hotel', restaurant: 'Restaurant', amenity: 'Place',
    building: 'Building', road: 'Road',
  };
  return MAP[key] || (key ? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Place');
}

async function fetchAutocompleteFromNominatim(query, limit) {
  const url = `${NOMINATIM_URL}?format=jsonv2&addressdetails=1&limit=${limit}&q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`Nominatim responded ${res.status}`);
    const data = await res.json();
    return (data || []).map((item) => ({
      // "name" is the short, readable label to put in the input once
      // selected; "display_name" is the full address for the subtitle.
      name: item.name || item.display_name.split(',')[0],
      display_name: item.display_name,
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon),
      place_type: humanizePlaceType(item),
      importance: item.importance ?? 0,
    }));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns up to `limit` place suggestions matching `query`, ranked by
 * Nominatim's relevance ordering. Never throws — returns [] on any error
 * (bad query, rate limit, timeout, network failure) so a flaky autocomplete
 * call never surfaces as a broken dropdown, just an empty one.
 */
export async function autocompletePlaces(query, { limit = 8 } = {}) {
  const trimmed = (query || '').trim();
  if (trimmed.length < 2) return []; // too short to search — avoid noisy 1-2 char queries hitting Nominatim at all

  const cappedLimit = Math.min(10, Math.max(1, limit));
  const cacheKey = `${normalize(trimmed)}:${cappedLimit}`;
  const cached = autocompleteCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

  const results = await (queue = queue.then(async () => {
    await waitForRateLimit();
    try {
      return await fetchAutocompleteFromNominatim(trimmed, cappedLimit);
    } catch (err) {
      console.error(`[geocoding] Autocomplete failed for "${trimmed}":`, err.message);
      return [];
    }
  }));

  autocompleteCache.set(cacheKey, { results, expiresAt: Date.now() + AUTOCOMPLETE_CACHE_TTL_MS });
  return results;
}

export function clearGeocodeCache() {
  cache.clear();
  autocompleteCache.clear();
}