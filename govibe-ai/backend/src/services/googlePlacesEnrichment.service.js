/**
 * Google Places API (New) enrichment.
 *
 * This is deliberately separate from googlePlaces.service.js (the existing
 * legacy Nearby-Search-based service, still used for spot-seeding and the
 * Emergency Services feature — untouched by this change). This service has
 * one job: given a SMALL, already-filtered set of OSM/candidate spots,
 * look each one up on Google Places (New) Text Search and return a
 * normalized familiarity/quality enrichment object. OSM/Overpass remains
 * the primary discovery source; Google is never called for the whole raw
 * candidate pool, and Google availability is never a hard dependency —
 * every function here fails soft (returns null/unchanged data) rather than
 * throwing, so itinerary generation always works even with no API key, a
 * quota error, or an unmatched place.
 */
import { env } from '../config/env.js';
import { haversineKm } from './geo.service.js';
import {
  GOOGLE_ENRICHMENT_LIMIT_PER_CATEGORY,
  GOOGLE_ENRICHMENT_CONCURRENCY,
  GOOGLE_ENRICHMENT_MATCH_MAX_KM,
  GOOGLE_ENRICHMENT_MIN_MATCH_CONFIDENCE,
} from '../config/scoringWeights.js';

const PLACES_NEW_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const REQUEST_TIMEOUT_MS = 8000;

// Only request the fields actually needed (spec Part 3) — no wildcard "*".
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.types',
  'places.rating',
  'places.userRatingCount',
  'places.regularOpeningHours',
  'places.googleMapsUri',
].join(',');

export const isGoogleEnrichmentConfigured = Boolean(env.googlePlacesApiKey);

// Process-lifetime cache. Keyed first by normalized name+city (cheap,
// checkable before any request is made), and again by the resolved Google
// Place ID once a match is found (the stable external identifier the spec
// asks for). Reused across itinerary generations for the same destination
// (spec Part 10 / Test 5) — a second run for the same city/spots makes no
// new Google requests for anything already resolved.
const enrichmentByNameKey = new Map();
const enrichmentByPlaceId = new Map();

function nameKey(name, city) {
  return `${(name || '').trim().toLowerCase()}::${(city || '').trim().toLowerCase()}`;
}

