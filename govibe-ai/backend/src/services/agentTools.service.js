/**
 * The AI Agent's tool set (itineraryAgent.service.js).
 *
 * Every tool wraps REAL GoVIBE services — spot matching/ranking, budget,
 * routing, transport planning, final validation, weather, geocoding — the
 * exact same modules itineraryEngine.service.js uses to generate a trip in
 * the first place. Nothing here invents travel times, distances, prices,
 * opening hours, coordinates, or restaurant info: every number comes from
 * a real dataset row or a real API call, and where the data genuinely
 * isn't available (e.g. no live menu-pricing feed), the tool says so
 * instead of guessing.
 *
 * Handlers are `(args, ctx) => result`, where `ctx` is the agent's shared,
 * mutable working context for this turn (see itineraryAgent.service.js):
 *   { trip, stops, candidates, forecast, changedDays: Set<number>, notes: string[] }
 * A handler that changes the itinerary reassigns `ctx.stops` (and adds the
 * affected day number(s) to `ctx.changedDays`) rather than returning a new
 * itinerary — this keeps every tool call in a turn composable, so "make
 * Day 1 less hectic AND add a vegetarian restaurant" can chain two tool
 * calls against the same working copy.
 *
 * Handlers never throw — every failure path returns `{ error }` so a bad
 * or infeasible request degrades into a conversational explanation
 * instead of crashing the agent's turn.
 */
import { haversineKm, routeDistance } from './geo.service.js';
import { geocodePlace } from './geocoding.service.js';
import {
  selectSpots, findHiddenGems, hiddenGemReason, HIDDEN_GEM_CATEGORY_GROUPS,
} from './spotMatching.service.js';
import { ALLOWED_SPOT_CATEGORIES } from './attractionFilter.service.js';
import { classifyAttractionTier } from './attractionRanking.service.js';
import {
  estimateSpotEntryCost, estimateMealCost, validateBudget, checkBudgetFeasibility, splitBudget,
} from './budget.service.js';
import { runFinalValidation } from './finalValidation.service.js';
import { explainSpotChoice } from './ai.service.js';
import { getDailyForecast, formatWeatherNote } from './weather.service.js';
import { searchNearby } from './nearbySearch.service.js';
import { searchWeb, isWebSearchConfigured } from './webSearch.service.js';
import { applyReorderDay } from './assistant.service.js';
import { generateItinerary, estimateTransportCostForStops } from './itineraryEngine.service.js';
import {
  getDayNumbers, getDaySlice, rebuildDayTimeline, insertStopAtBestPosition,
  removeMatchingStops, stopNameMatches, renumberStops, replaceDayStops,
} from './agentDayOps.service.js';

const TRANSPORT_MODE_ENUM = ['walk', 'bike', 'auto', 'cab', 'car', 'bus', 'train'];

// ------------------------------------------------------------
// Small shared helpers
// ------------------------------------------------------------

function groupSizeOf(trip) {
  return (trip.adults || 0) + (trip.kids || 0) + (trip.elderly || 0) + (trip.specially_abled || 0);
}

function isWeekendDate(dateStr) {
  if (!dateStr) return false;
  return [0, 6].includes(new Date(dateStr).getDay());
}

/** Resolves a free-text "near X" reference to coordinates: an existing stop's name first (no network call), else geocoding, else the trip's destination. */
async function resolveAnchor(ctx, { near, day } = {}) {
  if (near) {
    const matched = ctx.stops.find((s) => stopNameMatches(s, near));
    if (matched && Number.isFinite(matched.latitude)) {
      return { lat: matched.latitude, lng: matched.longitude, label: matched.name };
    }
    const geo = await geocodePlace(near);
    if (geo.lat != null) return { lat: geo.lat, lng: geo.lng, label: near };
  }
  if (day != null) {
    const { dayStops } = getDaySlice(ctx.stops, day);
    const withCoords = dayStops.find((s) => Number.isFinite(s.latitude));
    if (withCoords) return { lat: withCoords.latitude, lng: withCoords.longitude, label: withCoords.name };
  }
  return { lat: ctx.trip.destination_lat, lng: ctx.trip.destination_lng, label: ctx.trip.destination };
}

function usedSpotIds(ctx) {
  return new Set(ctx.stops.map((s) => s.spot_id).filter(Boolean));
}

/** Parses "under ₹250" / "under 250 rupees" / "budget 300" style hints out of free text. */
function parseMaxPrice(text) {
  if (!text) return null;
  const match = /(?:under|below|less than|budget(?: of)?|max(?:imum)?)\s*(?:₹|rs\.?|inr)?\s*(\d{2,6})/i.exec(text)
    || /(?:₹|rs\.?|inr)\s*(\d{2,6})/i.exec(text);
  return match ? Number(match[1]) : null;
}

const FOOD_PREF_KEYWORDS = [
  { re: /\bvegan\b/i, pref: 'vegan' },
  { re: /\bveg(etarian)?\b/i, pref: 'veg' },
  { re: /\bseafood\b/i, pref: 'seafood' },
  { re: /\bnon[- ]?veg\b/i, pref: 'non_veg' },
  { re: /\bmulti[- ]?cuisine\b/i, pref: 'multi_cuisine' },
];

