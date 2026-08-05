/**
 * AI confidence scores for a generated itinerary. Each sub-score is 0-100
 * and derived from the actual generation output (not guessed), so the
 * traveler can see *why* the AI is or isn't confident in a given area
 * instead of a single opaque number.
 */
export function computeConfidenceScores({ trip, stops, byCategory = {}, entryFeesTotal = 0, forecast, outdoorSwaps = 0 }) {
  const interestMatch = scoreInterestMatch(trip, stops);
  const budgetAccuracy = scoreBudgetAccuracy(trip, byCategory, entryFeesTotal);
  const routeEfficiency = scoreRouteEfficiency(stops);
  const weatherSuitability = scoreWeatherSuitability(forecast, outdoorSwaps, stops);
  const transportOptimization = scoreTransportOptimization(trip, stops);

  const overall = Math.round(
    interestMatch * 0.25 +
    budgetAccuracy * 0.20 +
    routeEfficiency * 0.20 +
    weatherSuitability * 0.15 +
    transportOptimization * 0.20
  );

  return {
    interest_match: interestMatch,
    budget_accuracy: budgetAccuracy,
    route_efficiency: routeEfficiency,
    weather_suitability: weatherSuitability,
    transport_optimization: transportOptimization,
    overall,
  };
}

function scoreInterestMatch(trip, stops) {
  const explicitCategories = new Set((trip.interests || []).map((i) => i.category));
  if (explicitCategories.size === 0 || !stops.length) return 70; // nothing explicit to grade against
  const matched = stops.filter((s) => explicitCategories.has(s.category)).length;
  return Math.round((matched / stops.length) * 100);
}

function scoreBudgetAccuracy(trip, byCategory, entryFeesTotal) {
  const budget = Number(trip.total_budget_inr) || 0;
  if (!budget) return 70;
  const allocated = Object.values(byCategory).reduce((sum, v) => sum + (Number(v) || 0), 0);
  // The category split should already sum close to the total budget; entry
  // fees are a sanity cross-check against the "experience" bucket sizing.
  const diffRatio = Math.abs(allocated - budget) / budget;
  const allocationScore = Math.max(0, 100 - diffRatio * 100);
  const entryFeeShare = allocated > 0 ? entryFeesTotal / allocated : 0;
  const overspendPenalty = entryFeeShare > 0.6 ? 15 : 0; // entry fees alone eating most of the experience bucket
  return Math.round(Math.max(0, Math.min(100, allocationScore - overspendPenalty)));
}

function scoreRouteEfficiency(stops) {
  const legs = stops.filter((s) => typeof s.distance_km_from_prev === 'number' && s.distance_km_from_prev != null);
  if (!legs.length) return 70;
  const avgLegKm = legs.reduce((sum, s) => sum + s.distance_km_from_prev, 0) / legs.length;
  // Shorter average hop between stops = a tighter, less backtracking-heavy route.
  return Math.round(Math.max(40, Math.min(100, 100 - avgLegKm * 6)));
}

function scoreWeatherSuitability(forecast, outdoorSwaps, stops) {
  if (!forecast) return 70; // unknown, not bad
  if (!forecast.outdoorUnfriendly) return 95;
  const remainingOutdoorStops = stops.filter((s) => ['nature', 'adventure'].includes(s.category)).length;
  if (remainingOutdoorStops === 0) return 100; // fully adapted to the forecast
  return Math.round(Math.min(95, 55 + outdoorSwaps * 12));
}

function scoreTransportOptimization(trip, stops) {
  const legs = stops.filter((s) => s.route_source);
  const osrmFraction = legs.length ? legs.filter((s) => s.route_source === 'osrm').length / legs.length : 0;
  const priorityBonus = trip.transport_priority ? 10 : 0;
  return Math.round(Math.min(100, 65 + osrmFraction * 25 + priorityBonus));
}
