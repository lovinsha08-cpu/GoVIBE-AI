import 'dotenv/config';

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];

for (const key of required) {
  if (!process.env[key]) {
    console.warn(`[env] Missing ${key} — set it in backend/.env before connecting to Supabase.`);
  }
}

export const env = {
  port: process.env.PORT || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY,
  // Lets the Gemini model be swapped (e.g. to a newer/cheaper release)
  // without a code change. See ai.service.js for the default.
  geminiModel: process.env.GEMINI_MODEL,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY,
  // Amadeus Self-Service API — used by /api/flights/search. Defaults to the
  // free "test" environment; switch to https://api.amadeus.com in production.
  amadeusClientId: process.env.AMADEUS_CLIENT_ID,
  amadeusClientSecret: process.env.AMADEUS_CLIENT_SECRET,
  amadeusBaseUrl: process.env.AMADEUS_BASE_URL || 'https://test.api.amadeus.com',
};

if (!process.env.AMADEUS_CLIENT_ID || !process.env.AMADEUS_CLIENT_SECRET) {
  console.warn('[env] Missing AMADEUS_CLIENT_ID/AMADEUS_CLIENT_SECRET — /api/flights/search will return 503 until set in backend/.env.');
}

console.log('[debug] service role key loaded:', env.supabaseServiceRoleKey ? `yes (${env.supabaseServiceRoleKey.length} chars)` : 'NO — MISSING');