function parseFoodPreference(text, fallback) {
  if (text) {
    const hit = FOOD_PREF_KEYWORDS.find((k) => k.re.test(text));
    if (hit) return [hit.pref];
  }
  return fallback?.length ? fallback : ['veg'];
}

/** Recomputes the itinerary's real (not just pre-allocated) budget numbers off the CURRENT working stops — same formula itineraryEngine.service.js uses. */
function recomputeBudget(ctx) {
  const dayCount = getDayNumbers(ctx.stops).length || 1;
  const groupSize = groupSizeOf(ctx.trip);
  const entryFeesTotal = ctx.stops.reduce((sum, s) => sum + (Number(s.entry_cost_inr) || 0), 0);
  const transportCost = estimateTransportCostForStops(ctx.stops);
  // The itinerary carries explicit meal suggestions. When a traveler asks
  // for an extreme cap, retain at least one economical meal per day rather
  // than silently charging for two meals that were removed from the plan.
  const mealStopsCount = Math.max(dayCount, ctx.stops.filter((s) => s.meal_type).length);
  const foodCost = estimateMealCost(ctx.trip.food_preferences, groupSize, mealStopsCount);

  const budgetValidation = validateBudget({
    totalBudgetInr: ctx.trip.total_budget_inr,
    transportCostInr: transportCost,
    foodCostInr: foodCost,
    entryFeesInr: entryFeesTotal,
  });
  const feasibility = checkBudgetFeasibility({
    totalBudgetInr: ctx.trip.total_budget_inr,
    transportCostInr: transportCost,
    foodCostInr: foodCost,
  });
  const byCategory = splitBudget({
    totalBudgetInr: ctx.trip.total_budget_inr,
    interests: ctx.trip.interests || [],
    needsAccommodation: Boolean(ctx.trip.needs_accommodation),
  });

  return {
    by_category: byCategory,
    entry_fees_total_inr: entryFeesTotal,
    estimated_food_cost_inr: foodCost,
    total_budget_inr: ctx.trip.total_budget_inr,
    budget_validation: budgetValidation,
    budget_feasibility: feasibility.feasible ? null : {
      bare_minimum_inr: feasibility.bareMinimumInr,
      shortfall_inr: feasibility.shortfallInr,
      note: `Food and transport alone for ${groupSize} traveler(s) already come to about ₹${feasibility.bareMinimumInr.toLocaleString('en-IN')} — ₹${feasibility.shortfallInr.toLocaleString('en-IN')} over the ₹${Number(ctx.trip.total_budget_inr).toLocaleString('en-IN')} budget before any attractions are counted.`,
    },
  };
}

/** Drops the cheapest-to-lose (never Must Visit, never a meal) stops one at a time until the itinerary fits the budget or nothing trimmable is left. Mirrors the trim loop in itineraryEngine.service.js's main generation path. */
function trimToBudget(ctx) {
  let budget = recomputeBudget(ctx);
  let guard = 0;
  const minStops = Math.max(2, getDayNumbers(ctx.stops).length);
  while (!budget.budget_validation.within_budget && guard < 25 && ctx.stops.length > minStops) {
    guard += 1;
    const trimmable = ctx.stops
      .filter((s) => !s.meal_type && s.category !== 'accommodation'
        && classifyAttractionTier(ctx.candidates.find((c) => c.id === s.spot_id) || {}) !== 'must_visit')
      .sort((a, b) => (b.entry_cost_inr || 0) - (a.entry_cost_inr || 0));
    // Keep one meal suggestion per day, but a strict cap may require
    // dropping surplus cafe/lunch/dinner stops. The remaining daily meal is
    // still costed, so this never pretends food is free.
    const surplusMeals = ctx.stops.filter((s) => s.meal_type).filter((s) => {
      const sameDayMeals = ctx.stops.filter((other) => other.day === s.day && other.meal_type);
      return sameDayMeals.length > 1;
    });
    if (!trimmable.length && !surplusMeals.length) break;
    const drop = trimmable[0] || surplusMeals[surplusMeals.length - 1];
    ctx.stops = ctx.stops.filter((s) => s !== drop);
    ctx.stops = renumberStops(ctx.stops);
    ctx.changedDays.add(drop.day);
    budget = recomputeBudget(ctx);
  }
  return budget;
}

async function rebuildOneDay(ctx, day) {
  ctx.stops = await rebuildDayTimeline(ctx.stops, day, {
    trip: ctx.trip,
    allowedTransportModes: (ctx.trip.transport_modes?.length ? ctx.trip.transport_modes : [ctx.trip.transport_priority === 'cheapest' ? 'bus' : 'cab']),
    transportMode: ctx.trip.transport_modes?.[0] || 'cab',
    forecast: ctx.forecast,
    isWeekend: isWeekendDate(ctx.stops.find((s) => s.day === day)?.date),
  });
}

