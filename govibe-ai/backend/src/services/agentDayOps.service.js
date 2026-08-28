/**
 * Shared primitives for the AI Agent's itinerary-editing tools
 * (agentTools.service.js): splicing stops into/out of a day, and
 * recomputing that day's timeline (distances, travel times, arrival/
 * departure clocks, transport mode/plan, crowd level) afterward.
 *
 * Deliberately reuses the same building blocks the main generation
 * pipeline (itineraryEngine.service.js) uses for each leg — routing.service
 * for mode/crowd/best-time, geo.service for distance/duration,
 * transportPlanner.service (via attachTransportPlan) for the rich
 * multi-option transport card — rather than re-deriving any of that logic,
 * so an agent-edited day stays consistent with a freshly generated one.
 */
import { haversineKm, routeDistance, estimateTravelMinutes } from './geo.service.js';
import { recommendTransportMode, estimateCrowdLevel, suggestBestVisitTime, suggestPublicTransport } from './routing.service.js';
import { minutesToClock, attachTransportPlan } from './itineraryEngine.service.js';

// Same meal windows the main engine nudges arrival times into — kept in
// sync with the MEAL_WINDOWS_MIN table in finalValidation.service.js.
const MEAL_WINDOWS_MIN = { breakfast: 7 * 60, lunch: 12 * 60, cafe: 16 * 60 + 30, dinner: 19 * 60 };

/** Reassigns a gapless, globally sequential `order` (1-based) across every stop, preserving relative position. */
export function renumberStops(stops) {
  return stops.map((s, i) => ({ ...s, order: i + 1 }));
}

/** Every distinct day number present in the itinerary, ascending. */
export function getDayNumbers(stops) {
  return [...new Set(stops.map((s) => s.day))].sort((a, b) => a - b);
}

/** Splits `stops` into { before, dayStops, after } around one day's contiguous block. */
export function getDaySlice(stops, day) {
  const firstIdx = stops.findIndex((s) => s.day === day);
  if (firstIdx === -1) return { before: stops, dayStops: [], after: [], firstIdx: -1 };
  const dayStops = stops.filter((s) => s.day === day);
  return {
    before: stops.slice(0, firstIdx),
    dayStops,
    after: stops.slice(firstIdx + dayStops.length),
    firstIdx,
  };
}

/** Replaces one day's stop block with `newDayStops` (already in the desired order) and renumbers the whole itinerary. */
export function replaceDayStops(stops, day, newDayStops) {
  const { before, after, firstIdx } = getDaySlice(stops, day);
  if (firstIdx === -1) return renumberStops([...stops, ...newDayStops]); // day didn't exist yet — append
  return renumberStops([...before, ...newDayStops, ...after]);
}

/**
 * The point a day's FIRST leg is measured from: the previous stop in the
 * full itinerary if it has coordinates (this is correct whether that's an
 * accommodation "return to hotel" stop or the prior day's last attraction —
 * see insertAccommodationStops's own doc comment for why the hotel takes
 * over as the anchor once one exists), otherwise the trip's declared start
 * point / destination center — the same anchor the heuristic generation
 * pipeline uses for a day's opening leg.
 */
function resolveDayStartAnchor(stops, day, trip) {
  const { before } = getDaySlice(stops, day);
  const prev = before[before.length - 1];
  if (prev && Number.isFinite(prev.latitude) && Number.isFinite(prev.longitude)) {
    return { lat: prev.latitude, lng: prev.longitude, name: prev.name };
  }
  return {
    lat: trip.start_lat ?? trip.destination_lat,
    lng: trip.start_lng ?? trip.destination_lng,
    name: trip.start_location || trip.destination,
  };
}

function dayStartHour(day, trip) {
  if (day === 1 && trip.start_time) {
    const h = parseInt(String(trip.start_time).split(':')[0], 10);
    if (Number.isFinite(h)) return h;
  }
  return 9;
}

/**
 * Recomputes distance/travel-time/arrival/departure/transport/crowd for
 * every stop of one day, in whatever order they're CURRENTLY in — call
 * this after any tool adds, removes, replaces, or reorders stops within a
 * day. Returns a new full `stops` array with that day's block replaced.
 */
