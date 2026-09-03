import 'dotenv/config';

function clean(value){return typeof value==='string'?value.trim():value}
const isProduction=clean(process.env.NODE_ENV)==='production';

const required=['SUPABASE_URL','SUPABASE_ANON_KEY'];
if(isProduction) required.push('SUPABASE_SERVICE_ROLE_KEY');
for(const key of required){if(!clean(process.env[key])){const message=`Missing required environment variable: ${key}`;if(isProduction)throw new Error(`[env] ${message}`);console.warn(`[env] ${message} — set it in backend/.env.`)}}

export const env={
  port:clean(process.env.PORT)||4000,
  nodeEnv:clean(process.env.NODE_ENV)||'development',
  supabaseUrl:clean(process.env.SUPABASE_URL),
  supabaseAnonKey:clean(process.env.SUPABASE_ANON_KEY),
  supabaseServiceRoleKey:clean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  geminiApiKey:clean(process.env.GEMINI_API_KEY),
  geminiModel:clean(process.env.GEMINI_MODEL),
  groqApiKey:clean(process.env.GROQ_API_KEY),
  groqModel:clean(process.env.GROQ_MODEL),
  corsOrigin:clean(process.env.CORS_ORIGIN)||'http://localhost:5173',
  googlePlacesApiKey:clean(process.env.GOOGLE_PLACES_API_KEY),
  googleEnrichmentLimitPerCategory:Number(clean(process.env.GOOGLE_ENRICHMENT_LIMIT_PER_CATEGORY))||8,
  googleEnrichmentConcurrency:Number(clean(process.env.GOOGLE_ENRICHMENT_CONCURRENCY))||5,
  amadeusClientId:clean(process.env.AMADEUS_CLIENT_ID),
  amadeusClientSecret:clean(process.env.AMADEUS_CLIENT_SECRET),
  amadeusBaseUrl:clean(process.env.AMADEUS_BASE_URL)||'https://test.api.amadeus.com',
  tavilyApiKey:clean(process.env.TAVILY_API_KEY),
};

if(env.supabaseUrl){
  try{
    const parsed=new URL(env.supabaseUrl);
    if(!/\.supabase\.co$/i.test(parsed.hostname)&&!/localhost|127\.0\.0\.1/.test(parsed.hostname)) console.warn(`[env] SUPABASE_URL hostname "${parsed.hostname}" doesn't look like a *.supabase.co project URL.`);
  }catch{if(isProduction)throw new Error('[env] SUPABASE_URL is not a valid URL.');console.warn('[env] SUPABASE_URL is not a valid URL.')}
}

if(!env.amadeusClientId||!env.amadeusClientSecret) console.warn('[env] Amadeus credentials are missing — /api/flights/search will remain unavailable.');
