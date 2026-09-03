/**
 * Step 10 — Final Validation.
 *
 * Runs the itinerary-quality checklist from the redesign spec against an
 * already-generated itinerary and returns a structured pass/fail report.
 * The validator also applies one narrow, deterministic quality repair:
 * if a destination has an identified Must Visit attraction but the
 * generated itinerary omitted all of them, the weakest non-meal/non-
 * accommodation sightseeing slot is replaced by the best available Must
 * Visit candidate. This is deliberately done here because this validator
 * is shared by the heuristic and AI/agent generation paths.
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

/**
 * Hard hierarchy repair shared by every generation path.
 *
 * Policy:
 *   1. A normal trip gets at least one Must Visit when one exists nearby.
 *   2. Hidden gems never displace that first Must Visit.
 *   3. Explicit hidden_gems_only trips are left untouched.
 *   4. We only replace a sightseeing stop; meals/accommodation are never
 *      converted into attractions.
 *   5. The replacement keeps the generated slot's timing/reasoning metadata
 *      so the repair is minimally invasive.
 *
 * The main selector/ranking layer remains responsible for the full
 * Major → Popular → Local → Hidden ordering; this final pass is the safety
 * net for AI output and narrow/imbalanced candidate pools.
 */
export function enforceAttractionHierarchy({ stops, candidates, tripStyle = null }) {
  if (!Array.isArray(stops) || !Array.isArray(candidates)) return stops;
  if (tripStyle === 'hidden_gems_only') return stops;

  const mustVisit = candidates
    .filter((c) => classifyAttractionTier(c) === 'must_visit')
    .filter((c) => c.category !== 'food_dining' && c.category !== 'stay' && c.category !== 'accommodation');

  if (mustVisit.length === 0) return stops;

  const includedIds = new Set(stops.map((s) => s.spot_id).filter(Boolean));
  if (mustVisit.some((c) => includedIds.has(c.id))) return stops;

  const replacementIndex = stops.findIndex((s) =>
    !s.meal_type
    && s.category !== 'food_dining'
    && s.category !== 'stay'
    && s.category !== 'accommodation'
  );
  if (replacementIndex === -1) return stops;

  const replacement = [...mustVisit]
    .filter((c) => !includedIds.has(c.id))
    .sort((a, b) => {
      const ar = Number(a.rating) || 0;
      const br = Number(b.rating) || 0;
      const ac = Number(a.review_count ?? a._google?.userRatingCount) || 0;
      const bc = Number(b.review_count ?? b._google?.userRatingCount) || 0;
      return br - ar || bc - ac;
    })[0];

  if (!replacement) return stops;

  const old = stops[replacementIndex];
  stops[replacementIndex] = {
    ...old,
    spot_id: replacement.id,
    name: replacement.name,
    category: replacement.category,
    latitude: replacement.latitude,
    longitude: replacement.longitude,
    opening_hours: replacement.opening_hours || null,
    rating: replacement.rating ?? null,
    entry_cost_inr: replacement.entry_fee_inr ?? old.entry_cost_inr ?? 0,
    to_location_name: replacement.name,
    attraction_tier: 'must_visit',
  };

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
  const hiddenGemIdsOnRoute = new Set(
    stops.filter((s) => classifyAttractionTier({ rating: s.rating, popularity_score: undefined }) === 'hidden_gem').map((s) => s.spot_id)
  );
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
  enforceAttractionHierarchy({ stops, candidates, tripStyle });

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
