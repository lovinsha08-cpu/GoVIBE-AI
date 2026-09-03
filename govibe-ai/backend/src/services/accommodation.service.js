import { env } from '../config/env.js';
import { haversineKm } from './geo.service.js';
import { isGooglePlacesConfigured } from './googlePlaces.service.js';

/**
 * Live accommodation discovery for GoVIBE.
 * Google Places is the primary discovery source; OSM is a resilience fallback.
 * Neither source provides a reliable live room rate here, so GoVIBE never
 * invents or displays a hotel price. Current pricing is checked externally
 * with the traveler's actual dates and guest count.
 */
const NEARBY_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const PLACE_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const SEARCH_RADIUS_METERS = 8000;
const MIN_RATING = 3.5;

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
  // Hotel pricing is calendar-date based. Preserve the trip clock times in
  // our returned context, but do not claim Booking.com uses them for pricing.
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
      place_id: p.place_id,
      name: p.name,
      address: p.vicinity || null,
      rating: p.rating ?? null,
      review_count: p.user_ratings_total ?? 0,
      price_level: p.price_level ?? null,
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
  } finally { clearTimeout(timeout); }
}

function buildReason({ trip, place }) {
  const bits = [];
  if (place.rating >= 4.5) bits.push(`an excellent ${place.rating}★ rating`);
  else if (place.rating >= 4.0) bits.push(`a strong ${place.rating}★ rating`);
  if (place.review_count > 0) bits.push(`${place.review_count.toLocaleString('en-IN')} reviews`);
  if (trip.trip_style === 'luxury') bits.push('a premium-oriented trip style');
  else if (trip.trip_style === 'family_friendly') bits.push('a family-oriented trip style');
  else if (trip.trip_style === 'budget_friendly') bits.push('a budget-conscious trip style without assuming a live room price');
  else if (trip.trip_style === 'couple') bits.push('a couple-oriented trip style');
  bits.push('convenient location for the planned itinerary');
  return `Recommended for ${bits.join(', ')}.`;
}

export async function findAccommodationRecommendation({ trip, groupSize = 1 }) {
  const lat = Number(trip.destination_lat);
  const lng = Number(trip.destination_lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  let candidates = await searchGoogleAccommodation(lat, lng);
  if (!candidates.length) candidates = await searchOsmAccommodation(lat, lng);
  if (!candidates.length) return null;

  const tripStyle = trip.trip_style || '';
  const distanceWeight = tripStyle === 'fast_paced' ? 0.55 : 0.45;
  const qualityWeight = 1 - distanceWeight;

  // Suitability ranking only. There is deliberately NO price/budget score.
  // A hotel is recommended because it is well-rated, well-reviewed and
  // geographically useful — the actual price is checked externally.
  const ranked = candidates.map((place) => {
    const distanceKm = haversineKm(lat, lng, place.latitude, place.longitude);
    const ratingScore = Math.min(5, Number(place.rating) || 0) / 5;
    const reviewConfidence = Math.min(1, Math.log10((Number(place.review_count) || 0) + 1) / 4);
    const qualityScore = (ratingScore * 0.75) + (reviewConfidence * 0.25);
    const distanceScore = Math.max(0, 1 - Math.min(distanceKm, 8) / 8);
    const suitabilityScore = (qualityScore * qualityWeight) + (distanceScore * distanceWeight);
    return { place, distanceKm, suitabilityScore };
  }).sort((a, b) => {
    if (b.suitabilityScore !== a.suitabilityScore) return b.suitabilityScore - a.suitabilityScore;
    if ((b.place.rating || 0) !== (a.place.rating || 0)) return (b.place.rating || 0) - (a.place.rating || 0);
    return a.distanceKm - b.distanceKm;
  });

  const best = ranked[0];
  if (!best) return null;

  let details = null;
  if (best.place.source === 'google_places' && best.place.place_id) {
    details = await fetchPlaceDetails(best.place.place_id);
  }

  const distanceKmFromCenter = Math.round(best.distanceKm * 10) / 10;
  const mapsUrl = details?.url || best.place.maps_url || `https://www.google.com/maps/search/?api=1&query=${best.place.latitude},${best.place.longitude}`;
  const websiteUrl = details?.website || best.place.website_url || null;
  const priceCheckUrl = buildBookingSearchUrl({ place: best.place, trip, groupSize });
  const comparePricesUrl = buildGoogleHotelSearchUrl({ place: best.place, trip, groupSize });
  const searchContext = buildTripSearchContext({ place: best.place, trip, groupSize });

  return {
    place_id: best.place.place_id,
    name: best.place.name,
    address: details?.formatted_address || best.place.address || null,
    phone: details?.formatted_phone_number || best.place.phone || null,
    rating: best.place.rating ?? null,
    review_count: best.place.review_count || 0,
    distance_km_from_center: distanceKmFromCenter,
    check_in_time: '12:00 PM',
    check_out_time: '10:00 AM',
    latitude: best.place.latitude,
    longitude: best.place.longitude,
    maps_url: mapsUrl,
    website_url: websiteUrl,
    booking_url: websiteUrl,
    price_check_url: priceCheckUrl,
    compare_prices_url: comparePricesUrl,
    price_check_provider: 'Booking.com search',
    price_search_context: {
      check_in_date: searchContext.checkin,
      check_out_date: searchContext.checkout,
      trip_start_time: searchContext.startTime,
      trip_end_time: searchContext.endTime,
      adults: searchContext.adults,
      children: searchContext.children,
      nights: searchContext.checkin && searchContext.checkout
        ? Math.max(1, Math.round((new Date(`${searchContext.checkout}T00:00:00`) - new Date(`${searchContext.checkin}T00:00:00`)) / 86400000))
        : null,
    },
    source: best.place.source,
    suitability_score: Math.round(best.suitabilityScore * 100),
    reason: buildReason({ trip, place: best.place }),
    price_note: 'Live room price is not estimated by GoVIBE. Check the current price for your exact dates and guests before booking.',
  };
}
