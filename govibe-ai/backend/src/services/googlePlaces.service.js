import { env } from '../config/env.js';
import { haversineKm } from './geo.service.js';

const NEARBY_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const REQUEST_TIMEOUT_MS = 10000;
const TYPE_DELAY_MS = 200;

const PLACE_TYPE_QUERIES = [
  { type: 'tourist_attraction', category: 'heritage_historical', subcategory: 'Monuments' },
  { type: 'museum', category: 'heritage_historical', subcategory: 'Museums' },
  { type: 'art_gallery', category: 'arts_culture', subcategory: 'Art Galleries' },
  { type: 'hindu_temple', category: 'religious_spiritual', subcategory: 'Temples' },
  { type: 'church', category: 'religious_spiritual', subcategory: 'Churches' },
  { type: 'mosque', category: 'religious_spiritual', subcategory: 'Mosques' },
  { type: 'park', category: 'nature_scenic', subcategory: 'Parks' },
  // 'natural_feature' was removed from the Places API's nearby-search type
  // list years ago — that query silently returned zero/error results on
  // every call, starving nature_scenic candidates near any destination and
  // making it easy for a category like shopping (reliably deep/well-rated
  // in most cities) to dominate the pool once other interests came back
  // thin. Beaches/lakes/hills aren't a Nearby Search "type" Google
  // supports directly, so these are fetched via Text Search instead — see
  // NATURE_TEXT_QUERIES + fetchNatureTextResults below.
  { type: 'zoo', category: 'wildlife', subcategory: 'Zoos' },
  { type: 'aquarium', category: 'wildlife', subcategory: 'Aquariums' },
  { type: 'amusement_park', category: 'entertainment_recreation', subcategory: 'Theme Parks' },
  { type: 'lodging', category: 'stay', subcategory: 'Hotels' },
  { type: 'restaurant', category: 'food_dining', subcategory: 'Restaurants' },
  { type: 'cafe', category: 'food_dining', subcategory: 'Cafés' },
  { type: 'shopping_mall', category: 'shopping', subcategory: 'Shopping Malls' },
  { type: 'stadium', category: 'sports_adventure', subcategory: 'Stadiums' },
  { type: 'spa', category: 'wellness_leisure', subcategory: 'Spas' },
  { type: 'night_club', category: 'nightlife', subcategory: 'Bars' },
  { type: 'bar', category: 'nightlife', subcategory: 'Bars' },
  { type: 'library', category: 'science_learning', subcategory: 'Libraries' },
  { type: 'movie_theater', category: 'arts_culture', subcategory: 'Theatres' },
];

// Never trust a Google "type" bucket alone — a result can carry several
// types at once. If any of these administrative/utility types show up
// alongside the tourism type we searched for, the place is dropped.
const EXCLUDED_GOOGLE_TYPES = new Set([
  'local_government_office', 'city_hall', 'courthouse', 'police',
  'fire_station', 'hospital', 'doctor', 'school', 'primary_school',
  'secondary_school', 'university', 'bank', 'atm', 'post_office',
  'embassy', 'storage', 'moving_company', 'car_repair', 'car_dealer',
  'train_station', 'transit_station', 'subway_station', 'bus_station',
  'light_rail_station',
]);

// Text Search substitute for the dead 'natural_feature' nearby-search type
// (see PLACE_TYPE_QUERIES comment above) — Google has no single "type" for
// beaches/lakes/hills, but a plain keyword search near a point works fine.
const NATURE_TEXT_QUERIES = [
  { query: 'beach', subcategory: 'Beaches' },
  { query: 'lake', subcategory: 'Lakes' },
  { query: 'scenic viewpoint', subcategory: 'Scenic Viewpoints' },
  { query: 'garden', subcategory: 'Gardens' },
];

export const isGooglePlacesConfigured = Boolean(env.googlePlacesApiKey);

async function fetchNatureTextResults(lat, lng, radiusMeters, query) {
  const url = `${TEXT_SEARCH_URL}?query=${encodeURIComponent(query)}&location=${lat},${lng}&radius=${radiusMeters}&key=${env.googlePlacesApiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Google Places responded ${res.status}`);
    const data = await res.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places status: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
    }
    return data.results || [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNearbyByType(lat, lng, radiusMeters, type) {
  const url = `${NEARBY_SEARCH_URL}?location=${lat},${lng}&radius=${radiusMeters}&type=${type}&key=${env.googlePlacesApiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Google Places responded ${res.status}`);
    const data = await res.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places status: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
    }
    return data.results || [];
  } finally {
    clearTimeout(timeout);
  }
}

