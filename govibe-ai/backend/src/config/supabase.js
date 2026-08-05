import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

export const isSupabaseConfigured = Boolean(
  env.supabaseUrl && (env.supabaseServiceRoleKey || env.supabaseAnonKey)
);

// Standard client (using Service Role Key if available, or Anon Key)
export const supabase = isSupabaseConfigured
  ? createClient(
      env.supabaseUrl,
      env.supabaseServiceRoleKey || env.supabaseAnonKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )
  : null;

// Admin client specifically using Service Role Key to bypass RLS
export const supabaseAdmin = isSupabaseConfigured
  ? createClient(
      env.supabaseUrl,
      env.supabaseServiceRoleKey || env.supabaseAnonKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )
  : null;