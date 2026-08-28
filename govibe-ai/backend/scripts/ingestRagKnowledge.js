/**
 * Phase 1 — RAG ingestion pipeline.
 *
 * Sources:
 * 1. sampleSpots.json
 *    - Tourism
 *    - Shopping
 *
 * 2. businesses table
 *    - Food
 *    - Cafes
 *    - Restaurants
 *    - Juice shops
 *    - Shopping
 *    - Other registered businesses
 *
 * Uses the local BGE embedding model through rag.service.js.
 *
 * Idempotent:
 * Each dataset is cleared before being re-ingested.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import {
  upsertKbDocument,
  clearKbDocumentsByDataset,
} from '../src/services/rag.service.js';

import {
  isSupabaseConfigured,
  supabaseAdmin,
} from '../src/config/supabase.js';

import {
  toCanonicalDocument,
  isHiddenGem,
  isPeaceful,
  isFamilyFriendly,
  budgetLevelOf,
} from '../src/services/ragDocument.model.js';

const __dirname = path.dirname(
  fileURLToPath(import.meta.url)
);

const SAMPLE_SPOTS_PATH = path.join(
  __dirname,
  '..',
  'src',
  'data',
  'sampleSpots.json'
);

// ============================================================
// TOURISM DATA
// ============================================================

const TOURISM_CATEGORIES = new Set([
  'religious_spiritual',
  'heritage_historical',
  'nature_scenic',
  'wildlife',
  'entertainment_recreation',
  'arts_culture',
  'science_learning',
  'photography_landmarks',
]);

function tourismDocFromSpot(spot) {
  const flags = {
    hidden_gem: isHiddenGem(spot),
    peaceful: isPeaceful(spot),
    family_friendly: isFamilyFriendly(spot),
  };

  const budget_level = budgetLevelOf(spot);

  const descriptors = [
    spot.subcategory,
    flags.peaceful
      ? 'a peaceful, low-crowd spot'
      : null,
    flags.hidden_gem
      ? 'a hidden gem (well-rated, low footfall)'
      : null,
    flags.family_friendly
      ? 'family-friendly'
      : null,
    budget_level === 'free'
      ? 'free entry'
      : budget_level === 'budget'
        ? 'budget-friendly'
        : null,
  ]
    .filter(Boolean)
    .join(', ');

  const content = [
    spot.description ||
      `${spot.name} is a ${
        spot.subcategory || spot.category
      } spot in ${spot.city}.`,

    descriptors
      ? `Known for: ${descriptors}.`
      : null,

    spot.rating != null
      ? `Rated ${spot.rating}/5.`
      : null,

    spot.opening_hours
      ? `Hours: ${spot.opening_hours}.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  return toCanonicalDocument({
    title: spot.name,
    content,

    city: spot.city || null,

    category:
      spot.category === 'shopping'
        ? 'shopping'
        : spot.category,

    subcategory:
      spot.subcategory || null,

    latitude:
      spot.latitude ?? null,

    longitude:
      spot.longitude ?? null,

    rating:
      spot.rating ?? null,

    source:
      spot.category === 'shopping'
        ? 'shopping'
        : 'tourism',

    dataset:
      spot.source || 'sampleSpots',

    audience: 'traveler',

    ...flags,

    budget_level,
  });
}

async function ingestTourismAndShopping() {
  const spots = JSON.parse(
    readFileSync(
      SAMPLE_SPOTS_PATH,
      'utf-8'
    )
  );

  const relevant = spots.filter(
    (spot) =>
      TOURISM_CATEGORIES.has(
        spot.category
      ) ||
      spot.category === 'shopping'
  );

  console.log(
    `Found ${relevant.length}/${spots.length} spots in tourism/shopping categories.`
  );

  const byDataset = new Map();

  for (const spot of relevant) {
    const dataset =
      spot.source || 'sampleSpots';

    if (!byDataset.has(dataset)) {
      byDataset.set(dataset, []);
    }

    byDataset
      .get(dataset)
      .push(spot);
  }

  let inserted = 0;

  for (const [dataset, rows] of byDataset) {
    await clearKbDocumentsByDataset(
      dataset
    );

    console.log(
      `[${dataset}] embedding + inserting ${rows.length} docs...`
    );

    for (const spot of rows) {
      try {
        await upsertKbDocument(
          tourismDocFromSpot(spot)
        );

        inserted += 1;
      } catch (err) {
        console.error(
          `  ✗ ${spot.name}: ${err.message}`
        );
      }
    }
  }

  console.log(
    `Tourism/shopping: inserted ${inserted} docs.`
  );
}

// ============================================================
// BUSINESS DATA
// ============================================================

function normalizeBusinessCategory(
  category
) {
  const value = String(
    category || ''
  )
    .trim()
    .toLowerCase();

  if (value === 'food') {
    return 'food_dining';
  }

  if (value === 'shopping') {
    return 'shopping';
  }

  if (value === 'stay') {
    return 'stay';
  }

  return value || 'business';
}

/**
 * Converts existing business_model text into
 * the canonical RAG subcategory.
 *
 * IMPORTANT:
 * "Restaurant / Café" becomes "cafe".
 *
 * We normalize accented characters so:
 *
 * Café
 * café
 * CAFE
 *
 * all become:
 *
 * cafe
 */
