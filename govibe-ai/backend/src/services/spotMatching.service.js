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
  return SCENIC_SUBCATEGORY_KEYWORDS.some((kw) => sub.includes(kw))
    || spot.category === 'nature_scenic'
    || spot.category === 'photography_landmarks';
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
  relaxed: (spot) => (['wellness_leisure', 'nature_scenic'].includes(spot.category) ? 1 : 0),
  scenic: (spot) => (isScenicSpot(spot) ? 3 : 0),
  food_explorer: (spot) => (spot.category === 'food_dining' ? 3 : 0),
  family_friendly: (spot) => {
    if (['wildlife', 'entertainment_recreation'].includes(spot.category)) return 3;
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
    if (s.category === 'food_dining' && !featureFood) return false;
    return true;
  });

  const scored = pool
    .map((spot) => ({ spot, score: scoreSpot(spot, { interests, anchor, tripStyle }), tier: classifyAttractionTier(spot) }))
    .filter((s) => s.score >= 0)
    // A small random jitter breaks near-ties before sorting. Without it,
    // scoring is fully deterministic, so hitting "Regenerate itinerary"
    // on the heuristic path (used whenever Gemini is unavailable or
    // fails) returned the exact same stops every time — which looked
    // exactly like the regenerate button "not working". The jitter is
    // small enough that a genuinely stronger spot still wins; it only
    // reshuffles spots that were already close in quality.
    .sort((a, b) => (b.score + Math.random() * 0.6) - (a.score + Math.random() * 0.6));

  const maxFoodStops = featureFood ? Math.max(1, Math.round(limit * 0.4)) : Infinity;
  const seated = [];
  const seatedIds = new Set();
  let foodCount = 0;

  // Per-subcategory cap (Part 9 follow-up): without this, a strong-scoring
  // narrow subcategory — most commonly "Shopping Malls" — can win several
  // of the "fill remaining slots" seats in Step 2 below purely on rating,
  // producing a route with two or three malls instead of one mall + a
  // market + a bookstore etc. "Repeatable experience" categories
  // (shopping) get a tight cap of 1 per subcategory so the exact same
  // kind of stop can't recur; everything else gets a looser cap of 2.
  // Spots with no subcategory tag at all are exempt from the cap — a lot
  // of live/seeded data doesn't always carry a subcategory, and grouping
  // every untagged spot in a category into one bucket would starve that
  // whole category down to 1-2 stops for no good reason.
  const subcategoryCounts = new Map();
  const subcategoryCap = (spot) => (spot.category === 'shopping' ? 1 : 2);
  const subcategoryKey = (spot) => (spot.subcategory ? `${spot.category}::${spot.subcategory}` : null);

  // Per-category cap across the WHOLE selection (Part 9 fix): the
  // subcategory cap above only stops one narrow subcategory (e.g. one
  // specific "Shopping Malls" bucket) from repeating — it does nothing to
  // stop shopping as a whole category from quietly eating every remaining
  // seat in Steps 2/3 whenever it out-scores the traveler's other
  // interests (which real-world data skews toward: malls are numerous and
  // well-reviewed in a city like Chennai, while e.g. genuine nature spots
  // near a dense urban destination are comparatively rare). When the
  // traveler picked more than one interest, no single category may take
  // more than a fair share of the route, so a multi-interest trip always
  // comes back touching most/all of what was picked instead of one
  // category (typically shopping) crowding the rest out.
  const requestedCategoriesForCap = [...new Set((interests || []).map((i) => i.category).filter(Boolean))];
  const categoryCap = requestedCategoriesForCap.length > 1
    ? Math.max(2, Math.ceil(limit / requestedCategoriesForCap.length) + 1)
    : Infinity;
  const categoryCounts = new Map();

  const trySeat = (spot, { enforceCap = true, enforceCategoryCap = true } = {}) => {
    if (!spot || seatedIds.has(spot.id) || seated.length >= limit) return false;
    if (spot.category === 'food_dining' && foodCount >= maxFoodStops) return false;
    if (enforceCategoryCap && requestedCategoriesForCap.includes(spot.category)) {
      const catCount = categoryCounts.get(spot.category) || 0;
      if (catCount >= categoryCap) return false;
    }
    const key = subcategoryKey(spot);
    if (enforceCap && key) {
      const cap = subcategoryCap(spot);
      const count = subcategoryCounts.get(key) || 0;
      if (count >= cap) return false;
    }
    if (spot.category === 'food_dining') foodCount += 1;
    if (key) subcategoryCounts.set(key, (subcategoryCounts.get(key) || 0) + 1);
    categoryCounts.set(spot.category, (categoryCounts.get(spot.category) || 0) + 1);
    seated.push(spot);
    seatedIds.add(spot.id);
    return true;
  };

  // Step 1 — interest coverage guarantee: before filling the route purely
  // by overall score (which can let one or two strong categories crowd
  // out everything else), seat the best-scoring spot for every interest
  // category the traveler actually picked, in the order they picked
  // them — then, room permitting, a *second* spot for that same category
  // as long as it's a different subcategory (so "shopping" can surface a
  // mall AND a market instead of just one lonely stop). This is what
  // ensures a trip with several selected interests comes back touching
  // (almost) all of them, each with a genuine spread rather than a single
  // token stop, while still respecting the shopping/food opt-in rules and
  // the overall stop limit.
  const requestedCategories = [...new Set((interests || []).map((i) => i.category).filter(Boolean))];
  for (const category of requestedCategories) {
    if (seated.length >= limit) break;
    if (category === 'food_dining' && !featureFood) continue; // meals scheduled separately, not as a route "interest" slot
    if (category === 'shopping' && !includeShopping) continue;
    const candidatesForCategory = scored.filter((s) => s.spot.category === category && !seatedIds.has(s.spot.id));
    const first = candidatesForCategory[0];
    if (first) trySeat(first.spot);
    if (seated.length >= limit) break;
    const second = candidatesForCategory.find((s) => !seatedIds.has(s.spot.id));
    if (second) trySeat(second.spot);
  }

  // Step 2 — fill remaining slots, favoring subcategory diversity. Iconic
  // Must Visit Landmarks are never dropped in favor of lower-value spots
  // just because the pool is large: they're seated first (still in score
  // order among themselves), then the rest of the ranked list fills
  // whatever's left.
  const mustVisit = scored.filter((s) => s.tier === 'must_visit');
  const rest = scored.filter((s) => s.tier !== 'must_visit');
  for (const { spot } of [...mustVisit, ...rest]) {
    if (seated.length >= limit) break;
    trySeat(spot);
  }

  // Step 3a — round-robin guarantee-fill: if the subcategory cap above
  // left slots empty, refill by cycling through the traveler's requested
  // categories one spot at a time (still respecting the per-category cap,
  // just not the subcategory cap) instead of draining straight down the
  // overall score-sorted list — which is what used to backfill an entire
  // itinerary with more shopping the moment other interests ran short on
  // genuine nearby candidates.
  if (seated.length < limit && requestedCategoriesForCap.length > 1) {
    let progress = true;
    while (seated.length < limit && progress) {
      progress = false;
      for (const category of requestedCategoriesForCap) {
        if (seated.length >= limit) break;
        if (category === 'food_dining' && !featureFood) continue;
        if (category === 'shopping' && !includeShopping) continue;
        const next = scored.find((s) => s.spot.category === category && !seatedIds.has(s.spot.id));
        if (next && trySeat(next.spot, { enforceCap: false })) progress = true;
      }
    }
  }

  // Step 3b — relaxed guarantee-fill: LOOSEN the diversity caps instead of
  // removing them outright. The old version of this step dropped every
  // cap — including the per-category one — the moment slots were still
  // empty, which is exactly what let a single abundant category (almost
  // always shopping malls, since they're numerous and well-reviewed in a
  // dense city like Chennai) quietly swallow every remaining seat and
  // produce a "9 malls, 0 temples/parks/restaurants" itinerary even though
  // the traveler picked several other interests. Padding the trip with
  // *more of an already-abundant category* is a worse outcome for the
  // traveler than a shorter itinerary that stays genuinely varied, so this
  // step only widens the caps a bit (one extra subcategory seat, and up to
  // ~60% of the trip for a single category) rather than lifting them.
  if (seated.length < limit) {
    const relaxedCategoryCap = requestedCategoriesForCap.length > 1
      ? Math.max(categoryCap, Math.ceil(limit * 0.6))
      : Infinity;
    for (const { spot } of [...mustVisit, ...rest]) {
      if (seated.length >= limit) break;
      if (seatedIds.has(spot.id)) continue;
      if (requestedCategoriesForCap.includes(spot.category)) {
        const catCount = categoryCounts.get(spot.category) || 0;
        if (catCount >= relaxedCategoryCap) continue;
      }
      const key = subcategoryKey(spot);
      if (key) {
        const cap = subcategoryCap(spot) + 1; // one extra seat of leeway
        const count = subcategoryCounts.get(key) || 0;
        if (count >= cap) continue;
      }
      trySeat(spot, { enforceCap: false, enforceCategoryCap: false });
    }
  }

  // Step 3c — absolute last resort: every cap fully lifts only if the
  // itinerary would otherwise come back with nothing (or almost nothing)
  // usable at all — never just to top up an already-varied route to an
  // exact stop count.
  if (seated.length === 0) {
    for (const { spot } of [...mustVisit, ...rest]) {
      if (seated.length >= limit) break;
      trySeat(spot, { enforceCap: false, enforceCategoryCap: false });
    }
  }

  return seated;
}

