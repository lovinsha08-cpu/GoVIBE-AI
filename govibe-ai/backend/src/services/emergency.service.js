import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { haversineKm } from './geo.service.js';
import { fetchEmergencyServicesFromGoogle } from './googlePlaces.service.js';

/**
 * Emergency-contacts support for the itinerary. Three free, keyless sources:
 *  1. Official national emergency helpline numbers (static, curated from
 *     each country's public emergency-services listings).
 *  2. Nearest real hospitals/police stations/pharmacies around the
 *     destination, pulled live from OpenStreetMap via the Overpass API
 *     (free, no key, no rate-limit auth required for light use).
 *  3. For Chennai specifically: a curated, government-sourced list of ESI
 *     (Employees' State Insurance) Dispensaries and Empanelled Hospitals,
 *     bundled locally as static data so it's always available even if the
 *     live providers above are down or return nothing for a given spot.
 *
 * Never blocks itinerary generation — falls back to numbers-only if
 * Overpass is unreachable.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Static ESI Chennai dataset (ESI Dispensaries + Empanelled Hospitals),
// sourced from the official ESI Chennai facility register. No lat/lng is
// published for these entries, so they're surfaced without distance_km and
// only when the caller's location falls inside the Chennai metro area.
let esiChennaiData = { esi_dispensaries: [], empanelled_hospitals: [] };
try {
  esiChennaiData = JSON.parse(
    readFileSync(path.join(__dirname, '../data/esiChennaiFacilities.json'), 'utf-8')
  );
} catch {
  // Missing/unreadable dataset should never break emergency lookups.
}

// Rough bounding box covering Chennai city + its ESI-served suburbs
// (Ambattur, Avadi, Tambaram, Thiruvottiyur, etc.).
const CHENNAI_BOUNDS = { minLat: 12.80, maxLat: 13.30, minLng: 79.95, maxLng: 80.35 };

function isWithinChennai(lat, lng) {
  if (lat == null || lng == null) return false;
  return (
    lat >= CHENNAI_BOUNDS.minLat && lat <= CHENNAI_BOUNDS.maxLat &&
    lng >= CHENNAI_BOUNDS.minLng && lng <= CHENNAI_BOUNDS.maxLng
  );
}

function mapsSearchUrlForAddress(address) {
  if (!address) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

// Scores an entry higher when its place/zone/address text overlaps with the
// traveler's current area (trip destination or itinerary-stop name). With no
// hint, entries keep their original register order.
function areaMatchScore(text, areaHint) {
  if (!areaHint) return 0;
  const hintWords = areaHint.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (!hintWords.length) return 0;
  const haystack = (text || '').toLowerCase();
  return hintWords.reduce((score, w) => (haystack.includes(w) ? score + 1 : score), 0);
}

/**
 * Builds the Chennai-only ESI supplement in the same shape as the live
 * hospitals/clinics categories, so it can be concatenated straight onto
 * either provider's results. Returns empty arrays outside Chennai.
 */
function getEsiChennaiSupplement({ lat, lng, areaHint, limit = 5 }) {
  if (!isWithinChennai(lat, lng)) return { hospitals: [], clinics: [] };

  const clinics = [...esiChennaiData.esi_dispensaries]
    .sort((a, b) => areaMatchScore(`${b.place} ${b.address}`, areaHint) - areaMatchScore(`${a.place} ${a.address}`, areaHint))
    .slice(0, limit)
    .map((d) => ({
      name: `ESI Dispensary — ${d.place}`,
      address: d.address,
      phone: d.phone || null,
      distance_km: null,
      latitude: null,
      longitude: null,
      maps_url: mapsSearchUrlForAddress(d.address),
      source: 'esi_chennai_register',
    }));

  const hospitals = [...esiChennaiData.empanelled_hospitals]
    .sort((a, b) => areaMatchScore(`${b.zone} ${b.name_address}`, areaHint) - areaMatchScore(`${a.zone} ${a.name_address}`, areaHint))
    .slice(0, limit)
    .map((h) => ({
      name: h.name_address,
      address: `${(h.zone || '').replace(/^\d+-/, '')} zone, Chennai${h.pincode ? ` - ${h.pincode}` : ''}`,
      phone: null,
      distance_km: null,
      latitude: null,
      longitude: null,
      maps_url: mapsSearchUrlForAddress(h.name_address),
      source: 'esi_chennai_register',
    }));

  return { hospitals, clinics };
}

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// Official national emergency numbers. India is GoVIBE's primary market
// today; a couple of others are included so this scales as-is.
const NATIONAL_EMERGENCY_NUMBERS = {
  IN: [
    { label: 'All-in-one emergency (police/fire/medical)', number: '112' },
    { label: 'Police', number: '100' },
    { label: 'Fire', number: '101' },
    { label: 'Ambulance', number: '102' },
    { label: 'Tourist helpline', number: '1363' },
    { label: 'Women helpline', number: '1091' },
    { label: 'Child helpline', number: '1098' },
  ],
  US: [
    { label: 'All-in-one emergency', number: '911' },
    { label: 'Poison control', number: '1-800-222-1222' },
  ],
  GB: [
    { label: 'All-in-one emergency', number: '999' },
    { label: 'Non-emergency police/medical', number: '111' },
  ],
  default: [
    { label: 'All-in-one emergency (EU/international GSM standard)', number: '112' },
  ],
};

