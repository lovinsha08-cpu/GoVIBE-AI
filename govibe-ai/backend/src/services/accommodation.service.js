import { env } from '../config/env.js';
import { haversineKm } from './geo.service.js';
import { isGooglePlacesConfigured } from './googlePlaces.service.js';

/**
 * Live accommodation discovery for GoVIBE.
 * Google Places is the discovery source; OSM is only a resilience fallback.
 * Neither source is treated as a live room-rate feed. Google price levels are
 * estimates only; exact dates/guest pricing is checked through an external
 * hotel-search deeplink using the traveler's complete trip details.
 */
const NEARBY_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const PLACE_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const SEARCH_RADIUS_METERS = 8000;
const MIN_RATING = 3.5;
const PRICE_LEVEL_TO_INR_PER_NIGHT = { 0: 1200, 1: 1800, 2: 3500, 3: 7000, 4: 12000 };
const DEFAULT_PRICE_LEVEL_INR = 3500;
const STYLE_PREFERRED_PRICE_LEVEL = {
  luxury: 4, business: 3, couple: 3, family_friendly: 2, relaxed: 2,
  scenic: 2, food_explorer: 2, fast_paced: 1, budget_friendly: 1, hidden_gems_only: 1,
};

function encode(value) { return encodeURIComponent(String(value || '').trim()); }
function normaliseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}
function normaliseTime(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function buildTripSearchContext({ place, trip, groupSize }) {
  const checkin = normaliseDate(trip.start_date);
  const checkout = normaliseDate(trip.end_date);
  const startTime = normaliseTime(trip.start_time);
  const endTime = normaliseTime(trip.end_time);
  const adults = Math.max(1, Number(trip.adults) || Number(groupSize) || 1);
  const children = Math.max(0, Number(trip.kids) || 0);
  const destination = [place.name, place.address, trip.destination].filter(Boolean).join(', ');
  return { checkin, checkout, startTime, endTime, adults, children, destination };
}

function buildBookingSearchUrl({ place, trip, groupSize }) {
  const context = buildTripSearchContext({ place, trip, groupSize });
  const params = new URLSearchParams({
    ss: context.destination,
    group_adults: String(context.adults),
    no_rooms: '1',
    group_children: String(context.children),
  });
  if (context.checkin) params.set('checkin', context.checkin);
  if (context.checkout && context.checkout !== context.checkin) params.set('checkout', context.checkout);
  // Hotel inventory is priced by calendar dates. The trip's clock times are
  // still preserved in the deep-link context for providers/pages that can
  // use arrival/departure times when determining availability.
  if (context.startTime) params.set('checkin_time', context.startTime);
  if (context.endTime) params.set('checkout_time', context.endTime);
  return `https://www.booking.com/searchresults.html?${params.toString()}`;
}

function buildGoogleHotelSearchUrl({ place, trip, groupSize }) {
  const context = buildTripSearchContext({ place, trip, groupSize });
  const queryParts = [
    place.name,
    place.address,
    trip.destination,
    'hotel prices',
    context.checkin && `check-in ${context.checkin}`,
    context.checkout && `check-out ${context.checkout}`,
    context.startTime && `arrival ${context.startTime}`,
    context.endTime && `departure ${context.endTime}`,
    `${context.adults} adults`,
    context.children ? `${context.children} children` : null,
  ].filter(Boolean);
  return `https://www.google.com/search?q=${encode(queryParts.join(' '))}`;
}

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
  } finally { clearTimeout(timeout); }
}

