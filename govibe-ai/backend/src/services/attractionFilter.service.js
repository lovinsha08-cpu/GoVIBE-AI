/**
 * Genuine-tourist-attraction filtering.
 *
 * Spot data comes from several sources (Supabase cache, Google Places,
 * OSM/Overpass, the bundled sample set) and every one of them can leak
 * through non-tourism places — a "tourist_attraction" Google Places result
 * that's actually a government complex, an OSM node tagged loosely, a
 * stale cached row, etc. Rather than trusting any single source's tagging,
 * every spot is re-validated here — by category *and* by name — right
 * before it's allowed into candidate selection, and again as a last check
 * before an itinerary is finalized.
 */

// Categories the rest of the app already uses (spot.category). Anything
// outside this allow-list is dropped before scoring/selection ever sees it.
export const ALLOWED_SPOT_CATEGORIES = new Set([
  'religious_spiritual',
  'heritage_historical',
  'nature_scenic',
  'wildlife',
  'entertainment_recreation',
  'arts_culture',
  'science_learning',
  'shopping',
  'food_dining',
  'photography_landmarks',
  'sports_adventure',
  'wellness_leisure',
  'nightlife',
  'stay', // hotels/homestays — needed for accommodation, not shown as a "stop"
]);

// Name substrings that flag a place as administrative/civic/utility rather
// than a travel destination, regardless of which category it was tagged
// under. Matched case-insensitively against the spot name (and OSM/Google
// "types"/tags where available). This is the safety net that catches the
// "MLA office got tagged as tourism=attraction" class of bug.
const EXCLUDED_NAME_PATTERNS = [
  /\bmla\b/i, /\bmp\b.*\boffice\b/i, /\bmp office\b/i,
  /collector'?ate/i, /\btehsil\b/i, /\bpanchayat\b/i,
  /municipal|nagar\s?nigam|nagar\s?palika|corporation office/i,
  /\bgovernment\b|\bgovt\.?\b/i, /secretariat/i, /\bassembly\b/i,
  /\bpolice station\b|\bpolice chowki\b|police\s?outpost/i,
  /\bfire station\b/i,
  /\bhospital\b|\bclinic\b|\bdispensary\b|primary health cent(re|er)/i,
  /\bschool\b|\bcollege\b|\buniversity\b|\bvidyalaya\b|\bpolytechnic\b/i,
  /\bbank\b|\batm\b/i,
  /\bwarehouse\b|\bgodown\b/i,
  /\bindustrial (area|estate)\b|\bfactory\b/i,
  /\btaluk(a)? office\b|\bblock office\b|\bdistrict office\b/i,
  /\butility office\b|\belectricity board\b|\bwater board\b|\bwater works\b/i,
  /\bpetrol pump\b|\bfuel station\b|\bgas station\b/i,
  /\bbus depot\b|\bbus stand\b(?!.*market)|\bbus stop\b|\bbus terminus\b|\bbus terminal\b/i,
  /\brailway (colony|office|quarters)\b/i,
  // Railway/train stations are excluded as sightseeing candidates by
  // default — a station only belongs in an itinerary as the traveler's
  // explicit start/end location, which is handled separately from this
  // candidate pool, never as a "stop" in its own right.
  /\brailway station\b|\btrain station\b|\brail(way)? terminus\b/i,
  /\bresidency\b|\bquarters\b|\bapartments?\b|\bhousing (society|colony)\b/i,
  /\bresidential (area|colony|complex|layout)\b/i,
  /\bcourt\b|\bcourthouse\b|\bjail\b|\bprison\b/i,
  // Generic day-to-day shops (as opposed to a named tourist bazaar/market),
  // which shouldn't appear as sightseeing stops unless the traveler
  // explicitly searched for shopping.
  /\bkirana( store)?\b|\bgeneral store\b|\bgrocery store\b|\bconvenience store\b|\bmedical store\b|\bstationery shop\b/i,

  // Functional/wholesale markets — these get tagged the same generic way
  // as tourist bazaars in OSM (amenity=marketplace) and Google Places, but
  // are day-to-day trading places for locals, not travel destinations.
  // Matched separately from the broad market/bazaar terms so a legitimate
  // tourist market (e.g. "Bapu Bazaar", "Devaraja Market") isn't caught.
  /\bfish market\b/i, /\bmeat market\b/i, /\bmutton market\b/i, /\bpoultry market\b/i,
  /\bvegetable market\b/i, /\bveg(\.|etable)? market\b/i, /\bwholesale market\b/i,
  /\bgrain market\b/i, /\bgrain mandi\b/i, /\bmandi\b/i, /\bsabzi\s?mandi\b/i,
  /\bwet market\b/i, /\bfruit\s?(&|and)?\s?veg(etable)? market\b/i,
];

// Google Places "types" values that mark a result as non-tourism even if
// it was returned under a tourism-flavored query type.
const EXCLUDED_GOOGLE_TYPES = new Set([
  'local_government_office', 'city_hall', 'courthouse', 'police',
  'fire_station', 'hospital', 'doctor', 'school', 'primary_school',
  'secondary_school', 'university', 'bank', 'atm', 'post_office',
  'embassy', 'storage', 'moving_company', 'car_repair', 'car_dealer',
  'train_station', 'transit_station', 'subway_station', 'bus_station',
  'light_rail_station',
]);

/** True if a spot is a genuine tourist/travel-related place worth recommending. */
export function isGenuineTouristSpot(spot) {
  if (!spot?.name) return false;

  if (!ALLOWED_SPOT_CATEGORIES.has(spot.category)) return false;

  if (EXCLUDED_NAME_PATTERNS.some((re) => re.test(spot.name))) return false;
  if (spot.description && EXCLUDED_NAME_PATTERNS.some((re) => re.test(spot.description))) return false;

  const googleTypes = spot.google_types || spot.types;
  if (Array.isArray(googleTypes) && googleTypes.some((t) => EXCLUDED_GOOGLE_TYPES.has(t))) {
    return false;
  }

  return true;
}

/** Filters a list of candidate spots down to genuine tourist/travel destinations. */
export function filterGenuineTouristSpots(spots = []) {
  return spots.filter(isGenuineTouristSpot);
}

/**
 * Final validation for an already-built itinerary stop (heuristic or
 * Gemini path). A "stop" carries name/category (and sometimes only a
 * loosely-matched name from the AI), so it's checked the same way a raw
 * candidate spot is.
 */
export function isValidItineraryStop(stop) {
  if (!stop?.name) return false;
  // A stop with no real coordinates can't be placed on the map or used to
  // compute route distance/travel time — this is what used to let a
  // Gemini-invented/unmatched place name slip through as a "valid" stop
  // and silently vanish from the itinerary map (only the stops that
  // happened to match a dataset entry ever had lat/lng, so most of the
  // map went blank while the timeline still listed every stop).
  if (!Number.isFinite(stop.latitude) || !Number.isFinite(stop.longitude)) return false;
  if (EXCLUDED_NAME_PATTERNS.some((re) => re.test(stop.name))) return false;
  // Stops from the Gemini path may carry a free-text category the model
  // invented (e.g. "Historical Site") rather than one of our internal
  // slugs — only reject on category when it's one of ours and disallowed.
  if (stop.category && ALLOWED_SPOT_CATEGORIES.has(stop.category) === false && KNOWN_INTERNAL_CATEGORIES.has(stop.category)) {
    return false;
  }
  return true;
}

const KNOWN_INTERNAL_CATEGORIES = new Set([
  ...ALLOWED_SPOT_CATEGORIES,
  'government', 'administrative', 'office', 'utility',
]);