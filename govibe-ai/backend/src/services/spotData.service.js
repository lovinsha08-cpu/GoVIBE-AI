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

// A cached/single-source pool below this size, or covering fewer distinct
// categories than this, is treated as too thin to trust on its own.
const MIN_TRUSTED_ROWS = 12;
const MIN_TRUSTED_CATEGORIES = 4;

/** Stable identity for a spot across sources (Supabase row / Google Places /
 * OSM), since the same real-world place can come back with a different id
 * from each — same name within ~100m counts as a duplicate. */
function dedupeKey(spot) {
  const name = (spot.name || '').trim().toLowerCase();
  if (!name) return null;
  const lat = Number(spot.latitude);
  const lng = Number(spot.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return `${name}::${lat.toFixed(3)}::${lng.toFixed(3)}`;
  }
  return name;
}

/** Merges `rows` into `target` (deduped via `seenKeys`), returning only the
 * rows that were actually new — so callers can cache just the delta. */
function mergeUnique(target, seenKeys, rows) {
  const added = [];
  for (const row of rows) {
    const key = dedupeKey(row);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    target.push(row);
    added.push(row);
  }
  return added;
}

/**
 * Whether `pool` is broad enough to itself be trusted as THE candidate set
 * for this trip — both in raw volume and in actually covering the
 * categories the traveler asked for. This is evaluated per-request (against
 * this trip's interests), not once per destination, because a pool that's
 * plenty for a "shopping only" trip can still be far too narrow for a trip
 * that also wants temples, beaches, and restaurants — which is exactly how
 * a handful of stale cached mall rows used to silently starve every other
 * requested interest no matter how good the downstream ranking was.
 */
function hasSufficientCoverage(pool, requestedCategories) {
  if (pool.length === 0) return false;
  if (requestedCategories.length > 0) {
    const present = new Set(pool.map((s) => s.category));
    const missing = requestedCategories.filter((c) => !present.has(c));
    // Allow at most one requested category to be genuinely absent (e.g. the
    // traveler picked "beach" for a landlocked town) before treating the
    // pool as a data-coverage gap rather than a real "nothing nearby" case
    // — the latter is handled by the fallback-to-famous-spots step further
    // down the pipeline, not here.
    if (missing.length > 1) return false;
  }
  return pool.length >= MIN_TRUSTED_ROWS || new Set(pool.map((s) => s.category)).size >= MIN_TRUSTED_CATEGORIES;
}

/**
 * Loads candidate spots for a trip. Sources are layered and MERGED — cache,
 * then Google Places, then OSM — rather than the first source that returns
 * anything winning outright, and each layer only runs if what's been
 * gathered so far genuinely covers the traveler's requested interests
 * (`hasSufficientCoverage`). This is what stops a thin/narrow Supabase
 * cache (e.g. only shopping rows from an earlier crawl for this exact
 * destination) from silently blocking richer live data the traveler's
 * other interests actually need. Newly-fetched live rows are cached back to
 * Supabase so later requests for the same destination get progressively
 * richer instead of being stuck on the original narrow crawl forever.
 */
export async function loadSpots({ city, lat, lng, interests = [] } = {}) {
  const requestedCategories = [...new Set((interests || []).map((i) => i.category).filter(Boolean))];
  const pool = [];
  const seenKeys = new Set();
  const sourcesUsed = [];
  const toCache = [];

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
      if (mergeUnique(pool, seenKeys, genuine).length > 0) sourcesUsed.push('supabase');
    }
  }

  if (!hasSufficientCoverage(pool, requestedCategories) && lat != null && lng != null) {
    if (isGooglePlacesConfigured) {
      const googleRows = filterGenuineTouristSpots(await fetchGooglePlacesSpots({ lat, lng, city }));
      const added = mergeUnique(pool, seenKeys, googleRows);
      if (added.length > 0) {
        sourcesUsed.push('google_places');
        toCache.push(...added);
      } else {
        console.warn(`[spotData] Google Places returned nothing new for "${city}".`);
      }
    }

    // Still short after Google Places (or Google Places isn't configured) —
    // top up with live OSM data too, rather than treating "cache had a few
    // rows" or "Google Places had a few rows" as the end of the search.
    if (!hasSufficientCoverage(pool, requestedCategories)) {
      const liveRows = filterGenuineTouristSpots(await fetchLiveSpots({ lat, lng, city }));
      const added = mergeUnique(pool, seenKeys, liveRows);
      if (added.length > 0) {
        sourcesUsed.push('osm_live');
        toCache.push(...added);
      }
    }

    if (toCache.length > 0) await cacheSpots(toCache);
  }

  if (pool.length > 0) return { spots: pool, source: sourcesUsed.join('+') || 'supabase' };

  console.warn(`[spotData] No live or cached spots found for "${city}" — falling back to bundled sample data.`);
  return { spots: filterGenuineTouristSpots(loadSampleSpots()), source: 'sample' };
}