function buildStopFromSpot(spot, { day, date, meal_type = null }, ctx) {
  const entryCost = estimateSpotEntryCost(spot, {
    adults: ctx.trip.adults, kids: ctx.trip.kids, elderly: ctx.trip.elderly, speciallyAbled: ctx.trip.specially_abled,
  });
  return {
    spot_id: spot.id,
    name: spot.name,
    category: spot.category,
    meal_type,
    latitude: spot.latitude,
    longitude: spot.longitude,
    day,
    date,
    entry_cost_inr: entryCost,
    opening_hours: spot.opening_hours || null,
    rating: spot.rating ?? null,
    visit_minutes: Math.max(15, Math.round(spot.avg_visit_minutes || 60)),
    reasoning: null, // filled in async by the caller when it matters (keeps most tool calls fast)
    weather_alternative: null,
    nearby_attractions: [],
  };
}

// ------------------------------------------------------------
// Handlers
// ------------------------------------------------------------

async function handleGetCurrentItinerary(_args, ctx) {
  return {
    destination: ctx.trip.destination,
    total_budget_inr: ctx.trip.total_budget_inr,
    transport_modes: ctx.trip.transport_modes,
    days: getDayNumbers(ctx.stops).map((day) => ({
      day,
      date: ctx.stops.find((s) => s.day === day)?.date || null,
      stops: getDaySlice(ctx.stops, day).dayStops.map((s) => ({
        order: s.order, name: s.name, category: s.category, meal_type: s.meal_type,
        arrival_time: s.arrival_time, departure_time: s.departure_time,
        entry_cost_inr: s.entry_cost_inr, transport_mode: s.transport_mode,
      })),
    })),
  };
}

async function handleGetBudgetStatus(_args, ctx) {
  return recomputeBudget(ctx);
}

async function handleCheckFeasibility(args, ctx) {
  const anchor = { lat: ctx.trip.destination_lat, lng: ctx.trip.destination_lng };
  const stopsToCheck = args?.day != null ? getDaySlice(ctx.stops, args.day).dayStops : ctx.stops;
  const hiddenGems = findHiddenGems(ctx.candidates, { anchor });
  const budgetValidation = recomputeBudget(ctx).budget_validation;
  const requestedCategories = [...new Set((ctx.trip.interests || []).map((i) => i.category).filter(Boolean))];
  const report = runFinalValidation({
    stops: stopsToCheck, candidates: ctx.candidates, hiddenGems, budgetValidation,
    tripStartHour: 9, requestedCategories,
  });
  return report;
}

async function handleFindRestaurants(args, ctx) {
  const anchor = await resolveAnchor(ctx, { near: args?.near, day: args?.day });
  const maxPrice = args?.max_price_inr ?? parseMaxPrice(args?.price_hint);
  const foodPrefs = parseFoodPreference(args?.cuisine || args?.price_hint, ctx.trip.food_preferences);
  const estimatedCostPerPerson = estimateMealCost(foodPrefs, 1, 1);

  let pool = ctx.candidates
    .filter((c) => c.category === 'food_dining')
    .map((c) => ({ spot: c, distanceKm: Math.round(haversineKm(anchor.lat, anchor.lng, c.latitude, c.longitude) * 10) / 10 }))
    .filter((c) => c.distanceKm <= 15)
    .sort((a, b) => a.distanceKm - b.distanceKm || (b.spot.rating || 0) - (a.spot.rating || 0))
    .slice(0, 8);

  // Thin local pool — fall back to a live nearby search (real GoVIBE
  // business data / Google Places / OSM via nearbySearch.service.js), not
  // an invented list.
  let liveFallbackUsed = false;
  if (pool.length < 3) {
    const nearby = await searchNearby({ lat: anchor.lat, lng: anchor.lng, query: 'restaurant', radiusMeters: 5000 });
    if (nearby?.results?.length) {
      liveFallbackUsed = true;
      pool = nearby.results.slice(0, 8).map((r) => ({
        spot: { id: r.id || r.place_id || r.name, name: r.name, category: 'food_dining', rating: r.rating ?? null },
        distanceKm: r.distanceKm ?? null,
      }));
    }
  }

  if (pool.length === 0) {
    return { error: `No restaurant data found near ${anchor.label}.`, near: anchor.label };
  }

  return {
    near: anchor.label,
    price_note: 'GoVIBE does not have live per-item menu pricing — this is a rough per-person average for the matched food preference, not a real menu price.',
    estimated_cost_per_person_inr: estimatedCostPerPerson,
    within_requested_budget: maxPrice != null ? estimatedCostPerPerson <= maxPrice : null,
    source: liveFallbackUsed ? 'live_nearby_search' : 'govibe_dataset',
    restaurants: pool.map(({ spot, distanceKm }) => ({
      spot_id: spot.id, name: spot.name, subcategory: spot.subcategory || null,
      rating: spot.rating ?? null, distance_km: distanceKm,
    })),
  };
}

