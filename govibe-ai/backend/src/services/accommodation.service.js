import { env } from '../config/env.js';
import { haversineKm } from './geo.service.js';
import { isGooglePlacesConfigured } from './googlePlaces.service.js';

/**
 * Recommends a real, bookable-looking stay near the destination and
 * returns everything the "Recommended Stay" UI section + itinerary
 * engine need: name, address, rating, an estimated per-night price,
 * distance from the destination center, check-in/out times, a maps
 * link, and a short human-readable reason it was picked.
 *
 * Deliberately Google-Places-only (no invented hotel names): if no key
 * is configured, this returns null and the itinerary engine simply
 * skips accommodation stops/costs — the same "never hallucinate a real
 * place" rule the rest of this app already follows for emergency
 * services and tourist spots.
 */

const NEARBY_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const PLACE_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const SEARCH_RADIUS_METERS = 8000;
const MIN_RATING = 3.5;

// Google's price_level (0-4) doesn't come with an actual currency figure
// attached, so this maps it to a rough India per-night INR band. This is
// clearly an estimate — real pricing varies by season/demand — and is
// only ever presented as "approximate price per night".
const PRICE_LEVEL_TO_INR_PER_NIGHT = { 0: 1200, 1: 1800, 2: 3500, 3: 7000, 4: 12000 };
const DEFAULT_PRICE_LEVEL_INR = 3500; // used when Google doesn't report a price_level at all

// How strongly each trip style prefers a given Google price_level (0-4).
// Used to break ties among budget-compatible candidates, not as a hard filter.
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
    const fields = 'formatted_phone_number,formatted_address,url';
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

function estimatedPricePerNight(place) {
  if (place.price_level == null) return DEFAULT_PRICE_LEVEL_INR;
  return PRICE_LEVEL_TO_INR_PER_NIGHT[place.price_level] ?? DEFAULT_PRICE_LEVEL_INR;
}

function buildReason({ trip, place, pricePerNight, fitsBudget }) {
  const bits = [];
  if (place.rating >= 4.5) bits.push(`an excellent ${place.rating}★ rating`);
  else if (place.rating >= 4.0) bits.push(`a strong ${place.rating}★ rating`);

  const styleLabel = {
    luxury: 'a comfortable, premium stay for a luxury-style trip',
    budget_friendly: 'a wallet-friendly stay that keeps more budget for experiences',
    family_friendly: 'a well-rated, family-suited stay',
    business: 'a stay well-suited for a business trip',
    couple: 'a comfortable stay for a couple',
  }[trip.trip_style];
  if (styleLabel) bits.push(styleLabel);

  bits.push(fitsBudget ? 'comfortably within your accommodation budget' : 'the best fit available near this budget range');

  if (!bits.length) return `Selected for its rating and proximity to your planned attractions in ${trip.destination}.`;
  return `Chosen for ${bits.join(', ')}, close to your planned attractions in ${trip.destination}.`;
}

/**
 * @param {object} params.trip - the trip row (destination coords, trip_style, total_budget_inr, dates)
 * @param {number} params.groupSize - total travelers (adults+kids+elderly+specially_abled)
 * @param {number} params.nights - number of nights the stay covers
 * @returns {Promise<object|null>} the recommended stay, or null if unavailable
 */
export async function findAccommodationRecommendation({ trip, groupSize = 1, nights = 1 }) {
  if (!isGooglePlacesConfigured) return null;
  const lat = trip.destination_lat;
  const lng = trip.destination_lng;
  if (lat == null || lng == null) return null;

  let raw;
  try {
    const url = `${NEARBY_SEARCH_URL}?location=${lat},${lng}&radius=${SEARCH_RADIUS_METERS}&type=lodging&key=${env.googlePlacesApiKey}`;
    raw = await fetchJson(url);
  } catch (err) {
    console.warn('[accommodation] Nearby lodging search failed:', err.message);
    return null;
  }

  const candidates = raw.filter((p) => p.geometry?.location && (p.rating ?? 0) >= MIN_RATING);
  if (!candidates.length) return null;

  // Budget guardrail: how much of the total budget is realistically
  // allotted to accommodation for the whole stay (mirrors the 35% base
  // weight budget.service.js uses), spread across nights.
  const accommodationBudgetShare = (Number(trip.total_budget_inr) || 0) * 0.35;
  const maxPerNight = nights > 0 ? accommodationBudgetShare / nights : accommodationBudgetShare;
  const preferredLevel = STYLE_PREFERRED_PRICE_LEVEL[trip.trip_style] ?? 2;

  const ranked = candidates
    .map((p) => {
      const pricePerNight = estimatedPricePerNight(p);
      const fitsBudget = maxPerNight <= 0 || pricePerNight <= maxPerNight * 1.15; // small tolerance
      const styleDistance = Math.abs((p.price_level ?? 2) - preferredLevel);
      return { place: p, pricePerNight, fitsBudget, styleDistance };
    })
    .sort((a, b) => {
      if (a.fitsBudget !== b.fitsBudget) return a.fitsBudget ? -1 : 1; // budget-fitting first
      if (a.styleDistance !== b.styleDistance) return a.styleDistance - b.styleDistance; // then closest to preferred style
      return (b.place.rating ?? 0) - (a.place.rating ?? 0); // then highest rated
    });

  const best = ranked[0];
  if (!best) return null;

  const details = await fetchPlaceDetails(best.place.place_id);
  const distanceKmFromCenter = Math.round(
    haversineKm(lat, lng, best.place.geometry.location.lat, best.place.geometry.location.lng) * 10
  ) / 10;

  return {
    place_id: best.place.place_id,
    name: best.place.name,
    address: details?.formatted_address || best.place.vicinity || null,
    phone: details?.formatted_phone_number || null,
    rating: best.place.rating ?? null,
    price_per_night_inr: best.pricePerNight,
    distance_km_from_center: distanceKmFromCenter,
    check_in_time: '12:00 PM',
    check_out_time: '10:00 AM',
    latitude: best.place.geometry.location.lat,
    longitude: best.place.geometry.location.lng,
    maps_url: details?.url
      || `https://www.google.com/maps/search/?api=1&query=${best.place.geometry.location.lat},${best.place.geometry.location.lng}&query_place_id=${best.place.place_id}`,
    reason: buildReason({ trip, place: best.place, pricePerNight: best.pricePerNight, fitsBudget: best.fitsBudget }),
    price_estimate_note: 'Approximate — based on Google\'s general pricing tier for this property, not live rates.',
  };
}