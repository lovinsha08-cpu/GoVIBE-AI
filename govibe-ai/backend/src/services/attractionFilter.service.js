/**
 * Genuine-tourist-attraction filtering.
 *
 * Spot data comes from Supabase, Google Places, OSM/Overpass and bundled
 * fallback data. This module is the final gate before candidate selection.
 */

export const ALLOWED_SPOT_CATEGORIES = new Set([
  'religious_spiritual','heritage_historical','nature_scenic','wildlife',
  'entertainment_recreation','arts_culture','science_learning','shopping',
  'food_dining','photography_landmarks','sports_adventure','wellness_leisure',
  'nightlife','stay',
]);

const EXCLUDED_NAME_PATTERNS = [
  /\bmla\b/i, /\bmp\b.*\boffice\b/i, /\bmp office\b/i, /collector'?ate/i,
  /\btehsil\b/i, /\bpanchayat\b/i, /municipal|nagar\s?nigam|nagar\s?palika|corporation office/i,
  /\bgovernment\b|\bgovt\.?\b/i, /secretariat/i, /\bassembly\b/i,
  /\bpolice station\b|\bpolice chowki\b|police\s?outpost/i, /\bfire station\b/i,
  /\bhospital\b|\bclinic\b|\bdispensary\b|primary health cent(re|er)/i,
  /\bschool\b|\bcollege\b|\buniversity\b|\bvidyalaya\b|\bpolytechnic\b/i,
  /\bbank\b|\batm\b/i, /\bwarehouse\b|\bgodown\b/i,
  /\bindustrial (area|estate)\b|\bfactory\b/i, /\btaluk(a)? office\b|\bblock office\b|\bdistrict office\b/i,
  /\butility office\b|\belectricity board\b|\bwater board\b|\bwater works\b/i,
  /\bpetrol pump\b|\bfuel station\b|\bgas station\b/i,
  /\bbus depot\b|\bbus stand\b(?!.*market)|\bbus stop\b|\bbus terminus\b|\bbus terminal\b/i,
  /\brailway (colony|office|quarters)\b/i,
  /\brailway station\b|\btrain station\b|\brail(way)? terminus\b/i,
  /\bresidency\b|\bquarters\b|\bapartments?\b|\bhousing (society|colony)\b/i,
  /\bresidential (area|colony|complex|layout)\b/i,
  /\bcourt\b|\bcourthouse\b|\bjail\b|\bprison\b/i,
  /\bkirana( store)?\b|\bgeneral store\b|\bgrocery store\b|\bconvenience store\b|\bmedical store\b|\bstationery shop\b/i,
  /\bfish market\b|\bmeat market\b|\bmutton market\b|\bpoultry market\b/i,
  /\bvegetable market\b|\bveg(\.|etable)? market\b|\bwholesale market\b/i,
  /\bgrain market\b|\bgrain mandi\b|\bmandi\b|\bsabzi\s?mandi\b/i,
  /\bwet market\b|\bfruit\s?(&|and)?\s?veg(etable)? market\b/i,
];

const EXCLUDED_GOOGLE_TYPES = new Set([
  'local_government_office','city_hall','courthouse','police','fire_station','hospital',
  'doctor','school','primary_school','secondary_school','university','bank','atm',
  'post_office','embassy','storage','moving_company','car_repair','car_dealer',
  'train_station','transit_station','subway_station','bus_station','light_rail_station',
]);

export function isGenuineTouristSpot(spot) {
  if (!spot?.name || !ALLOWED_SPOT_CATEGORIES.has(spot.category)) return false;
  if (EXCLUDED_NAME_PATTERNS.some((re) => re.test(spot.name))) return false;
  if (spot.description && EXCLUDED_NAME_PATTERNS.some((re) => re.test(spot.description))) return false;
  const googleTypes = spot.google_types || spot.types;
  if (Array.isArray(googleTypes) && googleTypes.some((t) => EXCLUDED_GOOGLE_TYPES.has(t))) return false;
  return true;
}

function normalizedName(value) {
  return String(value || '').toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,' ').trim();
}

function hasCoordinates(spot) {
  return Number.isFinite(Number(spot?.latitude)) && Number.isFinite(Number(spot?.longitude));
}

/**
 * Filters candidates and removes duplicate records that represent the same
 * place under different IDs/sources. Google Place ID is preferred; when it
 * is unavailable, normalized name + proximity is used. This prevents the
 * same attraction from consuming multiple itinerary slots.
 */
export function filterGenuineTouristSpots(spots = []) {
  const accepted = [];
  const googleIds = new Set();

  for (const raw of spots) {
    const spot = { ...raw };
    if (!isGenuineTouristSpot(spot)) continue;
    if (!hasCoordinates(spot)) continue;

    const googleId = spot.google_place_id || spot.place_id || spot._google?.id || null;
    if (googleId && googleIds.has(googleId)) continue;
    if (googleId) googleIds.add(googleId);

    const name = normalizedName(spot.name);
    const duplicate = accepted.some((existing) => {
      if (googleId && (existing.google_place_id || existing.place_id || existing._google?.id) === googleId) return true;
      if (!name || normalizedName(existing.name) !== name) return false;
      const distanceKm = haversineKmLocal(existing.latitude, existing.longitude, spot.latitude, spot.longitude);
      return distanceKm <= 0.15;
    });
    if (duplicate) continue;

    accepted.push(spot);
  }
  return accepted;
}

function haversineKmLocal(lat1,lng1,lat2,lng2){
  const toRad=(d)=>d*Math.PI/180;
  const a=Math.sin(toRad(lat2-lat1)/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(toRad(lng2-lng1)/2)**2;
  return 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(Math.max(0,1-a)));
}

export function isValidItineraryStop(stop) {
  if (!stop?.name) return false;
  if (!hasCoordinates(stop)) return false;
  if (EXCLUDED_NAME_PATTERNS.some((re) => re.test(stop.name))) return false;
  if (stop.category && ALLOWED_SPOT_CATEGORIES.has(stop.category) === false && KNOWN_INTERNAL_CATEGORIES.has(stop.category)) return false;
  return true;
}

const KNOWN_INTERNAL_CATEGORIES = new Set([
  ...ALLOWED_SPOT_CATEGORIES,'government','administrative','office','utility',
]);
