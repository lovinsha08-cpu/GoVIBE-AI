import { routeDistance } from './geo.service.js';
import { classifyAttractionTier } from './attractionRanking.service.js';

/**
 * Orders a list of spots into a route starting from `start`, using a greedy
 * nearest-neighbor heuristic. Not optimal TSP, but fast and good enough for
 * <15 stops — full optimal solving isn't worth the latency here.
 *
 * Step 5 (Route Optimization): rather than pure nearest-neighbor from the
 * very first pick, the route is seeded with the most important nearby
 * landmark (a Must Visit Landmark if one is within a reasonable first hop,
 * otherwise the single closest spot) so the day reads "arrival → iconic
 * attraction → nearby → nearby → ..." like a local guide would plan it,
 * not just "whatever happens to be nearest first."
 */
export async function orderSpotsRoute(spots, start, mode = 'cab') {
  const remaining = [...spots];
  const ordered = [];
  let current = { lat: start.lat, lng: start.lng };
  let totalDistanceKm = 0;
  let totalDurationMinutes = 0;

  const seedIdx = pickSeedIndex(remaining, current);

  while (remaining.length) {
    let bestIdx = 0;
    let bestResult = null;
    let bestDistance = Infinity;

    if (ordered.length === 0 && seedIdx != null) {
      bestIdx = seedIdx;
      bestResult = await routeDistance(
        current,
        { lat: remaining[seedIdx].latitude, lng: remaining[seedIdx].longitude },
        mode
      );
    } else {
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const result = await routeDistance(
          current,
          { lat: candidate.latitude, lng: candidate.longitude },
          mode
        );
        if (result.distanceKm < bestDistance) {
          bestDistance = result.distanceKm;
          bestIdx = i;
          bestResult = result;
        }
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0];
    ordered.push({
      spot: chosen,
      distanceKmFromPrev: Math.round(bestResult.distanceKm * 10) / 10,
      travelMinutesFromPrev: bestResult.durationMinutes,
      routeSource: bestResult.source,
    });
    totalDistanceKm += bestResult.distanceKm;
    totalDurationMinutes += bestResult.durationMinutes;
    current = { lat: chosen.latitude, lng: chosen.longitude };
  }

  return {
    ordered,
    totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
    totalDurationMinutes,
  };
}

/**
 * Picks the seed (first) stop for a route: prefers a Must Visit Landmark
 * within a reasonable first hop (<= 12km of the start point) so the day
 * opens on the destination's headline attraction rather than whatever
 * happens to be a few hundred meters closer. Falls back to `null` (plain
 * nearest-neighbor) if no landmark-tier spot is close enough to open with.
 */