/**
 * Builds the emergency-contacts block for a trip: national numbers +
 * nearest real facilities around the destination coordinates.
 */
export async function getEmergencyContacts({ lat, lng, countryCode = 'IN', areaHint } = {}) {
  const nationalNumbers = NATIONAL_EMERGENCY_NUMBERS[countryCode] || NATIONAL_EMERGENCY_NUMBERS.default;
  const nearbyFacilities = await findNearbyFacilities({ lat, lng });

  const esiSupplement = getEsiChennaiSupplement({ lat, lng, areaHint, limit: 3 });
  const esiFacilities = [...esiSupplement.hospitals, ...esiSupplement.clinics].map((f) => ({
    name: f.name,
    type: f.name.startsWith('ESI Dispensary') ? 'clinic' : 'hospital',
    phone: f.phone,
    latitude: null,
    longitude: null,
    distance_km: null,
  }));

  const allFacilities = [...nearbyFacilities, ...esiFacilities];

  return {
    national_numbers: nationalNumbers,
    nearby_facilities: allFacilities,
    source: esiFacilities.length
      ? (nearbyFacilities.length ? 'openstreetmap-overpass+esi_chennai_register' : 'esi_chennai_register')
      : (nearbyFacilities.length ? 'openstreetmap-overpass' : 'national-numbers-only'),
  };
}

