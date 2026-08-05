import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { supabaseAdmin, isSupabaseConfigured } from '../config/supabase.js';
import { fetchLiveSpots, cacheSpots } from './liveSpots.service.js';
import { fetchGooglePlacesSpots, isGooglePlacesConfigured } from './googlePlaces.service.js';
import { filterGenuineTouristSpots } from './attractionFilter.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(__dirname, '..', 'data', 'sampleSpots.json');

let cachedSample = null;
function loadSampleSpots() {
  if (!cachedSample) {
    const raw = readFileSync(SAMPLE_PATH, 'utf-8');
    cachedSample = JSON.parse(raw).map((s, i) => ({ id: `sample-${i + 1}`, ...s }));
  }
  return cachedSample;
}

export async function loadSpots({ city, lat, lng } = {}) {
  if (isSupabaseConfigured && city) {
    const needle = city.trim().toLowerCase();
    const { data, error } = await supabaseAdmin
      .from('spots')
      .select('*')
      .ilike('city', `%${needle}%`);
    if (!error && data?.length) {
      // Supabase may hold rows cached from an earlier, less-strict crawl —
      // re-validate before handing them to the itinerary engine.
      const genuine = filterGenuineTouristSpots(data);
      if (genuine.length > 0) return { spots: genuine, source: 'supabase' };
    }
  }

  if (isGooglePlacesConfigured && lat != null && lng != null) {
    const googleRows = filterGenuineTouristSpots(await fetchGooglePlacesSpots({ lat, lng, city }));
    if (googleRows.length > 0) {
      await cacheSpots(googleRows);
      return { spots: googleRows, source: 'google_places' };
    }
    console.warn(`[spotData] Google Places returned nothing for "${city}" — falling back to OSM.`);
  }

  if (lat != null && lng != null) {
    const liveRows = filterGenuineTouristSpots(await fetchLiveSpots({ lat, lng, city }));
    if (liveRows.length > 0) {
      await cacheSpots(liveRows);
      return { spots: liveRows, source: 'osm_live' };
    }
  }

  console.warn(`[spotData] No live or cached spots found for "${city}" — falling back to bundled sample data.`);
  return { spots: filterGenuineTouristSpots(loadSampleSpots()), source: 'sample' };
}