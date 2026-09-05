import { env } from '../config/env.js';
import { loadSpots } from './spotData.service.js';
import { filterGenuineTouristSpots, isValidItineraryStop } from './attractionFilter.service.js';
import { haversineKm, estimateTravelMinutes } from './geo.service.js';
import { recommendTransportMode, suggestBestVisitTime } from './routing.service.js';
import { estimateSpotEntryCost } from './budget.service.js';
import { explainSpotChoice } from './ai.service.js';

const GOOGLE_TEXT_SEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const REQUEST_TIMEOUT_MS = 8000;
const SEARCH_RADIUS_KM = 20;

const EXCLUDED_GOOGLE_TYPES = new Set([
  'local_government_office', 'city_hall', 'courthouse', 'police', 'fire_station',
  'hospital', 'doctor', 'school', 'primary_school', 'secondary_school', 'university',
  'bank', 'atm', 'post_office', 'embassy', 'storage', 'moving_company',
  'car_repair', 'car_dealer', 'train_station', 'transit_station', 'subway_station',
  'bus_station', 'light_rail_station',
]);

const TOURISM_TYPES = new Set([
  'tourist_attraction', 'museum', 'art_gallery', 'park', 'zoo', 'aquarium',
  'amusement_park', 'church', 'hindu_temple', 'mosque', 'synagogue', 'stadium',
  'spa', 'movie_theater', 'night_club', 'bar', 'natural_feature', 'point_of_interest',
]);

const TOURISM_KEYWORDS = [
  'museum', 'fort', 'palace', 'temple', 'church', 'mosque', 'park', 'beach', 'lake',
  'garden', 'gallery', 'monument', 'memorial', 'zoo', 'aquarium', 'planetarium',
  'heritage', 'waterfall', 'viewpoint', 'dam', 'sanctuary', 'national park',
  'amusement', 'theme park', 'theatre', 'theater', 'stadium', 'promenade',
  'market', 'mall', 'shopping', 'art', 'cultural', 'church', 'cathedral',
];

function normalizeName(value) {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const aTokens = new Set(na.split(' '));
  const bTokens = new Set(nb.split(' '));
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  return shared / Math.max(aTokens.size, bTokens.size);
}