function businessSubcategory(biz) {
  const modelText = String(
    biz.business_model || ''
  ).trim();

  const normalized = modelText
    .toLowerCase()
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    );

  if (
    /\bjuice\b/.test(normalized)
  ) {
    return 'juice shop';
  }

  if (
    /\bcafe\b/.test(normalized)
  ) {
    return 'cafe';
  }

  if (
    /\brestaurant\b/.test(normalized)
  ) {
    return 'restaurant';
  }

  if (
    /\bbakery\b/.test(normalized)
  ) {
    return 'bakery';
  }

  if (
    /\bhotel\b/.test(normalized) ||
    /\bhomestay\b/.test(normalized) ||
    /\bhome\s*stay\b/.test(normalized)
  ) {
    return 'hotel';
  }

  if (normalized) {
    return normalized;
  }

  return null;
}

/**
 * Extract city only when it is explicitly present
 * in the existing business location.
 *
 * Examples:
 *
 * Chennai
 * CHENNAI
 * T.Nagar,Chennai
 * kelambakkam,chennai
 *
 * -> Chennai
 */
function extractCityFromLocation(
  location
) {
  const value = String(
    location || ''
  ).trim();

  if (!value) {
    return null;
  }

  if (
    /\bchennai\b/i.test(value)
  ) {
    return 'Chennai';
  }

  return null;
}

/**
 * Extract locality from existing location text.
 *
 * Examples:
 *
 * "T.Nagar,Chennai"
 * -> "T.Nagar"
 *
 * "kelambakkam,chennai"
 * -> "kelambakkam"
 *
 * "velachery"
 * -> "velachery"
 *
 * "Chennai"
 * -> "Chennai"
 */
function extractLocalityFromLocation(
  location
) {
  const value = String(
    location || ''
  ).trim();

  if (!value) {
    return null;
  }

  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 1) {
    return parts[0];
  }

  const nonCityPart = parts.find(
    (part) =>
      !/\bchennai\b/i.test(part)
  );

  return (
    nonCityPart ||
    'Chennai'
  );
}

function businessDoc(biz) {
  const category =
    normalizeBusinessCategory(
      biz.category
    );

  const subcategory =
    businessSubcategory(biz);

  const location =
    biz.location || null;

  const city =
    extractCityFromLocation(
      location
    );

  const locality =
    extractLocalityFromLocation(
      location
    );

  const isVerified =
    biz.verified === true;

  const verificationText =
    isVerified
      ? 'This business is verified on the platform.'
      : 'This business is registered on the platform but is not currently verified.';

  const description =
    biz.description ||
    `${biz.business_name} is a registered ${
      biz.business_model ||
      biz.category ||
      'business'
    }${
      location
        ? ` in ${location}`
        : ''
    }.`;

  const content = [
    description,

    `Category: ${
      biz.category ||
      'unknown'
    }${
      biz.business_model
        ? ` (${biz.business_model})`
        : ''
    }.`,

    verificationText,
  ]
    .filter(Boolean)
    .join(' ');

  return toCanonicalDocument({
    title:
      biz.business_name ||
      'Registered business',

    content,

    city,

    locality,

    category,

    subcategory,

    latitude:
      biz.location_lat ??
      null,

    longitude:
      biz.location_lng ??
      null,

    rating: null,

    source:
      category === 'food_dining'
        ? 'food'
        : category === 'shopping'
          ? 'shopping'
          : 'business',

    dataset:
      'businesses table',

    audience:
      'traveler',

    // The current businesses table
    // has no reliable price field.
    // Do not invent a budget level.
    budget_level: null,
  });
}

async function ingestRegisteredBusinesses() {
  if (!isSupabaseConfigured) {
    console.warn(
      'Supabase not configured — skipping business ingestion.'
    );

    return;
  }

  const {
    data,
    error,
  } = await supabaseAdmin
    .from('businesses')
    .select('*');

  if (error) {
    console.error(
      'Failed to read businesses table:',
      error.message
    );

    return;
  }

  console.log(
    `Found ${data?.length || 0} registered businesses.`
  );

  if (!data?.length) {
    return;
  }

  await clearKbDocumentsByDataset(
    'businesses table'
  );

  let inserted = 0;

  for (const biz of data) {
    try {
      const document =
        businessDoc(biz);

      await upsertKbDocument(
        document
      );

      inserted += 1;

      console.log(
        `  ✓ ${
          biz.business_name ||
          'Unknown business'
        } ` +
        `[${document.category}/${
          document.subcategory ||
          '-'
        }] ` +
        `city=${
          document.city || '-'
        } ` +
        `locality=${
          document.locality || '-'
        }`
      );
    } catch (err) {
      console.error(
        `  ✗ ${
          biz.business_name ||
          'Unknown business'
        }: ${err.message}`
      );
    }
  }

  console.log(
    `Registered businesses: inserted ${inserted} docs.`
  );
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  if (!isSupabaseConfigured) {
    console.error(
      'Supabase is not configured ' +
      '(SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) — aborting.'
    );

    process.exit(1);
  }

  await ingestTourismAndShopping();

  await ingestRegisteredBusinesses();

  console.log(
    'Done. Run `node scripts/seedKnowledgeBase.js` separately for GoVIBE FAQs/platform docs if not already seeded.'
  );
}

main().catch((err) => {
  console.error(
    'RAG ingestion failed:',
    err
  );

  process.exit(1);
});