export async function rebuildDayTimeline(stops, day, { trip, allowedTransportModes, transportMode, forecast, isWeekend }) {
  const { dayStops } = getDaySlice(stops, day);
  if (dayStops.length === 0) return stops;

  const anchor = resolveDayStartAnchor(stops, day, trip);
  const groupSize = (trip.adults || 0) + (trip.kids || 0) + (trip.elderly || 0) + (trip.specially_abled || 0);
  let clock = dayStartHour(day, trip) * 60;
  let current = { lat: anchor.lat, lng: anchor.lng };
  let fromName = anchor.name;

  const rebuilt = [];
  for (const original of dayStops) {
    const stop = { ...original };
    const to = { lat: stop.latitude, lng: stop.longitude };
    let distanceKm = 0;
    let travelMinutes = 0;
    let routeSource = 'haversine_estimate';

    if (Number.isFinite(to.lat) && Number.isFinite(to.lng) && Number.isFinite(current.lat) && Number.isFinite(current.lng)) {
      try {
        const result = await routeDistance(current, to, transportMode);
        distanceKm = Math.round(result.distanceKm * 10) / 10;
        travelMinutes = result.durationMinutes;
        routeSource = result.source || routeSource;
      } catch {
        distanceKm = Math.round(haversineKm(current.lat, current.lng, to.lat, to.lng) * 10) / 10;
        travelMinutes = estimateTravelMinutes(distanceKm, transportMode);
      }
    }

    const legTransport = recommendTransportMode(distanceKm, allowedTransportModes, transportMode);
    if (legTransport.mode !== transportMode) {
      travelMinutes = estimateTravelMinutes(distanceKm, legTransport.mode);
    }
    travelMinutes = Math.max(travelMinutes, distanceKm > 0 ? 2 : 0);

    clock += travelMinutes;
    let arrivalMinutes = clock;
    if (stop.meal_type && MEAL_WINDOWS_MIN[stop.meal_type] && arrivalMinutes < MEAL_WINDOWS_MIN[stop.meal_type]) {
      arrivalMinutes = MEAL_WINDOWS_MIN[stop.meal_type];
      clock = arrivalMinutes;
    }
    const visitMinutes = Math.max(15, Math.round(Number(stop.visit_minutes)) || 60);
    clock += visitMinutes;
    const departureMinutes = clock;

    stop.from_location_name = fromName;
    stop.to_location_name = stop.name;
    stop.distance_km_from_prev = distanceKm;
    stop.travel_minutes_from_prev = travelMinutes;
    stop.transport_mode = legTransport.mode;
    stop.transport_reason = legTransport.note;
    stop.route_source = routeSource;
    stop.arrival_time = minutesToClock(arrivalMinutes);
    stop.departure_time = minutesToClock(departureMinutes);
    stop.visit_minutes = visitMinutes;
    stop.crowd_level = estimateCrowdLevel(Math.floor(arrivalMinutes / 60) % 24, Boolean(isWeekend));
    stop.best_visit_time = suggestBestVisitTime(stop.category, Boolean(isWeekend));
    stop.public_transport = suggestPublicTransport(distanceKm);
    stop.transport = attachTransportPlan({
      distanceKm,
      fromName,
      toName: stop.name,
      travellers: Math.max(1, groupSize),
      allowedModes: allowedTransportModes,
      transportPriority: trip.transport_priority,
      arrivalClock: stop.arrival_time,
      forecast,
      destinationName: trip.destination,
    });

    rebuilt.push(stop);
    current = to;
    fromName = stop.name;
  }

  return replaceDayStops(stops, day, rebuilt);
}

/**
 * Inserts a newly-picked spot into a day's stop list at whichever position
 * keeps the route geographically sensible: right after the existing stop
 * it's geographically closest to (so the day doesn't zig-zag back across
 * the city to visit it), or at the end if the day has 0-1 stops. Never
 * inserts before/after a meal stop's exact slot — meals stay anchored to
 * their nearest non-meal neighbor's position instead of splitting a pair.
 */
export function insertStopAtBestPosition(dayStops, newStopBase) {
  if (dayStops.length === 0) return [newStopBase];

  let bestIdx = dayStops.length;
  let bestDist = Infinity;
  for (let i = 0; i < dayStops.length; i++) {
    const s = dayStops[i];
    if (!Number.isFinite(s.latitude) || !Number.isFinite(s.longitude)) continue;
    const dist = haversineKm(s.latitude, s.longitude, newStopBase.latitude, newStopBase.longitude);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i + 1; // insert right after the nearest existing stop
    }
  }
  const result = [...dayStops];
  result.splice(bestIdx, 0, newStopBase);
  return result;
}

/** Removes stops matching a predicate from a day's list, returning { removed, remaining }. */
export function removeMatchingStops(dayStops, predicate) {
  const removed = dayStops.filter(predicate);
  const remaining = dayStops.filter((s) => !predicate(s));
  return { removed, remaining };
}

/** Loose case-insensitive substring/word match against a stop's name — used to resolve "the museum" / "marina beach" style references from chat. */
export function stopNameMatches(stop, query) {
  if (!query) return false;
  const a = stop.name.toLowerCase();
  const b = query.toLowerCase().trim();
  return a.includes(b) || b.includes(a);
}