async function findNearbyFacilities({ lat, lng }) {
  if (lat == null || lng == null) return [];

  try {
    const radiusMeters = 4000;
    const query = `[out:json][timeout:6];(
      node["amenity"="hospital"](around:${radiusMeters},${lat},${lng});
      node["amenity"="clinic"](around:${radiusMeters},${lat},${lng});
      node["amenity"="police"](around:${radiusMeters},${lat},${lng});
      node["amenity"="pharmacy"](around:${radiusMeters},${lat},${lng});
    );out center 15;`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`);

    const data = await res.json();
    const facilities = (data.elements || [])
      .map((el) => {
        const flat = el.lat ?? el.center?.lat;
        const flng = el.lon ?? el.center?.lon;
        if (flat == null || flng == null) return null;
        return {
          name: el.tags?.name || defaultNameFor(el.tags?.amenity),
          type: el.tags?.amenity || 'facility',
          phone: el.tags?.phone || el.tags?.['contact:phone'] || null,
          latitude: flat,
          longitude: flng,
          distance_km: Math.round(haversineKm(lat, lng, flat, flng) * 10) / 10,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, 8);

    return facilities;
  } catch {
    return []; // Overpass can be slow/overloaded — never break the trip plan over it
  }
}

// ============================================================
// Categorized live lookup — powers the on-demand "Emergency Services"
// button (as opposed to getEmergencyContacts above, which runs once at
// itinerary-generation time and stores a lighter snapshot). Tries Google
// Places first (richer data: phone, open-now, rating); if no Google key
// is configured, falls back to this categorized Overpass query so the
// feature still works without a paid key, just with fewer details per
// facility.
// ============================================================

const OVERPASS_CATEGORY_TAGS = {
  hospitals: [['amenity', 'hospital']],
  clinics: [['amenity', 'clinic']],
  police: [['amenity', 'police']],
  fire: [['amenity', 'fire_station']],
  medical_stores: [['amenity', 'pharmacy']],
  // OSM has no reliable ambulance-depot tag; emergency=ambulance_station
  // exists but is sparsely mapped, so this category is usually empty on
  // the OSM fallback path — Google Places (text search) covers it instead.
  ambulance: [['emergency', 'ambulance_station']],
};

async function fetchOverpassCategory(categoryKey, lat, lng, radiusMeters) {
  const tags = OVERPASS_CATEGORY_TAGS[categoryKey];
  if (!tags) return [];
  const clauses = tags.map(([k, v]) => `node["${k}"="${v}"](around:${radiusMeters},${lat},${lng});`).join('\n');
  const query = `[out:json][timeout:6];(${clauses});out center 10;`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Overpass request failed: ${res.status}`);
    const data = await res.json();
    return (data.elements || [])
      .map((el) => {
        const flat = el.lat ?? el.center?.lat;
        const flng = el.lon ?? el.center?.lon;
        if (flat == null || flng == null) return null;
        return {
          place_id: null,
          name: el.tags?.name || defaultNameFor(el.tags?.amenity),
          address: el.tags?.['addr:full'] || [el.tags?.['addr:housenumber'], el.tags?.['addr:street']].filter(Boolean).join(' ') || null,
          phone: el.tags?.phone || el.tags?.['contact:phone'] || null,
          distance_km: Math.round(haversineKm(lat, lng, flat, flng) * 10) / 10,
          rating: null,
          open_now: null,
          latitude: flat,
          longitude: flng,
          maps_url: `https://www.google.com/maps/search/?api=1&query=${flat},${flng}`,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.distance_km - b.distance_km)
      .slice(0, 5);
  } catch {
    return []; // Overpass can be slow/overloaded — an empty category is fine, never throw
  }
}

async function fetchEmergencyServicesFromOverpass({ lat, lng }) {
  if (lat == null || lng == null) return null;
  const radiusMeters = 6000;
  const categoryKeys = Object.keys(OVERPASS_CATEGORY_TAGS);
  const results = await Promise.all(categoryKeys.map((key) => fetchOverpassCategory(key, lat, lng, radiusMeters)));
  return categoryKeys.reduce((acc, key, i) => {
    acc[key] = results[i];
    return acc;
  }, {});
}

/**
 * Single entry point for the live "Emergency Services" button: Google
 * Places first (if a key is configured), OSM/Overpass otherwise. Always
 * resolves to a { hospitals, clinics, police, fire, medical_stores,
 * ambulance, source } shape — never throws, so a bad request from either
 * provider never breaks the screen.
 */
export async function getLiveEmergencyServices({ lat, lng, areaHint } = {}) {
  if (lat == null || lng == null) {
    return { hospitals: [], clinics: [], police: [], fire: [], medical_stores: [], ambulance: [], source: 'no_location' };
  }

  const googleResult = await fetchEmergencyServicesFromGoogle({ lat, lng });
  const base = googleResult
    ? { ...googleResult, source: 'google_places' }
    : { ...(await fetchEmergencyServicesFromOverpass({ lat, lng })), source: 'openstreetmap_overpass' };

  // Chennai-only: fold in the curated ESI Dispensary / Empanelled Hospital
  // register alongside whatever the live provider returned, so travelers
  // always see these government-listed facilities for Chennai trips even
  // if Google/Overpass came back sparse for the exact spot.
  const esiSupplement = getEsiChennaiSupplement({ lat, lng, areaHint });
  if (esiSupplement.hospitals.length || esiSupplement.clinics.length) {
    return {
      ...base,
      hospitals: [...(base.hospitals || []), ...esiSupplement.hospitals],
      clinics: [...(base.clinics || []), ...esiSupplement.clinics],
      source: `${base.source}+esi_chennai_register`,
    };
  }

  return base;
}

function defaultNameFor(amenity) {
  const labels = {
    hospital: 'Hospital (unnamed on OSM)',
    clinic: 'Clinic (unnamed on OSM)',
    police: 'Police station (unnamed on OSM)',
    pharmacy: 'Pharmacy (unnamed on OSM)',
  };
  return labels[amenity] || 'Facility';
}