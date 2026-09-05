import { routeDistance } from './geo.service.js';
import { classifyAttractionTier } from './attractionRanking.service.js';

/**
 * Orders itinerary stops using a route-aware optimization pass.
 *
 * The old implementation stopped at nearest-neighbour, which can produce a
 * locally short next leg while making the complete day's route unnecessarily
 * long. This implementation keeps the important-attraction seed, builds a
 * route-distance matrix, creates a strong nearest-neighbour initial route,
 * then improves it with deterministic 2-opt swaps. The first stop remains
 * the chosen Must Visit Landmark when one is available within 12km, so
 * importance is preserved while the rest of the day is optimized for total
 * travel distance.
 *
 * 2-opt is intentionally bounded for itinerary-sized inputs. This gives a
 * materially better route than greedy nearest-neighbour without introducing
 * an expensive exact TSP solver or an external optimization dependency.
 */
export async function orderSpotsRoute(spots, start, mode = 'cab') {
  const validSpots = (spots || []).filter((spot) =>
    Number.isFinite(Number(spot?.latitude)) && Number.isFinite(Number(spot?.longitude))
  );

  if (!validSpots.length) {
    return { ordered: [], totalDistanceKm: 0, totalDurationMinutes: 0 };
  }

  const origin = { lat: Number(start.lat), lng: Number(start.lng) };
  const n = validSpots.length;

  // Build the complete route-distance matrix once. This avoids repeatedly
  // calling the routing provider for the same pair during optimization.
  const matrix = Array.from({ length: n }, () => Array(n).fill(null));
  const originRoutes = Array(n).fill(null);

  await Promise.all(validSpots.map(async (spot, i) => {
    originRoutes[i] = await routeDistance(
      origin,
      { lat: Number(spot.latitude), lng: Number(spot.longitude) },
      mode
    );
  }));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const [forward, reverse] = await Promise.all([
        routeDistance(
          { lat: Number(validSpots[i].latitude), lng: Number(validSpots[i].longitude) },
          { lat: Number(validSpots[j].latitude), lng: Number(validSpots[j].longitude) },
          mode
        ),
        routeDistance(
          { lat: Number(validSpots[j].latitude), lng: Number(validSpots[j].longitude) },
          { lat: Number(validSpots[i].latitude), lng: Number(validSpots[i].longitude) },
          mode
        ),
      ]);
      matrix[i][j] = forward;
      matrix[j][i] = reverse;
    }
  }

  const seedIdx = pickSeedIndex(validSpots, origin);
  const unvisited = new Set(validSpots.map((_, i) => i));
  const route = [];

  // Preserve the destination's headline attraction as the first stop when
  // possible. If there is no nearby Must Visit Landmark, use the closest
  // actual routed stop from the origin.
  let firstIdx = seedIdx;
  if (firstIdx == null) {
    firstIdx = [...unvisited].sort((a, b) =>
      (originRoutes[a]?.distanceKm ?? Infinity) - (originRoutes[b]?.distanceKm ?? Infinity)
    )[0];
  }

  route.push(firstIdx);
  unvisited.delete(firstIdx);

  // Nearest-neighbour creates a good starting solution.
  while (unvisited.size) {
    const current = route[route.length - 1];
    let bestIdx = null;
    let bestDistance = Infinity;

    for (const candidate of unvisited) {
      const distance = matrix[current][candidate]?.distanceKm ?? Infinity;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIdx = candidate;
      }
    }

    if (bestIdx == null) break;
    route.push(bestIdx);
    unvisited.delete(bestIdx);
  }

  // Improve the complete route with 2-opt. Keep index 0 fixed so the
  // Must-Visit/closest seed is never displaced by an optimization swap.
  let improved = true;
  let passes = 0;
  const maxPasses = Math.max(2, Math.min(20, n * 2));

  while (improved && passes < maxPasses) {
    improved = false;
    passes += 1;

    for (let i = 1; i < route.length - 1; i++) {
      for (let k = i + 1; k < route.length; k++) {
        const beforeI = route[i - 1];
        const iNode = route[i];
        const kNode = route[k];
        const afterK = k + 1 < route.length ? route[k + 1] : null;

        const currentCost =
          getDistance(matrix, beforeI, iNode) +
          (afterK == null ? 0 : getDistance(matrix, kNode, afterK));
        const swappedCost =
          getDistance(matrix, beforeI, kNode) +
          (afterK == null ? 0 : getDistance(matrix, iNode, afterK));

        if (swappedCost + 0.001 < currentCost) {
          reverseSegment(route, i, k);
          improved = true;
        }
      }
    }
  }

  const ordered = [];
  let totalDistanceKm = 0;
  let totalDurationMinutes = 0;

  for (let position = 0; position < route.length; position++) {
    const idx = route[position];
    const result = position === 0
      ? originRoutes[idx]
      : matrix[route[position - 1]][idx];

    const safeResult = result || {
      distanceKm: haversineFallback(
        position === 0 ? origin.lat : validSpots[route[position - 1]].latitude,
        position === 0 ? origin.lng : validSpots[route[position - 1]].longitude,
        validSpots[idx].latitude,
        validSpots[idx].longitude
      ),
      durationMinutes: 0,
      source: 'fallback'
    };

    const distanceKm = Number(safeResult.distanceKm) || 0;
    const durationMinutes = Number(safeResult.durationMinutes) || 0;

    ordered.push({
      spot: validSpots[idx],
      distanceKmFromPrev: Math.round(distanceKm * 10) / 10,
      travelMinutesFromPrev: durationMinutes,
      routeSource: safeResult.source,
    });

    totalDistanceKm += distanceKm;
    totalDurationMinutes += durationMinutes;
  }

  return {
    ordered,
    totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
    totalDurationMinutes: Math.round(totalDurationMinutes),
  };
}

