import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

export const isSupabaseConfigured = Boolean(
  env.supabaseUrl && (env.supabaseServiceRoleKey || env.supabaseAnonKey)
);

// Give every Supabase request a hard timeout instead of letting it hang
// indefinitely when the project is paused or the host is unreachable.
// Without this, a network-level stall can look identical to a slow
// response until something else (e.g. a client timeout) eventually gives up.
function fetchWithTimeout(timeoutMs = 8000) {
  return (input, init = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };
}

const clientOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  global: {
    fetch: fetchWithTimeout(8000),
  },
};

// Standard client (using Service Role Key if available, or Anon Key)
export const supabase = isSupabaseConfigured
  ? createClient(env.supabaseUrl, env.supabaseServiceRoleKey || env.supabaseAnonKey, clientOptions)
  : null;

// Admin client specifically using Service Role Key to bypass RLS
export const supabaseAdmin = isSupabaseConfigured
  ? createClient(env.supabaseUrl, env.supabaseServiceRoleKey || env.supabaseAnonKey, clientOptions)
  : null;

// One-time startup check: hit Supabase's auth health endpoint directly so
// a bad SUPABASE_URL / paused project / no-internet server shows up in the
// logs immediately at boot, with the *actual* underlying cause, rather than
// waiting for the first user signup/login to hit the generic 503.
export async function checkSupabaseConnection() {
  if (!isSupabaseConfigured) {
    console.warn('[supabase] Not configured — SUPABASE_URL/keys are missing. Auth endpoints will fail until backend/.env is set.');
    return;
  }

  const healthUrl = `${env.supabaseUrl.replace(/\/+$/, '')}/auth/v1/health`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    // /auth/v1/ is a protected route — Supabase's gateway requires the
    // `apikey` header on every request to it (this is true even for the
    // health endpoint) and returns 401 without one, regardless of whether
    // the project/keys are otherwise fine. The check below was previously
    // sending no headers at all, so it *always* logged a 401 here even on
    // a perfectly healthy project — which is why login (via supabase-js,
    // which does send this header automatically) kept succeeding right
    // next to this warning. Sending the key here makes the check actually
    // mean something instead of being permanently red.
    const apiKey = env.supabaseServiceRoleKey || env.supabaseAnonKey;
    const res = await fetch(healthUrl, {
      headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (res.ok) {
      console.log(`[supabase] Connected OK (${healthUrl})`);
    } else {
      console.error(
        `[supabase] Reached Supabase but got HTTP ${res.status} from ${healthUrl}. ` +
        `If this is 401/403, check SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY match this project. ` +
        `If it's a 5xx, the project may be paused — check the Supabase dashboard.`
      );
    }
  } catch (err) {
    const cause = err?.cause?.code || err?.code || err?.name || err?.message || 'unknown error';
    if (err?.name === 'AbortError') {
      console.error(
        `[supabase] Connection to ${healthUrl} timed out after 8s. ` +
        `This usually means either the Supabase project is paused, or this server has no outbound internet access. ` +
        `Test manually with: curl -I ${healthUrl}`
      );
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(cause)) {
      console.error(
        `[supabase] DNS lookup failed for ${healthUrl} (${cause}). ` +
        `SUPABASE_URL is likely wrong, or this server can't resolve external DNS. ` +
        `Double-check SUPABASE_URL in backend/.env has no typo or stray character.`
      );
    } else if (/ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(cause)) {
      console.error(
        `[supabase] Could not reach ${healthUrl} (${cause}). ` +
        `This server likely has no outbound internet access, or a firewall is blocking it.`
      );
    } else {
      console.error(`[supabase] Startup connectivity check failed for ${healthUrl}:`, cause);
    }
  }
}