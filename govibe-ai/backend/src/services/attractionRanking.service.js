/**
 * Attraction Ranking & Classification.
 *
 * Replaces "closest first" selection with a proper multi-factor ranking so
 * famous, iconic attractions are always prioritized over minor/low-value
 * places that merely happen to be nearby — and so every candidate spot is
 * tagged with a stable classification tier the rest of the pipeline
 * (route builder, hidden-gem module, final validation) can rely on.
 *
 * Tiers (every genuine tourist spot gets exactly one):
 *   - must_visit_landmark : the iconic, "you-can't-skip-this" attractions
 *   - popular_attraction  : well-known, well-rated, but not a must-see icon
 *   - hidden_gem          : great but low-footfall/under-the-radar
 *   - standard            : everything else that still cleared the tourist filter
 *   - restaurant / cafe / shopping / transport / accommodation
 *       non-sightseeing categories — these never compete for a sightseeing slot.
 */

const NON_SIGHTSEEING_CATEGORY_TIER = {
  food: null, // split into 'restaurant' vs 'cafe' below via subcategory
  shopping: 'shopping',
  stay: 'accommodation',
};

const CAFE_SUBCATEGORY_KEYWORDS = ['cafe', 'café', 'coffee', 'bakery', 'tea house', 'tea stall'];

/** Heritage/UNESCO-flavoured keywords checked across subcategory + description, since most
 *  spot sources don't carry a dedicated UNESCO boolean field. */
const HERITAGE_SIGNIFICANCE_KEYWORDS = [
  'unesco', 'world heritage', 'heritage site', 'archaeological', 'ancient',
  'dynasty', 'centuries old', 'centuries-old', 'monument of national importance',
];

const ICONIC_SUBCATEGORY_KEYWORDS = [
  'forts & palaces', 'monuments', 'temples', 'unesco', 'world heritage',
];

/** True if this is a genuine sightseeing category (i.e. eligible for tier classification at all). */
function isSightseeingCategory(spot) {
  return !['food', 'shopping', 'stay'].includes(spot.category);
}

/** Maps a spot to exactly one of the 8 classification labels required by the product spec. */
export function classifyPlaceType(spot) {
  if (spot.category === 'stay') return 'accommodation';
  if (spot.category === 'shopping') return 'shopping';
  if (spot.category === 'food') {
    const sub = (spot.subcategory || '').toLowerCase();
    const name = (spot.name || '').toLowerCase();
    const isCafe = CAFE_SUBCATEGORY_KEYWORDS.some((kw) => sub.includes(kw) || name.includes(kw));
    return isCafe ? 'cafe' : 'restaurant';
  }
  if (spot.category === 'transport') return 'transport';

  const tier = classifyAttractionTier(spot);
  if (tier === 'must_visit') return 'Must Visit Landmark';
  if (tier === 'hidden_gem') return 'Hidden Gem';
  return 'Popular Attraction';
}

/**
 * Tier classification for sightseeing spots only. Uses rating + popularity
 * (footfall proxy) + review-volume-derived importance + heritage keyword
 * signals, since raw distance says nothing about how iconic a place is.
 */
export function classifyAttractionTier(spot) {
  if (!isSightseeingCategory(spot)) return null;

  const rating = Number(spot.rating) || 0;
  const popularity = spot.popularity_score != null ? Number(spot.popularity_score) : 0.5;
  const reviewCount = Number(spot.review_count) || 0;
  const heritageSignal = hasHeritageSignificance(spot);

  // Must Visit Landmark: high rating AND high footfall/importance (or an explicit
  // heritage/UNESCO signal on a strong-rating place) — the "everyone goes here" tier.
  if ((rating >= 4.4 && popularity >= 0.75) || (heritageSignal && rating >= 4.3) || reviewCount >= 8000) {
    return 'must_visit';
  }

  // Hidden Gem: rated well by the people who do visit, but low footfall.
  if (rating >= 4.0 && popularity <= 0.4) {
    return 'hidden_gem';
  }

  if (rating >= 3.8 || popularity >= 0.5) {
    return 'popular';
  }

  return 'standard';
}

