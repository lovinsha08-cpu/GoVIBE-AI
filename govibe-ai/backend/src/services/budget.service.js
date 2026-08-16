/**
 * Splits a total budget (INR) across food / transport / experience / accommodation.
 *
 * Base weights are adjusted by:
 * - needsAccommodation (zeroes that bucket out if false, redistributes)
 * - interest categories (e.g. "food" interest bumps food weight, "adventure" bumps experience)
 * - group composition (more people generally means more absolute spend, ratios stay similar,
 *   but kids/elderly nudge a little more toward comfort/experience over rock-bottom transport)
 */
const BASE_WEIGHTS = {
  accommodation: 0.35,
  food: 0.25,
  transport: 0.20,
  experience: 0.20,
};

const INTEREST_NUDGES = {
  food: { food: 0.08, experience: -0.04, transport: -0.04 },
  adventure: { experience: 0.10, food: -0.05, transport: -0.05 },
  relaxation: { accommodation: 0.08, experience: -0.04, transport: -0.04 },
  heritage: { experience: 0.06, transport: -0.03, food: -0.03 },
  nightlife: { experience: 0.06, food: 0.02, transport: -0.04, accommodation: -0.04 },
  shopping: { experience: 0.08, food: -0.04, transport: -0.04 },
};

export function splitBudget({ totalBudgetInr, interests = [], needsAccommodation = true }) {
  let weights = { ...BASE_WEIGHTS };

  for (const interest of interests) {
    const nudge = INTEREST_NUDGES[interest.category];
    if (!nudge) continue;
    for (const [bucket, delta] of Object.entries(nudge)) {
      weights[bucket] = (weights[bucket] || 0) + delta;
    }
  }

  if (!needsAccommodation) {
    const freed = weights.accommodation;
    weights.accommodation = 0;
    weights.food += freed * 0.4;
    weights.transport += freed * 0.3;
    weights.experience += freed * 0.3;
  }

  // Clamp negatives, then renormalize to sum to 1
  for (const key of Object.keys(weights)) {
    weights[key] = Math.max(weights[key], 0.05);
  }
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  for (const key of Object.keys(weights)) {
    weights[key] = weights[key] / sum;
  }

  const split = {};
  for (const [key, weight] of Object.entries(weights)) {
    split[key] = Math.round(totalBudgetInr * weight);
  }

  return split;
}

/**
 * Estimates entry fee cost for a spot given the group composition.
 * Assumes kids under a threshold and elderly may get discounted/free entry —
 * this is a simplifying heuristic until real per-venue pricing rules are added.
 */
export function estimateSpotEntryCost(spot, group) {
  const { adults = 1, kids = 0, elderly = 0, speciallyAbled = 0 } = group;
  const fee = Number(spot.entry_fee_inr) || 0;
  if (fee === 0) return 0;
  const fullPayers = adults;
  const halfPayers = kids + elderly + speciallyAbled; // common concession pattern in India
  return Math.round(fullPayers * fee + halfPayers * fee * 0.5);
}

/** Average per-meal cost per person by food preference, used for food budget estimates. */
const AVG_MEAL_COST_INR = {
  veg: 200,
  non_veg: 300,
  vegan: 250,
  seafood: 400,
  multi_cuisine: 350,
};

export function estimateMealCost(foodPreferences = [], groupSize = 1, mealsCount = 1) {
  const prefs = foodPreferences.length ? foodPreferences : ['veg'];
  const avgCost = prefs.reduce((sum, p) => sum + (AVG_MEAL_COST_INR[p] || 250), 0) / prefs.length;
  return Math.round(avgCost * groupSize * mealsCount);
}

/**
 * Step 9 (Budget Validation): checks the itinerary's actual computed cost
 * (transport + food + entry fees + a small miscellaneous buffer) against
 * the traveler's stated total budget, rather than only ever showing a
 * pre-allocated split that may not reflect what got scheduled.
 */
export function validateBudget({
  totalBudgetInr,
  transportCostInr = 0,
  foodCostInr = 0,
  entryFeesInr = 0,
  miscellaneousInr = null,
}) {
  const budget = Number(totalBudgetInr) || 0;
  // A miscellaneous buffer (tips, incidentals, local transport top-ups) —
  // default to 8% of the known costs if not supplied.
  const misc = miscellaneousInr != null
    ? miscellaneousInr
    : Math.round((transportCostInr + foodCostInr + entryFeesInr) * 0.08);

  const totalEstimatedCostInr = Math.round(transportCostInr + foodCostInr + entryFeesInr + misc);
  const withinBudget = budget === 0 ? true : totalEstimatedCostInr <= budget;
  const overageInr = withinBudget ? 0 : totalEstimatedCostInr - budget;
  const remainingInr = withinBudget ? budget - totalEstimatedCostInr : 0;

  return {
    total_budget_inr: budget,
    breakdown: {
      transport_inr: Math.round(transportCostInr),
      food_inr: Math.round(foodCostInr),
      entry_fees_inr: Math.round(entryFeesInr),
      miscellaneous_inr: Math.round(misc),
    },
    total_estimated_cost_inr: totalEstimatedCostInr,
    within_budget: withinBudget,
    overage_inr: overageInr,
    remaining_budget_inr: remainingInr,
  };
}

/**
 * Step 9 follow-up — Budget Feasibility: the auto-trim step in the
 * itinerary engine can only ever recover money by dropping *stops*
 * (entry fees, mostly). For a low budget relative to group size/duration,
 * food and transport alone — costs that exist even with ZERO attractions
 * on the itinerary — can already exceed the traveler's stated budget. In
 * that case trimming stops is pointless (it was previously the only
 * lever pulled, even when every stop had a ₹0 entry fee, which silently
 * did nothing) and the honest thing is to say so plainly, the same way
 * the Gemini prompt is instructed to when a budget is unrealistic.
 */
export function checkBudgetFeasibility({ totalBudgetInr, transportCostInr = 0, foodCostInr = 0 }) {
  const budget = Number(totalBudgetInr) || 0;
  const bareMinimumInr = Math.round(transportCostInr + foodCostInr);
  if (budget === 0) return { feasible: true, bareMinimumInr, shortfallInr: 0 };
  const feasible = bareMinimumInr <= budget;
  return {
    feasible,
    bareMinimumInr,
    shortfallInr: feasible ? 0 : bareMinimumInr - budget,
  };
}