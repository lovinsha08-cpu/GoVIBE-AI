import { haversineKm } from './geo.service.js';
import { computeAttractionWeight, classifyAttractionTier } from './attractionRanking.service.js';

// Subcategory keywords that read as "scenic/photogenic" — used to boost
// the Scenic & Photography trip style and the Photography interest, which
// are cross-cutting rather than tied to one spot.category.
const SCENIC_SUBCATEGORY_KEYWORDS = [
  'viewpoint', 'sunset', 'sunrise', 'beach', 'lake', 'waterfall', 'hill',
  'architecture', 'heritage walk', 'garden',
];

function isScenicSpot(spot) {
  const sub = (spot.subcategory || '').toLowerCase();
  return SCENIC_SUBCATEGORY_KEYWORDS.some((kw) => sub.includes(kw)) || spot.category === 'nature';
}

function isLowCostSpot(spot) {
  const fee = Number(spot.entry_fee_inr) || 0;
  return fee <= 100;
}

function isPremiumSpot(spot) {
  const fee = Number(spot.entry_fee_inr) || 0;
  return fee >= 300 || (Number(spot.rating) || 0) >= 4.6;
}

function isHiddenGemSpot(spot) {
  const rating = Number(spot.rating) || 0;
  const popularity = spot.popularity_score != null ? Number(spot.popularity_score) : 0.5;
  return rating >= 4.0 && popularity <= 0.4;
}

/**
 * Per-Trip-Style scoring boosts. Each function returns a score delta (can
 * be negative) applied on top of the base interest/rating/proximity score,
 * so a Trip Style meaningfully reshapes which spots get picked instead of
 * just tweaking pacing after the fact.
 */
const TRIP_STYLE_BOOSTS = {
  fast_paced: (spot) => ((Number(spot.rating) || 0) >= 4.0 ? 0.5 : 0),
  relaxed: (spot) => (['relaxation', 'nature'].includes(spot.category) ? 1 : 0),
  scenic: (spot) => (isScenicSpot(spot) ? 3 : 0),
  food_explorer: (spot) => (spot.category === 'food' ? 3 : 0),
  family_friendly: (spot) => {
    if (spot.category === 'family') return 3;
    if (spot.category === 'nightlife') return -3; // avoid overly tiring / adult-oriented stops
    return 0;
  },
  budget_friendly: (spot) => (isLowCostSpot(spot) ? 2 : -1.5),
  luxury: (spot) => (isPremiumSpot(spot) ? 2.5 : 0),
  hidden_gems_only: (spot) => (isHiddenGemSpot(spot) ? 4 : -2),
};

/**
 * Scores a spot's relevance to a trip based on interest match, rating,
 * proximity to the destination anchor point, and the traveler's chosen
 * Trip Style. Higher is better.
 */
export function scoreSpot(spot, { interests = [], anchor, maxRadiusKm = 60, tripStyle = null }) {
  let score = 0;

  const interestCategories = new Set(interests.map((i) => i.category));
  const interestSubcats = new Set(interests.flatMap((i) => i.subcategories || []));

  if (interestCategories.has(spot.category)) score += 3;
  if (spot.subcategory && interestSubcats.has(spot.subcategory)) score += 2;
  // "Photography" and "Hidden Gems" interests are cross-cutting — they
  // don't map to a single spot.category, so they're matched by trait.
  if (interestSubcats.has('Scenic Viewpoints') || interestSubcats.has('Sunrise Spots') || interestSubcats.has('Sunset Spots') || interestSubcats.has('Architecture') || interestSubcats.has('Instagram-worthy Places')) {
    if (isScenicSpot(spot)) score += 2;
  }
  if (interestCategories.has('hidden_gems') && isHiddenGemSpot(spot)) score += 2;

  score += (Number(spot.rating) || 0) * 0.6;

  // Multi-factor tourist-importance weighting (Step 4): tourist importance,
  // rating, review volume, and historical/heritage significance, on top of
  // the simpler interest/rating scoring above. This is what lets a famous
  // landmark outrank a closer-but-minor spot instead of distance deciding
  // everything. Scaled up (x6) so it carries real weight against the
  // largely-integer bumps above.
  score += computeAttractionWeight(spot, { interestCategories, interestSubcats }) * 6;

  if (tripStyle && TRIP_STYLE_BOOSTS[tripStyle]) {
    score += TRIP_STYLE_BOOSTS[tripStyle](spot);
  }

  if (anchor) {
    const dist = haversineKm(anchor.lat, anchor.lng, spot.latitude, spot.longitude);
    if (dist > maxRadiusKm) return -1; // out of range, exclude
    // closer spots score slightly higher, tapering off — kept as a
    // relatively small tie-breaker so proximity alone can't beat out a
    // Must Visit Landmark the way it used to.
    score += Math.max(0, (maxRadiusKm - dist) / maxRadiusKm) * 1.2;
  }

  return score;
}

