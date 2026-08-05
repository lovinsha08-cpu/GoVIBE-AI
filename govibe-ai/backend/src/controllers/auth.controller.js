import { supabase, supabaseAdmin } from '../config/supabase.js';

// POST /api/auth/traveler/signup
export async function travelerSignup(req, res, next) {
  try {
    const { email, password, fullName, phone } = req.body;
    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'email, password, and fullName are required' });
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, phone, role: 'traveler' } },
    });
    if (error) return res.status(400).json({ error: error.message });

    const { error: travelerError } = await supabaseAdmin
     .from('travelers')
     .insert({
       id: data.user.id,
       full_name: fullName,
       phone: phone || null,
  });

  if (travelerError) {
    console.error("Traveler insert failed:", travelerError);
    return res.status(400).json({ error: travelerError.message });
  }

    res.status(201).json({ user: data.user, session: data.session });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/business/signup
export async function businessSignup(req, res, next) {
  try {
    const {
      email, password, businessName, businessModel,
      location, category, description, phone,
    } = req.body;

    if (!email || !password || !businessName || !businessModel || !location || !category) {
      return res.status(400).json({
        error: 'email, password, businessName, businessModel, location, and category are required',
      });
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { business_name: businessName, role: 'business' } },
    });
    if (error) return res.status(400).json({ error: error.message });

    await supabaseAdmin.from('businesses').insert({
      id: data.user.id,
      business_name: businessName,
      business_model: businessModel,
      location,
      category,
      description: description || null,
      phone: phone || null,
      verified: false, // genuineness check happens separately, see services/businessVerification.js
    });

    res.status(201).json({ user: data.user, session: data.session });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/login  (shared by traveler + business — role comes back in user metadata)
export async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });

    res.json({ user: data.user, session: data.session });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/forgot-password
export async function forgotPassword(req, res, next) {
  try {
    const { email, redirectTo } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) return res.status(400).json({ error: error.message });

    res.json({ message: 'Password reset email sent' });
  } catch (err) {
    next(err);
  }
}

// GET /api/auth/me
export async function getMe(req, res) {
  res.json({ user: req.user });
}
