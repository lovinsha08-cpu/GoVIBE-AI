/**
 * "X near me" search (requirement 6) — juice shop near me, restaurants
 * nearby, ATM near me, hospital nearby, etc.
 *
 * Order of resolution:
 *   1. GoVIBE's own business database (partners) within radius.
 *   2. If that comes up short, fall back to Google Places (if configured)
 *      or OpenStreetMap/Overpass (always available, no key needed).
 *   3. Merge, sort by distance -> rating -> GoVIBE-partner status, return
 *      a small, conversational-ready result set.
 *
 * Never invents a business or distance — every result traces back to a
 * real row (GoVIBE `businesses` table) or a real third-party API response.
 */
import { env } from '../config/env.js';
import { supabaseAdmin, isSupabaseConfigured } from '../config/supabase.js';
import { haversineKm } from './geo.service.js';

const DEFAULT_RADIUS_METERS = 3000;
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const GOOGLE_NEARBY_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';

// Maps free-text "near me" phrasing to { govibeCategory, osmTags, googleType }
// so one search term drives all three sources consistently.
const CATEGORY_MAP = [
  { match: /juice|smoothie/, govibe: 'food', osm: ['shop=juice', 'shop=beverages'], google: 'cafe', label: 'juice shop' },
  { match: /restaurant|dinner|lunch|food(?!.*truck)/, govibe: 'food', osm: ['amenity=restaurant'], google: 'restaurant', label: 'restaurant' },
  { match: /cafe|coffee/, govibe: 'food', osm: ['amenity=cafe'], google: 'cafe', label: 'cafe' },
  { match: /hotel|stay|homestay|lodging/, govibe: 'stay', osm: ['tourism=hotel', 'tourism=guest_house'], google: 'lodging', label: 'hotel' },
  { match: /atm|cash/, govibe: null, osm: ['amenity=atm'], google: 'atm', label: 'ATM' },
  { match: /hospital|clinic|doctor|medical/, govibe: null, osm: ['amenity=hospital', 'amenity=clinic'], google: 'hospital', label: 'hospital' },
  { match: /pharmacy|chemist|medicine|medical store/, govibe: null, osm: ['amenity=pharmacy'], google: 'pharmacy', label: 'pharmacy' },
  { match: /pump|petrol|fuel|gas station/, govibe: null, osm: ['amenity=fuel'], google: 'gas_station', label: 'petrol pump' },
  { match: /shopping|mall|market/, govibe: 'shopping', osm: ['shop=mall'], google: 'shopping_mall', label: 'shopping' },
  { match: /activity|tour|guide|rental/, govibe: 'activity', osm: ['shop=rental'], google: 'travel_agency', label: 'activity/rental' },
];

function resolveCategory(query) {
  const lower = (query || '').toLowerCase();
  return CATEGORY_MAP.find((c) => c.match.test(lower)) || null;
}

function withDistance(items, lat, lng) {
  return items
    .map((it) => ({ ...it, distanceKm: it.latitude != null && it.longitude != null ? Number(haversineKm(lat, lng, it.latitude, it.longitude).toFixed(2)) : null }))
    .filter((it) => it.distanceKm == null || it.distanceKm <= 25);
}

/** 1. GoVIBE partner businesses within radius, filtered by category if we recognized one. */
async function searchGovibeBusinesses(lat, lng, category, radiusMeters) {
  if (!isSupabaseConfigured) return [];
  let query = supabaseAdmin
    .from('businesses')
    .select('id, business_name, business_model, category, location, latitude, longitude, avg_rating, phone_public, verified')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null);
  if (category) query = query.eq('category', category);

  const { data, error } = await query;
  if (error || !data) return [];

  return withDistance(data, lat, lng)
    .filter((b) => b.distanceKm != null && b.distanceKm * 1000 <= radiusMeters * 3) // generous — we still rank by distance after
    .map((b) => ({
      name: b.business_name,
      category: b.category,
      subtype: b.business_model,
      address: b.location,
      latitude: b.latitude,
      longitude: b.longitude,
      rating: b.avg_rating || null,
      phone: b.phone_public || null,
      distanceKm: b.distanceKm,
      isGovibePartner: true,
      verified: b.verified,
      source: 'govibe_business',
    }));
}

