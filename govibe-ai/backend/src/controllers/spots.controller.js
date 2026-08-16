import { loadSpots } from '../services/spotData.service.js';
import { findHiddenGems, HIDDEN_GEM_CATEGORY_GROUPS } from '../services/spotMatching.service.js';

// GET /api/spots?city=Jaipur&category=food&hiddenGems=true&hiddenGemCategory=nature
export async function list(req, res, next) {
  try {
    const { city, category, hiddenGems, hiddenGemCategory } = req.query;
    const { spots, source } = await loadSpots({ city });

    let result = spots;
    if (hiddenGems === 'true') {
      // Hidden Gems has its own five-bucket category filter (nature/food/
      // culture/shopping/offbeat) instead of the plain `category` filter,
      // since the raw spot.category enum is too granular for this view.
      result = findHiddenGems(result, {
        limit: result.length || 20,
        categoryGroup: hiddenGemCategory || null,
      });
    } else if (category) {
      result = result.filter((s) => s.category === category);
    }

    res.json({ spots: result, source, count: result.length });
  } catch (err) {
    next(err);
  }
}

// GET /api/spots/hidden-gem-categories — the five Hidden Gems filter buckets.
export async function hiddenGemCategories(req, res) {
  res.json({
    categories: HIDDEN_GEM_CATEGORY_GROUPS.map(({ key, label }) => ({ key, label })),
  });
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