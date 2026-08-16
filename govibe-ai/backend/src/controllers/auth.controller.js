import { supabase, supabaseAdmin } from '../config/supabase.js';

// supabase.auth.signUp()/signInWithPassword() reject with a bare
// "fetch failed" TypeError (or an AbortError from our fetch timeout, or a
// raw Node network error code) when Node can't reach the Supabase URL at
// all — DNS/network issue, wrong SUPABASE_URL, or a paused Supabase
// project. None of those raw messages are actionable in the UI, so we
// detect the whole family of network failures here and translate them.
const NETWORK_ERROR_PATTERN = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|AbortError|network/i;

function isSupabaseUnreachable(error) {
  if (!error) return false;
  const code = error?.cause?.code || error?.code || '';
  const name = error?.name || '';
  const message = error?.message || '';
  return NETWORK_ERROR_PATTERN.test(`${code} ${name} ${message}`);
}

const SUPABASE_UNREACHABLE_MESSAGE =
  'Unable to reach the authentication service (Supabase). Check that SUPABASE_URL in backend/.env is correct, that the Supabase project is not paused, and that this server has internet access.';

// Logs the real underlying error server-side (DNS code, timeout, etc.) so
// it's diagnosable from the logs, while the client only ever sees the
// friendly SUPABASE_UNREACHABLE_MESSAGE.
function logSupabaseUnreachable(context, error) {
  const cause = error?.cause?.code || error?.code || error?.name || error?.message || 'unknown';
  console.error(`[auth] Supabase unreachable during ${context}: ${cause}`);
}

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
    if (error) {
      if (isSupabaseUnreachable(error)) {
        logSupabaseUnreachable('travelerSignup', error);
        return res.status(503).json({ error: SUPABASE_UNREACHABLE_MESSAGE });
      }
      return res.status(400).json({ error: error.message });
    }

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
    if (error) {
      if (isSupabaseUnreachable(error)) {
        logSupabaseUnreachable('businessSignup', error);
        return res.status(503).json({ error: SUPABASE_UNREACHABLE_MESSAGE });
      }
      return res.status(400).json({ error: error.message });
    }

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
    if (error) {
      if (isSupabaseUnreachable(error)) {
        logSupabaseUnreachable('login', error);
        return res.status(503).json({ error: SUPABASE_UNREACHABLE_MESSAGE });
      }
      return res.status(401).json({ error: error.message });
    }

    // Supabase can return a 200 with no error but also no session — most
    // commonly when "Confirm email" is enabled and the account hasn't been
    // confirmed yet. Without this check the client silently gets `{}`.
    if (!data.session) {
      return res.status(401).json({
        error: 'Login succeeded but no session was returned. If your Supabase project has "Confirm email" enabled, this account may need to verify its email first.',
      });
    }

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
    if (error) {
      if (isSupabaseUnreachable(error)) {
        logSupabaseUnreachable('forgotPassword', error);
        return res.status(503).json({ error: SUPABASE_UNREACHABLE_MESSAGE });
      }
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: 'Password reset email sent' });
  } catch (err) {
    next(err);
  }
}

// GET /api/auth/me
export async function getMe(req, res) {
  res.json({ user: req.user });
}