/**
 * Fallback selection for when the traveler's chosen interests genuinely
 * don't match anything near the destination (e.g. they picked "beach" for
 * a landlocked hill town). Rather than failing the whole itinerary, this
 * surfaces the area's most famous/well-rated genuine tourist attractions —
 * ranked by tier (Must Visit Landmark first, then Popular, then Hidden
 * Gem/standard) and rating — regardless of interest match, so the
 * traveler still gets a real, usable itinerary for the destination they
 * asked for. Still respects the shopping opt-in and applies the same
 * subcategory diversity cap (with a guarantee-fill fallback) as
 * `selectBalancedSpots`.
 */
export function selectFallbackFamousSpots(candidateSpots, { anchor, limit = 8, includeShopping = true, maxRadiusKm = 60 } = {}) {
  const pool = candidateSpots.filter((s) => {
    if (s.category === 'stay' || s.category === 'food_dining') return false;
    if (s.category === 'shopping' && !includeShopping) return false;
    return true;
  });

  const tierRank = { must_visit: 3, popular: 2, hidden_gem: 1, standard: 0 };
  const scored = pool.map((spot) => {
    const tier = classifyAttractionTier(spot);
    const rating = Number(spot.rating) || 0;
    let distanceBonus = 0;
    if (anchor && Number.isFinite(spot.latitude) && Number.isFinite(spot.longitude)) {
      const dist = haversineKm(anchor.lat, anchor.lng, spot.latitude, spot.longitude);
      // No hard distance cutoff here (unlike the interest-matched path) —
      // if the destination's genuine spots are all slightly outside the
      // usual radius, still surface the closest famous ones rather than
      // returning nothing; distance only nudges the ranking.
      distanceBonus = Math.max(0, (maxRadiusKm - dist) / maxRadiusKm) * 1.2;
    }
    return { spot, tier, score: (tierRank[tier] || 0) * 10 + rating + distanceBonus };
  }).sort((a, b) => b.score - a.score);

  const seated = [];
  const seatedIds = new Set();
  const subcategoryCounts = new Map();
  const subcategoryCap = (spot) => (spot.category === 'shopping' ? 1 : 2);
  const subcategoryKey = (spot) => (spot.subcategory ? `${spot.category}::${spot.subcategory}` : null);

  for (const { spot } of scored) {
    if (seated.length >= limit) break;
    if (seatedIds.has(spot.id)) continue;
    const key = subcategoryKey(spot);
    if (key) {
      const count = subcategoryCounts.get(key) || 0;
      if (count >= subcategoryCap(spot)) continue;
      subcategoryCounts.set(key, count + 1);
    }
    seated.push(spot);
    seatedIds.add(spot.id);
  }
  // Guarantee-fill: never return fewer than the pool can support just
  // because of the diversity cap.
  if (seated.length < limit) {
    for (const { spot } of scored) {
      if (seated.length >= limit) break;
      if (seatedIds.has(spot.id)) continue;
      seated.push(spot);
      seatedIds.add(spot.id);
    }
  }

  return seated;
}

