/**
 * Canonical RAG knowledge-document model (Phase 1, Step 2).
 *
 * Every RAG document — regardless of whether it started life as a spot
 * (backend/src/data/sampleSpots.json, itself generated from
 * backend/datasets/*.csv), a verified `businesses` row, or a hand-written
 * FAQ/platform doc — is normalized into this one shape before embedding
 * and insertion into `kb_documents`:
 *
 *   { id, title, content, city, locality, category, subcategory, tags,
 *     latitude, longitude, rating, source, dataset,
 *     family_friendly, peaceful, hidden_gem, budget_level, audience }
 *
 * `id` is assigned by Postgres (uuid default) on insert — not set here.
 *
 * IMPORTANT: nothing in this file invents tourism data. Every field is
 * either copied directly from an existing record, or *derived* from fields
 * that already exist on that record using the exact same heuristics the
 * itinerary engine already uses (so a place classified "hidden gem" here
 * matches how spotMatching.service.js would classify it). Those heuristics
 * are duplicated (not imported) to avoid coupling the RAG ingestion path to
 * the itinerary engine's internals — see comments on each function for the
 * mirrored source.
 */

// Mirrors isHiddenGemSpot() in spotMatching.service.js exactly.
export function isHiddenGem({ rating, popularity_score }) {
  const r = Number(rating) || 0;
  const popularity = popularity_score != null ? Number(popularity_score) : 0.5;
  return r >= 4.0 && popularity <= 0.4;
}

// Mirrors isLowCostSpot()/isPremiumSpot() in spotMatching.service.js.
export function budgetLevelOf({ entry_fee_inr, rating }) {
  const fee = Number(entry_fee_inr) || 0;
  const r = Number(rating) || 0;
  if (fee <= 0) return 'free';
  if (fee <= 100) return 'budget';
  if (fee >= 300 || r >= 4.6) return 'premium';
  return 'mid';
}

// Mirrors the `relaxed` trip-style boost category set in
// spotMatching.service.js (['wellness_leisure', 'nature_scenic']), plus
// religious_spiritual — ashrams/temples are a recognized quiet-place
// signal in the same file's category taxonomy — combined with a low
// popularity_score, since a crowded temple or park isn't "peaceful" even
// if its category generally is.
const PEACEFUL_CATEGORIES = new Set(['wellness_leisure', 'nature_scenic', 'religious_spiritual']);
export function isPeaceful({ category, popularity_score }) {
  if (!PEACEFUL_CATEGORIES.has(category)) return false;
  const popularity = popularity_score != null ? Number(popularity_score) : 0.5;
  return popularity <= 0.55;
}

// Mirrors the `family_friendly` trip-style boost in spotMatching.service.js
// (['wildlife', 'entertainment_recreation'] positive, 'nightlife' negative)
// plus science_learning/nature_scenic, which the same file's
// `relaxed`/tier logic already treats as low-intensity, broadly suitable
// categories.
const FAMILY_FRIENDLY_CATEGORIES = new Set([
  'wildlife', 'entertainment_recreation', 'science_learning', 'nature_scenic',
]);
export function isFamilyFriendly({ category }) {
  return FAMILY_FRIENDLY_CATEGORIES.has(category) && category !== 'nightlife';
}

/** Builds the free-text `tags` array used for coarse keyword/array-overlap
 * filtering (metadata filtering, Step 5) — separate from and in addition
 * to semantic embedding search (Step 4 handles synonyms like
 * "peaceful"/"quiet"/"serene" at the embedding level; these tags exist so
 * a caller can also do an exact metadata-level filter). */
export function buildTags(doc) {
  const tags = new Set();
  if (doc.category) tags.add(doc.category);
  if (doc.subcategory) tags.add(doc.subcategory.toLowerCase());
  if (doc.family_friendly) tags.add('family_friendly');
  if (doc.peaceful) tags.add('peaceful');
  if (doc.hidden_gem) tags.add('hidden_gem');
  if (doc.budget_level) tags.add(doc.budget_level);
  return [...tags];
}

/**
 * Normalizes a raw record (spot, business, or hand-written doc) into the
 * canonical shape. `content` and `title` must already be prepared by the
 * caller (they differ enough per-source — a spot vs. a business vs. a
 * platform doc — that a single generic content template would read
 * awkwardly), everything else is filled in here.
 */
export function toCanonicalDocument({
  title,
  content,
  city = null,
  locality = null,
  category = null,
  subcategory = null,
  latitude = null,
  longitude = null,
  rating = null,
  source = null,
  dataset = null,
  audience = 'both',
  family_friendly = false,
  peaceful = false,
  hidden_gem = false,
  budget_level = null,
}) {
  const doc = {
    title, content, city, locality, category, subcategory,
    latitude, longitude, rating, source, dataset, audience,
    family_friendly, peaceful, hidden_gem, budget_level,
  };
  doc.tags = buildTags(doc);
  return doc;
}