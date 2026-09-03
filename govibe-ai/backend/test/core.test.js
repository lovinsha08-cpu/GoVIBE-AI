import test from 'node:test';
import assert from 'node:assert/strict';
import { splitBudget, validateBudget, checkBudgetFeasibility, estimateMealCost } from '../src/services/budget.service.js';
import { isGenuineTouristSpot, isValidItineraryStop } from '../src/services/attractionFilter.service.js';

test('splitBudget reconciles exactly to the requested budget', () => {
  const split = splitBudget({ totalBudgetInr: 10000, interests: [{ category: 'heritage' }], needsAccommodation: false });
  assert.equal(Object.values(split).reduce((sum, value) => sum + value, 0), 10000);
  assert.equal(split.accommodation, 0);
});

test('validateBudget never reports negative costs and excludes unknown hotel pricing', () => {
  const result = validateBudget({
    totalBudgetInr: 5000,
    transportCostInr: 1200,
    foodCostInr: 1800,
    entryFeesInr: 500,
    accommodationCostInr: null,
  });
  assert.equal(result.breakdown.accommodation_inr, null);
  assert.equal(result.pricing_scope, 'known_estimated_trip_cost_excludes_live_accommodation_price');
  assert.ok(result.total_estimated_cost_inr >= 0);
});

test('budget feasibility exposes unavoidable food and transport shortfall', () => {
  const result = checkBudgetFeasibility({ totalBudgetInr: 1000, transportCostInr: 700, foodCostInr: 600 });
  assert.equal(result.feasible, false);
  assert.equal(result.shortfallInr, 300);
});

test('meal estimates scale with people and scheduled meal count', () => {
  assert.equal(estimateMealCost(['veg'], 2, 3), 1200);
});

test('attraction filter rejects non-tourism places even when category is valid', () => {
  assert.equal(isGenuineTouristSpot({ name: 'District Collectorate', category: 'heritage_historical' }), false);
  assert.equal(isGenuineTouristSpot({ name: 'Marina Beach', category: 'nature_scenic' }), true);
});

test('itinerary stop validation requires real coordinates', () => {
  assert.equal(isValidItineraryStop({ name: 'Marina Beach', latitude: null, longitude: 80.28 }), false);
  assert.equal(isValidItineraryStop({ name: 'Marina Beach', latitude: 13.05, longitude: 80.28, category: 'nature_scenic' }), true);
});
