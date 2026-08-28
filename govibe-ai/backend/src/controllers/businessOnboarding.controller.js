import { verifyBusinessLocation } from '../services/businessVerification.service.js';

// Real GPS coordinates are always within these ranges — anything outside
// (or non-numeric, e.g. NaN from a bad browser reading) is rejected before
// it ever reaches the Places API.
function isValidCoordinate(lat, lng) {
  return (
    typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}

// POST /api/business-onboarding/verify-location
// Public (no account exists yet at this point in onboarding) — used by the
// Business Onboarding UI to preview a location match before the owner
// submits signup. The same check is re-run server-side during signup
// itself (see auth.controller.js#businessSignup), so nothing here needs to
// be trusted blindly by that step; this endpoint only powers the preview.
export async function verifyLocation(req, res, next) {
  try {
    const body = req.body || {};
    const businessName = (body.businessName || '').toString().trim();
    const category = body.category ? body.category.toString().trim() : undefined;
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);

    if (!businessName) {
      return res.status(400).json({ error: 'businessName is required', code: 'missing_business_name' });
    }
    if (body.latitude == null || body.longitude == null || !isValidCoordinate(latitude, longitude)) {
      return res.status(400).json({
        error: 'A valid latitude/longitude is required (lat -90..90, lng -180..180).',
        code: 'invalid_gps',
      });
    }

    const result = await verifyBusinessLocation({ businessName, category, latitude, longitude });

    if (result.status === 'rate_limited') {
      return res.status(429).json(result);
    }
    // 'matched' | 'too_far' | 'not_found' | 'unavailable' | 'api_failure' are
    // all expected, renderable outcomes for the onboarding UI — not server
    // errors — so they all come back as 200.
    res.json(result);
  } catch (err) {
    next(err);
  }
}