/**
 * Diversity safety net for the Gemini/AI-generated itinerary path (Part 9
 * follow-up). The heuristic path (selectBalancedSpots above) enforces a
 * hard per-category cap while it's choosing stops; the Gemini path never
 * did — it only asks the model, via the prompt, to diversify, then runs
 * `diversifyConsecutive` locally, which can only swap items that already
 * differ from their neighbors. If the model still returns a day (or a
 * whole trip) that's uniformly one category — the exact "9 stops, 9
 * shopping malls" failure mode — there's nothing already in the list to
 * swap with, so it goes out unfixed. This applies the same category-cap
 * logic as the heuristic path directly to Gemini's output, swapping any
 * stop over the cap for the best-scoring unused candidate from one of the
 * traveler's other requested categories, so both generation paths give
 * the same diversity guarantee.
 */
export function capStopsByCategory(stops, candidates, requestedCategories, { anchor } = {}) {
  const uniqueCategories = [...new Set((requestedCategories || []).filter(Boolean))];
  if (uniqueCategories.length <= 1 || stops.length === 0) return stops;

  const limit = stops.length;
  const categoryCap = Math.max(2, Math.ceil(limit * 0.6));
  const usedIds = new Set(stops.map((s) => s.spot_id).filter(Boolean));
  const categoryCounts = new Map();
  for (const s of stops) categoryCounts.set(s.category, (categoryCounts.get(s.category) || 0) + 1);

  // Build a ranked pool of unused candidates per under-represented requested
  // category, so an overflowing stop has something genuine to swap for.
  const replacementsByCategory = new Map();
  for (const category of uniqueCategories) {
    const pool = candidates
      .filter((c) => c.category === category && !usedIds.has(c.id))
      .map((spot) => ({ spot, score: scoreSpot(spot, { anchor }) }))
      .sort((a, b) => b.score - a.score);
    replacementsByCategory.set(category, pool);
  }

  return stops.map((stop) => {
    const count = categoryCounts.get(stop.category) || 0;
    if (count <= categoryCap || !uniqueCategories.includes(stop.category)) return stop;

    // This stop is past its category's fair share — look for a replacement
    // from a requested category that's currently under-represented.
    const underRepresented = uniqueCategories
      .filter((c) => c !== stop.category && (categoryCounts.get(c) || 0) < categoryCap)
      .sort((a, b) => (categoryCounts.get(a) || 0) - (categoryCounts.get(b) || 0));

    for (const candidateCategory of underRepresented) {
      const pool = replacementsByCategory.get(candidateCategory);
      const next = pool && pool.shift();
      if (next) {
        categoryCounts.set(stop.category, count - 1);
        categoryCounts.set(candidateCategory, (categoryCounts.get(candidateCategory) || 0) + 1);
        usedIds.delete(stop.spot_id);
        usedIds.add(next.spot.id);
        return {
          ...stop,
          spot_id: next.spot.id,
          name: next.spot.name,
          category: next.spot.category,
          latitude: next.spot.latitude,
          longitude: next.spot.longitude,
          entry_cost_inr: Number(next.spot.entry_fee_inr) || 0,
          rating: next.spot.rating ?? null,
          opening_hours: next.spot.opening_hours || null,
          reasoning: `Swapped in for variety — matches your ${candidateCategory.replace('_', ' ')} interest.`,
        };
      }
    }
    return stop; // no genuine alternative available anywhere nearby — leave as-is
  });
}