function toSpotRow(place, { category, subcategory }, city) {
  if (!place.name || !place.geometry?.location) return null;
  const types = place.types || [];
  if (types.some((t) => EXCLUDED_GOOGLE_TYPES.has(t))) return null;
  const reviewCount = place.user_ratings_total || 0;
  return {
    name: place.name,
    category,
    subcategory,
    latitude: place.geometry.location.lat,
    longitude: place.geometry.location.lng,
    city,
    rating: place.rating ?? null,
    review_count: reviewCount,
    popularity_score: Math.min(reviewCount / 2000, 1),
    avg_visit_minutes: category === 'stay' ? 0 : 60,
    entry_fee_inr: 0,
    opening_hours: place.opening_hours?.open_now != null
      ? (place.opening_hours.open_now ? 'Open now' : 'Closed now')
      : null,
    description: place.vicinity
      ? `${place.name}, near ${place.vicinity}.`
      : `${place.name} (${subcategory || category}).`,
    image_url: null,
    google_types: types,
    source: 'google_places',
  };
}

// ============================================================
// Live emergency services (on-demand — powers the "Emergency Services"
// button, as opposed to PLACE_TYPE_QUERIES above which is for tourism
// spot seeding). Separate from the Overpass-based static contacts in
// emergency.service.js: this hits Google Places directly for richer,
// per-facility data (phone, formatted address, open-now, rating) that
// OSM tags usually don't carry.
// ============================================================

const PLACE_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const EMERGENCY_RESULTS_PER_CATEGORY = 5;
const EMERGENCY_SEARCH_RADIUS_METERS = 6000;

// Maps our 6 UI categories to how each is actually found on Google Places.
// Google has no native "ambulance" place type, so that one uses a text
// search instead of a typed nearby search.
const EMERGENCY_CATEGORY_QUERIES = {
  hospitals: { mode: 'nearby', type: 'hospital' },
  clinics: { mode: 'nearby', type: 'doctor' },
  police: { mode: 'nearby', type: 'police' },
  fire: { mode: 'nearby', type: 'fire_station' },
  medical_stores: { mode: 'nearby', type: 'pharmacy' },
  ambulance: { mode: 'text', query: 'ambulance service' },
};

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Google Places responded ${res.status}`);
    const data = await res.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places status: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
    }
    return data.results || [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPlaceDetails(placeId) {
  try {
    const fields = 'formatted_phone_number,international_phone_number,formatted_address,opening_hours,url';
    const url = `${PLACE_DETAILS_URL}?place_id=${placeId}&fields=${fields}&key=${env.googlePlacesApiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.result || null;
  } catch {
    return null; // details are an enrichment, never block the listing over it
  }
}

