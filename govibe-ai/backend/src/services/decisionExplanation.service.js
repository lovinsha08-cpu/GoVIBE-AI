/**
 * Builds the trip-level "why the AI made these decisions" bullet list —
 * separate from the per-stop reasoning sentence, this summarizes the
 * cross-cutting decisions (budget fit, interest prioritization, weather
 * rearrangement, route optimization, meal timing, hidden gems, learned
 * preferences) so the traveler can see the AI's reasoning at a glance.
 */
export function buildDecisionExplanation(trip, stops, {
  forecast,
  outdoorSwaps = 0,
  hiddenGemCount = 0,
  learnedPreferences = null,
} = {}) {
  const bullets = [];

  const budget = Number(trip.total_budget_inr) || 0;
  if (budget) {
    bullets.push(`Selected stops and pacing to fit your ₹${budget.toLocaleString('en-IN')} budget.`);
  }

  const interestCategories = (trip.interests || []).map((i) => i.category).filter(Boolean);
  if (interestCategories.length) {
    bullets.push(`Prioritized ${interestCategories.slice(0, 3).join(', ')} attractions based on your stated interests.`);
  }

  if (forecast?.outdoorUnfriendly && outdoorSwaps > 0) {
    bullets.push(`Rearranged ${outdoorSwaps} outdoor stop${outdoorSwaps > 1 ? 's' : ''} for indoor alternatives because of the ${forecast.label.toLowerCase()} forecast.`);
  } else if (forecast && !forecast.outdoorUnfriendly) {
    bullets.push(`Kept the planned outdoor stops as-is — the forecast (${forecast.label.toLowerCase()}) looks favorable.`);
  }

  if (stops.length > 2) {
    bullets.push('Ordered destinations with a nearest-neighbor route to reduce backtracking and total travel time.');
  }

  const mealStopCount = stops.filter((s) => s.meal_suggestion).length;
  if (mealStopCount > 0) {
    bullets.push(`Recommended a nearby restaurant at ${mealStopCount} stop${mealStopCount > 1 ? 's' : ''}, timed around your visit.`);
  }

  if (hiddenGemCount > 0) {
    bullets.push(`Surfaced ${hiddenGemCount} hidden gem${hiddenGemCount > 1 ? 's' : ''} matching your interests that most tourists miss.`);
  }

  if (learnedPreferences?.favorite_interest_categories?.length) {
    bullets.push(`Leaned slightly toward ${learnedPreferences.favorite_interest_categories.join(', ')} based on patterns across your past ${learnedPreferences.trips_analyzed} trips.`);
  }

  return bullets;
}