/**
 * Hidden gems: low popularity_score but high rating — the "guidebooks skip it" spots.
 *
 * The Explore page's Hidden Gems filter groups every spot.category into
 * five broad, traveler-facing buckets rather than exposing the full
 * ~14-value internal category enum — a traveler browsing hidden gems
 * thinks in terms of "nature" or "food", not "photography_landmarks" vs
 * "wildlife". Keep this list and HIDDEN_GEM_CATEGORY_KEYS in sync with the
 * frontend's copy in frontend/src/lib/hiddenGemCategories.js.
 */
export const HIDDEN_GEM_CATEGORY_GROUPS = [
  {
    key: 'nature',
    label: 'Nature & Outdoors',
    categories: ['nature_scenic', 'wildlife', 'sports_adventure'],
  },
  {
    key: 'food',
    label: 'Food & Cafés',
    categories: ['food_dining'],
  },
  {
    key: 'culture',
    label: 'Culture & Heritage',
    categories: ['heritage_historical', 'religious_spiritual', 'arts_culture', 'science_learning'],
  },
  {
    key: 'shopping',
    label: 'Shopping & Local Life',
    categories: ['shopping'],
  },
  {
    key: 'offbeat',
    label: 'Offbeat & Leisure',
    categories: ['photography_landmarks', 'wellness_leisure', 'entertainment_recreation', 'nightlife'],
  },
];