/** 2a. Google Places Nearby Search fallback (if a key is configured). */
async function searchGooglePlaces(lat, lng, resolved, radiusMeters) {
  if (!env.googlePlacesApiKey || !resolved) return [];
  const url = `${GOOGLE_NEARBY_URL}?location=${lat},${lng}&radius=${radiusMeters}&type=${resolved.google}&key=${env.googlePlacesApiKey}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    if (data.status !== 'OK') return [];
    return (data.results || []).slice(0, 10).map((p) => ({
      name: p.name,
      category: resolved.label,
      address: p.vicinity || null,
      latitude: p.geometry?.location?.lat ?? null,
      longitude: p.geometry?.location?.lng ?? null,
      rating: p.rating ?? null,
      phone: null,
      distanceKm: p.geometry?.location ? Number(haversineKm(lat, lng, p.geometry.location.lat, p.geometry.location.lng).toFixed(2)) : null,
      isGovibePartner: false,
      openNow: p.opening_hours?.open_now ?? null,
      source: 'google_places',
    }));
  } catch {
    return [];
  }
}

/** 2b. OpenStreetMap/Overpass fallback — always available, no API key needed. */
async function searchOverpass(lat, lng, resolved, radiusMeters) {
  if (!resolved) return [];
  const tagClauses = resolved.osm
    .map((tag) => {
      const [k, v] = tag.split('=');
      return `node["${k}"="${v}"](around:${radiusMeters},${lat},${lng});way["${k}"="${v}"](around:${radiusMeters},${lat},${lng});`;
    })
    .join('\n');
  const query = `[out:json][timeout:10];(${tagClauses});out center 15;`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.elements || [])
      .map((el) => {
        const elLat = el.lat ?? el.center?.lat;
        const elLng = el.lon ?? el.center?.lon;
        if (elLat == null || elLng == null || !el.tags?.name) return null;
        return {
          name: el.tags.name,
          category: resolved.label,
          address: [el.tags['addr:street'], el.tags['addr:city']].filter(Boolean).join(', ') || null,
          latitude: elLat,
          longitude: elLng,
          rating: null,
          phone: el.tags.phone || el.tags['contact:phone'] || null,
          distanceKm: Number(haversineKm(lat, lng, elLat, elLng).toFixed(2)),
          isGovibePartner: false,
          source: 'openstreetmap',
        };
      })
      .filter(Boolean)
      .slice(0, 15);
  } catch {
    return [];
  }
}

/**
 * Main entry point. `query` is the raw free-text phrase (e.g. "juice shop
 * near me") — used both to detect the category and, if nothing matches our
 * keyword map, as a generic label. Requires the caller's current lat/lng
 * (frontend geolocation permission) — without it we can't search "near me".
 */
export async function searchNearby({ lat, lng, query, radiusMeters = DEFAULT_RADIUS_METERS }) {
  if (lat == null || lng == null) {
    return { results: [], resolvedCategory: null, source: 'no_location', message: 'I need your current location to search nearby — please allow location access.' };
  }

  const resolved = resolveCategory(query);

  const govibeResults = await searchGovibeBusinesses(lat, lng, resolved?.govibe, radiusMeters);

  let fallbackResults = [];
  let fallbackSource = null;
  if (govibeResults.length < 3) {
    const google = await searchGooglePlaces(lat, lng, resolved, radiusMeters);
    if (google.length) {
      fallbackResults = google;
      fallbackSource = 'google_places';
    } else {
      fallbackResults = await searchOverpass(lat, lng, resolved, radiusMeters);
      fallbackSource = 'openstreetmap_overpass';
    }
  }

  const merged = [...govibeResults, ...fallbackResults]
    // Sort: distance asc (primary), rating desc (secondary), GoVIBE partner first (tiebreaker)
    .sort((a, b) => {
      const distDiff = (a.distanceKm ?? 999) - (b.distanceKm ?? 999);
      if (Math.abs(distDiff) > 0.05) return distDiff;
      const ratingDiff = (b.rating || 0) - (a.rating || 0);
      if (ratingDiff !== 0) return ratingDiff;
      return (b.isGovibePartner ? 1 : 0) - (a.isGovibePartner ? 1 : 0);
    })
    .slice(0, 8);

  return {
    results: merged,
    resolvedCategory: resolved?.label || query,
    source: govibeResults.length ? (fallbackResults.length ? `govibe_business+${fallbackSource}` : 'govibe_business') : (fallbackSource || 'none'),
  };
}