async function handleFindHiddenGems(args, ctx) {
  const anchor = await resolveAnchor(ctx, { near: args?.near, day: args?.day });
  const categoryGroup = HIDDEN_GEM_CATEGORY_GROUPS.some((g) => g.key === args?.category_group) ? args.category_group : null;
  const used = usedSpotIds(ctx);
  const gems = findHiddenGems(ctx.candidates, { anchor, limit: 6, categoryGroup })
    .filter((s) => !used.has(s.id));
  return {
    near: anchor.label,
    hidden_gems: gems.map((s) => ({
      spot_id: s.id, name: s.name, category: s.category, rating: s.rating,
      distance_km: Math.round(haversineKm(anchor.lat, anchor.lng, s.latitude, s.longitude) * 10) / 10,
      reason: hiddenGemReason(s),
    })),
  };
}

async function handleAddAttraction(args, ctx) {
  const day = Number(args?.day);
  if (!getDayNumbers(ctx.stops).includes(day)) return { error: `Day ${args?.day} doesn't exist in this trip.` };

  const anchor = await resolveAnchor(ctx, { near: args?.near, day });
  const used = usedSpotIds(ctx);
  let pool = ctx.candidates.filter((c) => !used.has(c.id) && c.category !== 'stay' && c.category !== 'food_dining');

  const wantsHiddenGem = /hidden gem|offbeat|lesser.?known/i.test(args?.preference || '');
  if (wantsHiddenGem) {
    pool = findHiddenGems(pool, { anchor, limit: 20 });
  } else if (args?.category && ALLOWED_SPOT_CATEGORIES.has(args.category)) {
    pool = pool.filter((c) => c.category === args.category);
  }

  const picked = selectSpots(pool, { interests: ctx.trip.interests || [], anchor, limit: 1, tripStyle: ctx.trip.trip_style })[0];
  if (!picked) return { error: `Couldn't find a suitable ${args?.category || 'attraction'} to add near ${anchor.label} that isn't already on the itinerary.` };

  const dayDate = ctx.stops.find((s) => s.day === day)?.date || null;
  const newStop = buildStopFromSpot(picked, { day, date: dayDate }, ctx);
  newStop.reasoning = await explainSpotChoice(picked, { interestLabels: (ctx.trip.interests || []).map((i) => i.category) });

  const { dayStops } = getDaySlice(ctx.stops, day);
  const newDayStops = insertStopAtBestPosition(dayStops, newStop);
  ctx.stops = replaceDayStops(ctx.stops, day, newDayStops);
  ctx.changedDays.add(day);
  await rebuildOneDay(ctx, day);

  return { added: picked.name, category: picked.category, day, summary: `Added "${picked.name}" to Day ${day}.` };
}

async function handleRemoveAttraction(args, ctx) {
  const requestedDay = Number(args?.day);
  const days = Number.isFinite(requestedDay) ? [requestedDay] : getDayNumbers(ctx.stops);
  const predicate = args?.stop_name
    ? (s) => stopNameMatches(s, args.stop_name)
    : (s) => Number.isFinite(args?.order) && s.order === args.order;
  const removed = [];
  for (const day of days) {
    const { dayStops } = getDaySlice(ctx.stops, day);
    if (!dayStops.length) continue;
    const result = removeMatchingStops(dayStops, predicate);
    if (!result.removed.length) continue;
    removed.push(...result.removed);
    ctx.stops = replaceDayStops(ctx.stops, day, result.remaining);
    ctx.changedDays.add(day);
    if (result.remaining.length) await rebuildOneDay(ctx, day);
  }
  if (!removed.length) return { error: `Couldn't find "${args?.stop_name || args?.order}"${Number.isFinite(requestedDay) ? ` on Day ${requestedDay}` : ''}.` };
  return { removed: removed.map((s) => s.name), summary: `Removed ${removed.map((s) => `"${s.name}"`).join(', ')}.` };
}

async function handleReplaceStop(args, ctx) {
  const day = args?.day != null ? Number(args.day) : null;
  const searchScope = day != null ? getDaySlice(ctx.stops, day).dayStops : ctx.stops;
  const target = args?.stop_name
    ? searchScope.find((s) => stopNameMatches(s, args.stop_name))
    : (args?.meal_type ? searchScope.find((s) => s.meal_type === args.meal_type) : null);
  if (!target) return { error: `Couldn't find "${args?.stop_name || args?.meal_type}" to replace${day != null ? ` on Day ${day}` : ''}.` };

  const targetDay = target.day;
  const used = usedSpotIds(ctx);
  const isMeal = Boolean(target.meal_type);
  const hint = args?.replacement_hint || '';
  const maxPrice = args?.max_price_inr ?? parseMaxPrice(hint);

  let pool = ctx.candidates.filter((c) => !used.has(c.id));
  if (isMeal) {
    const mealSubcats = { lunch: ['Restaurants'], dinner: ['Restaurants'], cafe: ['Cafés'], breakfast: ['Cafés', 'Restaurants'] }[target.meal_type];
    pool = pool.filter((c) => c.category === 'food_dining' && (!mealSubcats || mealSubcats.includes(c.subcategory)));
  } else {
    pool = pool.filter((c) => c.category === target.category);
  }

  const anchor = { lat: target.latitude, lng: target.longitude };
  const picked = selectSpots(pool, { interests: ctx.trip.interests || [], anchor, limit: 1, tripStyle: ctx.trip.trip_style })[0];
  if (!picked) return { error: `No alternative ${isMeal ? 'restaurant' : target.category} found nearby to swap in.` };

  const replacement = buildStopFromSpot(picked, { day: targetDay, date: target.date, meal_type: target.meal_type }, ctx);
  replacement.order = target.order;
  replacement.reasoning = await explainSpotChoice(picked, { interestLabels: (ctx.trip.interests || []).map((i) => i.category) });

  const { dayStops } = getDaySlice(ctx.stops, targetDay);
  const newDayStops = dayStops.map((s) => (s === target ? replacement : s));
  ctx.stops = replaceDayStops(ctx.stops, targetDay, newDayStops);
  ctx.changedDays.add(targetDay);
  await rebuildOneDay(ctx, targetDay);

  const priceNote = isMeal
    ? ' (GoVIBE has no live menu pricing — matched on food preference/rating, not a verified price.)'
    : '';
  return {
    replaced: target.name, with: picked.name, day: targetDay,
    summary: `Replaced "${target.name}" with "${picked.name}" on Day ${targetDay}.${priceNote}`,
    price_hint_applied: maxPrice,
  };
}

