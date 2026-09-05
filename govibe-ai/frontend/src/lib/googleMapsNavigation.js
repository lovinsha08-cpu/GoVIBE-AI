/**
 * Build a single Google Maps Directions URL from the actual ordered
 * itinerary stops.
 *
 * IMPORTANT: this is intentionally NOT a trip start → trip end route.
 * GoVIBE already shows the itinerary sequence and its own calculated travel
 * legs. The Maps hand-off should mirror those itinerary places so the
 * traveler can see the planned stops together in one map.
 *
 * For compatibility with Google Maps Directions URLs, the first and last
 * itinerary stops become origin/destination and the middle stops become
 * waypoints. Stops are never reordered here — GoVIBE's itinerary order is
 * the source of truth.
 */

function pointToParam(point) {
  const latitude = Number(point?.latitude);
  const longitude = Number(point?.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return `${latitude},${longitude}`;
  }
  if (point?.name) return String(point.name).trim();
  return null;
}

/**
 * @param {object} _journey - kept for backwards compatibility with existing callers.
 *                            Trip start/end are deliberately ignored.
 * @param {Array} stops     - itinerary stops in GoVIBE's planned order
 * @returns {string|null} a Google Maps Directions URL
 */
export function buildGoogleMapsNavigationUrl(_journey, stops = []) {
  const params = [...stops]
    .filter((stop) => stop?.category !== 'accommodation')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(pointToParam)
    .filter(Boolean);

  if (!params.length) return null;

  // A single itinerary stop is better represented by a place search.
  if (params.length === 1) {
    const search = new URLSearchParams({ api: '1', query: params[0] });
    return `https://www.google.com/maps/search/?${search.toString()}`;
  }

  const origin = params[0];
  const destination = params[params.length - 1];

  // Google Maps Directions URLs support up to 23 intermediate waypoints
  // (25 total points including origin and destination). Never silently add
  // the trip's start/end location to fill the route — the itinerary stops
  // themselves are the route.
  const waypoints = params.slice(1, -1).slice(0, 23);

  const search = new URLSearchParams({
    api: '1',
    origin,
    destination,
    travelmode: 'driving',
  });

  if (waypoints.length) {
    search.set('waypoints', waypoints.join('|'));
  }

  return `https://www.google.com/maps/dir/?${search.toString()}`;
}

const MOBILE_UA_RE = /iPhone|iPad|iPod|Android/i;

/**
 * Opens a Google Maps URL reliably on desktop and mobile.
 * Mobile uses same-tab navigation so the installed Google Maps app can
 * intercept the URL where supported.
 */
export function openInGoogleMaps(url) {
  if (!url) return false;
  const isMobile = typeof navigator !== 'undefined' && MOBILE_UA_RE.test(navigator.userAgent || '');
  if (isMobile) {
    window.location.href = url;
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  return true;
}

export function openGoogleMapsNavigation(journey, stops) {
  const url = buildGoogleMapsNavigationUrl(journey, stops);
  return openInGoogleMaps(url);
}
