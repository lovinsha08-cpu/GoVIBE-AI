import 'dotenv/config';

// .env files saved on Windows (or edited there) often carry CRLF line
// endings. dotenv usually strips the trailing \r, but a value copy-pasted
// with an embedded \r/whitespace can slip through and silently break a URL
// like "https://xxxx.supabase.co\r" — which then fails DNS resolution with
// an opaque "fetch failed". Trim every value defensively so that class of
// bug can't happen here.
function clean(value) {
  return typeof value === 'string' ? value.trim() : value;
}

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];

for (const key of required) {
  if (!clean(process.env[key])) {
    console.warn(`[env] Missing ${key} — set it in backend/.env before connecting to Supabase.`);
  }
}

export const env = {
  port: clean(process.env.PORT) || 4000,
  nodeEnv: clean(process.env.NODE_ENV) || 'development',
  supabaseUrl: clean(process.env.SUPABASE_URL),
  supabaseAnonKey: clean(process.env.SUPABASE_ANON_KEY),
  supabaseServiceRoleKey: clean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  geminiApiKey: clean(process.env.GEMINI_API_KEY),
  // Lets the Gemini model be swapped (e.g. to a newer/cheaper release)
  // without a code change. See ai.service.js for the default.
  geminiModel: clean(process.env.GEMINI_MODEL),
  corsOrigin: clean(process.env.CORS_ORIGIN) || 'http://localhost:5173',
  googlePlacesApiKey: clean(process.env.GOOGLE_PLACES_API_KEY),
  // How many top candidates PER CATEGORY get sent to Google Places (New)
  // for familiarity/quality enrichment during itinerary generation — never
  // the whole raw OSM candidate pool. See googlePlacesEnrichment.service.js.
  googleEnrichmentLimitPerCategory: Number(clean(process.env.GOOGLE_ENRICHMENT_LIMIT_PER_CATEGORY)) || 8,
  // Max concurrent in-flight Google Places (New) requests during enrichment.
  googleEnrichmentConcurrency: Number(clean(process.env.GOOGLE_ENRICHMENT_CONCURRENCY)) || 5,
  // Amadeus Self-Service API — used by /api/flights/search. Defaults to the
  // free "test" environment; switch to https://api.amadeus.com in production.
  amadeusClientId: clean(process.env.AMADEUS_CLIENT_ID),
  amadeusClientSecret: clean(process.env.AMADEUS_CLIENT_SECRET),
  amadeusBaseUrl: clean(process.env.AMADEUS_BASE_URL) || 'https://test.api.amadeus.com',
};

// Catch a malformed SUPABASE_URL early with a clear message instead of
// letting it surface later as a mysterious "fetch failed" from deep inside
// the Supabase client.
if (env.supabaseUrl) {
  try {
    const parsed = new URL(env.supabaseUrl);
    if (!/\.supabase\.co$/i.test(parsed.hostname) && !/localhost|127\.0\.0\.1/.test(parsed.hostname)) {
      console.warn(
        `[env] SUPABASE_URL hostname "${parsed.hostname}" doesn't look like a *.supabase.co project URL — double check it against Supabase → Project Settings → API.`
      );
    }
  } catch {
    console.error(
      `[env] SUPABASE_URL ("${env.supabaseUrl}") is not a valid URL. It should look like https://xxxxxxxx.supabase.co with no trailing slash or stray characters.`
    );
  }
}

if (!process.env.AMADEUS_CLIENT_ID || !process.env.AMADEUS_CLIENT_SECRET) {
  console.warn('[env] Missing AMADEUS_CLIENT_ID/AMADEUS_CLIENT_SECRET — /api/flights/search will return 503 until set in backend/.env.');
}

console.log('[debug] service role key loaded:', env.supabaseServiceRoleKey ? `yes (${env.supabaseServiceRoleKey.length} chars)` : 'NO — MISSING');