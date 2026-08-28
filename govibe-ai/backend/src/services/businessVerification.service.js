/**
 * Phase 2 — Business onboarding geo-location verification.
 *
 * Given a business name/category and a GPS point, this deterministically
 * checks whether a real place matching that name exists near that point,
 * using Google's official Places API (Text Search + Place Details) — never
 * by scraping Google Maps, and never by asking an LLM to judge legitimacy.
 *
 * IMPORTANT — what this module does and does NOT do:
 *   - It answers exactly one question: "does a place matching this name
 *     exist near this GPS point?" -> `locationVerified`.
 *   - It never decides whether the *person submitting the form* is the
 *     real owner of that place. That's `ownerVerified`, which this module
 *     always reports as `false` — it's a separate, out-of-scope (for this
 *     phase) manual/human review process.
 *   - It never checks whether the business is "already registered on
 *     GoVIBE" — that's a different concern and intentionally not handled
 *     here.
 *   - The match itself is decided by plain arithmetic (Haversine distance)
 *     and simple, auditable string comparison — no ML/LLM scoring.
 */
import { env } from '../config/env.js';
import { haversineKm } from './geo.service.js';

const TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const PLACE_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const REQUEST_TIMEOUT_MS = 10000;
const DETAILS_TIMEOUT_MS = 6000;

export const isBusinessVerificationConfigured = Boolean(env.googlePlacesApiKey);

/** Lowercase, trim, and strip punctuation so name comparison ignores things like "Café" vs "Cafe". */
function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic name-similarity score — no fuzzy ML matching, just exact /
 * substring comparison on normalized strings:
 *   2 = normalized names are identical
 *   1 = one normalized name contains the other (e.g. "Backwater Bites" vs
 *       "Backwater Bites Cafe")
 *   0 = no textual relationship at all
 */
function nameMatchScore(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 2;
  if (na.includes(nb) || nb.includes(na)) return 1;
  return 0;
}

class PlacesApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 'rate_limited' | 'api_failure'
  }
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new PlacesApiError(`Google Places responded ${res.status}`, 'api_failure');
    const data = await res.json();
    if (data.status === 'OVER_QUERY_LIMIT') {
      throw new PlacesApiError('Google Places rate limit reached', 'rate_limited');
    }
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      throw new PlacesApiError(
        `Google Places status: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`,
        'api_failure',
      );
    }
    return data;
  } catch (err) {
    if (err instanceof PlacesApiError) throw err;
    if (err.name === 'AbortError') throw new PlacesApiError('Google Places request timed out', 'api_failure');
    throw new PlacesApiError(err.message || 'Google Places request failed', 'api_failure');
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPlaceDetails(placeId) {
  try {
    const fields = [
      'formatted_phone_number',
      'international_phone_number',
      'website',
      'opening_hours',
      'formatted_address',
      'business_status',
      'rating',
      'user_ratings_total',
    ].join(',');
    const url = `${PLACE_DETAILS_URL}?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${env.googlePlacesApiKey}`;
    const data = await fetchJson(url, DETAILS_TIMEOUT_MS);
    return data.result || null;
  } catch {
    // Details are an enrichment layer only — never let a details failure
    // block or invalidate a location match that already succeeded.
    return null;
  }
}

function toPlaceSummary(candidate, details) {
  const loc = candidate.geometry?.location;
  return {
    placeId: candidate.place_id || null,
    name: candidate.name || null,
    address: details?.formatted_address || candidate.formatted_address || null,
    latitude: loc?.lat ?? null,
    longitude: loc?.lng ?? null,
    googleTypes: candidate.types || [],
    isOpenNow: details?.opening_hours?.open_now ?? candidate.opening_hours?.open_now ?? null,
    rating: details?.rating ?? candidate.rating ?? null,
    reviewCount: details?.user_ratings_total ?? candidate.user_ratings_total ?? null,
    phone: details?.formatted_phone_number || details?.international_phone_number || null,
    website: details?.website || null,
    businessStatus: details?.business_status || candidate.business_status || null,
  };
}

/**
 * Runs the deterministic match. Always resolves (never rejects) with a
 * structured result — callers decide the HTTP status from `status`.
 *
 * @param {{ businessName: string, category?: string, latitude: number, longitude: number }} input
 */
export async function verifyBusinessLocation({ businessName, category, latitude, longitude }) {
  if (!isBusinessVerificationConfigured) {
    return {
      status: 'unavailable',
      locationVerified: false,
      ownerVerified: false,
      distanceMeters: null,
      place: null,
      message:
        'Location verification is temporarily unavailable. Your business was registered — location will be verified once this service is back.',
    };
  }

  const searchRadius = env.businessLocationSearchRadiusMeters;
  const matchRadius = env.businessLocationMatchRadiusMeters;
  const query = category ? `${businessName} ${category}` : businessName;
  const url = `${TEXT_SEARCH_URL}?query=${encodeURIComponent(query)}&location=${latitude},${longitude}&radius=${searchRadius}&key=${env.googlePlacesApiKey}`;

  let data;
  try {
    data = await fetchJson(url, REQUEST_TIMEOUT_MS);
  } catch (err) {
    if (err.code === 'rate_limited') {
      return {
        status: 'rate_limited',
        locationVerified: false,
        ownerVerified: false,
        distanceMeters: null,
        place: null,
        message: 'Too many location lookups right now — please try again in a minute.',
      };
    }
    console.error('[businessVerification] Places lookup failed:', err.message);
    return {
      status: 'api_failure',
      locationVerified: false,
      ownerVerified: false,
      distanceMeters: null,
      place: null,
      message:
        'Could not reach the location-verification service. Your business was registered — location will be verified once this service is back.',
    };
  }

  const candidates = (data.results || [])
    .filter((c) => c.geometry?.location)
    .map((c) => ({
      candidate: c,
      distanceMeters: haversineKm(
        latitude,
        longitude,
        c.geometry.location.lat,
        c.geometry.location.lng,
      ) * 1000,
      nameScore: nameMatchScore(businessName, c.name),
    }));

  if (!candidates.length) {
    return {
      status: 'not_found',
      locationVerified: false,
      ownerVerified: false,
      distanceMeters: null,
      place: null,
      message: `We couldn't find a place matching "${businessName}" near that location. You can still register — an admin can verify it manually.`,
    };
  }

  // Deterministic selection: only candidates within the tight match radius
  // are eligible to verify. Among those, prefer the closest name match,
  // then the closest distance. A very close GPS hit (<= 1/3 of the match
  // radius) is accepted even with a weak name match, since owners often
  // register under a slightly different name than what's on Maps.
  const tightRadius = matchRadius / 3;
  const withinMatchRadius = candidates.filter(
    (c) => c.distanceMeters <= matchRadius && (c.nameScore >= 1 || c.distanceMeters <= tightRadius),
  );

  if (withinMatchRadius.length) {
    withinMatchRadius.sort((a, b) => b.nameScore - a.nameScore || a.distanceMeters - b.distanceMeters);
    const best = withinMatchRadius[0];
    const details = await fetchPlaceDetails(best.candidate.place_id);
    return {
      status: 'matched',
      locationVerified: true,
      ownerVerified: false,
      distanceMeters: Math.round(best.distanceMeters),
      place: toPlaceSummary(best.candidate, details),
      message: 'Location verified against Google Places.',
    };
  }

  // Nothing close enough, but something with a name relationship exists
  // further away — tell the owner why, rather than a flat "not found".
  const nearbyNamedMatch = candidates
    .filter((c) => c.nameScore >= 1)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)[0];

  if (nearbyNamedMatch) {
    return {
      status: 'too_far',
      locationVerified: false,
      ownerVerified: false,
      distanceMeters: Math.round(nearbyNamedMatch.distanceMeters),
      place: toPlaceSummary(nearbyNamedMatch.candidate, null),
      message: `We found "${nearbyNamedMatch.candidate.name}", but it's about ${Math.round(nearbyNamedMatch.distanceMeters)}m from your current location — further than expected. Make sure location access is accurate, or an admin can verify manually.`,
    };
  }

  return {
    status: 'not_found',
    locationVerified: false,
    ownerVerified: false,
    distanceMeters: null,
    place: null,
    message: `We couldn't confidently match "${businessName}" near that location. You can still register — an admin can verify it manually.`,
  };
}