import { env } from './env.js';

/**
 * Central, tunable constants for the Google-Places-enrichment + attraction
 * ranking pipeline. Keeping these in one file (rather than scattering magic
 * numbers across services) is what lets the weights be retuned after
 * testing without hunting through attractionRanking.service.js,
 * spotMatching.service.js, and itineraryEngine.service.js.
 */

// ---- Multi-factor attraction ranking weights ---------------------------
// Approximate starting weights from the product spec (sum to 1.0).
// `interestMatch`, `familiarity`, `quality`, and `categoryDiversityContext`
// are applied directly inside attractionRanking.service.js's
// computeAttractionWeight(). `timeOpeningHours`, `routeEfficiency`, and
// `budgetFit` are NOT duplicated there — they're already enforced by other
// existing stages of the pipeline (finalValidation.service.js /
// routing.service.js's opening-hours + ordering logic, the distance-bonus
// tie-breaker in rankAttractionsByImportance/scoreSpot, and
// budget.service.js's feasibility checks respectively). They're listed
// here anyway so every factor from the spec has one obvious, documented
// home and a single place to retune it.
export const RANKING_WEIGHTS = {
  interestMatch: 0.35,
  familiarity: 0.20,
  quality: 0.10,
  timeOpeningHours: 0.15,          // enforced downstream — see comment above
  routeEfficiency: 0.10,           // enforced downstream — see comment above
  budgetFit: 0.05,                 // enforced downstream — see comment above
  categoryDiversityContext: 0.05,  // heritage/context signal, applied in computeAttractionWeight
};

// ---- Google Places (New) enrichment ------------------------------------
// How many of the top candidates PER CATEGORY get sent to Google for
// familiarity/quality enrichment — never the full raw OSM candidate pool.
export const GOOGLE_ENRICHMENT_LIMIT_PER_CATEGORY = env.googleEnrichmentLimitPerCategory;
// Max concurrent in-flight Google Places (New) requests (bounded
// Promise.all, not unlimited parallel requests).
export const GOOGLE_ENRICHMENT_CONCURRENCY = env.googleEnrichmentConcurrency;
// A Google Text Search result more than this far (km) from the OSM
// candidate's own coordinates is rejected as "clearly a different place",
// even if the name looks similar.
export const GOOGLE_ENRICHMENT_MATCH_MAX_KM = 2;
// Minimum composite (name-similarity + distance) confidence required to
// accept a Google result as a match at all.
export const GOOGLE_ENRICHMENT_MIN_MATCH_CONFIDENCE = 0.5;

// ---- Familiar-anchor + hidden-gem mix -----------------------------------
// Target share of a trip's attraction stops (meals excluded) that may be
// hidden gems once anchors are chosen. Configurable per spec Part 8.
export const HIDDEN_GEM_TARGET_RATIO_MIN = 0.20;
export const HIDDEN_GEM_TARGET_RATIO_MAX = 0.30;