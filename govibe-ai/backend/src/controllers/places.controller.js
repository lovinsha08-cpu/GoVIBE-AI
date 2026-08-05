import { autocompletePlaces } from '../services/geocoding.service.js';

// GET /api/places/autocomplete?q=chen&limit=8
// Public, read-only endpoint (same trust level as /api/spots) — powers the
// LocationAutocomplete frontend component for any location field (start
// location, destination, hotel search, restaurant search, etc.).
export async function autocomplete(req, res, next) {
  try {
    const q = (req.query.q || '').toString();

    // Empty/too-short queries are a normal, expected state (e.g. the input
    // was just focused or cleared) — return an empty list rather than an
    // error so the frontend doesn't need special-case error handling for it.
    if (!q.trim() || q.trim().length < 2) {
      return res.json({ suggestions: [] });
    }

    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit, 10) || 8));
    const suggestions = await autocompletePlaces(q, { limit });

    res.json({ suggestions });
  } catch (err) {
    next(err);
  }
}