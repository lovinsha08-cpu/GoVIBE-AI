import { loadSpots } from '../services/spotData.service.js';
import { findHiddenGems } from '../services/spotMatching.service.js';

// GET /api/spots?city=Jaipur&category=food&hiddenGems=true
export async function list(req, res, next) {
  try {
    const { city, category, hiddenGems } = req.query;
    const { spots, source } = await loadSpots({ city });

    let result = spots;
    if (category) {
      result = result.filter((s) => s.category === category);
    }
    if (hiddenGems === 'true') {
      result = findHiddenGems(result, { limit: result.length || 20 });
    }

    res.json({ spots: result, source, count: result.length });
  } catch (err) {
    next(err);
  }
}

// GET /api/spots/categories — distinct categories present in the current data pool
export async function categories(req, res, next) {
  try {
    const { spots, source } = await loadSpots({});
    const cats = [...new Set(spots.map((s) => s.category))].sort();
    res.json({ categories: cats, source });
  } catch (err) {
    next(err);
  }
}
