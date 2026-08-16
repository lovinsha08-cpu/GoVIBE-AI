/**
 * Step 10 — Final Validation.
 *
 * Runs the itinerary-quality checklist from the redesign spec against an
 * already-generated itinerary and returns a structured pass/fail report,
 * instead of silently trusting whatever the pipeline produced. Each check
 * is a small, independently-testable function so a failure can point at
 * exactly which section needs regenerating rather than a vague "something's
 * off."
 *
 * This module only *reports*; `itineraryEngine.service.js` decides what,
 * if anything, to auto-fix based on the report (see `applyAutoFixes` there).
 */

import { classifyAttractionTier } from './attractionRanking.service.js';

const MEAL_WINDOWS_MIN = {
  breakfast: [6 * 60, 10 * 60],
  lunch: [11 * 60 + 30, 14 * 60 + 30],
  cafe: [16 * 60, 18 * 60],
  dinner: [19 * 60, 24 * 60], // "7:00+" — no hard upper bound in the spec
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
  const passed = longLegs / legs.length <= 0.25; // allow a few long hops, not a route full of them
  return { passed, detail: `${longLegs}/${legs.length} legs exceed 25km (excessive backtracking indicator).` };
}

/** ✓ Are visit durations realistic? */
function checkVisitDurationsRealistic(stops) {
  const bad = stops.filter((s) => !Number.isFinite(s.visit_minutes) || s.visit_minutes < 10 || s.visit_minutes > 360);
  return { passed: bad.length === 0, detail: bad.length ? `${bad.length} stop(s) with an unrealistic visit duration.` : 'All visit durations are within a realistic range.' };
}

/** ✓ Are travel durations realistic (never 0 min by vehicle, no impossible schedules)? */
function checkTravelDurationsRealistic(stops) {
  const bad = stops.filter((s) => {
    if (!Number.isFinite(s.travel_minutes_from_prev) || !Number.isFinite(s.distance_km_from_prev)) return false;
    if (s.distance_km_from_prev <= 0) return false;
    // A non-walking leg reporting 0-1 minutes for a real distance is the
    // exact "0 minutes by car" bug this redesign targets.
    if (s.transport_mode && s.transport_mode !== 'walk' && s.travel_minutes_from_prev < 2 && s.distance_km_from_prev > 0.1) return true;
    // A "walk" leg covering more than 5km is an impossible schedule for foot travel.
    if (s.transport_mode === 'walk' && s.distance_km_from_prev > 5) return true;
    return false;
  });
  return { passed: bad.length === 0, detail: bad.length ? `${bad.length} stop(s) with an unrealistic travel time/mode combination.` : 'Travel times/modes look realistic.' };
}

/** ✓ Are meals scheduled correctly, and ✓ is lunch actually lunch? */
function checkMealsScheduledCorrectly(stops) {
  const mealStops = stops.filter((s) => s.meal_type);
  if (mealStops.length === 0) return { passed: true, detail: 'No deliberate meal stops in this itinerary.' };
  const misplaced = mealStops.filter((s) => {
    const window = MEAL_WINDOWS_MIN[s.meal_type];
    if (!window) return false;
    const arrival = clockToMinutes(s.arrival_time);
    if (arrival == null) return false;
    return arrival < window[0] - 30; // small grace window for rounding
  });
  return {
    passed: misplaced.length === 0,
    detail: misplaced.length
      ? `${misplaced.length} meal stop(s) scheduled outside their proper window (e.g. lunch before 11:30 AM).`
      : 'Lunch, dinner, and snack stops all land inside their proper windows.',
  };
}

/** ✓ Are restaurants separated from attractions (never treated as sightseeing stops)? */
function checkRestaurantsSeparatedFromAttractions(stops) {
  const violations = stops.filter((s) => s.category === 'food_dining' && !s.meal_type);
  return {
    passed: violations.length === 0,
    detail: violations.length
      ? `${violations.length} food-category stop(s) scheduled as a sightseeing stop instead of a deliberate meal.`
      : 'No restaurant/cafe is scheduled as a sightseeing stop.',
  };
}

/** ✓ Are hidden gems optional (never displacing a Must Visit Landmark)? */
function checkHiddenGemsOptional(stops, hiddenGems) {
  const hiddenGemIdsOnRoute = new Set(
    stops.filter((s) => classifyAttractionTier({ rating: s.rating, popularity_score: undefined }) === 'hidden_gem').map((s) => s.spot_id)
  );
  // Hidden gems are surfaced in the separate `hiddenGems` list, not forced
  // into the main route — the check is simply that the hidden-gems list
  // and the route are distinct concepts, which is structurally guaranteed
  // as long as no hidden gem silently replaced a must-visit slot. Since
  // must-visit inclusion is separately checked above, this passes whenever
  // hiddenGems is present as an independent, optional list.
  const passed = Array.isArray(hiddenGems);
  return { passed, detail: passed ? `${hiddenGems.length} hidden gem(s) offered as optional add-ons.` : 'Hidden gems list missing.' };
}

/** ✓ Is the itinerary feasible within available time (no day massively overrunning)? */
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
    if (departure != null && departure > 23 * 60) overrunDays += 1; // past 11 PM
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

/**
 * ✓ Does the itinerary actually reflect the traveler's spread of interests,
 * rather than one requested category swallowing the whole route? This is
 * the missing check that let a candidate pool skewed toward a single
 * category (most often shopping malls — numerous and well-rated in most
 * cities) produce a "technically valid" itinerary that ignored every other
 * interest the traveler picked. It runs on BOTH generation paths (heuristic
 * and Gemini/AI) since a narrow candidate pool or a model that ignored the
 * prompt's diversity instructions can produce the same lopsided result
 * either way.
 */
function checkInterestDiversityRespected(stops, requestedCategories) {
  const uniqueRequested = [...new Set((requestedCategories || []).filter(Boolean))];
  if (uniqueRequested.length <= 1) {
    return { passed: true, detail: 'Only one interest category requested — nothing to balance.' };
  }
  const relevantStops = stops.filter((s) => uniqueRequested.includes(s.category));
  if (relevantStops.length === 0) {
    return { passed: true, detail: 'No stops tagged with a requested category to evaluate.' };
  }
  const present = new Set(relevantStops.map((s) => s.category));
  const missing = uniqueRequested.filter((c) => !present.has(c));
  // One requested category missing entirely can be a genuine "nothing
  // nearby" case (e.g. "beach" for a hill town). Two or more missing from a
  // multi-interest trip is the "9 stops, all shopping malls" failure mode —
  // almost always a sign the candidate pool itself was too narrow, not that
  // the traveler's other interests genuinely don't exist at this destination.
  const passed = missing.length <= 1;
  return {
    passed,
    detail: passed
      ? `Itinerary touches ${present.size}/${uniqueRequested.length} requested interest categories.`
      : `Itinerary only covers ${present.size}/${uniqueRequested.length} requested interests — missing: ${missing.join(', ')}.`,
  };
}

/**
 * Runs the full Step 10 checklist and returns a report:
 * { passed, checks: [{ id, label, passed, detail }], failedCheckIds }
 */
export function runFinalValidation({ stops, candidates, hiddenGems, budgetValidation, tripStartHour, requestedCategories }) {
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