function isTourismPlace(place) {
  const types = place.types || [];
  if (types.some((type) => EXCLUDED_GOOGLE_TYPES.has(type))) return false;
  if (types.some((type) => TOURISM_TYPES.has(type))) return true;
  const haystack = `${place.name || ''} ${place.formatted_address || ''}`.toLowerCase();
  return TOURISM_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function inferCategory(place) {
  const types = new Set(place.types || []);
  if (types.has('museum') || types.has('art_gallery')) return 'arts_culture';
  if (types.has('church') || types.has('hindu_temple') || types.has('mosque') || types.has('synagogue')) return 'religious_spiritual';
  if (types.has('park') || types.has('natural_feature')) return 'nature_scenic';
  if (types.has('zoo') || types.has('aquarium')) return 'wildlife';
  if (types.has('amusement_park') || types.has('movie_theater') || types.has('stadium')) return 'entertainment_recreation';
  if (types.has('shopping_mall')) return 'shopping';
  if (types.has('spa')) return 'wellness_leisure';
  if (types.has('night_club') || types.has('bar')) return 'nightlife';
  return 'heritage_historical';
}

function inferSubcategory(place, category) {
  const haystack = `${place.name || ''} ${place.types?.join(' ') || ''}`.toLowerCase();
  if (haystack.includes('museum')) return 'Museums';
  if (haystack.includes('gallery')) return 'Art Galleries';
  if (haystack.includes('temple')) return 'Temples';
  if (haystack.includes('church') || haystack.includes('cathedral')) return 'Churches';
  if (haystack.includes('mosque')) return 'Mosques';
  if (haystack.includes('park')) return 'Parks';
  if (haystack.includes('beach')) return 'Beaches';
  if (haystack.includes('garden')) return 'Gardens';
  if (haystack.includes('zoo')) return 'Zoos';
  if (haystack.includes('aquarium')) return 'Aquariums';
  if (haystack.includes('mall') || haystack.includes('shopping')) return 'Shopping Malls';
  return category;
}

async function googleTextSearch(query, trip) {
  if (!env.googlePlacesApiKey) return [];
  const location = `${trip.destination_lat},${trip.destination_lng}`;
  const url = `${GOOGLE_TEXT_SEARCH_URL}?query=${encodeURIComponent(`${query}, ${trip.destination}`)}&location=${location}&radius=20000&key=${env.googlePlacesApiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') return [];
    return data.results || [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeGoogleResult(place, trip) {
  const lat = place.geometry?.location?.lat;
  const lng = place.geometry?.location?.lng;
  if (!place.name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const distanceKm = haversineKm(trip.destination_lat, trip.destination_lng, lat, lng);
  if (distanceKm > SEARCH_RADIUS_KM || !isTourismPlace(place)) return null;
  const category = inferCategory(place);
  return {
    id: `google:${place.place_id}`,
    source: 'google_places',
    place_id: place.place_id,
    name: place.name,
    display_name: place.formatted_address || place.vicinity || place.name,
    address: place.formatted_address || place.vicinity || null,
    latitude: lat,
    longitude: lng,
    category,
    subcategory: inferSubcategory(place, category),
    rating: place.rating ?? null,
    review_count: place.user_ratings_total ?? 0,
    popularity_score: Math.min((place.user_ratings_total || 0) / 2000, 1),
    opening_hours: place.opening_hours?.open_now == null ? null : (place.opening_hours.open_now ? 'Open now' : 'Closed now'),
    entry_fee_inr: null,
    avg_visit_minutes: 60,
    maps_url: place.place_id ? `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(place.place_id)}` : null,
    distance_from_destination_km: Math.round(distanceKm * 10) / 10,
  };
}

function normalizeLocalSpot(spot, trip) {
  if (!spot || !Number.isFinite(spot.latitude) || !Number.isFinite(spot.longitude)) return null;
  const distanceKm = haversineKm(trip.destination_lat, trip.destination_lng, spot.latitude, spot.longitude);
  if (distanceKm > SEARCH_RADIUS_KM || !isValidItineraryStop(spot)) return null;
  return {
    ...spot,
    source: spot.source || 'govibe_dataset',
    display_name: spot.address || `${spot.name}, ${trip.destination}`,
    distance_from_destination_km: Math.round(distanceKm * 10) / 10,
  };
}

/** Search only when the traveler explicitly types a replacement query. */
export async function searchItineraryReplacementPlaces(trip, query, existingStops = []) {
  const trimmed = (query || '').trim();
  if (trimmed.length < 2) return [];

  const existingNames = new Set(existingStops.map((stop) => normalizeName(stop.name)).filter(Boolean));
  const results = [];

  const googleResults = await googleTextSearch(trimmed, trip);
  for (const place of googleResults) {
    const normalized = normalizeGoogleResult(place, trip);
    if (!normalized || existingNames.has(normalizeName(normalized.name))) continue;
    results.push(normalized);
  }

  // Always supplement Google with GoVIBE's own curated spot dataset. This
  // keeps the feature useful when Places API is unavailable and gives the
  // traveler the same vetted spots used by itinerary generation.
  const { spots } = await loadSpots({
    city: trip.destination,
    lat: trip.destination_lat,
    lng: trip.destination_lng,
    interests: trip.interests || [],
  });
  const curated = filterGenuineTouristSpots(spots)
    .map((spot) => normalizeLocalSpot(spot, trip))
    .filter(Boolean)
    .filter((spot) => !existingNames.has(normalizeName(spot.name)))
    .filter((spot) => {
      const haystack = normalizeName(`${spot.name} ${spot.subcategory || ''} ${spot.category || ''}`);
      return haystack.includes(normalizeName(trimmed)) || nameSimilarity(spot.name, trimmed) >= 0.34;
    });

  const seen = new Set(results.map((result) => normalizeName(result.name)));
  for (const spot of curated) {
    if (!seen.has(normalizeName(spot.name))) {
      seen.add(normalizeName(spot.name));
      results.push(spot);
    }
  }

  return results
    .sort((a, b) => {
      const aExact = normalizeName(a.name) === normalizeName(trimmed) ? 1 : 0;
      const bExact = normalizeName(b.name) === normalizeName(trimmed) ? 1 : 0;
      return bExact - aExact
        || (b.rating || 0) - (a.rating || 0)
        || (a.distance_from_destination_km || 0) - (b.distance_from_destination_km || 0);
    })
    .slice(0, 10);
}

function clockToMinutes(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function minutesToClock(total) {
  const minutes = ((Math.round(total) % 1440) + 1440) % 1440;
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function rebuildRoute(stops, trip) {
  const updated = stops.map((stop) => ({ ...stop }));
  let previous = null;
  let previousDay = null;
  let dayClock = null;
  let totalDistance = 0;
  let totalMinutes = 0;

  for (const stop of updated) {
    const isNewDay = previousDay !== stop.day;
    if (isNewDay) {
      dayClock = clockToMinutes(stop.arrival_time) ?? (stop.day === 1 ? clockToMinutes(trip.start_time) : 9 * 60);
      previousDay = stop.day;
      previous = null;
    }

    const from = previous || {
      name: stop.day === 1 ? (trip.start_location || trip.destination) : (stop.category === 'accommodation' ? stop.name : trip.destination),
      latitude: stop.day === 1 ? (trip.start_lat ?? trip.destination_lat) : (stop.category === 'accommodation' ? stop.latitude : trip.destination_lat),
      longitude: stop.day === 1 ? (trip.start_lng ?? trip.destination_lng) : (stop.category === 'accommodation' ? stop.longitude : trip.destination_lng),
    };

    if (Number.isFinite(from.latitude) && Number.isFinite(from.longitude) && Number.isFinite(stop.latitude) && Number.isFinite(stop.longitude)) {
      const distanceKm = Math.round(haversineKm(from.latitude, from.longitude, stop.latitude, stop.longitude) * 10) / 10;
      const allowedModes = trip.transport_modes?.length ? trip.transport_modes : [];
      const fallbackMode = stop.transport_mode || trip.transport_priority || 'cab';
      const leg = recommendTransportMode(distanceKm, allowedModes, fallbackMode);
      const travelMinutes = distanceKm > 0 ? Math.max(2, Math.round(estimateTravelMinutes(distanceKm, leg.mode))) : 0;

      if (previous) dayClock += travelMinutes;
      else if (stop.category !== 'accommodation' && stop.arrival_time == null) dayClock += travelMinutes;

      const visitMinutes = Number(stop.visit_minutes) || 0;
      if (stop.category !== 'accommodation') {
        stop.arrival_time = minutesToClock(dayClock);
        dayClock += visitMinutes;
        stop.departure_time = minutesToClock(dayClock);
      }
      stop.from_location_name = from.name;
      stop.to_location_name = stop.name;
      stop.distance_km_from_prev = distanceKm;
      stop.travel_minutes_from_prev = travelMinutes;
      stop.transport_mode = leg.mode;
      totalDistance += distanceKm;
      totalMinutes += travelMinutes;
    }

    previous = stop;
  }

  return { stops: updated, totalDistanceKm: Math.round(totalDistance * 10) / 10, totalMinutes };
}

function updateJourneyAndBudget(itinerary, trip, stops, totalDistanceKm, totalMinutes) {
  const budget = { ...(itinerary.budget_summary || {}) };
  const extras = { ...(budget.ai_extras || {}) };
  const journey = extras.journey ? { ...extras.journey } : null;

  if (journey) {
    const endLat = trip.end_lat ?? trip.destination_lat;
    const endLng = trip.end_lng ?? trip.destination_lng;
    const last = stops[stops.length - 1];
    if (last && Number.isFinite(last.latitude) && Number.isFinite(last.longitude) && Number.isFinite(endLat) && Number.isFinite(endLng)) {
      const endDistance = Math.round(haversineKm(last.latitude, last.longitude, endLat, endLng) * 10) / 10;
      const endMode = recommendTransportMode(endDistance, trip.transport_modes || [], trip.transport_priority || 'cab');
      const endMinutes = endDistance > 0 ? Math.max(2, Math.round(estimateTravelMinutes(endDistance, endMode.mode))) : 0;
      journey.end = {
        ...(journey.end || {}),
        location: trip.end_location || trip.destination,
        from_location_name: last.name,
        distance_km_from_prev: endDistance,
        travel_minutes: endMinutes,
        transport_mode: endMode.mode,
      };
      journey.route_summary = {
        ...(journey.route_summary || {}),
        total_distance_km: Math.round((totalDistanceKm + endDistance) * 10) / 10,
        total_travel_minutes: totalMinutes + endMinutes,
      };
    }
  }

  const entryFees = stops.reduce((sum, stop) => sum + (Number(stop.entry_cost_inr) || 0), 0);
  const previousFees = Number(budget.entry_fees_total_inr) || 0;
  const deltaFees = entryFees - previousFees;
  budget.entry_fees_total_inr = entryFees;
  budget.per_spot = stops
    .filter((stop) => stop.category !== 'accommodation')
    .map((stop) => ({ name: stop.name, entry_cost_inr: stop.entry_cost_inr ?? null }));

  if (budget.budget_validation) {
    const validation = { ...budget.budget_validation };
    const oldEntry = Number(validation.breakdown?.entry_fees_inr) || 0;
    const newEntry = oldEntry + deltaFees;
    const oldTotal = Number(validation.total_estimated_cost_inr) || 0;
    const newTotal = Math.max(0, oldTotal + deltaFees);
    const budgetLimit = Number(validation.total_budget_inr) || 0;
    validation.breakdown = { ...(validation.breakdown || {}), entry_fees_inr: newEntry };
    validation.total_estimated_cost_inr = newTotal;
    validation.within_budget = budgetLimit === 0 ? true : newTotal <= budgetLimit;
    validation.overage_inr = validation.within_budget ? 0 : newTotal - budgetLimit;
    validation.remaining_budget_inr = validation.within_budget ? budgetLimit - newTotal : 0;
    budget.budget_validation = validation;
  }

  if (budget.cost_per_traveler_inr != null) {
    const groupSize = Math.max(1, (trip.adults || 0) + (trip.kids || 0) + (trip.elderly || 0) + (trip.specially_abled || 0));
    budget.cost_per_traveler_inr = Math.round((Number(budget.budget_validation?.total_estimated_cost_inr) || 0) / groupSize);
  }

  budget.ai_extras = { ...extras, ...(journey ? { journey } : {}) };
  return budget;
}

/** Replace exactly one traveler-selected stop and recalculate downstream route data. */
export async function replaceItineraryStop(trip, itinerary, stopOrder, selectedPlace) {
  const stops = [...(itinerary.stops || [])].map((stop) => ({ ...stop }));
  const idx = stops.findIndex((stop) => Number(stop.order) === Number(stopOrder));
  if (idx === -1) throw new Error('Stop not found in this itinerary.');

  const current = stops[idx];
  if (current.category === 'accommodation') throw new Error('Accommodation nodes cannot be manually replaced here.');

  const lat = Number(selectedPlace?.latitude);
  const lng = Number(selectedPlace?.longitude);
  const name = String(selectedPlace?.name || '').trim();
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error('A valid place selection is required.');

  const distanceFromDestination = haversineKm(trip.destination_lat, trip.destination_lng, lat, lng);
  if (distanceFromDestination > SEARCH_RADIUS_KM) {
    throw new Error(`Choose a place within ${SEARCH_RADIUS_KM} km of ${trip.destination}.`);
  }

  const duplicate = stops.some((stop, stopIndex) => stopIndex !== idx && normalizeName(stop.name) === normalizeName(name));
  if (duplicate) throw new Error('That place is already in your itinerary. Choose a different place.');

  const { spots } = await loadSpots({
    city: trip.destination,
    lat: trip.destination_lat,
    lng: trip.destination_lng,
    interests: trip.interests || [],
  });
  const localMatch = filterGenuineTouristSpots(spots)
    .filter((spot) => Number.isFinite(spot.latitude) && Number.isFinite(spot.longitude))
    .map((spot) => ({ spot, nameScore: nameSimilarity(spot.name, name), distanceKm: haversineKm(spot.latitude, spot.longitude, lat, lng) }))
    .filter(({ distanceKm, nameScore }) => distanceKm <= 1 && nameScore >= 0.45)
    .sort((a, b) => b.nameScore - a.nameScore || a.distanceKm - b.distanceKm)[0]?.spot || null;

  const replacement = {
    ...current,
    spot_id: localMatch?.id || selectedPlace.place_id || `manual:${normalizeName(name).replace(/\s+/g, '-')}`,
    name,
    category: localMatch?.category || selectedPlace.category || current.category,
    subcategory: localMatch?.subcategory || selectedPlace.subcategory || null,
    latitude: lat,
    longitude: lng,
    address: localMatch?.address || selectedPlace.address || selectedPlace.display_name || null,
    rating: localMatch?.rating ?? selectedPlace.rating ?? null,
    opening_hours: localMatch?.opening_hours || selectedPlace.opening_hours || null,
    entry_cost_inr: localMatch ? estimateSpotEntryCost(localMatch, {
      adults: trip.adults, kids: trip.kids, elderly: trip.elderly, speciallyAbled: trip.specially_abled,
    }) : null,
    maps_url: selectedPlace.maps_url || (selectedPlace.place_id
      ? `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(selectedPlace.place_id)}`
      : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${trip.destination}`)}`),
    reasoning: null,
    weather_alternative: null,
    to_location_name: name,
  };

  if (!replacement.meal_type) {
    replacement.visit_minutes = Number(localMatch?.avg_visit_minutes || current.visit_minutes || 60);
    replacement.best_visit_time = suggestBestVisitTime(replacement.category, [0, 6].includes(new Date(replacement.date || trip.start_date).getDay()));
  }

  try {
    replacement.reasoning = await explainSpotChoice(replacement, {
      interestLabels: (trip.interests || []).map((interest) => interest.category),
    });
  } catch {
    replacement.reasoning = current.reasoning || null;
  }

  stops[idx] = replacement;
  const route = rebuildRoute(stops, trip);
  const budgetSummary = updateJourneyAndBudget(itinerary, trip, route.stops, route.totalDistanceKm, route.totalMinutes);

  return {
    stops: route.stops,
    budgetSummary,
    replacedStop: route.stops[idx],
    previousStopName: current.name,
    totalDistanceKm: route.totalDistanceKm,
    totalDurationMinutes: route.totalMinutes,
  };
}
