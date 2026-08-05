#!/usr/bin/env node
/**
 * Seeds the `spots` table with real tourism data.
 *
 * Two modes, no paid API keys required:
 *
 *   node scripts/seedSpots.js --sample
 *     Loads the bundled backend/src/data/sampleSpots.json (curated Jaipur
 *     dataset) into Supabase. Good for a quick, reliable demo seed.
 *
 *   node scripts/seedSpots.js "Jaipur, India"
 *     Geocodes the city with OpenStreetMap Nominatim (free, no key), then
 *     pulls real attractions/hotels/restaurants from the Overpass API (free,
 *     no key) within a radius and upserts them as spots rows.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in backend/.env (the
 * service key is needed to bypass RLS for inserts).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env — set those first.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

// Maps OSM tags to our spot categories (matches interest_categories.slug + 'stay' for lodging).
const OSM_QUERIES = [
  { osm: 'tourism=attraction', category: 'heritage', subcategory: 'Monuments' },
  { osm: 'tourism=museum', category: 'heritage', subcategory: 'Museums' },
  { osm: 'historic=castle', category: 'heritage', subcategory: 'Forts & Palaces' },
  { osm: 'historic=monument', category: 'heritage', subcategory: 'Monuments' },
  { osm: 'tourism=viewpoint', category: 'nature', subcategory: 'Hill Stations' },
  { osm: 'leisure=park', category: 'relaxation', subcategory: 'Nature Walks' },
  { osm: 'tourism=hotel', category: 'stay', subcategory: 'Resorts' },
  { osm: 'tourism=guest_house', category: 'stay', subcategory: 'Homestay' },
  { osm: 'amenity=restaurant', category: 'food', subcategory: 'Local Cuisine Tours' },
  { osm: 'amenity=cafe', category: 'food', subcategory: 'Cafés' },
  { osm: 'shop=mall', category: 'shopping', subcategory: 'Malls' },
];

async function geocodeCity(cityName) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(cityName)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'GoVIBE-AI-seed-script/1.0' } });
  const data = await res.json();
  if (!data?.length) throw new Error(`Could not geocode "${cityName}"`);
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), displayName: data[0].display_name };
}

async function fetchOverpass(lat, lng, radiusMeters, tag) {
  const [key, value] = tag.split('=');
  const query = `
    [out:json][timeout:25];
    nwr["${key}"="${value}"](around:${radiusMeters},${lat},${lng});
    out center 40;
  `;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: query,
    headers: { 'Content-Type': 'text/plain' },
  });
  if (!res.ok) throw new Error(`Overpass request failed for ${tag}: ${res.status}`);
  const data = await res.json();
  return data.elements || [];
}

function toSpotRow(el, { category, subcategory }, city) {
  const tags = el.tags || {};
  const name = tags.name;
  if (!name) return null; // skip unnamed nodes — not useful for an itinerary
  // Nodes carry lat/lon directly; ways/relations (most malls, large
  // attractions, big complexes) only get a coordinate via "out center".
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
    rating: null, // OSM has no ratings; leave null until a review source is added
    popularity_score: 0.5,
    avg_visit_minutes: category === 'stay' ? 0 : 60,
    entry_fee_inr: 0,
    opening_hours: tags.opening_hours || null,
    description: tags.description || `${name} (${subcategory || category}), sourced from OpenStreetMap.`,
    image_url: null,
    source: 'osm',
  };
}

async function seedFromOsm(cityName) {
  console.log(`Geocoding "${cityName}"...`);
  const { lat, lng, displayName } = await geocodeCity(cityName);
  console.log(`Found: ${displayName} (${lat}, ${lng})`);

  const radiusMeters = 15000;
  const rows = [];
  for (const q of OSM_QUERIES) {
    console.log(`Querying Overpass for ${q.osm}...`);
    try {
      const elements = await fetchOverpass(lat, lng, radiusMeters, q.osm);
      for (const el of elements) {
        const row = toSpotRow(el, q, cityName.split(',')[0].trim());
        if (row) rows.push(row);
      }
      // Overpass's public instance rate-limits aggressive callers — be polite.
      await new Promise((r) => setTimeout(r, 1200));
    } catch (err) {
      console.warn(`  skipped ${q.osm}: ${err.message}`);
    }
  }

  // De-dupe by name+category (OSM sometimes tags the same place twice)
  const seen = new Set();
  const deduped = rows.filter((r) => {
    const key = `${r.name}|${r.category}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`Collected ${deduped.length} spots. Inserting into Supabase...`);
  return deduped;
}

async function seedFromSample() {
  const raw = readFileSync(path.join(__dirname, '..', 'src', 'data', 'sampleSpots.json'), 'utf-8');
  return JSON.parse(raw);
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage:\n  node scripts/seedSpots.js --sample\n  node scripts/seedSpots.js "City, Country"');
    process.exit(1);
  }

  const rows = arg === '--sample' ? await seedFromSample() : await seedFromOsm(arg);
  if (rows.length === 0) {
    console.log('Nothing to insert.');
    return;
  }

  const { error, count } = await supabase.from('spots').insert(rows, { count: 'exact' });
  if (error) {
    console.error('Insert failed:', error.message);
    process.exit(1);
  }
  console.log(`Inserted ${count ?? rows.length} spots.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});