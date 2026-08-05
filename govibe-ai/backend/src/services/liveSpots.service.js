/**
 * Fetches real, live tourist-spot data from OpenStreetMap's Overpass API for
 * any destination, on demand — no manual seeding required.
 */
import { supabaseAdmin } from '../config/supabase.js';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'GoVIBE-AI/1.0 (trip planning app)';
const REQUEST_TIMEOUT_MS = 12000;
const TAG_DELAY_MS = 1000;

// Tourism-focused tags only — deliberately avoids generic "office=*",
// "amenity=townhall", "amenity=police", etc. so administrative/civic
// buildings never enter the candidate pool in the first place. The
// attractionFilter service double-checks by name as a second layer.
const OSM_QUERIES = [
  // Culture & Heritage
  { osm: 'tourism=attraction', category: 'heritage', subcategory: 'Monuments' },
  { osm: 'tourism=museum', category: 'heritage', subcategory: 'Museums' },
  { osm: 'tourism=gallery', category: 'heritage', subcategory: 'Art Galleries' },
  { osm: 'historic=castle', category: 'heritage', subcategory: 'Forts & Palaces' },
  { osm: 'historic=fort', category: 'heritage', subcategory: 'Forts & Palaces' },
  { osm: 'historic=palace', category: 'heritage', subcategory: 'Forts & Palaces' },
  { osm: 'historic=monument', category: 'heritage', subcategory: 'Monuments' },
  { osm: 'historic=memorial', category: 'heritage', subcategory: 'Monuments' },
  { osm: 'historic=ruins', category: 'heritage', subcategory: 'Heritage Walks' },
  { osm: 'amenity=place_of_worship', category: 'heritage', subcategory: 'Temples' },
  // Nature & Outdoors
  { osm: 'tourism=viewpoint', category: 'nature', subcategory: 'Hills & Viewpoints' },
  { osm: 'natural=beach', category: 'nature', subcategory: 'Beaches' },
  { osm: 'natural=waterfall', category: 'nature', subcategory: 'Waterfalls' },
  { osm: 'natural=water', category: 'nature', subcategory: 'Lakes & Rivers' },
  { osm: 'leisure=nature_reserve', category: 'nature', subcategory: 'Wildlife Sanctuaries' },
  { osm: 'leisure=garden', category: 'nature', subcategory: 'Botanical Gardens' },
  { osm: 'leisure=park', category: 'relaxation', subcategory: 'Picnic Spots' },
  // Adventure & family
  { osm: 'tourism=theme_park', category: 'family', subcategory: 'Theme Parks' },
  { osm: 'tourism=zoo', category: 'family', subcategory: 'Zoos' },
  { osm: 'tourism=aquarium', category: 'family', subcategory: 'Aquariums' },
  { osm: 'leisure=water_park', category: 'adventure', subcategory: 'Water Sports' },
  // Stay
  { osm: 'tourism=hotel', category: 'stay', subcategory: 'Resorts' },
  { osm: 'tourism=guest_house', category: 'stay', subcategory: 'Homestay' },
  // Food & Dining
  { osm: 'amenity=restaurant', category: 'food', subcategory: 'Local Cuisine' },
  { osm: 'amenity=cafe', category: 'food', subcategory: 'Cafés' },
  // Shopping
  { osm: 'shop=mall', category: 'shopping', subcategory: 'Shopping Malls' },
  { osm: 'amenity=marketplace', category: 'shopping', subcategory: 'Local Markets' },
];

async function fetchOverpassTag(lat, lng, radiusMeters, tag) {
  const [key, value] = tag.split('=');
  const query = `
    [out:json][timeout:25];
    nwr["${key}"="${value}"](around:${radiusMeters},${lat},${lng});
    out center 40;
  `;
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

  const rows = [];
  for (const q of OSM_QUERIES) {
    try {
      const elements = await fetchOverpassTag(lat, lng, radiusMeters, q.osm);
      for (const el of elements) {
        const row = toSpotRow(el, q, city);
        if (row) rows.push(row);
      }
    } catch (err) {
      console.warn(`[liveSpots] Skipped ${q.osm} for "${city}":`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, TAG_DELAY_MS));
  }
  return rows;
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