async function handleChangeBudget(args, ctx) {
  const newBudget = Number(args?.new_total_budget_inr);
  if (!Number.isFinite(newBudget) || newBudget <= 0) return { error: 'A valid new total budget (INR) is required.' };
  ctx.trip = { ...ctx.trip, total_budget_inr: newBudget };
  ctx.tripChanged = true;
  let budget = trimToBudget(ctx);
  // Stop removal changes every subsequent route leg. Alternate a bounded
  // rebuild/trim pass so both the persisted stops and final total describe
  // the same route, not the route before the last removal.
  for (let pass = 0; pass < 3 && !budget.budget_validation.within_budget; pass += 1) {
    for (const day of getDayNumbers(ctx.stops)) {
      await rebuildOneDay(ctx, day);
      ctx.changedDays.add(day);
    }
    budget = trimToBudget(ctx);
  }
  for (const day of getDayNumbers(ctx.stops)) await rebuildOneDay(ctx, day);
  budget = recomputeBudget(ctx);
  const validation = budget.budget_validation;
  return {
    new_total_budget_inr: newBudget, budget,
    summary: validation.within_budget
      ? `Updated total budget to ₹${newBudget.toLocaleString('en-IN')}; the recalculated itinerary total is ₹${validation.total_estimated_cost_inr.toLocaleString('en-IN')}.`
      : `I reduced every optional stop I safely could, but the recalculated minimum is still ₹${validation.total_estimated_cost_inr.toLocaleString('en-IN')}, above ₹${newBudget.toLocaleString('en-IN')}.`,
  };
}

async function handleChangeTransport(args, ctx) {
  const modes = (Array.isArray(args?.modes) ? args.modes : [args?.modes]).filter((m) => TRANSPORT_MODE_ENUM.includes(m));
  if (modes.length === 0) return { error: `Valid transport modes are: ${TRANSPORT_MODE_ENUM.join(', ')}.` };

  if (args?.scope === 'day' && args?.day != null) {
    const day = Number(args.day);
    if (!getDayNumbers(ctx.stops).includes(day)) return { error: `Day ${args.day} doesn't exist in this trip.` };
    ctx.stops = await rebuildDayTimeline(ctx.stops, day, {
      trip: ctx.trip, allowedTransportModes: modes, transportMode: modes[0],
      forecast: ctx.forecast, isWeekend: isWeekendDate(ctx.stops.find((s) => s.day === day)?.date),
    });
    ctx.changedDays.add(day);
    return { modes, scope: 'day', day, summary: `Switched Day ${day} to ${modes.join('/')}.` };
  }

  ctx.trip = { ...ctx.trip, transport_modes: modes };
  ctx.tripChanged = true;
  for (const day of getDayNumbers(ctx.stops)) {
    ctx.stops = await rebuildDayTimeline(ctx.stops, day, {
      trip: ctx.trip, allowedTransportModes: modes, transportMode: modes[0],
      forecast: ctx.forecast, isWeekend: isWeekendDate(ctx.stops.find((s) => s.day === day)?.date),
    });
    ctx.changedDays.add(day);
  }
  return { modes, scope: 'trip', summary: `Switched the whole trip to ${modes.join('/')}.` };
}