/**
 * Selects and ranks the best spots for a trip from a candidate pool,
 * shaped by the traveler's Trip Style (see TRIP_STYLE_BOOSTS above).
 */
export function selectSpots(candidateSpots, { interests, anchor, limit = 8, tripStyle = null }) {
  return candidateSpots
    .map((spot) => ({ spot, score: scoreSpot(spot, { interests, anchor, tripStyle }) }))
    .filter((s) => s.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.spot);
}

/**
 * Selects the main route/sightseeing spots for a trip (Part 5/6/8):
 * `stay` never competes for a route slot, `shopping` only competes when the
 * traveler actually wants it, and `food` is excluded from the ranked pool
 * entirely unless the traveler wants it featured (Food Explorer style or a
 * "food" interest) — plain meal breaks are scheduled separately and
 * deliberately by the itinerary engine, not picked by this ranking. Even
 * when food is featured, its share of the route is capped so attractions
 * stay the majority of a "typical" day (Part 6's ~70–80%) rather than
 * flooding the plan.
 */
export function selectBalancedSpots(candidateSpots, {
  interests, anchor, limit = 8, tripStyle = null, includeShopping = true, featureFood = false,
} = {}) {
  const pool = candidateSpots.filter((s) => {
    if (s.category === 'stay') return false;
    if (s.category === 'shopping' && !includeShopping) return false;
    if (s.category === 'food' && !featureFood) return false;
    return true;
  });

  const scored = pool
    .map((spot) => ({ spot, score: scoreSpot(spot, { interests, anchor, tripStyle }), tier: classifyAttractionTier(spot) }))
    .filter((s) => s.score >= 0)
    .sort((a, b) => b.score - a.score);

  // Guarantee: a destination's iconic Must Visit Landmarks are never
  // dropped in favor of lower-value spots just because the pool is large.
  // They're seated first (still in score order among themselves), then the
  // remaining slots are filled by the normal ranked list. This directly
  // addresses "iconic attractions are missing while less important places
  // are selected."
  const mustVisit = scored.filter((s) => s.tier === 'must_visit');
  const rest = scored.filter((s) => s.tier !== 'must_visit');

  if (!featureFood) {
    const seated = mustVisit.slice(0, limit).map((s) => s.spot);
    const remainingSlots = Math.max(0, limit - seated.length);
    const seatedIds = new Set(seated.map((s) => s.id));
    for (const { spot } of rest) {
      if (seated.length >= limit) break;
      if (seatedIds.has(spot.id)) continue;
      seated.push(spot);
    }
    return seated;
  }

  const maxFoodStops = Math.max(1, Math.round(limit * 0.4));
  const result = [];
  let foodCount = 0;
  const orderedByPriority = [...mustVisit, ...rest];
  for (const { spot } of orderedByPriority) {
    if (result.length >= limit) break;
    if (spot.category === 'food') {
      if (foodCount >= maxFoodStops) continue;
      foodCount += 1;
    }
    if (result.some((r) => r.id === spot.id)) continue;
    result.push(spot);
  }
  return result;
}

/**
 * Hidden gems: low popularity_score but high rating — the "guidebooks skip it" spots.
 */
