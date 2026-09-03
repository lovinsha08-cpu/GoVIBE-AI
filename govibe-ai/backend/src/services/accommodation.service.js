import { env } from '../config/env.js';
import { haversineKm } from './geo.service.js';
import { isGooglePlacesConfigured } from './googlePlaces.service.js';

/**
 * Finds a real accommodation near the destination. Google Places is the
 * preferred source, but accommodation must not disappear just because the
 * optional Google key is unavailable. OpenStreetMap/Overpass is the
 * no-key fallback.
 *
 * No hotel names, ratings or URLs are invented: every property comes from
 * Google Places, OSM, or an existing GoVIBE business row in future adapters.
 */

const NEARBY_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const PLACE_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const SEARCH_RADIUS_METERS = 8000;
const MIN_RATING = 3.5;

const PRICE_LEVEL_TO_INR_PER_NIGHT = { 0: 1200, 1: 1800, 2: 3500, 3: 7000, 4: 12000 };
const DEFAULT_PRICE_LEVEL_INR = 3500;

const STYLE_PREFERRED_PRICE_LEVEL = {
  luxury: 4,
  business: 3,
  couple: 3,
  family_friendly: 2,
  relaxed: 2,
  scenic: 2,
  food_explorer: 2,
  fast_paced: 1,
  budget_friendly: 1,
  hidden_gems_only: 1,
};