async function fetchPlaceDetails(placeId) {
  try {
    const fields = 'formatted_phone_number,formatted_address,url,website';
    const url = `${PLACE_DETAILS_URL}?place_id=${placeId}&fields=${fields}&key=${env.googlePlacesApiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const data = await res.json();
      return data.status === 'OK' ? data.result || null : null;
    } finally { clearTimeout(timeout); }
  } catch { return null; }
}

async function searchGoogleAccommodation(lat, lng) {
  if (!isGooglePlacesConfigured) return [];
  try {
    const url = `${NEARBY_SEARCH_URL}?location=${lat},${lng}&radius=${SEARCH_RADIUS_METERS}&type=lodging&key=${env.googlePlacesApiKey}`;
    const raw = await fetchGoogleJson(url);
    return raw.filter((p) => p.geometry?.location && (p.rating ?? 0) >= MIN_RATING && p.name).map((p) => ({
      place_id: p.place_id, name: p.name, address: p.vicinity || null,
      rating: p.rating ?? null, review_count: p.user_ratings_total ?? 0,
      price_level: p.price_level, latitude: p.geometry.location.lat, longitude: p.geometry.location.lng,
      phone: null, website_url: null, maps_url: null, source: 'google_places',
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
    const res = await fetch(OVERPASS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'User-Agent': 'GoVIBE-AI/1.0 (trip planning app)' }, body: query, signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.elements || []).map((el) => {
      const latitude = el.lat ?? el.center?.lat;
      const longitude = el.lon ?? el.center?.lon;
      const tags = el.tags || {};
      if (!tags.name || latitude == null || longitude == null) return null;
      return {
        place_id: `osm-${el.type}-${el.id}`, name: tags.name,
        address: [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(', ') || null,
        rating: null, review_count: 0, price_level: null, latitude, longitude,
        phone: tags.phone || tags['contact:phone'] || null,
        website_url: tags.website || tags['contact:website'] || null,
        maps_url: `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`,
        source: 'openstreetmap',
      };
    }).filter(Boolean);
  } catch (err) {
    console.warn('[accommodation] OSM lodging search failed:', err.message);
    return [];
  } finally { clearTimeout(timeout); }
}

function estimatedPricePerNight(place) {
  if (place.price_level == null) return DEFAULT_PRICE_LEVEL_INR;
  return PRICE_LEVEL_TO_INR_PER_NIGHT[place.price_level] ?? DEFAULT_PRICE_LEVEL_INR;
}

function buildReason({ trip, place, fitsBudget }) {
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
  if (best.place.source === 'google_places' && best.place.place_id) details = await fetchPlaceDetails(best.place.place_id);

  const distanceKmFromCenter = Math.round(best.distanceKm * 10) / 10;
  const mapsUrl = details?.url || best.place.maps_url || `https://www.google.com/maps/search/?api=1&query=${best.place.latitude},${best.place.longitude}&query_place_id=${best.place.place_id}`;
  const websiteUrl = details?.website || best.place.website_url || null;
  const priceCheckUrl = buildBookingSearchUrl({ place: best.place, trip, groupSize });
  const comparePricesUrl = buildGoogleHotelSearchUrl({ place: best.place, trip, groupSize });
  const nightsSafe = Math.max(1, Number(nights) || 1);
  const searchContext = buildTripSearchContext({ place: best.place, trip, groupSize });

  return {
    place_id: best.place.place_id, name: best.place.name,
    address: details?.formatted_address || best.place.address || null,
    phone: details?.formatted_phone_number || best.place.phone || null,
    rating: best.place.rating ?? null, review_count: best.place.review_count || 0,
    price_per_night_inr: best.pricePerNight, estimated_total_stay_inr: best.pricePerNight * nightsSafe,
    distance_km_from_center: distanceKmFromCenter,
    check_in_time: '12:00 PM', check_out_time: '10:00 AM',
    latitude: best.place.latitude, longitude: best.place.longitude,
    maps_url: mapsUrl, website_url: websiteUrl, booking_url: websiteUrl,
    price_check_url: priceCheckUrl, compare_prices_url: comparePricesUrl,
    price_check_provider: 'Booking.com search',
    price_search_context: {
      check_in_date: searchContext.checkin,
      check_out_date: searchContext.checkout,
      trip_start_time: searchContext.startTime,
      trip_end_time: searchContext.endTime,
      adults: searchContext.adults,
      children: searchContext.children,
      nights: nightsSafe,
    },
    source: best.place.source,
    reason: buildReason({ trip, place: best.place, fitsBudget: best.fitsBudget }),
    price_estimate_note: best.place.source === 'google_places'
      ? 'GoVIBE estimate only — Google Places pricing is a general tier, not a live room rate. Check live dates before booking.'
      : 'GoVIBE estimate only — OSM has no live room rate. Check the current price before booking.',
  };
}