async function handleAdjustPace(args, ctx) {
  const day = Number(args?.day);
  const { dayStops } = getDaySlice(ctx.stops, day);
  if (dayStops.length === 0) return { error: `Day ${args?.day} doesn't exist in this trip.` };
  const wantsRelaxed = args?.pace === 'more_relaxed' || /less hectic|relax|slower|fewer/i.test(args?.pace || '');

  if (wantsRelaxed) {
    const droppable = dayStops
      .filter((s) => !s.meal_type && s.category !== 'accommodation'
        && classifyAttractionTier(ctx.candidates.find((c) => c.id === s.spot_id) || {}) !== 'must_visit')
      .sort((a, b) => (a.rating || 0) - (b.rating || 0));
    let newDayStops = dayStops;
    let droppedName = null;
    if (droppable.length > 0 && dayStops.length > 2) {
      droppedName = droppable[0].name;
      newDayStops = dayStops.filter((s) => s !== droppable[0]);
    }
    newDayStops = newDayStops.map((s) => ({ ...s, visit_minutes: Math.min(180, Math.round((s.visit_minutes || 60) * 1.25)) }));
    ctx.stops = replaceDayStops(ctx.stops, day, newDayStops);
    ctx.changedDays.add(day);
    await rebuildOneDay(ctx, day);
    return { day, dropped: droppedName, summary: `Made Day ${day} more relaxed${droppedName ? ` — removed "${droppedName}" and` : ' — '} gave the remaining stops more time.` };
  }

  // more_packed
  const shortened = dayStops.map((s) => ({ ...s, visit_minutes: Math.max(20, Math.round((s.visit_minutes || 60) * 0.85)) }));
  ctx.stops = replaceDayStops(ctx.stops, day, shortened);
  await rebuildOneDay(ctx, day);
  const addResult = await handleAddAttraction({ day }, ctx);
  return { day, summary: `Tightened Day ${day}'s pacing${addResult?.added ? ` and added "${addResult.added}"` : ''}.` };
}

async function handleReorderDay(args, ctx) {
  try {
    ctx.stops = applyReorderDay(ctx.stops, Number(args?.day), (args?.new_order || []).map(Number));
    ctx.changedDays.add(Number(args.day));
    return { day: Number(args.day), summary: `Reordered Day ${args.day}.` };
  } catch (err) {
    return { error: err.message };
  }
}

async function handleRegenerateDay(args, ctx) {
  const day = Number(args?.day);
  const { dayStops } = getDaySlice(ctx.stops, day);
  if (dayStops.length === 0) return { error: `Day ${args?.day} doesn't exist in this trip.` };

  const nonMeal = dayStops.filter((s) => !s.meal_type && s.category !== 'accommodation');
  const meals = dayStops.filter((s) => s.meal_type || s.category === 'accommodation');
  const used = usedSpotIds(ctx);
  for (const s of nonMeal) used.delete(s.spot_id); // these slots are being freed up for reselection

  const anchor = { lat: ctx.trip.destination_lat, lng: ctx.trip.destination_lng };
  const pool = ctx.candidates.filter((c) => !used.has(c.id) && c.category !== 'stay' && c.category !== 'food_dining');
  const fresh = selectSpots(pool, { interests: ctx.trip.interests || [], anchor, limit: nonMeal.length || 3, tripStyle: ctx.trip.trip_style });
  if (fresh.length === 0) return { error: `No alternative attractions available to regenerate Day ${day} with.` };

  const dayDate = dayStops[0]?.date || null;
  let newDayStops = meals;
  for (const spot of fresh) {
    const stop = buildStopFromSpot(spot, { day, date: dayDate }, ctx);
    newDayStops = insertStopAtBestPosition(newDayStops, stop);
  }
  const reasonings = await Promise.all(fresh.map((s) => explainSpotChoice(s, { interestLabels: (ctx.trip.interests || []).map((i) => i.category) })));
  let ri = 0;
  newDayStops = newDayStops.map((s) => (fresh.some((f) => f.id === s.spot_id) ? { ...s, reasoning: reasonings[ri++] } : s));

  ctx.stops = replaceDayStops(ctx.stops, day, newDayStops);
  ctx.changedDays.add(day);
  await rebuildOneDay(ctx, day);
  return { day, new_stops: fresh.map((s) => s.name), summary: `Regenerated Day ${day} with a fresh set of stops.` };
}

async function handleRegenerateItinerary(_args, ctx) {
  try {
    const result = await generateItinerary(ctx.trip);
    ctx.stops = result.stops;
    ctx.changedDays = new Set(getDayNumbers(ctx.stops));
    // Generation can legitimately report an infeasible budget (for example
    // food/transport alone exceeds it), but must never claim that it met a
    // requested cap when it did not. Rebuild and calculate from the exact
    // generated stops before returning the result.
    let budget = recomputeBudget(ctx);
    for (let pass = 0; pass < 3 && !budget.budget_validation.within_budget; pass += 1) {
      budget = trimToBudget(ctx);
      for (const day of getDayNumbers(ctx.stops)) await rebuildOneDay(ctx, day);
      budget = recomputeBudget(ctx);
    }
    ctx.regeneratedBudgetSummary = recomputeBudget(ctx);
    ctx.regeneratedHiddenGems = result.hiddenGems;
    const validation = ctx.regeneratedBudgetSummary.budget_validation;
    return {
      summary: validation.within_budget
        ? `Regenerated the itinerary; its recalculated total is ₹${validation.total_estimated_cost_inr.toLocaleString('en-IN')}.`
        : `Regenerated and minimized the itinerary, but its recalculated total is ₹${validation.total_estimated_cost_inr.toLocaleString('en-IN')}, so the ₹${Number(ctx.trip.total_budget_inr).toLocaleString('en-IN')} cap is not feasible with the current trip requirements.`,
      stop_count: ctx.stops.length,
      budget,
    };
  } catch (err) {
    return { error: `Couldn't regenerate the itinerary: ${err.message}` };
  }
}