async function fetchGoogleJson(url, timeoutMs = 8000) {
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
    const fields = 'formatted_phone_number,formatted_address,url,website';
    const url = `${PLACE_DETAILS_URL}?place_id=${placeId}&fields=${fields}&key=${env.googlePlacesApiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.result || null;
  } catch {
    return null;
  }
}

async function searchGoogleAccommodation(lat, lng) {
  if (!isGooglePlacesConfigured) return [];
  try {
    const url = `${NEARBY_SEARCH_URL}?location=${lat},${lng}&radius=${SEARCH_RADIUS_METERS}&type=lodging&key=${env.googlePlacesApiKey}`;
    const raw = await fetchGoogleJson(url);
    return raw.filter((p) => p.geometry?.location && (p.rating ?? 0) >= MIN_RATING).map((p) => ({
      place_id: p.place_id,
      name: p.name,
      address: p.vicinity || null,
      rating: p.rating ?? null,
      review_count: p.user_ratings_total ?? 0,
      price_level: p.price_level,
      latitude: p.geometry.location.lat,
      longitude: p.geometry.location.lng,
      phone: null,
      website_url: null,
      maps_url: null,
      source: 'google_places',
    }));
  } catch (err) {
    console.warn('[accommodation] Google lodging search failed; using OSM fallback:', err.message);
    return [];
  }
}

async function searchOsmAccommodation(lat, lng) {
  const query = `[out:json][timeout:12];(nwr["tourism"="hotel"](around:${SEARCH_RADIUS_METERS},${lat},${lng});nwr["tourism"="guest_house"](around:${SEARCH_RADIUS_METERS},${lat},${lng});nwr["tourism"="hostel"](around:${SEARCH_RADIUS_METERS},${lat},${lng});nwr["tourism"="motel"](around:${SEARCH_RADIUS_METERS},${lat},${lng}););out center 30;`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14000);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'User-Agent': 'GoVIBE-AI/1.0 (trip planning app)' },
      body: query,
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.elements || []).map((el) => {
      const latitude = el.lat ?? el.center?.lat;
      const longitude = el.lon ?? el.center?.lon;
      const tags = el.tags || {};
      if (!tags.name || latitude == null || longitude == null) return null;
      return {
        place_id: `osm-${el.type}-${el.id}`,
        name: tags.name,
        address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(', ') || null,
        rating: null,
        review_count: 0,
        price_level: null,
        latitude,
        longitude,
        phone: tags.phone || tags['contact:phone'] || null,
        website_url: tags.website || tags['contact:website'] || null,
        maps_url: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`,
        source: 'openstreetmap',
      };
    }).filter(Boolean);
  } catch (err) {
    console.warn('[accommodation] OSM lodging search failed:', err.message);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function estimatedPricePerNight(place) {
  if (place.price_level == null) return DEFAULT_PRICE_LEVEL_INR;
  return PRICE_LEVEL_TO_INR_PER_NIGHT[place.price_level] ?? DEFAULT_PRICE_LEVEL_INR;
}

function buildReason({ trip, place, pricePerNight, fitsBudget }) {
  const bits = [];
  if (place.rating >= 4.5) bits.push(`an excellent ${place.rating}★ rating`);
  else if (place.rating >= 4.0) bits.push(`a strong ${place.rating}★ rating`);
  if (trip.trip_style === 'budget_friendly') bits.push('a wallet-friendly stay that keeps more budget for experiences');
  else if (trip.trip_style === 'luxury') bits.push('a comfortable, premium stay for a luxury-style trip');
  else if (trip.trip_style === 'family_friendly') bits.push('a well-rated, family-suited stay');
  bits.push(fitsBudget ? 'within the accommodation budget estimate' : 'the best available fit near this budget range');
  return `Chosen for ${bits.join(', ')}, close to your planned attractions in ${trip.destination}.`;
}

export async function findAccommodationRecommendation({ trip, groupSize = 1, nights = 1 }) {
  const lat = Number(trip.destination_lat);
  const lng = Number(trip.destination_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // Google gives us ratings, review counts, price tiers and official URLs.
  // If it is unavailable, OSM still gives us real named accommodation so
  // the feature continues to work rather than silently returning nothing.
  let candidates = await searchGoogleAccommodation(lat, lng);
  if (!candidates.length) candidates = await searchOsmAccommodation(lat, lng);
  if (!candidates.length) return null;

  const accommodationBudgetShare = (Number(trip.total_budget_inr) || 0) * 0.35;
  const maxPerNight = nights > 0 ? accommodationBudgetShare / nights : accommodationBudgetShare;
  const preferredLevel = STYLE_PREFERRED_PRICE_LEVEL[trip.trip_style] ?? 2;

  const ranked = candidates.map((place) => {
    const pricePerNight = estimatedPricePerNight(place);
    const fitsBudget = maxPerNight <= 0 || pricePerNight <= maxPerNight * 1.15;
    const styleDistance = Math.abs((place.price_level ?? 2) - preferredLevel);
    const distanceKm = haversineKm(lat, lng, place.latitude, place.longitude);
    // Prefer budget fit first, then quality/review evidence, then proximity.
    const qualityScore = (place.rating || 0) * 2 + Math.log10((place.review_count || 0) + 1) * 0.35;
    return { place, pricePerNight, fitsBudget, styleDistance, distanceKm, qualityScore };
  }).sort((a, b) => {
    if (a.fitsBudget !== b.fitsBudget) return a.fitsBudget ? -1 : 1;
    if (a.styleDistance !== b.styleDistance) return a.styleDistance - b.styleDistance;
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    return a.distanceKm - b.distanceKm;
  });

  const best = ranked[0];
  if (!best) return null;

  let details = null;
  if (best.place.source === 'google_places' && best.place.place_id) {
    details = await fetchPlaceDetails(best.place.place_id);
  }

  const distanceKmFromCenter = Math.round(best.distanceKm * 10) / 10;
  const mapsUrl = details?.url || best.place.maps_url
    || `https://www.google.com/maps/search/?api=1&query=${best.place.latitude},${best.place.longitude}&query_place_id=${best.place.place_id}`;

  return {
    place_id: best.place.place_id,
    name: best.place.name,
    address: details?.formatted_address || best.place.address || null,
    phone: details?.formatted_phone_number || best.place.phone || null,
    rating: best.place.rating ?? null,
    review_count: best.place.review_count || 0,
    price_per_night_inr: best.pricePerNight,
    distance_km_from_center: distanceKmFromCenter,
    check_in_time: '12:00 PM',
    check_out_time: '10:00 AM',
    latitude: best.place.latitude,
    longitude: best.place.longitude,
    maps_url: mapsUrl,
    website_url: details?.website || best.place.website_url || null,
    source: best.place.source,
    reason: buildReason({ trip, place: best.place, pricePerNight: best.pricePerNight, fitsBudget: best.fitsBudget }),
    price_estimate_note: best.place.source === 'google_places'
      ? 'Approximate — based on Google\'s general pricing tier for this property, not live room rates.'
      : 'Approximate — no live room rate was available from OpenStreetMap; verify the hotel price before booking.',
  };
}