function getDistance(matrix, from, to) {
  return Number(matrix[from]?.[to]?.distanceKm) || 0;
}

function reverseSegment(route, start, end) {
  while (start < end) {
    [route[start], route[end]] = [route[end], route[start]];
    start += 1;
    end -= 1;
  }
}

/**
 * Picks the first stop: nearest Must Visit Landmark within 12km, otherwise
 * the nearest routed stop. This keeps the "major attractions first" rule
 * separate from the global optimization of subsequent stops.
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
  const dLat = toRad(Number(lat2) - Number(lat1));
  const dLng = toRad(Number(lng2) - Number(lng1));
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2))) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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

export function estimateCrowdLevel(arrivalHour, isWeekend) {
  let level = 'moderate';
  if (arrivalHour >= 10 && arrivalHour <= 13) level = isWeekend ? 'high' : 'moderate';
  else if (arrivalHour >= 16 && arrivalHour <= 18) level = isWeekend ? 'high' : 'moderate';
  else if (arrivalHour < 9 || arrivalHour > 19) level = 'low';
  return level;
}

export function weatherNotePlaceholder() {
  return 'Weather forecast not yet available — check closer to your travel date.';
}

const EARLY_BEST_CATEGORIES = new Set(['heritage_historical', 'nature_scenic', 'sports_adventure', 'religious_spiritual', 'wildlife']);

export function suggestBestVisitTime(category, isWeekend) {
  if (EARLY_BEST_CATEGORIES.has(category)) {
    return {
      best_time: 'Right at opening, or after 4 PM',
      avoid_time: isWeekend ? '11 AM – 4 PM (weekend peak)' : '12 PM – 3 PM (tour-group/lunch peak)',
      tip: 'Arriving within the first hour of opening beats tour buses and gives softer light for photos.',
    };
  }
  if (category === 'food_dining') {
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

export function suggestPublicTransport(distanceKm) {
  if (distanceKm <= 1.2) {
    return { mode: 'walk', note: 'Close enough to walk — skip the fare.' };
  }
  if (distanceKm <= 5) {
    return { mode: 'auto-rickshaw / shared auto', note: 'A shared auto or app-auto may be economical for this distance.' };
  }
  if (distanceKm <= 12) {
    return { mode: 'city bus / metro', note: 'Check whether a verified metro or city bus service covers this route.' };
  }
  return { mode: 'metro + cab combo', note: 'Check verified rail/transit coverage for the bulk of the distance, then use a short last-mile connection if available.' };
}
