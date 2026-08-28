import { supabaseAdmin } from '../config/supabase.js';

// Real-data replacements for the Business dashboard's Profile and Analytics
// pages, which previously ran entirely on lib/businessStore.js
// (localStorage/mock data) on the frontend. Both handlers here are scoped
// to `req.user.id` — the authenticated business's own id from the verified
// Supabase session — never a client-supplied business id.

// ---------- Profile ----------
// Only exposes/updates columns that actually exist on the `businesses`
// table (see backend/supabase/schema.sql). Fields the existing frontend
// mock also tracks (ownerName, email, openingHours, profileImage) have no
// backing column yet and are intentionally left out — see Phase 4 report.

const PROFILE_COLUMNS = 'business_name, business_model, location, category, description, phone, verified, created_at';

function toProfileDTO(row) {
  return {
    businessName: row.business_name,
    businessModel: row.business_model,
    location: row.location,
    category: row.category,
    description: row.description,
    phone: row.phone,
    verified: row.verified,
    createdAt: row.created_at,
  };
}

// GET /api/business/profile
export async function getMyBusinessProfile(req, res, next) {
  try {
    const { data, error } = await supabaseAdmin
      .from('businesses')
      .select(PROFILE_COLUMNS)
      .eq('id', req.user.id)
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Business profile not found' });
    res.json({ profile: toProfileDTO(data) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/business/profile — only the real, existing columns are
// updatable; anything else in the request body is silently ignored rather
// than erroring, so the existing frontend form doesn't break on fields
// this endpoint doesn't (yet) persist.
export async function updateMyBusinessProfile(req, res, next) {
  try {
    const b = req.body || {};
    const updates = {};
    if (b.businessName !== undefined) updates.business_name = b.businessName;
    if (b.businessModel !== undefined) updates.business_model = b.businessModel;
    if (b.location !== undefined) updates.location = b.location;
    if (b.category !== undefined) updates.category = b.category;
    if (b.description !== undefined) updates.description = b.description;
    if (b.phone !== undefined) updates.phone = b.phone;

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No recognized profile fields to update' });
    }

    const { data, error } = await supabaseAdmin
      .from('businesses')
      .update(updates)
      .eq('id', req.user.id)
      .select(PROFILE_COLUMNS)
      .maybeSingle();

    if (error) return res.status(400).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Business profile not found' });
    res.json({ profile: toProfileDTO(data) });
  } catch (err) {
    next(err);
  }
}

// ---------- Analytics ----------
// Every number here is computed from the real `offers` table for this
// business only. No fabricated visitor charts, no mock "listings" count
// (there is no listings table yet — see Phase 4 report).

// GET /api/business/analytics
export async function getMyAnalytics(req, res, next) {
  try {
    const { data, error } = await supabaseAdmin
      .from('offers')
      .select('title, is_active, views, bookings_attributed')
      .eq('business_id', req.user.id);

    if (error) return res.status(400).json({ error: error.message });

    const offers = data || [];
    const totals = offers.reduce(
      (acc, o) => ({
        views: acc.views + (o.views || 0),
        bookings_attributed: acc.bookings_attributed + (o.bookings_attributed || 0),
      }),
      { views: 0, bookings_attributed: 0 },
    );

    const bestOffer = offers.length
      ? offers.reduce((best, o) => ((o.views || 0) > (best.views || 0) ? o : best), offers[0])
      : null;

    res.json({
      analytics: {
        totalOffers: offers.length,
        activeOffers: offers.filter((o) => o.is_active).length,
        totalViews: totals.views,
        totalBookingsAttributed: totals.bookings_attributed,
        bestPerformingOffer: bestOffer ? bestOffer.title : null,
        // No listings table and no visitor-tracking pipeline exist yet —
        // reported explicitly as unavailable rather than invented.
        activeListings: null,
        monthlyVisitors: null,
      },
      unavailableMetrics: ['activeListings', 'monthlyVisitors'],
    });
  } catch (err) {
    next(err);
  }
}