const HIDDEN_GEM_CATEGORY_MAP = new Map(HIDDEN_GEM_CATEGORY_GROUPS.map((g) => [g.key, new Set(g.categories)]));

/**
 * @param {string} categoryGroup - one of HIDDEN_GEM_CATEGORY_GROUPS[].key, or falsy for "all".
 */
export function findHiddenGems(candidateSpots, { anchor, maxRadiusKm = 60, limit = 6, categoryGroup = null } = {}) {
  const allowedCategories = categoryGroup ? HIDDEN_GEM_CATEGORY_MAP.get(categoryGroup) : null;
  return candidateSpots
    .filter((s) => {
      const rating = Number(s.rating) || 0;
      const popularity = s.popularity_score != null ? Number(s.popularity_score) : 0.5;
      if (rating < 4.0 || popularity > 0.4) return false;
      if (allowedCategories && !allowedCategories.has(s.category)) return false;
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
 * within maxRadiusKm. `subcategories`, when given, restricts the search to
 * spots whose subcategory is in that list (e.g. only "Cafés" for a snack
 * slot, or only "Restaurants" for lunch/dinner) — this is what stops a
 * café from being picked as the lunch stop just because it's the nearest
 * food_dining spot.
 */
export function nearestInCategory(candidateSpots, category, anchor, { maxRadiusKm = 3, exclude = new Set(), subcategories = null } = {}) {
  let best = null;
  let bestDist = Infinity;
  for (const s of candidateSpots) {
    if (s.category !== category) continue;
    if (exclude.has(s.id)) continue;
    if (subcategories && subcategories.length && !subcategories.includes(s.subcategory)) continue;
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
    if (s.category === 'stay' || s.category === 'food_dining') return false;
    if (s.category === 'shopping' && !includeShopping) return false;
    return true;
  });
  const mealPool = candidateSpots.filter((s) => s.category === 'food_dining');
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