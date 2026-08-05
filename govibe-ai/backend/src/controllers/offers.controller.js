import { supabaseAdmin } from '../config/supabase.js';

// Shape a raw `offers` row (plus joined business_name) into the flat object
// the frontend expects on both the Business and Traveler dashboards.
function toOfferDTO(row) {
  return {
    id: row.id,
    businessId: row.business_id,
    businessName: row.businesses?.business_name || row.business_name || 'Local business',
    title: row.title,
    description: row.description,
    category: row.category,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    image: row.image_url,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- Business-side (authenticated) ----------

// POST /api/business/offers
export async function createOffer(req, res, next) {
  try {
    const b = req.body;
    if (!b.title || !b.discountValue || !b.category) {
      return res.status(400).json({ error: 'title, discountValue, and category are required' });
    }

    const { data, error } = await supabaseAdmin
      .from('offers')
      .insert({
        business_id: req.user.id,
        title: b.title,
        description: b.description || null,
        category: b.category,
        discount_type: b.discountType || 'percent',
        discount_value: b.discountValue,
        valid_from: b.validFrom || null,
        valid_until: b.validUntil || null,
        image_url: b.image || null,
        is_active: b.isActive ?? true,
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ offer: toOfferDTO(data) });
  } catch (err) {
    next(err);
  }
}

// GET /api/business/offers — offers belonging to the logged-in business
export async function listMyOffers(req, res, next) {
  try {
    const { data, error } = await supabaseAdmin
      .from('offers')
      .select('*')
      .eq('business_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json({ offers: data.map(toOfferDTO) });
  } catch (err) {
    next(err);
  }
}

// PUT /api/business/offers/:id
export async function updateOffer(req, res, next) {
  try {
    const b = req.body;
    const updates = { updated_at: new Date().toISOString() };
    if (b.title !== undefined) updates.title = b.title;
    if (b.description !== undefined) updates.description = b.description;
    if (b.category !== undefined) updates.category = b.category;
    if (b.discountType !== undefined) updates.discount_type = b.discountType;
    if (b.discountValue !== undefined) updates.discount_value = b.discountValue;
    if (b.validFrom !== undefined) updates.valid_from = b.validFrom;
    if (b.validUntil !== undefined) updates.valid_until = b.validUntil;
    if (b.image !== undefined) updates.image_url = b.image;
    if (b.isActive !== undefined) updates.is_active = b.isActive;

    const { data, error } = await supabaseAdmin
      .from('offers')
      .update(updates)
      .eq('id', req.params.id)
      .eq('business_id', req.user.id) // a business can only edit its own offers
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Offer not found' });
    res.json({ offer: toOfferDTO(data) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/business/offers/:id/status — toggle/set Active-Inactive
export async function setOfferStatus(req, res, next) {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive (boolean) is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('offers')
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('business_id', req.user.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Offer not found' });
    res.json({ offer: toOfferDTO(data) });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/business/offers/:id
export async function deleteOffer(req, res, next) {
  try {
    const { error } = await supabaseAdmin
      .from('offers')
      .delete()
      .eq('id', req.params.id)
      .eq('business_id', req.user.id);

    if (error) return res.status(400).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ---------- Traveler-side (public) ----------

// GET /api/offers — every ACTIVE offer, across all businesses.
// Optional filters: category, businessName, discountType, minDiscount, validOn (defaults to today)
export async function listPublicOffers(req, res, next) {
  try {
    const { category, businessName, discountType, minDiscount, validOn } = req.query;
    const today = validOn || new Date().toISOString().slice(0, 10);

    let query = supabaseAdmin
      .from('offers')
      .select('*, businesses(business_name)')
      .eq('is_active', true)
      .or(`valid_until.is.null,valid_until.gte.${today}`)
      .order('created_at', { ascending: false });

    if (category) query = query.eq('category', category);
    if (discountType) query = query.eq('discount_type', discountType);
    if (minDiscount) query = query.gte('discount_value', Number(minDiscount));

    const { data, error } = await query;
    if (error) return res.status(400).json({ error: error.message });

    let offers = data.map(toOfferDTO);

    // Business-name filter applied after the join since it's a text
    // search on a related table's column.
    if (businessName) {
      const needle = businessName.toLowerCase();
      offers = offers.filter((o) => o.businessName.toLowerCase().includes(needle));
    }

    res.json({ offers, count: offers.length });
  } catch (err) {
    next(err);
  }
}