#!/usr/bin/env node
/**
 * Diagnostic script — NOT part of the app.
 *
 * Tries a raw insert into "itineraries" using the service role key directly,
 * completely separate from the rest of the app's code, to check whether the
 * service role key itself can bypass RLS on your Supabase project.
 *
 * HOW TO RUN:
 *   1. Copy this file into your backend/ folder (same level as package.json).
 *   2. Run: node testInsert.js <a-real-trip-id>
 *      (use a trip_id you already created — check it in the Supabase Table
 *      Editor under the "trips" table, or from a previous POST /api/trips
 *      response)
 *   3. Read the output.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const tripId = process.argv[2];

if (!tripId) {
  console.error('Usage: node testInsert.js <a-real-trip-id>');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in your .env');
  process.exit(1);
}

console.log('Using project URL:', url);
console.log('Service role key length:', key.length);

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data, error } = await supabase
  .from('itineraries')
  .insert({
    trip_id: tripId,
    version: 999,
    stops: [],
    budget_summary: {},
    generated_by: 'debug-test',
  })
  .select()
  .single();

if (error) {
  console.log('\n❌ INSERT FAILED');
  console.log('message:', error.message);
  console.log('details:', error.details);
  console.log('hint:', error.hint);
  console.log('code:', error.code);
} else {
  console.log('\n✅ INSERT SUCCEEDED');
  console.log(data);
  console.log('\n(You can delete this test row from the Supabase Table Editor afterwards.)');
}
