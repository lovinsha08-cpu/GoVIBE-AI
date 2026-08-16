/**
 * Fetches real, live tourist-spot data from OpenStreetMap's Overpass API for
 * any destination, on demand — no manual seeding required.
 */
import { supabaseAdmin } from '../config/supabase.js';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'GoVIBE-AI/1.0 (trip planning app)';
// A single combined query (see buildCombinedOverpassQuery below) does more
// work per request than the old one-tag-at-a-time calls did, so it gets a
// longer timeout — but this is still one request instead of 27, so it's
// far faster overall even with the larger ceiling.
const REQUEST_TIMEOUT_MS = 25000;

// Tourism-focused tags only — deliberately avoids generic "office=*",
// "amenity=townhall", "amenity=police", etc. so administrative/civic
// buildings never enter the candidate pool in the first place. The
// attractionFilter service double-checks by name as a second layer.
const OSM_QUERIES = [
  // Heritage & Historical
  { osm: 'tourism=attraction', category: 'heritage_historical', subcategory: 'Monuments' },
  { osm: 'tourism=museum', category: 'heritage_historical', subcategory: 'Museums' },
  { osm: 'tourism=gallery', category: 'arts_culture', subcategory: 'Art Galleries' },
  { osm: 'historic=castle', category: 'heritage_historical', subcategory: 'Forts' },
  { osm: 'historic=fort', category: 'heritage_historical', subcategory: 'Forts' },
  { osm: 'historic=palace', category: 'heritage_historical', subcategory: 'Heritage Buildings' },
  { osm: 'historic=monument', category: 'heritage_historical', subcategory: 'Monuments' },
  { osm: 'historic=memorial', category: 'heritage_historical', subcategory: 'Memorials' },
  { osm: 'historic=ruins', category: 'heritage_historical', subcategory: 'Archaeological Sites' },
  { osm: 'amenity=place_of_worship', category: 'religious_spiritual', subcategory: 'Temples' },
  // Nature & Scenic
  { osm: 'tourism=viewpoint', category: 'photography_landmarks', subcategory: 'Viewpoints' },
  { osm: 'natural=beach', category: 'nature_scenic', subcategory: 'Beaches' },
  { osm: 'natural=waterfall', category: 'nature_scenic', subcategory: 'Rivers & Backwaters' },
  { osm: 'natural=water', category: 'nature_scenic', subcategory: 'Lakes' },
  { osm: 'leisure=nature_reserve', category: 'nature_scenic', subcategory: 'Eco Parks' },
  { osm: 'leisure=garden', category: 'nature_scenic', subcategory: 'Gardens' },
  { osm: 'leisure=park', category: 'nature_scenic', subcategory: 'Parks' },
  // Wildlife & Entertainment
  { osm: 'tourism=theme_park', category: 'entertainment_recreation', subcategory: 'Theme Parks' },
  { osm: 'tourism=zoo', category: 'wildlife', subcategory: 'Zoos' },
  { osm: 'tourism=aquarium', category: 'wildlife', subcategory: 'Aquariums' },
  { osm: 'leisure=water_park', category: 'entertainment_recreation', subcategory: 'Water Parks' },
  // Stay
  { osm: 'tourism=hotel', category: 'stay', subcategory: 'Hotels' },
  { osm: 'tourism=guest_house', category: 'stay', subcategory: 'Hotels' },
  // Food & Dining
  { osm: 'amenity=restaurant', category: 'food_dining', subcategory: 'Restaurants' },
  { osm: 'amenity=cafe', category: 'food_dining', subcategory: 'Cafés' },
  // Shopping
  { osm: 'shop=mall', category: 'shopping', subcategory: 'Shopping Malls' },
  { osm: 'amenity=marketplace', category: 'shopping', subcategory: 'Street Markets' },
];

// Builds ONE combined Overpass QL query covering every tag in OSM_QUERIES,
// instead of 27 separate HTTP requests each with a 1s throttling delay
// between them (~30+ seconds minimum just from the delays, before network
// time). Overpass supports a union block `(...)` of multiple filters in a
// single request — this is the standard, documented way to batch tag
// lookups and is a single round-trip instead of 27.
function buildCombinedOverpassQuery(lat, lng, radiusMeters, tags) {
  const clauses = tags.map((tag) => {
    const [key, value] = tag.split('=');
    return `nwr["${key}"="${value}"](around:${radiusMeters},${lat},${lng});`;
  }).join('\n    ');
  return `
    [out:json][timeout:50];
    (
    ${clauses}
    );
    out center 40;
  `;
}

async function fetchOverpassCombined(lat, lng, radiusMeters, tags) {
  const query = buildCombinedOverpassQuery(lat, lng, radiusMeters, tags);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: query,
      headers: {
        'Content-Type': 'text/plain',
        'User-Agent': USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Overpass responded ${res.status}`);
    const data = await res.json();
    return data.elements || [];
  } finally {
    clearTimeout(timeout);
  }
}

// A combined query has no per-element tag label to say which OSM_QUERIES
// entry matched it, so this rebuilds that mapping from the element's own
// tags (key=value) instead.
function classifyElement(el) {
  const tags = el.tags || {};
  for (const q of OSM_QUERIES) {
    const [key, value] = q.osm.split('=');
    if (tags[key] === value) return q;
  }
  return null;
}

const RELIGION_SUBCATEGORY = { hindu: 'Temples', buddhist: 'Temples', jain: 'Temples', christian: 'Churches', muslim: 'Mosques', sikh: 'Temples' };

function toSpotRow(el, { category, subcategory }, city) {
  const tags = el.tags || {};
  const name = tags.name;
  if (!name) return null;
  if (tags.religion && RELIGION_SUBCATEGORY[tags.religion]) {
    subcategory = RELIGION_SUBCATEGORY[tags.religion];
  }
  // Nodes carry lat/lon directly; ways/relations (most malls, large
  // attractions, big complexes) only get a coordinate via "out center",
  // which Overpass returns as el.center.{lat,lon}.
  const latitude = el.lat ?? el.center?.lat;
  const longitude = el.lon ?? el.center?.lon;
  if (latitude == null || longitude == null) return null;
  return {
    name,
    category,
    subcategory,
    latitude,
    longitude,
    city,
    rating: null,
    popularity_score: 0.5,
    avg_visit_minutes: category === 'stay' ? 0 : 60,
    entry_fee_inr: 0,
    opening_hours: tags.opening_hours || null,
    description: tags.description || `${name} (${subcategory || category}), sourced from OpenStreetMap.`,
    image_url: null,
    source: 'osm',
  };
}

export async function fetchLiveSpots({ lat, lng, city, radiusMeters = 15000 }) {
  if (lat == null || lng == null) return [];

  try {
    const tags = OSM_QUERIES.map((q) => q.osm);
    const elements = await fetchOverpassCombined(lat, lng, radiusMeters, tags);
    const rows = [];
    for (const el of elements) {
      const q = classifyElement(el);
      if (!q) continue;
      const row = toSpotRow(el, q, city);
      if (row) rows.push(row);
    }
    return rows;
  } catch (err) {
    console.warn(`[liveSpots] Combined Overpass query failed for "${city}":`, err.message);
    return [];
  }
}

export async function cacheSpots(rows) {
  if (!supabaseAdmin || rows.length === 0) return;
  try {
    const { error } = await supabaseAdmin.from('spots').insert(rows);
    if (error) console.warn('[liveSpots] Failed to cache spots in Supabase:', error.message);
  } catch (err) {
    console.warn('[liveSpots] Failed to cache spots in Supabase:', err.message);
  }
}