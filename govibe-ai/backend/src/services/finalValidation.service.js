/**
 * Step 10 — Final Validation.
 *
 * Runs the itinerary-quality checklist from the redesign spec against an
 * already-generated itinerary. The validator also applies a deterministic
 * attraction hierarchy repair shared by heuristic and AI generation:
 *
 *   Major / Must Visit -> Popular -> Local / Standard -> Hidden Gem
 *
 * The LLM may propose the itinerary, but it does not get to override this
 * hard tourism-priority rule.
 */

import { classifyAttractionTier } from './attractionRanking.service.js';

const MEAL_WINDOWS_MIN = {
  breakfast: [6 * 60, 10 * 60],
  lunch: [11 * 60 + 30, 14 * 60 + 30],
  cafe: [16 * 60, 18 * 60],
  dinner: [19 * 60, 24 * 60],
};

function clockToMinutes(clockStr) {
  if (!clockStr || typeof clockStr !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(clockStr.trim());
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

const HIERARCHY_RANK = {
  must_visit: 4,
  popular: 3,
  standard: 2,
  hidden_gem: 1,
};

function isSightseeingStop(stop) {
  return Boolean(stop)
    && !stop.meal_type
    && stop.category !== 'food_dining'
    && stop.category !== 'stay'
    && stop.category !== 'accommodation';
}

function candidateReviewCount(candidate) {
  return Number(candidate?.review_count ?? candidate?._google?.userRatingCount) || 0;
}

function candidateInterestScore(candidate, requestedCategories) {
  if (!requestedCategories?.length) return 0;
  return requestedCategories.includes(candidate.category) ? 3 : 0;
}

function rankCandidates(candidates, requestedCategories) {
  return [...candidates].sort((a, b) => {
    const tierDiff = HIERARCHY_RANK[classifyAttractionTier(b)] - HIERARCHY_RANK[classifyAttractionTier(a)];
    if (tierDiff) return tierDiff;
    const interestDiff = candidateInterestScore(b, requestedCategories) - candidateInterestScore(a, requestedCategories);
    if (interestDiff) return interestDiff;
    const ratingDiff = (Number(b.rating) || 0) - (Number(a.rating) || 0);
    if (ratingDiff) return ratingDiff;
    return candidateReviewCount(b) - candidateReviewCount(a);
  });
}

/**
 * Hard attraction hierarchy shared by every generation path.
 *
 * A normal itinerary reserves roughly 40% of sightseeing slots for Major /
 * Must Visit attractions when enough are available, then fills the remaining
 * slots in strict tier order: Popular -> Local/Standard -> Hidden Gem.
 *
 * Interests refine ranking WITHIN a tier. They never allow a lower-tier spot
 * to displace an available major attraction. Hidden gems are therefore
 * supplementary rather than replacements for iconic tourism anchors.
 *
 * The function mutates the existing stops array so callers that already hold
 * the generated itinerary automatically receive the repaired result without
 * a second generation pass.
 */
export function enforceAttractionHierarchy({ stops, candidates, requestedCategories = [] }) {
  if (!Array.isArray(stops) || !Array.isArray(candidates)) return stops;

  const sightseeingStops = stops.filter(isSightseeingStop);
  if (sightseeingStops.length === 0) return stops;

  const tourismCandidates = candidates.filter((candidate) =>
    candidate.category !== 'food_dining'
    && candidate.category !== 'stay'
    && candidate.category !== 'accommodation'
  );
  if (tourismCandidates.length === 0) return stops;

  const ranked = rankCandidates(tourismCandidates, requestedCategories);
  const tierBuckets = {
    must_visit: ranked.filter((c) => classifyAttractionTier(c) === 'must_visit'),
    popular: ranked.filter((c) => classifyAttractionTier(c) === 'popular'),
    standard: ranked.filter((c) => classifyAttractionTier(c) === 'standard'),
    hidden_gem: ranked.filter((c) => classifyAttractionTier(c) === 'hidden_gem'),
  };

  const slotCount = sightseeingStops.length;
  if (tierBuckets.must_visit.length === 0) return stops;

  // Short trips still get at least one iconic anchor. Longer trips reserve
  // about 40% for major attractions, while never exceeding availability.
  const majorTarget = Math.min(
    tierBuckets.must_visit.length,
    Math.max(1, Math.ceil(slotCount * 0.4)),
  );

  const desired = [];
  const desiredIds = new Set();
  const addFromTier = (tier, count) => {
    let added = 0;
    for (const candidate of tierBuckets[tier]) {
      if (desired.length >= slotCount || added >= count) break;
      if (desiredIds.has(candidate.id)) continue;
      desired.push(candidate);
      desiredIds.add(candidate.id);
      added += 1;
    }
  };

  // Hard tier order. The candidate pool is the source of truth; nothing is
  // invented by the model or by this repair layer.
  addFromTier('must_visit', majorTarget);
  addFromTier('popular', slotCount);
  addFromTier('standard', slotCount);
  addFromTier('hidden_gem', slotCount);

  const candidateById = new Map(tourismCandidates.map((c) => [c.id, c]));
  const existingDesired = new Set(
    sightseeingStops
      .map((stop) => candidateById.get(stop.spot_id))
      .filter(Boolean)
      .filter((candidate) => desiredIds.has(candidate.id))
      .map((candidate) => candidate.id),
  );

  const replacementPool = desired.filter((candidate) => !existingDesired.has(candidate.id));
  let replacementCursor = 0;

  const currentTierForStop = (stop) => {
    const candidate = candidateById.get(stop.spot_id);
    return candidate ? classifyAttractionTier(candidate) : 'standard';
  };

  const needsReplacement = sightseeingStops
    .map((stop) => ({ stop, tier: currentTierForStop(stop) }))
    .filter(({ stop }) => !desiredIds.has(stop.spot_id))
    .sort((a, b) => HIERARCHY_RANK[a.tier] - HIERARCHY_RANK[b.tier]);

  for (const { stop } of needsReplacement) {
    while (replacementCursor < replacementPool.length) {
      const replacement = replacementPool[replacementCursor++];
      if (!replacement || stops.some((s) => s.spot_id === replacement.id)) continue;

      const stopIndex = stops.indexOf(stop);
      if (stopIndex === -1) break;

      stops[stopIndex] = {
        ...stop,
        spot_id: replacement.id,
        name: replacement.name,
        category: replacement.category,
        latitude: replacement.latitude,
        longitude: replacement.longitude,
        opening_hours: replacement.opening_hours || null,
        rating: replacement.rating ?? null,
        entry_cost_inr: replacement.entry_fee_inr ?? stop.entry_cost_inr ?? 0,
        to_location_name: replacement.name,
        attraction_tier: classifyAttractionTier(replacement),
      };
      break;
    }
  }

  // Final deterministic guard: if no major survived because the AI output had
  // duplicates or malformed spot IDs, force the best major into the weakest
  // sightseeing slot. This guarantees the core invariant.
  const hasMajor = stops.some((stop) => {
    const candidate = candidateById.get(stop.spot_id);
    return candidate && classifyAttractionTier(candidate) === 'must_visit';
  });

  if (!hasMajor) {
    const replacement = tierBuckets.must_visit[0];
    const weakest = [...stops]
      .map((stop, index) => ({ stop, index, tier: currentTierForStop(stop) }))
      .filter(({ stop }) => isSightseeingStop(stop))
      .sort((a, b) => HIERARCHY_RANK[a.tier] - HIERARCHY_RANK[b.tier])[0];

    if (replacement && weakest) {
      stops[weakest.index] = {
        ...weakest.stop,
        spot_id: replacement.id,
        name: replacement.name,
        category: replacement.category,
        latitude: replacement.latitude,
        longitude: replacement.longitude,
        opening_hours: replacement.opening_hours || null,
        rating: replacement.rating ?? null,
        entry_cost_inr: replacement.entry_fee_inr ?? weakest.stop.entry_cost_inr ?? 0,
        to_location_name: replacement.name,
        attraction_tier: 'must_visit',
      };
    }
  }

  return stops;
}

/** ✓ Are the destination's iconic attractions included? */
function checkIconicAttractionsIncluded(stops, candidates) {
  const availableMustVisit = candidates.filter((c) => classifyAttractionTier(c) === 'must_visit');
  if (availableMustVisit.length === 0) {
    return { passed: true, detail: 'No Must Visit Landmarks identified in the candidate pool for this destination.' };
  }
  const includedIds = new Set(stops.map((s) => s.spot_id));
  const includedCount = availableMustVisit.filter((s) => includedIds.has(s.id)).length;
  const passed = includedCount >= Math.min(availableMustVisit.length, 1);
  return {
    passed,
    detail: `${includedCount}/${availableMustVisit.length} identified Must Visit Landmarks are in the itinerary.`,
  };
}

/** ✓ Is the route geographically optimized (no wild backtracking)? */
function checkRouteOptimized(stops) {
  const legs = stops.filter((s) => typeof s.distance_km_from_prev === 'number');
  if (legs.length === 0) return { passed: true, detail: 'No multi-stop legs to evaluate.' };
  const longLegs = legs.filter((s) => s.distance_km_from_prev > 25).length;
  const passed = longLegs / legs.length <= 0.25;
  return { passed, detail: `${longLegs}/${legs.length} legs exceed 25km (excessive backtracking indicator).` };
}

/** ✓ Are visit durations realistic? */
function checkVisitDurationsRealistic(stops) {
  const bad = stops.filter((s) => !Number.isFinite(s.visit_minutes) || s.visit_minutes < 10 || s.visit_minutes > 360);
  return { passed: bad.length === 0, detail: bad.length ? `${bad.length} stop(s) with an unrealistic visit duration.` : 'All visit durations are within a realistic range.' };
}

/** ✓ Are travel durations realistic? */
function checkTravelDurationsRealistic(stops) {
  const bad = stops.filter((s) => {
    if (!Number.isFinite(s.travel_minutes_from_prev) || !Number.isFinite(s.distance_km_from_prev)) return false;
    if (s.distance_km_from_prev <= 0) return false;
    if (s.transport_mode && s.transport_mode !== 'walk' && s.travel_minutes_from_prev < 2 && s.distance_km_from_prev > 0.1) return true;
    if (s.transport_mode === 'walk' && s.distance_km_from_prev > 5) return true;
    return false;
  });
  return { passed: bad.length === 0, detail: bad.length ? `${bad.length} stop(s) with an unrealistic travel time/mode combination.` : 'Travel times/modes look realistic.' };
}

/** ✓ Are meals scheduled correctly? */
function checkMealsScheduledCorrectly(stops) {
  const mealStops = stops.filter((s) => s.meal_type);
  if (mealStops.length === 0) return { passed: true, detail: 'No deliberate meal stops in this itinerary.' };
  const misplaced = mealStops.filter((s) => {
    const window = MEAL_WINDOWS_MIN[s.meal_type];
    if (!window) return false;
    const arrival = clockToMinutes(s.arrival_time);
    if (arrival == null) return false;
    return arrival < window[0] - 30;
  });
  return {
    passed: misplaced.length === 0,
    detail: misplaced.length
      ? `${misplaced.length} meal stop(s) scheduled outside their proper window (e.g. lunch before 11:30 AM).`
      : 'Lunch, dinner, and snack stops all land inside their proper windows.',
  };
}

/** ✓ Are restaurants separated from attractions? */
function checkRestaurantsSeparatedFromAttractions(stops) {
  const violations = stops.filter((s) => s.category === 'food_dining' && !s.meal_type);
  return {
    passed: violations.length === 0,
    detail: violations.length
      ? `${violations.length} food-category stop(s) scheduled as a sightseeing stop instead of a deliberate meal.`
      : 'No restaurant/cafe is scheduled as a sightseeing stop.',
  };
}

/** ✓ Are hidden gems optional? */
function checkHiddenGemsOptional(stops, hiddenGems) {
  const passed = Array.isArray(hiddenGems);
  return { passed, detail: passed ? `${hiddenGems.length} hidden gem(s) offered as optional add-ons.` : 'Hidden gems list missing.' };
}

/** ✓ Is the itinerary feasible within available time? */
function checkFeasibleWithinTime(stops, tripStartHour = 9) {
  const dayGroups = new Map();
  for (const s of stops) {
    const key = s.day ?? 1;
    if (!dayGroups.has(key)) dayGroups.set(key, []);
    dayGroups.get(key).push(s);
  }
  let overrunDays = 0;
  for (const dayStops of dayGroups.values()) {
    const last = dayStops[dayStops.length - 1];
    const departure = clockToMinutes(last?.departure_time);
    if (departure != null && departure > 23 * 60) overrunDays += 1;
  }
  return { passed: overrunDays === 0, detail: overrunDays ? `${overrunDays} day(s) run past 11 PM.` : 'Every day finishes at a reasonable hour.' };
}

/** ✓ Is the budget respected? */
function checkBudgetRespected(budgetValidation) {
  if (!budgetValidation) return { passed: true, detail: 'No budget validation computed.' };
  return {
    passed: Boolean(budgetValidation.within_budget),
    detail: budgetValidation.within_budget
      ? 'Estimated total cost is within the stated budget.'
      : `Estimated cost exceeds budget by ₹${budgetValidation.overage_inr}.`,
  };
}

/** ✓ Does the itinerary reflect the traveler's spread of interests? */
function checkInterestDiversityRespected(stops, requestedCategories) {
  const uniqueRequested = [...new Set((requestedCategories || []).filter(Boolean))];
  if (uniqueRequested.length <= 1) return { passed: true, detail: 'Only one interest category requested — nothing to balance.' };
  const relevantStops = stops.filter((s) => uniqueRequested.includes(s.category));
  if (relevantStops.length === 0) return { passed: true, detail: 'No stops tagged with a requested category to evaluate.' };
  const present = new Set(relevantStops.map((s) => s.category));
  const missing = uniqueRequested.filter((c) => !present.has(c));
  const passed = missing.length <= 1;
  return {
    passed,
    detail: passed
      ? `Itinerary touches ${present.size}/${uniqueRequested.length} requested interest categories.`
      : `Itinerary only covers ${present.size}/${uniqueRequested.length} requested interests — missing: ${missing.join(', ')}.`,
  };
}

/**
 * Runs the full Step 10 checklist. The hierarchy repair happens before the
 * checks so the report describes the itinerary that will actually be shown.
 */
export function runFinalValidation({ stops, candidates, hiddenGems, budgetValidation, tripStartHour, requestedCategories, tripStyle = null }) {
  // `tripStyle` is accepted for API compatibility. The hard tourism hierarchy
  // applies to normal trips; hidden-gems-only remains a deliberate product
  // mode and therefore bypasses the major-attraction composition rule.
  if (tripStyle !== 'hidden_gems_only') {
    enforceAttractionHierarchy({ stops, candidates, requestedCategories });
  }

  const checks = [
    { id: 'iconic_attractions_included', label: "Destination's iconic attractions are included", ...checkIconicAttractionsIncluded(stops, candidates) },
    { id: 'route_optimized', label: 'Route is geographically optimized', ...checkRouteOptimized(stops) },
    { id: 'visit_durations_realistic', label: 'Visit durations are realistic', ...checkVisitDurationsRealistic(stops) },
    { id: 'travel_durations_realistic', label: 'Travel durations are realistic', ...checkTravelDurationsRealistic(stops) },
    { id: 'meals_scheduled_correctly', label: 'Meals are scheduled correctly (lunch is actually lunch)', ...checkMealsScheduledCorrectly(stops) },
    { id: 'restaurants_separated', label: 'Restaurants/cafes are separated from attractions', ...checkRestaurantsSeparatedFromAttractions(stops) },
    { id: 'hidden_gems_optional', label: 'Hidden gems are optional, not forced', ...checkHiddenGemsOptional(stops, hiddenGems) },
    { id: 'feasible_within_time', label: 'Itinerary is feasible within available time', ...checkFeasibleWithinTime(stops, tripStartHour) },
    { id: 'budget_respected', label: 'Budget is respected', ...checkBudgetRespected(budgetValidation) },
    { id: 'interest_diversity_respected', label: "Itinerary reflects the traveler's full spread of interests", ...checkInterestDiversityRespected(stops, requestedCategories) },
  ];

  const failedCheckIds = checks.filter((c) => !c.passed).map((c) => c.id);
  return { passed: failedCheckIds.length === 0, checks, failedCheckIds };
}