async function handleGetWeather(args, ctx) {
  let date = args?.date;
  if (!date && args?.day != null) {
    date = ctx.stops.find((s) => s.day === Number(args.day))?.date;
  }
  date = date || ctx.trip.start_date;
  const forecast = await getDailyForecast({ lat: ctx.trip.destination_lat, lng: ctx.trip.destination_lng, date });
  if (!forecast) return { date, error: 'No live forecast available for that date (likely more than ~16 days out) — use general seasonal expectations instead of inventing specifics.' };
  return { date, forecast: formatWeatherNote(forecast), outdoor_unfriendly: Boolean(forecast.outdoorUnfriendly), raw: forecast };
}

async function handleGetRoute(args, ctx) {
  const from = await resolveAnchor(ctx, { near: args?.from });
  const to = await resolveAnchor(ctx, { near: args?.to });
  if (!args?.to) return { error: 'A destination place is required.' };
  const mode = TRANSPORT_MODE_ENUM.includes(args?.mode) ? args.mode : (ctx.trip.transport_modes?.[0] || 'cab');
  const result = await routeDistance({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }, mode);
  return {
    from: from.label, to: to.label, mode,
    distance_km: Math.round(result.distanceKm * 10) / 10,
    duration_minutes: result.durationMinutes,
    source: result.source,
  };
}

async function handleWebSearch(args, ctx) {
  if (!isWebSearchConfigured) {
    return { error: 'Web search is not configured for this deployment. Answer from GoVIBE data, or tell the traveler this specific current-info lookup isn\'t available right now — never invent an answer.' };
  }
  const query = args?.query?.trim() || '';
  const scoped = /chennai|tamil nadu|india/i.test(query) || !ctx.trip?.destination
    ? query
    : `${query} ${ctx.trip.destination}`;
  return searchWeb(scoped, { maxResults: 5 });
}