function hasHeritageSignificance(spot) {
  const haystack = `${spot.subcategory || ''} ${spot.description || ''}`.toLowerCase();
  if (spot.category === 'heritage' && ICONIC_SUBCATEGORY_KEYWORDS.some((kw) => (spot.subcategory || '').toLowerCase().includes(kw))) {
    return true;
  }
  return HERITAGE_SIGNIFICANCE_KEYWORDS.some((kw) => haystack.includes(kw));
}

/**
 * Multi-factor weighted score for ranking sightseeing candidates. Distance
 * is deliberately given the smallest weight of the group — a famous
 * landmark 6km away should still usually outrank a forgettable spot 500m
 * away, matching "the algorithm should always prioritize famous attractions
 * first."
 *
 * Weights (sum to 1.0 across the "importance" factors, distance applied as
 * a separate bounded bonus so it can never fully cancel out importance):
 *   - tourist_importance (popularity_score)      0.30
 *   - google_rating                              0.20
 *   - review_count (log-scaled)                  0.15
 *   - historical_cultural_importance (heritage)   0.15
 *   - user_interest_match                         0.20
 */
export function computeAttractionWeight(spot, { interestCategories = new Set(), interestSubcats = new Set() } = {}) {
  const rating = Number(spot.rating) || 0;
  const popularity = spot.popularity_score != null ? Number(spot.popularity_score) : 0.5;
  const reviewCount = Number(spot.review_count) || 0;

  const touristImportance = popularity; // 0-1
  const ratingScore = rating / 5; // 0-1
  const reviewScore = Math.min(1, Math.log10(reviewCount + 1) / 4); // ~0 at 0 reviews, 1 around 10k+
  const heritageScore = hasHeritageSignificance(spot) ? 1 : (spot.category === 'heritage' ? 0.5 : 0);

  let interestScore = 0;
  if (interestCategories.has(spot.category)) interestScore += 0.7;
  if (spot.subcategory && interestSubcats.has(spot.subcategory)) interestScore += 0.3;
  interestScore = Math.min(1, interestScore);

  const weighted =
    touristImportance * 0.30 +
    ratingScore * 0.20 +
    reviewScore * 0.15 +
    heritageScore * 0.15 +
    interestScore * 0.20;

  // Must Visit Landmarks get a flat bonus on top of the weighted score so
  // they consistently surface above "popular" or "standard" tier spots
  // even when a lesser spot has a slightly closer proximity bonus applied
  // downstream.
  const tier = classifyAttractionTier(spot);
  const tierBonus = tier === 'must_visit' ? 0.35 : tier === 'popular' ? 0.1 : tier === 'hidden_gem' ? 0.05 : 0;

  return Math.round((weighted + tierBonus) * 1000) / 1000; // 0 - ~1.35
}

/**
 * Ranks candidate sightseeing spots by importance-first weighted score,
 * then applies a bounded distance-from-anchor adjustment as a tie-breaker
 * rather than the primary sort key. Returns spots annotated with
 * `_tier` and `_weight` for downstream use (selection guarantees, display).
 */
export function rankAttractionsByImportance(spots, { interests = [], anchor, maxRadiusKm = 60 } = {}) {
  const interestCategories = new Set(interests.map((i) => i.category));
  const interestSubcats = new Set(interests.flatMap((i) => i.subcategories || []));

  return spots
    .map((spot) => {
      const weight = computeAttractionWeight(spot, { interestCategories, interestSubcats });
      let distanceBonus = 0;
      let outOfRange = false;
      if (anchor && Number.isFinite(spot.latitude) && Number.isFinite(spot.longitude)) {
        const dist = haversine(anchor.lat, anchor.lng, spot.latitude, spot.longitude);
        if (dist > maxRadiusKm) outOfRange = true;
        // Small, capped bonus (max ~0.15) so proximity can break ties between
        // similarly-important spots without ever outweighing a Must Visit tier.
        distanceBonus = Math.max(0, (maxRadiusKm - dist) / maxRadiusKm) * 0.15;
      }
      return {
        ...spot,
        _tier: classifyAttractionTier(spot),
        _weight: weight + distanceBonus,
        _outOfRange: outOfRange,
      };
    })
    .filter((s) => !s._outOfRange)
    .sort((a, b) => b._weight - a._weight);
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}