function normalizeForCompare(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** 0-1 name-similarity heuristic — exact match, substring containment, then token overlap. */
function nameSimilarity(a, b) {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const aTokens = new Set(na.split(' '));
  const bTokens = new Set(nb.split(' '));
  const shared = [...aTokens].filter((t) => bTokens.has(t)).length;
  return shared / Math.max(aTokens.size, bTokens.size);
}

async function searchTextOnce(query, { lat, lng }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const body = { textQuery: query, maxResultCount: 3 };
    if (lat != null && lng != null) {
      body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 8000 } };
    }
    const res = await fetch(PLACES_NEW_TEXT_SEARCH_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.googlePlacesApiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Places API (New) responded ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return data.places || [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Picks the best Google result for an OSM/candidate spot, or null if
 * nothing is a confident match. Never blindly takes the first result
 * (spec Part 4) — matches on name similarity + geographical distance, and
 * rejects anything that's clearly a different place.
 */
function pickBestMatch(spot, googleResults) {
  let best = null;
  let bestScore = 0;
  for (const place of googleResults) {
    const displayName = place.displayName?.text || '';
    const sim = nameSimilarity(spot.name, displayName);
    if (sim < 0.5) continue;

    let distKm = 0;
    if (place.location && Number.isFinite(spot.latitude) && Number.isFinite(spot.longitude)) {
      distKm = haversineKm(spot.latitude, spot.longitude, place.location.latitude, place.location.longitude);
    }
    if (distKm > GOOGLE_ENRICHMENT_MATCH_MAX_KM) continue;

    const distScore = Math.max(0, (GOOGLE_ENRICHMENT_MATCH_MAX_KM - distKm) / GOOGLE_ENRICHMENT_MATCH_MAX_KM);
    const score = sim * 0.75 + distScore * 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = place;
    }
  }
  return bestScore >= GOOGLE_ENRICHMENT_MIN_MATCH_CONFIDENCE ? best : null;
}

function normalizeEnrichment(place) {
  return {
    googlePlaceId: place.id,
    rating: place.rating ?? null,
    userRatingCount: place.userRatingCount ?? null,
    regularOpeningHours: place.regularOpeningHours || null,
    googleMapsUri: place.googleMapsUri || null,
    googleTypes: place.types || [],
  };
}

/** Enriches a single spot. Never throws — a failure just means no enrichment for that spot. */
async function enrichOne(spot, city) {
  const key = nameKey(spot.name, city);
  if (enrichmentByNameKey.has(key)) return enrichmentByNameKey.get(key);
  if (!isGoogleEnrichmentConfigured) return null;

  try {
    const query = city ? `${spot.name}, ${city}` : spot.name;
    const results = await searchTextOnce(query, { lat: spot.latitude, lng: spot.longitude });
    const match = pickBestMatch(spot, results);
    const enrichment = match ? normalizeEnrichment(match) : null;
    enrichmentByNameKey.set(key, enrichment);
    if (enrichment?.googlePlaceId) enrichmentByPlaceId.set(enrichment.googlePlaceId, enrichment);
    return enrichment;
  } catch (err) {
    console.warn(`[googlePlacesEnrichment] Failed to enrich "${spot.name}":`, err.message);
    // Cache the miss too, so a spot that's failing (bad name match, etc.)
    // doesn't get hit again every itinerary regeneration this process.
    enrichmentByNameKey.set(key, null);
    return null;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight at once — bounded concurrency, not unlimited parallel requests (spec Part 10). */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Selects up to `limitPerCategory` of the highest-value candidates PER
 * CATEGORY to send for Google enrichment, so Google Places is never called
 * for every raw OSM candidate (spec Part 10). Uses each candidate's
 * existing popularity_score/rating (from whatever source it already has)
 * purely as a cheap pre-filter — the real familiarity/quality scoring
 * happens after enrichment.
 */
export function selectTopCandidatesPerCategory(candidates, limitPerCategory = GOOGLE_ENRICHMENT_LIMIT_PER_CATEGORY) {
  const byCategory = new Map();
  for (const spot of candidates) {
    if (!byCategory.has(spot.category)) byCategory.set(spot.category, []);
    byCategory.get(spot.category).push(spot);
  }
  const picked = [];
  for (const spots of byCategory.values()) {
    const ranked = [...spots].sort((a, b) => {
      const pa = a.popularity_score != null ? Number(a.popularity_score) : 0.5;
      const pb = b.popularity_score != null ? Number(b.popularity_score) : 0.5;
      const ra = (Number(a.rating) || 0) / 5;
      const rb = (Number(b.rating) || 0) / 5;
      return (pb * 0.5 + rb * 0.5) - (pa * 0.5 + ra * 0.5);
    });
    picked.push(...ranked.slice(0, limitPerCategory));
  }
  return picked;
}

/**
 * Enriches a small, pre-filtered set of candidates with Google Places
 * (New) data. Returns the spots unchanged (no `_google` field) for
 * anything that fails to match/enrich — Google is never a hard dependency
 * for itinerary generation (spec Part 11).
 */
export async function enrichCandidatesWithGoogle(candidates, { city } = {}) {
  if (!isGoogleEnrichmentConfigured || candidates.length === 0) {
    return {
      enriched: candidates,
      stats: { attempted: 0, matched: 0, cached: 0, configured: isGoogleEnrichmentConfigured },
    };
  }

  let attempted = 0;
  let matched = 0;
  let cached = 0;

  const enrichments = await mapWithConcurrency(candidates, GOOGLE_ENRICHMENT_CONCURRENCY, async (spot) => {
    if (enrichmentByNameKey.has(nameKey(spot.name, city))) cached += 1;
    else attempted += 1;
    const enrichment = await enrichOne(spot, city);
    if (enrichment) matched += 1;
    return enrichment;
  });

  const enriched = candidates.map((spot, i) => (enrichments[i] ? { ...spot, _google: enrichments[i] } : spot));
  return { enriched, stats: { attempted, matched, cached, configured: true } };
}