function mapsUrlFor(place) {
  if (place.place_id) {
    return `https://www.google.com/maps/search/?api=1&query=${place.geometry.location.lat},${place.geometry.location.lng}&query_place_id=${place.place_id}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${place.geometry.location.lat},${place.geometry.location.lng}`;
}

/**
 * Fetches, enriches (phone/address/open-now via Place Details), sorts by
 * distance, and caps one emergency category's results. Detail lookups run
 * with limited concurrency so a single category doesn't fire 20+ parallel
 * requests.
 */
async function fetchEmergencyCategory(categoryKey, { lat, lng }) {
  const config = EMERGENCY_CATEGORY_QUERIES[categoryKey];
  if (!config) return [];

  let raw;
  try {
    if (config.mode === 'nearby') {
      const url = `${NEARBY_SEARCH_URL}?location=${lat},${lng}&radius=${EMERGENCY_SEARCH_RADIUS_METERS}&type=${config.type}&key=${env.googlePlacesApiKey}`;
      raw = await fetchJson(url);
    } else {
      const url = `${TEXT_SEARCH_URL}?query=${encodeURIComponent(config.query)}&location=${lat},${lng}&radius=${EMERGENCY_SEARCH_RADIUS_METERS}&key=${env.googlePlacesApiKey}`;
      raw = await fetchJson(url);
    }
  } catch (err) {
    console.warn(`[googlePlaces] Emergency category "${categoryKey}" failed:`, err.message);
    return [];
  }

  const withDistance = raw
    .filter((p) => p.geometry?.location)
    .map((p) => ({
      ...p,
      distance_km: Math.round(haversineKm(lat, lng, p.geometry.location.lat, p.geometry.location.lng) * 10) / 10,
    }))
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, EMERGENCY_RESULTS_PER_CATEGORY);

  const enriched = [];
  for (const place of withDistance) {
    const details = await fetchPlaceDetails(place.place_id);
    enriched.push({
      place_id: place.place_id,
      name: place.name,
      address: details?.formatted_address || place.vicinity || null,
      phone: details?.formatted_phone_number || details?.international_phone_number || null,
      distance_km: place.distance_km,
      rating: place.rating ?? null,
      open_now: details?.opening_hours?.open_now ?? place.opening_hours?.open_now ?? null,
      latitude: place.geometry.location.lat,
      longitude: place.geometry.location.lng,
      // Prefer our own constructed URL (Google's documented Maps URLs API,
      // https://developers.google.com/maps/documentation/urls/get-started)
      // over the raw `details.url` the Place Details API returns. That
      // field is a "cid" link (maps.google.com/?cid=...) which goes
      // through an extra server-side redirect Google's own domain
      // performs — a hop that many mobile/in-app webviews (and some
      // privacy-hardened browsers) fail silently on, showing a blank
      // page instead of Maps. The api=1 search URL below deep-links
      // straight into the native app or web Maps with no redirect hop,
      // so it's kept as the primary link; details.url is only used as a
      // last-resort fallback if we somehow don't have coordinates.
      maps_url: mapsUrlFor(place) || details?.url || null,
    });
  }
  return enriched;
}

/**
 * Fetches all 6 emergency categories in parallel around a point. Returns
 * null (not an empty object) if Google Places isn't configured, so the
 * caller knows to fall back to the Overpass-based lookup instead.
 */
export async function fetchEmergencyServicesFromGoogle({ lat, lng }) {
  if (!isGooglePlacesConfigured || lat == null || lng == null) return null;

  const categoryKeys = Object.keys(EMERGENCY_CATEGORY_QUERIES);
  const results = await Promise.all(categoryKeys.map((key) => fetchEmergencyCategory(key, { lat, lng })));
  return categoryKeys.reduce((acc, key, i) => {
    acc[key] = results[i];
    return acc;
  }, {});
}

export async function fetchGooglePlacesSpots({ lat, lng, city, radiusMeters = 15000 }) {
  if (!isGooglePlacesConfigured || lat == null || lng == null) return [];

  const seen = new Set();
  const rows = [];
  for (const q of PLACE_TYPE_QUERIES) {
    try {
      const places = await fetchNearbyByType(lat, lng, radiusMeters, q.type);
      for (const place of places) {
        if (seen.has(place.place_id)) continue;
        seen.add(place.place_id);
        const row = toSpotRow(place, q, city);
        if (row) rows.push(row);
      }
    } catch (err) {
      console.warn(`[googlePlaces] Skipped ${q.type} for "${city}":`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, TYPE_DELAY_MS));
  }

  // Nature/scenic spots the typed nearby-search loop above can't reach
  // (see the NATURE_TEXT_QUERIES comment) — fetched via Text Search and
  // merged into the same deduped pool so they compete fairly for route
  // slots instead of nature_scenic quietly staying empty.
  for (const nq of NATURE_TEXT_QUERIES) {
    try {
      const places = await fetchNatureTextResults(lat, lng, radiusMeters, `${nq.query} in ${city || ''}`.trim());
      for (const place of places) {
        if (seen.has(place.place_id)) continue;
        seen.add(place.place_id);
        const row = toSpotRow(place, { category: 'nature_scenic', subcategory: nq.subcategory }, city);
        if (row) rows.push(row);
      }
    } catch (err) {
      console.warn(`[googlePlaces] Skipped nature text query "${nq.query}" for "${city}":`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, TYPE_DELAY_MS));
  }

  return rows;
}