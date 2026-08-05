/**
 * Builds a Google Maps "Navigate" URL for a full itinerary — start
 * location, every stop in AI-generated order, back to the end location
 * (usually the same hotel) — so tapping one button hands the traveler
 * off to turn-by-turn navigation for the whole day/trip.
 *
 * Coordinates are preferred over place names wherever available, since
 * they're unambiguous; a place name is only used as a fallback for a
 * point that has no lat/lng.
 *
 * Never reorders anything — the array is walked in exactly the order
 * it's given (journey.start, then stops in `order`, then journey.end).
 */

// Raw (unencoded) representation of a point — either "lat,lng" or a place
// name. Encoding is left to URLSearchParams so it always matches what the
// Google Maps URL API actually expects for query values.
function pointToParam(point) {
  const hasCoords = Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
  if (hasCoords) return `${point.latitude},${point.longitude}`;
  if (point.name) return point.name.trim();
  return null;
}

/**
 * @param {object} journey - the itinerary's journey object ({ start, end })
 * @param {Array}  stops   - the itinerary's stops array (each with name/latitude/longitude/order)
 * @returns {string|null} a Google Maps URL, or null if there's nothing navigable
 */
export function buildGoogleMapsNavigationUrl(journey, stops = []) {
  const points = [];

  if (journey?.start?.location || (journey?.start?.latitude != null && journey?.start?.longitude != null)) {
    points.push({
      name: journey.start.location,
      latitude: journey.start.latitude,
      longitude: journey.start.longitude,
    });
  }

  [...stops]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .forEach((s) => {
      points.push({ name: s.name, latitude: s.latitude, longitude: s.longitude });
    });

  if (journey?.end?.location || (journey?.end?.latitude != null && journey?.end?.longitude != null)) {
    points.push({
      name: journey.end.location,
      latitude: journey.end.latitude,
      longitude: journey.end.longitude,
    });
  }

  const params = points.map(pointToParam).filter(Boolean);
  if (!params.length) return null;

  // A single point isn't a "route" — just center the map on it.
  if (params.length === 1) {
    const search = new URLSearchParams({ api: '1', query: params[0] });
    return `https://www.google.com/maps/search/?${search.toString()}`;
  }

  // Google's documented Directions URL API (query-string based) — far more
  // reliable than the old undocumented /maps/dir/seg1/seg2/... path format,
  // which can render a blank results page when segments mix coordinates
  // and place names. Middle points become up to 23 waypoints (Google's cap
  // for the web app is 25 total points including origin/destination).
  const origin = params[0];
  const destination = params[params.length - 1];
  const waypoints = params.slice(1, -1).slice(0, 23);

  const search = new URLSearchParams({
    api: '1',
    origin,
    destination,
    travelmode: 'driving',
  });
  if (waypoints.length) search.set('waypoints', waypoints.join('|'));

  return `https://www.google.com/maps/dir/?${search.toString()}`;
}

const MOBILE_UA_RE = /iPhone|iPad|iPod|Android/i;

/**
 * Opens any google.com/maps URL reliably across desktop and mobile.
 *
 * The blank-page bug: `window.open(url, '_blank')` creates a brand-new
 * browsing context. On desktop that's a harmless new tab, but inside the
 * mobile app's webview (and most in-app/embedded browsers) a fresh
 * browsing context can't be rendered at all — the user gets a blank
 * page instead of Google Maps. It also defeats the point of the link,
 * since iOS Universal Links / Android App Links only reliably intercept
 * and hand off to the *installed* Google Maps app when the navigation
 * happens in the *current* browsing context (a same-tab redirect), not
 * when it's fired via `window.open`.
 *
 * Fix: on mobile, navigate in place (`window.location.href`) so the OS
 * can intercept and deep-link into the native app, falling back to the
 * mobile web experience automatically if the app isn't installed. On
 * desktop (no native app to deep-link to) a new tab is still the better
 * UX, so that behavior is kept there.
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

/**
 * Opens the full-itinerary navigation URL. See openInGoogleMaps for why
 * this no longer uses window.open unconditionally.
 */
export function openGoogleMapsNavigation(journey, stops) {
  const url = buildGoogleMapsNavigationUrl(journey, stops);
  return openInGoogleMaps(url);
}