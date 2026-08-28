/**
 * Phase 1, Step 7 — RAG test harness.
 *
 * Runs the required RAG test queries with a safe delay between
 * embedding requests so Gemini's embedding RPM limit is not
 * hammered.
 *
 * Also runs two negative-control checks:
 *   - juice shop must NOT retrieve shopping malls
 *   - shopping mall must NOT retrieve juice shops
 *
 * Run:
 *   node scripts/testRag.js
 */

import {
  retrieveKbContext,
  extractFiltersFromQuery,
  normalizeQuery,
} from '../src/services/rag.service.js';

import { isSupabaseConfigured } from '../src/config/supabase.js';

// ------------------------------------------------------------
// Test queries
// ------------------------------------------------------------

const QUERIES = [
  'peaceful places in Chennai',
  'peaceful places in Guindy',
  'beaches in Chennai',
  'hidden gems in Chennai',
  'cafes in Chennai',
  'juice shops in Chennai',
  'shopping malls in Chennai',
  'places for parents',
  'budget food in Chennai',
  'museums in Chennai',
];

// ------------------------------------------------------------
// Gemini embedding rate-limit protection
// ------------------------------------------------------------
//
// Gemini Embedding 1 has a limited requests-per-minute quota.
// We deliberately space out test queries.
//
// 15 seconds between requests ≈ 4 requests/minute,
// which is far below the 100 RPM limit shown in AI Studio.
//

const DELAY_BETWEEN_QUERIES_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------
// Output
// ------------------------------------------------------------

function printResult(query, filters, results) {
  console.log(`\n--- "${query}" ---`);

  console.log(
    `normalized: "${normalizeQuery(query)}"`
  );

  console.log(
    `filters used: ${JSON.stringify(filters)}`
  );

  console.log(
    `retrieved: ${results.length}`
  );

  results.slice(0, 5).forEach((r, i) => {
    console.log(
      `  ${i + 1}. ${r.title} ` +
        `[${r.category}${
          r.subcategory
            ? '/' + r.subcategory
            : ''
        }]` +
        ` city=${r.city || '-'}` +
        ` locality=${r.locality || '-'}` +
        ` sim=${
          r.similarity?.toFixed(3) || '-'
        }` +
        ` source=${r.source}` +
        ` dataset=${r.dataset || '-'}`
    );
  });
}

// ------------------------------------------------------------
// Single query
// ------------------------------------------------------------

async function runQuery(query) {
  const filters =
    extractFiltersFromQuery(query);

  const results =
    await retrieveKbContext(query, {
      limit: 5,
      autoDetectFilters: true,
    });

  printResult(
    query,
    filters,
    results
  );

  return results;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

async function main() {
  if (!isSupabaseConfigured) {
    console.error(
      'Supabase is not configured — cannot run retrieval tests.'
    );

    process.exit(1);
  }

  console.log(
    `Running ${QUERIES.length} RAG queries with ` +
      `${DELAY_BETWEEN_QUERIES_MS / 1000}s delay between requests...`
  );

  // ----------------------------------------------------------
  // Main test queries
  // ----------------------------------------------------------

  for (let i = 0; i < QUERIES.length; i += 1) {
    const q = QUERIES[i];

    await runQuery(q);

    // Don't delay after the final query.
    if (i < QUERIES.length - 1) {
      console.log(
        `Waiting ${
          DELAY_BETWEEN_QUERIES_MS / 1000
        }s before next embedding request...`
      );

      await sleep(
        DELAY_BETWEEN_QUERIES_MS
      );
    }
  }

  // ----------------------------------------------------------
  // Negative controls
  // ----------------------------------------------------------

  console.log(
    '\n=== Negative-control checks (Step 4) ==='
  );

  let failed = false;

  // ----------------------------------------------------------
  // Juice shop → must not return mall
  // ----------------------------------------------------------

  await sleep(
    DELAY_BETWEEN_QUERIES_MS
  );

  const juice =
    await retrieveKbContext(
      'juice shop',
      {
        limit: 5,
        autoDetectFilters: true,
      }
    );

  if (
    juice.some(
      (r) =>
        r.subcategory === 'malls' ||
        /mall/i.test(r.title)
    )
  ) {
    console.error(
      'FAIL: "juice shop" query retrieved a shopping mall.'
    );

    failed = true;
  } else {
    console.log(
      'PASS: "juice shop" did not retrieve shopping malls.'
    );
  }

  // ----------------------------------------------------------
  // Shopping mall → must not return juice shop
  // ----------------------------------------------------------

  await sleep(
    DELAY_BETWEEN_QUERIES_MS
  );

  const mall =
    await retrieveKbContext(
      'shopping mall',
      {
        limit: 5,
        autoDetectFilters: true,
      }
    );

  if (
    mall.some(
      (r) =>
        r.subcategory === 'juice shop'
    )
  ) {
    console.error(
      'FAIL: "shopping mall" query retrieved a juice shop.'
    );

    failed = true;
  } else {
    console.log(
      'PASS: "shopping mall" did not retrieve juice shops.'
    );
  }

  // ----------------------------------------------------------
  // Final status
  // ----------------------------------------------------------

  if (failed) {
    console.error(
      '\nRAG test completed with failures.'
    );

    process.exit(1);
  }

  console.log(
    '\nAll checks completed successfully.'
  );
}

main().catch((err) => {
  console.error(
    '\nRAG test harness error:',
    err.message
  );

  process.exit(1);
});