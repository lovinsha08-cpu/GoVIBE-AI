/**
 * Budget helpers used by itinerary generation and the trip assistant.
 *
 * Important product rule: GoVIBE may estimate food/transport/entry costs,
 * but it must never present an unavailable live price (especially hotel
 * pricing) as if it were known. Accommodation is therefore handled as an
 * external price-check item by accommodation.service.js.
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
  const budget = Math.max(0, Number(totalBudgetInr) || 0);
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

  // Keep the zero-accommodation contract intact. Only positive buckets need
  // the minimum floor; otherwise a disabled accommodation bucket would be
  // silently reintroduced and the split would stop reflecting the request.
  for (const key of Object.keys(weights)) {
    if (key !== 'accommodation' || needsAccommodation) weights[key] = Math.max(weights[key], 0.05);
  }

  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  for (const key of Object.keys(weights)) weights[key] /= sum;

  // Round every bucket but repair rounding drift so the displayed split
  // always reconciles exactly to the stated budget.
  const entries = Object.entries(weights);
  const split = Object.fromEntries(entries.map(([key, weight]) => [key, Math.round(budget * weight)]));
  const drift = budget - Object.values(split).reduce((a, b) => a + b, 0);
  if (entries.length) split[entries[entries.length - 1][0]] += drift;
  return split;
}

export function estimateSpotEntryCost(spot, group = {}) {
  const adults = Math.max(0, Number(group.adults) || 0);
  const kids = Math.max(0, Number(group.kids) || 0);
  const elderly = Math.max(0, Number(group.elderly) || 0);
  const speciallyAbled = Math.max(0, Number(group.specially_abled ?? group.speciallyAbled) || 0);
  const fee = Math.max(0, Number(spot?.entry_fee_inr) || 0);
  if (fee === 0) return 0;

  const fullPayers = adults;
  const halfPayers = kids + elderly + speciallyAbled;
  return Math.round(fullPayers * fee + halfPayers * fee * 0.5);
}

const AVG_MEAL_COST_INR = {
  veg: 200,
  non_veg: 300,
  vegan: 250,
  seafood: 400,
  multi_cuisine: 350,
};

export function estimateMealCost(foodPreferences = [], groupSize = 1, mealsCount = 1) {
  const prefs = Array.isArray(foodPreferences) && foodPreferences.length ? foodPreferences : ['veg'];
  const people = Math.max(1, Number(groupSize) || 1);
  const meals = Math.max(0, Number(mealsCount) || 0);
  const avgCost = prefs.reduce((sum, p) => sum + (AVG_MEAL_COST_INR[p] || 250), 0) / prefs.length;
  return Math.round(avgCost * people * meals);
}

export function validateBudget({
  totalBudgetInr,
  transportCostInr = 0,
  foodCostInr = 0,
  entryFeesInr = 0,
  miscellaneousInr = null,
  accommodationCostInr = null,
}) {
  const budget = Math.max(0, Number(totalBudgetInr) || 0);
  const transport = Math.max(0, Number(transportCostInr) || 0);
  const food = Math.max(0, Number(foodCostInr) || 0);
  const entry = Math.max(0, Number(entryFeesInr) || 0);
  const accommodationKnown = accommodationCostInr != null && Number.isFinite(Number(accommodationCostInr));
  const accommodation = accommodationKnown ? Math.max(0, Number(accommodationCostInr)) : 0;
  const knownBase = transport + food + entry + accommodation;
  const misc = miscellaneousInr != null
    ? Math.max(0, Number(miscellaneousInr) || 0)
    : Math.round((transport + food + entry) * 0.08);

  const totalEstimatedCostInr = Math.round(knownBase + misc);
  const withinBudget = budget === 0 ? true : totalEstimatedCostInr <= budget;
  const overageInr = withinBudget ? 0 : totalEstimatedCostInr - budget;
  const remainingInr = withinBudget ? budget - totalEstimatedCostInr : 0;

  return {
    total_budget_inr: budget,
    breakdown: {
      transport_inr: Math.round(transport),
      food_inr: Math.round(food),
      entry_fees_inr: Math.round(entry),
      accommodation_inr: accommodationKnown ? Math.round(accommodation) : null,
      miscellaneous_inr: Math.round(misc),
    },
    total_estimated_cost_inr: totalEstimatedCostInr,
    pricing_scope: accommodationKnown ? 'includes_external_accommodation_price' : 'known_estimated_trip_cost_excludes_live_accommodation_price',
    within_budget: withinBudget,
    overage_inr: overageInr,
    remaining_budget_inr: remainingInr,
  };
}

export function checkBudgetFeasibility({ totalBudgetInr, transportCostInr = 0, foodCostInr = 0 }) {
  const budget = Math.max(0, Number(totalBudgetInr) || 0);
  const transport = Math.max(0, Number(transportCostInr) || 0);
  const food = Math.max(0, Number(foodCostInr) || 0);
  const bareMinimumInr = Math.round(transport + food);
  if (budget === 0) return { feasible: true, bareMinimumInr, shortfallInr: 0 };
  const feasible = bareMinimumInr <= budget;
  return {
    feasible,
    bareMinimumInr,
    shortfallInr: feasible ? 0 : bareMinimumInr - budget,
  };
}