export function findHiddenGems(candidateSpots, { anchor, maxRadiusKm = 60, limit = 6 } = {}) {
  return candidateSpots
    .filter((s) => {
      const rating = Number(s.rating) || 0;
      const popularity = s.popularity_score != null ? Number(s.popularity_score) : 0.5;
      if (rating < 4.0 || popularity > 0.4) return false;
      if (anchor) {
        const dist = haversineKm(anchor.lat, anchor.lng, s.latitude, s.longitude);
        if (dist > maxRadiusKm) return false;
      }
      return true;
    })
    .sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0))
    .slice(0, limit);
}

/** One-line reason a spot qualifies as a hidden gem, for display next to it. */
export function hiddenGemReason(spot) {
  const rating = Number(spot.rating) || 0;
  const popularity = spot.popularity_score != null ? Number(spot.popularity_score) : 0.5;
  if (popularity <= 0.15) {
    return `Rated ${rating.toFixed(1)}★ by visitors but almost never crowded — most tourists miss it.`;
  }
  if (popularity <= 0.3) {
    return `Rated ${rating.toFixed(1)}★ with a fraction of the footfall of the big-name spots nearby.`;
  }
  return `Rated ${rating.toFixed(1)}★ — well-loved locally, but rarely on tourist itineraries.`;
}

/**
 * Finds the nearest spot in a given category to an anchor point, for
 * "restaurant near this stop" style recommendations. Returns null if none
 * within maxRadiusKm.
 */
export function nearestInCategory(candidateSpots, category, anchor, { maxRadiusKm = 3, exclude = new Set() } = {}) {
  let best = null;
  let bestDist = Infinity;
  for (const s of candidateSpots) {
    if (s.category !== category) continue;
    if (exclude.has(s.id)) continue;
    const dist = haversineKm(anchor.lat, anchor.lng, s.latitude, s.longitude);
    if (dist <= maxRadiusKm && dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best ? { spot: best, distanceKm: Math.round(bestDist * 10) / 10 } : null;
}

/**
 * Splits the genuine-tourist candidate pool into the "route pool" (the
 * places a day's sightseeing is actually built from) and food spots kept
 * aside for deliberate meal scheduling (Part 6/7). Keeping food out of the
 * main scoring pool is what stops restaurants/cafés from competing with —
 * and crowding out — attractions for route slots; they're added back in
 * on purpose at meal time instead. `stay` is always excluded from the route
 * pool (accommodation isn't a sightseeing stop). Shopping is excluded
 * unless the traveler actually wants it (Part 8).
 */
export function splitRouteAndMealPools(candidateSpots, { includeShopping = true } = {}) {
  const routePool = candidateSpots.filter((s) => {
    if (s.category === 'stay' || s.category === 'food') return false;
    if (s.category === 'shopping' && !includeShopping) return false;
    return true;
  });
  const mealPool = candidateSpots.filter((s) => s.category === 'food');
  return { routePool, mealPool };
}

/**
 * Reorders a list so that no two consecutive items share the same
 * "variety key" (subcategory, falling back to category) wherever a swap
 * later in the list can fix it — Part 9's "avoid Café → Café, Museum →
 * Museum" rule. This is a light local reshuffle, not a re-rank: it only
 * swaps items already in the list, so the geographic/route ordering done
 * upstream (nearest-neighbor, etc.) is preserved as much as possible.
 */
export function diversifyConsecutive(items, keyFn) {
  const list = [...items];
  for (let i = 1; i < list.length; i++) {
    const prevKey = keyFn(list[i - 1]);
    if (keyFn(list[i]) !== prevKey) continue;
    const nextKey = i + 1 < list.length ? keyFn(list[i + 1]) : null;
    const swapIdx = list.findIndex((it, j) => {
      if (j <= i) return false;
      const k = keyFn(it);
      return k !== prevKey && k !== nextKey;
    });
    if (swapIdx !== -1) {
      [list[i], list[swapIdx]] = [list[swapIdx], list[i]];
    }
  }
  return list;
}