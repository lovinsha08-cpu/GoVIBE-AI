/**
 * Haversine distance between two lat/lng points, in kilometers.
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * Rough travel time estimate by mode, used when OSRM isn't reachable.
 * Speeds are conservative averages for Indian road/rail conditions.
 */
const AVG_SPEED_KMH = {
  walk: 4,
  bike: 15,
  cab: 28,
  car: 30,
  bus: 22,
  train: 45,
  flight: 500,
};

export function estimateTravelMinutes(distanceKm, mode = 'cab') {
  const speed = AVG_SPEED_KMH[mode] || AVG_SPEED_KMH.cab;
  const hours = distanceKm / speed;
  // add fixed overhead (boarding/parking/etc.)
  const overheadMinutes = mode === 'flight' ? 90 : mode === 'train' ? 20 : 5;
  return Math.round(hours * 60 + overheadMinutes);
}

/**
 * Try OSRM's public routing API for a more accurate distance/duration.
 * Falls back to haversine + heuristic speed if OSRM is unreachable or errors.
 */
export async function routeDistance(from, to, mode = 'cab') {
  try {
    const profile = mode === 'walk' ? 'foot' : mode === 'bike' ? 'bike' : 'driving';
    const url = `https://router.project-osrm.org/route/v1/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('OSRM request failed');
    const data = await res.json();
    const route = data.routes?.[0];
    if (!route) throw new Error('No route found');
    return {
      distanceKm: route.distance / 1000,
      durationMinutes: Math.round(route.duration / 60),
      source: 'osrm',
    };
  } catch {
    const distanceKm = haversineKm(from.lat, from.lng, to.lat, to.lng);
    return {
      distanceKm,
      durationMinutes: estimateTravelMinutes(distanceKm, mode),
      source: 'haversine_estimate',
    };
  }
}