function pickSeedIndex(spots, start) {
  let bestIdx = null;
  let bestDist = Infinity;
  for (let i = 0; i < spots.length; i++) {
    if (classifyAttractionTier(spots[i]) !== 'must_visit') continue;
    const dist = haversineFallback(start.lat, start.lng, spots[i].latitude, spots[i].longitude);
    if (dist <= 12 && dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function haversineFallback(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Recommends the realistic transport mode for a single leg, by distance
 * band (Step 6), rather than applying one fixed mode to every leg of the
 * trip regardless of how short the hop is:
 *
 *   < 500m        -> walk
 *   500m - 3km    -> walk (short end) or auto
 *   3km - 15km    -> auto / cab
 *   15km+         -> bus / train / cab
 *
 * `allowedModes` (from the traveler's transport preference) constrains the
 * choice: if their preferred mode(s) don't fit the distance band at all
 * (e.g. they only picked "cab" but the hop is 200m), the function still
 * recommends walking with a note, since suggesting a cab for a 200m hop is
 * exactly the "unnecessary vehicle for short distance" bug being fixed —
 * but respects an explicit non-walking preference for the 500m-3km band,
 * where either is genuinely reasonable.
 */
export function recommendTransportMode(distanceKm, allowedModes = [], fallbackMode = 'cab') {
  const allowed = new Set(allowedModes.filter(Boolean));
  const pick = (candidates, note) => {
    const match = candidates.find((m) => allowed.has(m));
    return { mode: match || candidates[0], note, matchedPreference: Boolean(match) };
  };

  if (distanceKm < 0.5) {
    return { ...pick(['walk'], 'Under 500m — walking is faster than waiting for any vehicle.') };
  }
  if (distanceKm < 3) {
    return { ...pick(['walk', 'auto', 'cab'], 'Short hop — walk if comfortable, or a quick auto/cab.') };
  }
  if (distanceKm < 15) {
    return { ...pick(['auto', 'cab', 'car'], 'Mid-range distance — auto-rickshaw or cab is the practical choice.') };
  }
  return { ...pick(['bus', 'train', 'cab', 'car'], 'Longer distance — bus, train, or a cab depending on availability.') };
}

/**
 * Heuristic crowd level by time of day + day of week, since we don't have
 * a live crowd data source yet. Documented as an estimate, not measured.
 */
export function estimateCrowdLevel(arrivalHour, isWeekend) {
  let level = 'moderate';
  if (arrivalHour >= 10 && arrivalHour <= 13) level = isWeekend ? 'high' : 'moderate';
  else if (arrivalHour >= 16 && arrivalHour <= 18) level = isWeekend ? 'high' : 'moderate';
  else if (arrivalHour < 9 || arrivalHour > 19) level = 'low';
  return level;
}

/** Placeholder weather note until a live weather API call is wired in. */
export function weatherNotePlaceholder() {
  return 'Weather forecast not yet available — check closer to your travel date.';
}

/**
 * Best-time-to-visit + crowd-avoidance guidance per category, so travelers
 * know when to show up and when to stay away — not just what the crowd
 * level will be at their scheduled arrival time.
 */
const EARLY_BEST_CATEGORIES = new Set(['heritage', 'nature', 'adventure']);

export function suggestBestVisitTime(category, isWeekend) {
  if (EARLY_BEST_CATEGORIES.has(category)) {
    return {
      best_time: 'Right at opening, or after 4 PM',
      avoid_time: isWeekend ? '11 AM – 4 PM (weekend peak)' : '12 PM – 3 PM (tour-group/lunch peak)',
      tip: 'Arriving within the first hour of opening beats tour buses and gives softer light for photos.',
    };
  }
  if (category === 'food') {
    return {
      best_time: 'Off-peak hours, roughly 3 – 6 PM',
      avoid_time: '1 – 2 PM and 8 – 9 PM (peak meal rush)',
      tip: 'Walk-in wait times are shortest between the lunch and dinner rushes.',
    };
  }
  if (category === 'stay') {
    return { best_time: 'Standard check-in window', avoid_time: null, tip: 'Confirm check-in time directly with the property.' };
  }
  return {
    best_time: 'Late morning to early afternoon',
    avoid_time: isWeekend ? 'Weekend afternoons tend to be busiest' : null,
    tip: 'Weekdays are generally quieter than weekends at most attractions.',
  };
}

/**
 * Suggests a public transport option for a leg, as an alternative to the
 * trip's chosen primary mode — useful for budget travelers or as a fallback
 * when cabs are scarce. Heuristic based on distance, since a live transit
 * API (GTFS) isn't wired up for most Indian cities.
 */
export function suggestPublicTransport(distanceKm) {
  if (distanceKm <= 1.2) {
    return { mode: 'walk', note: 'Close enough to walk — skip the fare.' };
  }
  if (distanceKm <= 5) {
    return { mode: 'auto-rickshaw / shared auto', note: 'A shared auto or app-auto is usually cheapest for this distance.' };
  }
  if (distanceKm <= 12) {
    return { mode: 'city bus / metro', note: 'Check if a metro or city bus line covers this route — often 70–80% cheaper than a cab.' };
  }
  return { mode: 'metro + cab combo', note: 'Consider metro/rail for the bulk of the distance, then a short cab for the last mile.' };
}