// ------------------------------------------------------------
// Declarations (OpenAI/JSON-schema tool format — see agentLLM.service.js
// for the Gemini-format conversion) + registry
// ------------------------------------------------------------

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_itinerary',
      description: "Returns the CURRENT working itinerary (reflecting any edits already made this turn) — day-by-day stop list with times and costs. Call this first if you need to see exact current stop names/order before editing (e.g. to know what's currently on a day before adding/removing something).",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_trip_budget_status',
      description: "Returns the itinerary's real computed cost (transport + food + entry fees) vs. the traveler's total budget, including whether it's feasible at all. Use for any budget/cost/'how much' question.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_feasibility',
      description: 'Runs the full itinerary validation checklist (realistic timing, budget respected, route sanity, meal windows, interest coverage) against the current itinerary, optionally scoped to one day. Use before telling the traveler a change is complete, or when asked "does this actually work?"',
      parameters: {
        type: 'object',
        properties: { day: { type: 'integer', description: 'Optional — limit the check to one day number.' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_restaurants',
      description: 'Finds real restaurants/cafés from GoVIBE data (or a live nearby search as fallback) matching a location and optional food preference/price hint. Read-only — does not change the itinerary. Use this before replace_stop when the traveler wants a restaurant recommendation without necessarily swapping anything yet.',
      parameters: {
        type: 'object',
        properties: {
          near: { type: 'string', description: 'A stop name or place name to search near. Omit to use the trip destination center.' },
          day: { type: 'integer', description: 'Optional day number to anchor the search near.' },
          cuisine: { type: 'string', description: "Food preference hint, e.g. 'vegetarian', 'seafood'." },
          price_hint: { type: 'string', description: "Free-text budget hint from the traveler, e.g. 'under ₹250'." },
          max_price_inr: { type: 'number', description: 'Explicit max per-person price in INR, if known.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_hidden_gems',
      description: 'Finds real lesser-known, highly-rated spots (low popularity, high rating) from GoVIBE data near a location. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          near: { type: 'string', description: 'A stop name or place name to search near.' },
          day: { type: 'integer', description: 'Optional day number to anchor the search near.' },
          category_group: { type: 'string', enum: ['nature', 'food', 'culture', 'shopping', 'offbeat'], description: 'Optional category group filter.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_attraction',
      description: "Adds a real attraction/spot to a specific day of the itinerary, picked from GoVIBE's data and ranked against the traveler's interests. Actually mutates the itinerary.",
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'integer', description: 'Day number to add the stop to.' },
          category: { type: 'string', description: 'Optional GoVIBE category to constrain the pick to, e.g. nature_scenic, heritage_historical, shopping.' },
          preference: { type: 'string', description: "Free-text hint, e.g. 'a hidden gem', 'something scenic'." },
          near: { type: 'string', description: 'Optional stop/place name to add it near.' },
        },
        required: ['day'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_attraction',
      description: 'Removes a stop from a specific day by name (or order number). Actually mutates the itinerary.',
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'integer' },
          stop_name: { type: 'string', description: 'Name (or partial name) of the stop to remove.' },
          order: { type: 'integer', description: "The stop's order number, if you already know it from get_current_itinerary." },
        },
        required: ['day'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_stop',
      description: "Swaps out one existing stop (an attraction OR a meal — lunch/dinner/café) for a different real place matching an optional hint (cuisine, price, 'a different museum', etc.). Actually mutates the itinerary. Use this for 'replace X with Y' requests.",
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'integer', description: 'Optional — narrows the search to one day.' },
          stop_name: { type: 'string', description: 'Name (or partial name) of the stop to replace.' },
          meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'cafe', 'dinner'], description: "Alternative to stop_name — target 'lunch', 'dinner', etc. directly." },
          replacement_hint: { type: 'string', description: "Free text describing what to replace it with, e.g. 'vegetarian food under ₹250', 'something cheaper', 'a different museum'." },
          max_price_inr: { type: 'number' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'change_budget',
      description: "Updates the trip's total budget and re-checks (and, if needed, trims) the itinerary to fit it. Actually mutates the itinerary and trip.",
      parameters: {
        type: 'object',
        properties: { new_total_budget_inr: { type: 'number', description: 'The new total trip budget in INR.' } },
        required: ['new_total_budget_inr'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'change_transport',
      description: "Changes the preferred transport mode(s) for the whole trip or one day, and recomputes every affected leg's transport plan/timing. Actually mutates the itinerary.",
      parameters: {
        type: 'object',
        properties: {
          modes: { type: 'array', items: { type: 'string', enum: TRANSPORT_MODE_ENUM }, description: "New preferred mode(s), e.g. ['bus','train'] for public transport." },
          scope: { type: 'string', enum: ['trip', 'day'], description: "Defaults to 'trip'." },
          day: { type: 'integer', description: "Required if scope is 'day'." },
        },
        required: ['modes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adjust_pace',
      description: "Makes a specific day less hectic ('more_relaxed' — removes one non-essential stop and gives the rest more time) or more packed ('more_packed' — tightens visit durations and adds a stop). Actually mutates the itinerary.",
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'integer' },
          pace: { type: 'string', enum: ['more_relaxed', 'more_packed'] },
        },
        required: ['day', 'pace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reorder_day',
      description: "Resequences a day's existing stops into a new order (moving something earlier/later). Requires the full set of that day's current order numbers — call get_current_itinerary first if you don't already have them. Actually mutates the itinerary.",
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'integer' },
          new_order: { type: 'array', items: { type: 'integer' }, description: 'The full list of order numbers for every stop in that day, in the new sequence.' },
        },
        required: ['day', 'new_order'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'regenerate_day',
      description: "Replaces a single day's attraction stops with a freshly-selected set (keeps existing meals). Use for 'redo Day X' / 'give me different options for Day X'. Actually mutates the itinerary.",
      parameters: { type: 'object', properties: { day: { type: 'integer' } }, required: ['day'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'regenerate_itinerary',
      description: 'Regenerates the ENTIRE itinerary from scratch using the trip\'s current preferences (including any budget/transport changes already made this conversation). Use only when the traveler explicitly wants a full redo/optimization, not for single-day or single-stop requests.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weather_forecast',
      description: 'Gets the live weather forecast for a trip day or specific date. Use for any weather/rain/forecast question, including deciding whether to swap outdoor plans.',
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'integer', description: 'Trip day number.' },
          date: { type: 'string', description: 'YYYY-MM-DD, alternative to day.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_route_info',
      description: 'Gets real distance/travel-time between two places (or two existing stops) for a given transport mode. Use for any "how far"/"how long to get to" question not requiring an itinerary edit.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          mode: { type: 'string', enum: TRANSPORT_MODE_ENUM },
        },
        required: ['to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: "Live web search for CURRENT/time-sensitive information GoVIBE's own data can't provide: whether a place is open today/now/tomorrow and its opening/closing hours, current entry fees/ticket prices/offers, current bus/train schedules/numbers/fares when no dedicated transit tool covers them, current events, temporary closures, festivals/local events, newly opened places, or other current/time-sensitive travel info. ALWAYS call this for opening-hours or current-price/current-schedule questions — never answer them from general knowledge, RAG background context, or a dataset value, and never present an estimate as the verified current value. Do NOT use this for ordinary static tourism questions (what a place is, what's nearby, general descriptions/categories) — those are covered by RAG and the other tools above. Never used as a primary source for routine itinerary data.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
];

const HANDLERS = {
  get_current_itinerary: handleGetCurrentItinerary,
  get_trip_budget_status: handleGetBudgetStatus,
  check_feasibility: handleCheckFeasibility,
  find_restaurants: handleFindRestaurants,
  find_hidden_gems: handleFindHiddenGems,
  add_attraction: handleAddAttraction,
  remove_attraction: handleRemoveAttraction,
  replace_stop: handleReplaceStop,
  change_budget: handleChangeBudget,
  change_transport: handleChangeTransport,
  adjust_pace: handleAdjustPace,
  reorder_day: handleReorderDay,
  regenerate_day: handleRegenerateDay,
  regenerate_itinerary: handleRegenerateItinerary,
  get_weather_forecast: handleGetWeather,
  get_route_info: handleGetRoute,
  web_search: handleWebSearch,
};

export function getAgentToolHandler(name) {
  return HANDLERS[name] || null;
}