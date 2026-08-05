import { supabaseAdmin } from '../config/supabase.js';

export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.split(' ')[1];
  const { data, error } = await supabaseAdmin.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user = data.user;
  next();
}

// Like requireAuth, but never blocks the request — used by routes (e.g. the
// AI assistant chat) that should work for guests too, but can personalize
// their response when a valid session is present. req.user is the Supabase
// user object if the token was valid, otherwise null.
export async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    req.user = !error && data?.user ? data.user : null;
  } catch {
    req.user = null;
  }
  next();
}