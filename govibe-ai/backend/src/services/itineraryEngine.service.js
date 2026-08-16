import { loadSpots } from './spotData.service.js';
import {
  selectBalancedSpots, findHiddenGems, hiddenGemReason, nearestInCategory,
  splitRouteAndMealPools, diversifyConsecutive, selectFallbackFamousSpots,
  capStopsByCategory,
} from './spotMatching.service.js';
import { filterGenuineTouristSpots, isValidItineraryStop } from './attractionFilter.service.js';
import { classifyAttractionTier } from './attractionRanking.service.js';
import { getTripStylePacing } from './tripStyle.service.js';
import { orderSpotsRoute, estimateCrowdLevel, suggestPublicTransport, suggestBestVisitTime, recommendTransportMode } from './routing.service.js';
import { splitBudget, estimateSpotEntryCost, estimateMealCost, validateBudget, checkBudgetFeasibility } from './budget.service.js';
import { runFinalValidation } from './finalValidation.service.js';
import { explainSpotChoice, generateFullItinerary, buildHeuristicTripSummary } from './ai.service.js';
import { getDailyForecast, formatWeatherNote, isOutdoorSpot } from './weather.service.js';
import { getEmergencyContacts } from './emergency.service.js';
import { getLocalEvents } from './events.service.js';
import { findAccommodationRecommendation } from './accommodation.service.js';
import { buildPackingList } from './packing.service.js';
import { learnTravelerPreferences, applyLearnedInterestBoost } from './preferenceLearning.service.js';
import { computeConfidenceScores } from './confidenceScore.service.js';
import { buildDecisionExplanation } from './decisionExplanation.service.js';
import { haversineKm, estimateTravelMinutes, routeDistance } from './geo.service.js';
import { buildTransportPlan, buildBookingItinerary, destinationHasMetro } from './transportPlanner.service.js';
import { env } from '../config/env.js';

/**
 * Generates a full itinerary for a trip. This is the core of GoVIBE's AI engine:
 * 1. Pull candidate spots near the destination
 * 2. Rank + select the ones matching interests
 * 3. Order them into a route (nearest-neighbor)
 * 4. Attach timing, crowd estimate, transport mode, budget, and AI reasoning per stop
 * 5. Compute a full budget summary
 */
export async function generateItinerary(trip) {
  const anchor = { lat: trip.destination_lat, lng: trip.destination_lng };
  const groupSize = trip.adults + trip.kids + trip.elderly + trip.specially_abled;

  // 0. Accommodation recommendation (if requested) — computed once, up
  //    front, so it can act as the day-start/day-end anchor for both the
  //    Gemini path and the heuristic path below, and so its real cost can
  //    replace the generic accommodation budget-split guess later.
  const dayCountForStay = Math.max(1, daysBetween(trip.start_date, trip.end_date));
  const nights = dayCountForStay > 1 ? dayCountForStay - 1 : 1;

  // These four steps don't depend on each other's output, but used to run
  // one after another with separate `await`s — each one's latency simply
  // added onto the total instead of overlapping. Running them concurrently
  // means the total wait is however long the SLOWEST one takes, not the
  // sum of all four (accommodation/spot-loading in particular can each
  // take several seconds against live external APIs).
  const [accommodation, spotsResult, forecast, learnedPreferences] = await Promise.all([
    trip.needs_accommodation
      ? findAccommodationRecommendation({ trip, groupSize, nights })
      : Promise.resolve(null),
    // 1. Fetch candidate spots within range of the destination.
    //    (A tighter PostGIS radius query would replace this once spot volume grows.)
    //    Falls back to the bundled sample dataset when Supabase isn't configured/seeded yet.
    loadSpots({
      city: trip.destination,
      lat: trip.destination_lat,
      lng: trip.destination_lng,
      interests: trip.interests || [],
    }),
    // 1b. Live weather forecast for the destination on the trip's start date —
    //     fetched once up front so both the Gemini path and the heuristic
    //     path below can use it for weather-aware adjustments.
    getDailyForecast({ lat: trip.destination_lat, lng: trip.destination_lng, date: trip.start_date }),
    // 1c'. Personalized learning: look at this traveler's past trips (if any)
    //      and softly boost interest categories they've consistently liked,
    //      so itineraries get more personalized the more the traveler uses
    //      the app — without overriding what they explicitly chose this trip.
    learnTravelerPreferences(trip.traveler_id, trip.id),
  ]);

  const { spots: rawCandidates, source: spotSource } = spotsResult;
  // Belt-and-braces: loadSpots already filters by source, but re-validate
  // here too so every entry point into itinerary generation is protected.
  const candidates = filterGenuineTouristSpots(rawCandidates);
  if (candidates.length === 0) {
    throw new Error('No genuine tourist spots available yet for this destination — spot data needs to be seeded.');
  }

  const tripStylePacing = getTripStylePacing(trip.trip_style);
  const boostedInterests = applyLearnedInterestBoost(trip.interests || [], learnedPreferences);

  // 1c. If Gemini is configured, let it generate the whole itinerary first —
  //     it reasons over timing, weather, crowding, and budget together far
  //     better than the heuristic pipeline. Any failure (no key, bad JSON,
  //     timeout) falls straight through to the heuristic path below, so
  //     generation never breaks because the AI call had a bad day.
  if (env.geminiApiKey) {
    const aiResult = await tryFullAiItinerary(trip, candidates, forecast, learnedPreferences, accommodation, nights);
    if (aiResult) return aiResult;
  }

  // 2. Select + rank spots matching the traveler's interests.
  //    Food only competes for a route slot (i.e. appears as a featured stop
  //    in its own right, not just a meal break) when the traveler actually
  //    wants that — Food Explorer style or an explicit "food" interest
  //    (Part 8). Shopping is the same: it's only in the running when the
  //    traveler selected a "shopping" interest. This keeps the route
  //    dominated by attractions (Part 6) instead of restaurants/cafés and
  //    markets crowding out sightseeing.
  const wantsFoodFeatured = trip.trip_style === 'food_explorer'
    || (trip.interests || []).some((i) => i.category === 'food_dining');
  const wantsShopping = (trip.interests || []).some((i) => i.category === 'shopping');

  const dayCount = Math.max(1, daysBetween(trip.start_date, trip.end_date));
  const stopsPerDay = Math.max(1, Math.round(3 * tripStylePacing.stopsPerDayMultiplier)); // ~3 stops/day, reshaped by Trip Style
  const spotLimit = Math.min(candidates.length, dayCount * stopsPerDay);
  let selected = selectBalancedSpots(candidates, {
    interests: boostedInterests,
    anchor,
    limit: spotLimit,
    tripStyle: trip.trip_style,
    includeShopping: wantsShopping,
    featureFood: wantsFoodFeatured,
  });

  // Fallback: the traveler's selected interests genuinely don't match
  // anything near this destination (e.g. "Beaches" for a landlocked hill
  // town) — rather than failing itinerary generation outright, fall back
  // to the destination's most famous/well-rated genuine tourist
  // attractions so the traveler still gets a real, usable plan. A note is
  // surfaced in the trip summary/extras so the traveler understands why
  // the results don't match what they picked.
  let interestFallbackNote = null;
  if (selected.length === 0) {
    selected = selectFallbackFamousSpots(candidates, {
      anchor, limit: spotLimit, includeShopping: true,
    });
    if (selected.length > 0) {
      interestFallbackNote = `We couldn't find spots matching your selected interests near ${trip.destination}, so here are the most popular tourist attractions in the area instead.`;
    }
  }

  if (selected.length === 0) {
    throw new Error('No genuine tourist spots found near this destination — spot data may need to be seeded for this city.');
  }

  // 2b. Food candidates set aside for deliberate meal scheduling (Part 7) —
  //     separate from whatever food spots (if any) made it into `selected`
  //     above as featured stops, so lunch/dinner never doubles up on the
  //     same restaurant a Food Explorer trip already featured as a stop.
  const { mealPool } = splitRouteAndMealPools(candidates, { includeShopping: true });

  // 3. Order into a route
  const transportMode = pickPrimaryMode(trip.transport_modes, trip.transport_priority);
  // Step 6: the traveler's preference is a *set* of acceptable modes for
  // sizeable hops, not a single mode forced onto every leg regardless of
  // distance — a 200m leg between two stops should never be "by cab" just
  // because that's the trip's primary mode.
  const allowedTransportModes = (trip.transport_modes && trip.transport_modes.length)
    ? trip.transport_modes
    : [transportMode];
  const { ordered, totalDistanceKm, totalDurationMinutes } = await orderSpotsRoute(
    selected,
    { lat: trip.start_lat || trip.destination_lat, lng: trip.start_lng || trip.destination_lng },
    transportMode
  );

  // 3b. Weather note + outdoor-swap tracking, using the forecast fetched in step 1b.
  const weatherNote = formatWeatherNote(forecast);
  const usedSpotIds = new Set(selected.map((s) => s.id));
  let outdoorSwaps = 0;

  // 4. Attach timing, crowd, budget, weather, meals, transit, and reasoning to each stop
  const tripStartHour = trip.start_time ? parseInt(trip.start_time.split(':')[0], 10) : 9;
  const interestLabels = (trip.interests || []).map((i) => i.category);

  // 4a. Split the ordered route into one bucket per trip day, as evenly as
  //     possible while preserving order (the nearest-neighbor ordering
  //     above already tends to cluster geographically-close stops next to
  //     each other, so sequential chunking approximates a same-day cluster
  //     reasonably well without re-running route optimization per day).
  //     Each day's attractions are first nudged into a natural time-of-day
  //     order (Part 8 — temples/gardens/beaches in the morning, museums/
  //     shopping/indoor spots midday, marina/sunset/entertainment in the
  //     evening), then diversified (Part 9) so the same subcategory doesn't
  //     land back-to-back (Temple → Temple, Museum → Museum), then woven
  //     together with deliberate meal stops (Part 6/7) into a single
  //     per-day plan below.
  const rawDayBuckets = chunkIntoDays(ordered, dayCount);
  const dayBuckets = rawDayBuckets
    .map((bucket) => applyTimeOfDayOrdering(bucket))
    // Two passes: broad category first (stops the "food, food, food, food"
    // / "mall, mall" runs the PDF export was showing — chunkIntoDays above
    // already spreads categories across days, this catches whatever still
    // lands adjacent within one day), then subcategory (finer-grained —
    // "Temple A, Temple B" back-to-back within the same category).
    .map((bucket) => diversifyConsecutive(bucket, (it) => it.spot.category))
    .map((bucket) => diversifyConsecutive(bucket, (it) => it.spot.subcategory || it.spot.category));
  const startAnchor = { lat: trip.start_lat || trip.destination_lat, lng: trip.start_lng || trip.destination_lng };

  let stops = [];
  let totalEntryCost = 0;
  const usedMealSpotIds = new Set(); // tracks which mealPool spots have already been scheduled as lunch/dinner/café, across the whole trip

  for (let dayIndex = 0; dayIndex < dayBuckets.length; dayIndex++) {
    const dayNumber = dayIndex + 1;
    const dayDate = addDays(trip.start_date, dayIndex);
    const isWeekend = [0, 6].includes(new Date(dayDate).getDay());
    let clock = tripStartHour * 60; // minutes since midnight, reset every day
    let lastCoords = null; // updated after every stop (attraction or meal) so meal-stop distances are accurate

    const dayPlan = buildDayPlan(dayBuckets[dayIndex], { wantsFoodFeatured, tripStartHour: dayIndex === 0 ? tripStartHour : 9 });

    for (let i = 0; i < dayPlan.length; i++) {
    const planEntry = dayPlan[i];
    const isFirstOfDay = i === 0;
    let distanceKmFromPrev;
    let travelMinutesFromPrev;
    let routeSource;
    let spot;
    let weatherAlternative = null;
    let mealTypeLabel = null;

    if (planEntry.kind === 'meal') {
      const anchorPoint = lastCoords || startAnchor;
      // Prefer the subcategory that actually fits the meal slot — lunch and
      // dinner are full sit-down meals (Restaurants), while the "cafe" slot
      // is the evening snack/tea break (Cafés). Without this, "nearest
      // food_dining spot" was picked regardless of type, so a café could
      // land as the lunch stop and a full restaurant as the snack stop.
      // If nothing matching that preference is within range, fall back to
      // any food_dining spot nearby rather than dropping the meal slot.
      // Exclude against `usedSpotIds` (not just `usedMealSpotIds`) — that
      // set already contains every spot seated anywhere in the trip so
      // far, including any food_dining spot already featured as its own
      // attraction stop (Food Explorer style). Without this, the same
      // restaurant could be scheduled as a stop AND picked again later
      // for lunch/dinner/café.
      const mealSubcategoryPreference = {
        lunch: ['Restaurants'],
        dinner: ['Restaurants'],
        cafe: ['Cafés'],
        breakfast: ['Cafés', 'Restaurants'],
      }[planEntry.mealType] || null;

      let nearestMeal = mealSubcategoryPreference
        ? nearestInCategory(mealPool, 'food_dining', { lat: anchorPoint.lat, lng: anchorPoint.lng }, {
            maxRadiusKm: 5, exclude: usedSpotIds, subcategories: mealSubcategoryPreference,
          })
        : null;
      if (!nearestMeal) {
        nearestMeal = nearestInCategory(mealPool, 'food_dining', { lat: anchorPoint.lat, lng: anchorPoint.lng }, {
          maxRadiusKm: 5, exclude: usedSpotIds,
        });
      }
      if (!nearestMeal) continue; // no food candidate nearby left to schedule — skip this meal slot rather than force one
      if (!nearestMeal || !nearestMeal.spot) {
          console.warn("Invalid nearestMeal:", nearestMeal);
          continue;
      }

      
      spot = nearestMeal.spot;
      distanceKmFromPrev = nearestMeal.distanceKm;
      travelMinutesFromPrev = estimateTravelMinutesFallback(nearestMeal.distanceKm, transportMode);
      routeSource = 'haversine_estimate';
      usedMealSpotIds.add(spot.id);
      usedSpotIds.add(spot.id);
      mealTypeLabel = planEntry.mealType;
    } else {
      ({ spot, distanceKmFromPrev, travelMinutesFromPrev, routeSource } = planEntry.item);

      // First stop of a day (after day 1) isn't reached from the previous
      // day's last stop — the traveler starts fresh from their accommodation
      // / starting point, so recompute that leg instead of reusing the
      // continuous-route distance from the overall ordering pass.
      if (isFirstOfDay && dayIndex > 0) {
        const fromStart = haversineKm(startAnchor.lat, startAnchor.lng, spot.latitude, spot.longitude);
        distanceKmFromPrev = Math.round(fromStart * 10) / 10;
        const dayStartLeg = recommendTransportMode(distanceKmFromPrev, allowedTransportModes, transportMode);
        travelMinutesFromPrev = estimateTravelMinutesFallback(fromStart, dayStartLeg.mode);
        routeSource = 'haversine_estimate';
      }

      // Weather-aware swap: if forecast is outdoor-unfriendly and this stop is
      // outdoor, look for an indoor candidate nearby with a similar interest
      // match instead of dropping the stop entirely.
      if (forecast?.outdoorUnfriendly && isOutdoorSpot(spot)) {
        const replacement = candidates.find((c) =>
          !usedSpotIds.has(c.id) && !isOutdoorSpot(c) &&
          haversineNear(c, spot, 8)
        );
        if (replacement) {
          weatherAlternative = { originalName: spot.name, reason: `${forecast.label.toLowerCase()} forecast — swapped for an indoor spot` };
          usedSpotIds.delete(spot.id);
          usedSpotIds.add(replacement.id);
          spot = replacement;
          outdoorSwaps += 1;
        }
      }
    }

    // Step 6: pick the realistic transport mode for *this specific leg* by
    // distance band, rather than blindly reusing the trip's primary mode —
    // this is what stops a 300m hop from being labeled "by cab" or a short
    // walk from rounding down to an unrealistic 0-minute leg.
    const legTransport = recommendTransportMode(distanceKmFromPrev, allowedTransportModes, transportMode);
    if (legTransport.mode !== transportMode) {
      travelMinutesFromPrev = estimateTravelMinutesFallback(distanceKmFromPrev, legTransport.mode);
    }
    // A leg is never shown as instantaneous — even a very short hop carries
    // at least a minute or two of real-world overhead (crossing a street,
    // parking, boarding).
    travelMinutesFromPrev = Math.max(travelMinutesFromPrev, distanceKmFromPrev > 0 ? 2 : 0);

    clock += travelMinutesFromPrev;
    let arrivalMinutes = clock;

    // Deliberate meal stops are nudged to land inside their proper window
    // (Part 7) — e.g. lunch shouldn't land at 10:30 AM just because the
    // route got there early. Only nudges forward (waits), never backward.
    if (mealTypeLabel && MEAL_WINDOWS[mealTypeLabel] && arrivalMinutes < MEAL_WINDOWS[mealTypeLabel].startMin) {
      arrivalMinutes = MEAL_WINDOWS[mealTypeLabel].startMin;
      clock = arrivalMinutes;
    }

    const visitMinutes = mealTypeLabel
      ? Math.max(15, Math.round(MEAL_WINDOWS[mealTypeLabel].visitMinutes * tripStylePacing.visitMinutesMultiplier))
      : Math.max(15, Math.round((spot.avg_visit_minutes || 60) * tripStylePacing.visitMinutesMultiplier));
    clock += visitMinutes;
    const departureMinutes = clock;

    const entryCost = estimateSpotEntryCost(spot, {
      adults: trip.adults, kids: trip.kids, elderly: trip.elderly, speciallyAbled: trip.specially_abled,
    });
    totalEntryCost += entryCost;

    // Reasoning used to be fetched here with `await`, one Gemini call per
    // stop, one after another — for a 10-15 stop trip that's 10-15 serial
    // round-trips (each with its own timeout/retry) stacking up in the
    // critical path. It's filled in below, once, for every stop at once
    // via Promise.all — same total work, done concurrently instead of
    // sequentially.
    const reasoning = null;

    // Restaurant/meal suggestion near this stop: intentionally NOT
    // generated per-attraction anymore. Food is already fully covered by
    // the deliberately-scheduled meal-time stops (breakfast/lunch/cafe/
    // dinner — one each, added in buildDayPlan above); attaching another
    // "nearby food recommendation" to every single attraction stop on top
    // of that meant a day could show several food suggestions at once
    // instead of exactly one per meal time. `mealSuggestion` stays null
    // for every non-meal stop.
    const mealSuggestion = null;
    const publicTransport = suggestPublicTransport(distanceKmFromPrev);
    const bestVisitTime = suggestBestVisitTime(spot.category, isWeekend);
    const nearbyAttractionsList = nearbyAttractions(candidates, spot, usedSpotIds, { limit: 3, maxRadiusKm: 2.5 });

    // The traveler's starting point for the very first leg of every day
    // (day 1's first stop, and each later day's fresh start) — every other
    // leg is "from" whatever stop was visited immediately before it.
    const previousStop = stops[stops.length - 1];

    const fromLocationName = isFirstOfDay
      ? (trip.start_location || trip.destination)
      : (previousStop?.name || trip.start_location || trip.destination);
    stops.push({
      spot_id: spot.id,
      name: spot.name,
      category: spot.category,
      meal_type: mealTypeLabel,
      latitude: spot.latitude,
      longitude: spot.longitude,
      order: stops.length + 1,
      day: dayNumber,
      date: dayDate,
      arrival_time: minutesToClock(arrivalMinutes),
      departure_time: minutesToClock(departureMinutes),
      visit_minutes: visitMinutes,
      from_location_name: fromLocationName,
      to_location_name: spot.name,
      transport_mode: legTransport.mode,
      transport_reason: legTransport.note,
      distance_km_from_prev: distanceKmFromPrev,
      travel_minutes_from_prev: travelMinutesFromPrev,
      route_source: routeSource,
      entry_cost_inr: entryCost,
      opening_hours: spot.opening_hours || null,
      rating: spot.rating ?? null,
      crowd_level: estimateCrowdLevel(Math.floor(arrivalMinutes / 60) % 24, isWeekend),
      best_visit_time: bestVisitTime,
      weather_note: weatherNote,
      weather_alternative: weatherAlternative,
      public_transport: publicTransport,
      meal_suggestion: mealSuggestion,
      nearby_attractions: nearbyAttractionsList,
      reasoning,
    });

    lastCoords = { lat: spot.latitude, lng: spot.longitude };
    } // end per-stop loop
  } // end per-day loop

  // Fill in every stop's AI reasoning concurrently now that the schedule
  // itself (times, ordering, costs) is fully built — see the note above
  // where `reasoning` was set to null. This is the single biggest latency
  // win available here: N sequential Gemini calls become one batch of N
  // parallel calls.
  const reasonings = await Promise.all(stops.map((s) => explainSpotChoice(s, { interestLabels })));
  stops.forEach((s, i) => { s.reasoning = reasonings[i]; });

  // 4b. Final validation (Part 7): make sure nothing that slipped through
  // is a government office, administrative building, or other non-tourism
  // place. Any invalid stop is swapped for the next best unused candidate
  // of the same category rather than just deleted, so the day plan
  // doesn't end up with a gap.
  replaceInvalidStops(stops, candidates, usedSpotIds);

  // 4c. AI Smart Transit Planner: attach a full ranked, multi-option
  // transport plan to every leg (walk/bicycle/bike-taxi/auto/cab/metro/
  // local-bus/train/ferry with fares, schedules, and booking links) —
  // additive on top of the transport_mode/public_transport fields above.
  enrichStopsWithTransportPlans(stops, trip, groupSize, forecast, allowedTransportModes);

  // 4d. Fold the recommended accommodation into the itinerary itself as
  // real stops (check-in day 1, day-start/return each day, check-out on
  // the last day) — see insertAccommodationStops for details. A no-op
  // when accommodation wasn't requested or couldn't be found.
  stops = insertAccommodationStops(stops, { accommodation, trip, allowedTransportModes, transportMode });

  // 5. Budget summary — estimates a category breakdown for the total budget
  //    so the itinerary results page can show/track it; this is a byproduct
  //    of itinerary generation, not a user-facing input.
  // Only allocate a slice of the budget to "accommodation" when a stay was
  // both requested AND actually found — `trip.needs_accommodation` alone
  // used to be enough to carve out ~35% of the budget into that bucket,
  // so a trip where no accommodation could be found (or a day trip that
  // never asked for one, covered separately below) still reported a real
  // rupee cost for a stay that never appears anywhere else in the plan —
  // the PDF could (and did) show both "no accommodation was found" and a
  // non-zero accommodation line in the same document. When that money
  // isn't really being spent, it belongs back with the buckets that fund
  // the actual itinerary (food/transport/experience), same as the
  // existing !needsAccommodation redistribution below.
  const accommodationSecured = Boolean(trip.needs_accommodation && accommodation);
  const budgetSplit = splitBudget({
    totalBudgetInr: trip.total_budget_inr,
    interests: boostedInterests,
    needsAccommodation: accommodationSecured,
  });

  const mealCostPerDay = estimateMealCost(trip.food_preferences, groupSize, 3); // 3 meals/day
  const estimatedFoodCost = mealCostPerDay * dayCount;

  // Hidden gems, surfaced separately from the main route
  const hiddenGems = findHiddenGems(candidates, { anchor }).map((s) => ({
    id: s.id, name: s.name, category: s.category, rating: s.rating, reason: hiddenGemReason(s),
  }));

  const tripSummary = buildHeuristicTripSummary(trip, stops, {
    hiddenGemCount: hiddenGems.length,
    outdoorSwaps,
  });

  const tripExtras = await buildTripExtras(trip, forecast, dayCount);

  const confidenceScores = computeConfidenceScores({
    trip, stops, byCategory: budgetSplit, entryFeesTotal: totalEntryCost, forecast, outdoorSwaps,
  });
  const decisionExplanation = buildDecisionExplanation(trip, stops, {
    forecast, outdoorSwaps, hiddenGemCount: hiddenGems.length, learnedPreferences,
  });

  // 6. Complete the journey: compute the final leg from the last stop to the
  //    traveler's selected end location, and a start-to-end route summary.
  const journey = await buildJourney(trip, stops, { fallbackTransportMode: transportMode });
  if (journey.end?.location) {
    journey.end.transport = attachTransportPlan({
      distanceKm: journey.end.distance_km_from_prev,
      fromName: journey.end.from_location_name,
      toName: journey.end.location,
      travellers: groupSize,
      allowedModes: allowedTransportModes,
      transportPriority: trip.transport_priority,
      arrivalClock: stops[stops.length - 1]?.departure_time,
      forecast,
      destinationName: trip.destination,
    });
  }
  const bookingItinerary = buildBookingItinerary(stops, journey);

  // 6b. Step 9 — Budget Validation: check the itinerary's *actual* computed
  // cost (transport + food + entry fees + buffer) against the stated
  // budget, not just the pre-allocated split above.
  const transportCostEstimate = estimateTransportCostForStops(stops);
  let budgetValidation = validateBudget({
    totalBudgetInr: trip.total_budget_inr,
    transportCostInr: transportCostEstimate,
    foodCostInr: estimatedFoodCost,
    entryFeesInr: totalEntryCost,
  });

  // Budget Feasibility: food + transport alone (i.e. the cost of the trip
  // with ZERO attraction stops) checked against the stated budget *before*
  // any trimming is attempted. This used to be skipped entirely, so the
  // only corrective action available was dropping the single highest
  // entry-fee stop — which does nothing when every candidate nearby is a
  // free-entry spot (malls, parks, viewpoints), leaving a budget overshoot
  // reported with no real attempt to close it and no explanation of why.
  const budgetFeasibility = checkBudgetFeasibility({
    totalBudgetInr: trip.total_budget_inr,
    transportCostInr: transportCostEstimate,
    foodCostInr: estimatedFoodCost,
  });

  // 6c. Step 10 — Final Validation: run the full checklist. If the only
  // thing that failed is the budget check AND the shortfall is actually
  // recoverable by dropping stops (i.e. food+transport alone still fit the
  // budget), iteratively drop the most expensive non-essential — i.e. not
  // Must Visit tier, not a meal — stops one at a time until the plan fits,
  // the trimmable pool runs out, or a floor of stops is reached, rather
  // than a single drop that silently no-ops whenever entry fees are ₹0.
  const requestedCategoriesForValidation = [...new Set((trip.interests || []).map((i) => i.category).filter(Boolean))];
  let finalValidation = runFinalValidation({
    stops, candidates, hiddenGems, budgetValidation, tripStartHour, requestedCategories: requestedCategoriesForValidation,
  });

  // Interest-diversity auto-fix: if the route ended up dominated by one
  // category despite the traveler requesting several, swap the overflow
  // stops for genuine unused candidates from the under-represented
  // categories — the same repair the Gemini path already applies (see
  // capStopsByCategory usage further below) — rather than shipping a
  // "technically valid" itinerary that quietly ignored half the trip's
  // requested interests.
  if (!finalValidation.passed && finalValidation.failedCheckIds.includes('interest_diversity_respected')) {
    stops = capStopsByCategory(stops, candidates, requestedCategoriesForValidation, {
      anchor: { lat: trip.destination_lat, lng: trip.destination_lng },
    });
    stops.forEach((s, i) => { s.order = i + 1; });
    totalEntryCost = stops.reduce((sum, s) => sum + (Number(s.entry_cost_inr) || 0), 0);
    budgetValidation = validateBudget({
      totalBudgetInr: trip.total_budget_inr,
      transportCostInr: estimateTransportCostForStops(stops),
      foodCostInr: estimatedFoodCost,
      entryFeesInr: totalEntryCost,
    });
    finalValidation = runFinalValidation({
      stops, candidates, hiddenGems, budgetValidation, tripStartHour, requestedCategories: requestedCategoriesForValidation,
    });
  }

  const MIN_STOPS_AFTER_TRIM = Math.max(2, Math.ceil(dayCount * 1)); // never trim below ~1 stop/day
  if (
    !finalValidation.passed
    && finalValidation.failedCheckIds.length === 1
    && finalValidation.failedCheckIds[0] === 'budget_respected'
    && budgetFeasibility.feasible
  ) {
    let guard = 0; // safety net against any unforeseen infinite loop
    while (!budgetValidation.within_budget && guard < 25) {
      guard += 1;
      const trimmable = stops
        .filter((s) => !s.meal_type && s.category !== 'accommodation'
          && (s.entry_cost_inr || 0) > 0
          && classifyAttractionTier(candidates.find((c) => c.id === s.spot_id) || {}) !== 'must_visit')
        .sort((a, b) => (b.entry_cost_inr || 0) - (a.entry_cost_inr || 0));
      if (trimmable.length === 0 || stops.length <= MIN_STOPS_AFTER_TRIM) break;
      const drop = trimmable[0];
      const idx = stops.findIndex((s) => s.spot_id === drop.spot_id && s.order === drop.order);
      if (idx === -1) break;
      stops.splice(idx, 1);
      stops.forEach((s, i) => { s.order = i + 1; });
      totalEntryCost -= drop.entry_cost_inr || 0;
      budgetValidation = validateBudget({
        totalBudgetInr: trip.total_budget_inr,
        transportCostInr: estimateTransportCostForStops(stops),
        foodCostInr: estimatedFoodCost,
        entryFeesInr: totalEntryCost,
      });
    }
    finalValidation = runFinalValidation({
      stops, candidates, hiddenGems, budgetValidation, tripStartHour, requestedCategories: requestedCategoriesForValidation,
    });
  }

  const budgetSummary = {
    by_category: budgetSplit,
    entry_fees_total_inr: totalEntryCost,
    estimated_food_cost_inr: estimatedFoodCost,
    total_budget_inr: trip.total_budget_inr,
    // Surfaced so the results page / PDF can explain *why* the plan is over
    // budget when trimming stops genuinely can't close the gap — e.g. food
    // and transport for this many travelers, over this many days, already
    // exceed what was budgeted, regardless of which attractions are picked.
    budget_feasibility: budgetFeasibility.feasible
      ? null
      : {
          bare_minimum_inr: budgetFeasibility.bareMinimumInr,
          shortfall_inr: budgetFeasibility.shortfallInr,
          note: `Food and transport alone for ${groupSize} traveler(s) over ${dayCount} day(s) come to about ₹${budgetFeasibility.bareMinimumInr.toLocaleString('en-IN')} — already ₹${budgetFeasibility.shortfallInr.toLocaleString('en-IN')} over the ₹${Number(trip.total_budget_inr).toLocaleString('en-IN')} budget before any attractions are added. Consider raising the budget, choosing a cheaper food preference, or shortening the trip.`,
        },
    per_spot: stops.map((s) => ({ name: s.name, entry_cost_inr: s.entry_cost_inr })),
    budget_validation: budgetValidation,
    ai_extras: {
      summary: tripSummary,
      weather_forecast: forecast,
      emergency_contacts: tripExtras.emergencyContacts,
      local_events: tripExtras.localEvents,
      packing_list: tripExtras.packingList,
      confidence_scores: confidenceScores,
      decision_explanation: decisionExplanation,
      learned_preferences: learnedPreferences,
      journey,
      final_validation: finalValidation,
      booking_itinerary: bookingItinerary,
      interest_fallback_note: interestFallbackNote,
    },
  };

  applyAccommodationToBudget(budgetSummary, { accommodation, nights, groupSize });

  return {
    stops,
    budgetSummary,
    hiddenGems,
    journey,
    totalDistanceKm: journey.route_summary.total_distance_km,
    totalDurationMinutes: journey.route_summary.total_travel_minutes,
    generatedBy: 'heuristic+gemini',
    spotSource, // 'supabase' | 'sample' — lets the frontend flag demo data
    interestFallbackNote,
  };
}

/**
 * Final AI validation pass (Part 7): walks a generated stop list and swaps
 * out anything that isn't a genuine tourist/travel destination — a
 * government office, administrative building, or other non-tourism place
 * that slipped past the earlier filtering — for the next best unused
 * candidate spot, preferring the same category so the day's theme still
 * holds together. Mutates `stops` in place; `usedSpotIds` is kept in sync
 * so later logic (meal suggestions, nearby attractions) doesn't double-book
 * the replacement.
 */
function replaceInvalidStops(stops, candidates, usedSpotIds) {
  // Gemini's prompt asks it not to repeat places, but nothing downstream
  // ever enforced that — unlike the heuristic path (which seats spots
  // into a Set and can never double-book one), the AI path just trusted
  // the model's compliance. Two failure modes both show up as "repeated
  // places": Gemini itself naming the same attraction (or restaurant)
  // twice, and findMatchingSpot's fuzzy substring/word-overlap matching
  // resolving two differently-worded Gemini place names to the very same
  // candidate spot. Accommodation is the one deliberate exception — a
  // hotel legitimately repeats across check-in/day-start/return/check-out
  // — so every other stop, including food_dining (a restaurant/café
  // shouldn't be reused for two different meals either), is deduplicated
  // here across the *whole* trip, not just within a single day.
  const seenIds = new Set();
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const isDuplicate = stop.category !== 'accommodation'
      && stop.spot_id
      && seenIds.has(stop.spot_id);
    if (isValidItineraryStop(stop) && !isDuplicate) {
      if (stop.category !== 'accommodation' && stop.spot_id) {
        seenIds.add(stop.spot_id);
      }
      continue;
    }

    const sameCategoryReplacement = candidates.find(
      (c) => c.category === stop.category && !usedSpotIds.has(c.id) && isValidItineraryStop(c)
    );
    const anyReplacement = sameCategoryReplacement
      || candidates.find((c) => !usedSpotIds.has(c.id) && isValidItineraryStop(c));

    if (!anyReplacement) {
      // Nothing left to swap in — drop the invalid/duplicate stop rather
      // than show it twice.
      usedSpotIds.delete(stop.spot_id);
      stops.splice(i, 1);
      i -= 1;
      continue;
    }

    usedSpotIds.delete(stop.spot_id);
    usedSpotIds.add(anyReplacement.id);
    stops[i] = {
      ...stop,
      spot_id: anyReplacement.id,
      name: anyReplacement.name,
      category: anyReplacement.category,
      latitude: anyReplacement.latitude,
      longitude: anyReplacement.longitude,
      opening_hours: anyReplacement.opening_hours || null,
      rating: anyReplacement.rating ?? null,
      entry_cost_inr: stop.entry_cost_inr, // recomputed budget already ran; close enough for a same-slot swap
      reasoning: stop.reasoning,
      to_location_name: anyReplacement.name,
    };
    if (anyReplacement.category !== 'accommodation') {
      seenIds.add(anyReplacement.id);
    }
  }
}

/**
 * Finds nearby attractions worth knowing about around a stop — spots
 * already in the candidate dataset that aren't already part of this
 * itinerary, within a short walking/short-hop radius, ranked by rating.
 * This is separate from the main route: it's "while you're here, also
 * consider..." rather than another scheduled stop.
 */
function nearbyAttractions(candidates, spot, usedIds, { limit = 3, maxRadiusKm = 2.5 } = {}) {
  return candidates
    .filter((c) => c.id !== spot.id && !usedIds.has(c.id))
    .map((c) => ({ c, distanceKm: haversineKm(spot.latitude, spot.longitude, c.latitude, c.longitude) }))
    .filter(({ distanceKm }) => distanceKm <= maxRadiusKm)
    .sort((a, b) => (b.c.rating || 0) - (a.c.rating || 0) || a.distanceKm - b.distanceKm)
    .slice(0, limit)
    .map(({ c, distanceKm }) => ({
      name: c.name,
      category: c.category,
      rating: c.rating ?? null,
      distance_km: Math.round(distanceKm * 10) / 10,
    }));
}

/**
 * Builds the trip-level "wow" extras that apply once per trip rather than
 * per stop: emergency contacts near the destination, any public holidays/
 * local events during the trip dates, and a weather-and-interest-aware
 * packing list. Shared by both the heuristic and full-Gemini generation
 * paths so neither one skips these features.
 */
async function buildTripExtras(trip, forecast, dayCount) {
  const [emergencyContacts, localEvents] = await Promise.all([
    getEmergencyContacts({ lat: trip.destination_lat, lng: trip.destination_lng, countryCode: trip.country_code || 'IN', areaHint: trip.destination }),
    getLocalEvents({ startDate: trip.start_date, endDate: trip.end_date, countryCode: trip.country_code || 'IN' }),
  ]);

  const packingList = buildPackingList({
    forecast,
    dayCount,
    interests: trip.interests || [],
    groupComposition: { kids: trip.kids, elderly: trip.elderly, speciallyAbled: trip.specially_abled },
    needsAccommodation: trip.needs_accommodation,
  });

  return { emergencyContacts, localEvents, packingList };
}

/**
 * Splits an ordered list of route stops into `dayCount` contiguous buckets
 * of roughly equal size, preserving order. Used to give multi-day trips an
 * actual day-by-day structure instead of one continuous, ever-growing
 * timeline that silently wraps past midnight.
 */
function chunkIntoDays(orderedStops, dayCount) {
  const count = Math.max(1, dayCount);
  const buckets = Array.from({ length: count }, () => []);
  if (orderedStops.length === 0) return buckets;

  const perDay = Math.ceil(orderedStops.length / count);

  // Category-balanced bucket assignment (Part 9 fix): a naive positional
  // slice of the nearest-neighbor route ("first `perDay` stops -> Day 1,
  // next `perDay` -> Day 2, ...") can dump an entire same-category run
  // into one day — nearest-neighbor ordering visits nearby same-type
  // spots (5 restaurants, 2 malls) back-to-back because they're
  // geographically clustered, so a plain slice grabs that whole run
  // intact. The later diversifyConsecutive pass only reorders *within* a
  // day and can't fix a day that's already 5-of-7 stops from one
  // category — there's nothing different to swap it with locally.
  //
  // Instead, walk the route in its existing (already route-optimized)
  // order, but assign each stop to whichever day — among days not yet at
  // `perDay` capacity — currently holds the fewest stops of that same
  // category. This spreads a same-category run evenly across the trip's
  // days instead of stacking it into one, while still broadly respecting
  // the route order (ties go to the earliest day), so day-level
  // geographic coherence isn't badly disrupted.
  const categoryCountsByDay = buckets.map(() => new Map());
  for (const stop of orderedStops) {
    const category = stop.spot.category;
    let bestDay = -1;
    let bestCount = Infinity;
    for (let d = 0; d < count; d++) {
      if (buckets[d].length >= perDay) continue;
      const c = categoryCountsByDay[d].get(category) || 0;
      if (c < bestCount) {
        bestCount = c;
        bestDay = d;
      }
    }
    if (bestDay === -1) {
      // Rounding edge case — every day already hit `perDay`. Fall back to
      // whichever day has the fewest stops overall.
      bestDay = buckets.reduce((minIdx, b, idx) => (b.length < buckets[minIdx].length ? idx : minIdx), 0);
    }
    buckets[bestDay].push(stop);
    categoryCountsByDay[bestDay].set(category, (categoryCountsByDay[bestDay].get(category) || 0) + 1);
  }
  return buckets;
}

/**
 * Rebalances WHICH DAY each stop belongs to so no single day ends up
 * dominated by one category — used on the Gemini/AI path, where day
 * assignment comes straight from the model's own output. Gemini can (and
 * does) put a whole same-category run — 5 restaurants, 2 malls — onto one
 * day, and no amount of *reordering within* that day can fix it if
 * there's nothing else in that day to swap with. This walks the stops in
 * their existing order and reassigns each one to whichever day — among
 * days not yet back at their original stop count — currently holds the
 * fewest stops of that same category, so a same-category run gets spread
 * across the trip instead of stacked into a single day.
 *
 * Accommodation stops (legitimately repeat check-in/day-start/etc.) and
 * any stop without a valid `day` are left untouched. Each day's *total*
 * stop count is preserved — only which stops land where changes — so
 * trip length/structure isn't disturbed.
 */
function rebalanceCategoriesAcrossDays(stops) {
  const movable = stops.filter((s) => s.category !== 'accommodation' && Number.isFinite(s.day));
  const days = [...new Set(movable.map((s) => s.day))].sort((a, b) => a - b);
  if (days.length < 2) return stops; // nothing to balance across

  const dayCapacity = new Map();
  const dayDate = new Map();
  for (const d of days) {
    dayCapacity.set(d, movable.filter((s) => s.day === d).length);
    dayDate.set(d, movable.find((s) => s.day === d)?.date || null);
  }

  const dayUsed = new Map(days.map((d) => [d, 0]));
  const dayCategoryCounts = new Map(days.map((d) => [d, new Map()]));
  const newDayFor = new Map();

  for (const stop of movable) {
    let bestDay = null;
    let bestCount = Infinity;
    for (const d of days) {
      if (dayUsed.get(d) >= dayCapacity.get(d)) continue;
      const c = dayCategoryCounts.get(d).get(stop.category) || 0;
      if (c < bestCount) {
        bestCount = c;
        bestDay = d;
      }
    }
    if (bestDay == null) bestDay = stop.day; // shouldn't happen — capacities sum to movable.length
    newDayFor.set(stop, bestDay);
    dayUsed.set(bestDay, dayUsed.get(bestDay) + 1);
    const catMap = dayCategoryCounts.get(bestDay);
    catMap.set(stop.category, (catMap.get(stop.category) || 0) + 1);
  }

  return stops.map((s) => {
    const newDay = newDayFor.get(s);
    if (newDay == null || newDay === s.day) return s;
    return { ...s, day: newDay, date: dayDate.get(newDay) || s.date };
  });
}


// naturally belongs to. Matched against category first (cheap, reliable),
// then subcategory/name keywords for the cross-cutting cases (a "sunset
// point" is nature/heritage by category but unmistakably an evening spot).
// Anything that matches nothing stays 'any' and is left wherever the
// geographic ordering already put it.
const TIME_SLOT_RANK = { morning: 0, any: 1, afternoon: 2, evening: 3 };

const MORNING_CATEGORIES = new Set(['heritage_historical', 'nature_scenic', 'religious_spiritual']);
const MORNING_KEYWORDS = ['temple', 'garden', 'beach', 'sunrise', 'park', 'lake'];

const AFTERNOON_CATEGORIES = new Set(['shopping', 'arts_culture', 'science_learning']);
const AFTERNOON_KEYWORDS = ['museum', 'gallery', 'aquarium', 'indoor', 'planetarium', 'mall'];

const EVENING_CATEGORIES = new Set(['nightlife', 'entertainment_recreation']);
const EVENING_KEYWORDS = ['marina', 'sunset', 'promenade', 'boardwalk', 'night market', 'viewpoint', 'entertainment'];

/** Which part of the day a spot is most naturally visited in — see Part 8. */
function getPreferredTimeSlot(spot) {
  const haystack = `${spot.subcategory || ''} ${spot.name || ''}`.toLowerCase();

  if (EVENING_CATEGORIES.has(spot.category) || EVENING_KEYWORDS.some((kw) => haystack.includes(kw))) {
    return 'evening';
  }
  if (AFTERNOON_CATEGORIES.has(spot.category) || AFTERNOON_KEYWORDS.some((kw) => haystack.includes(kw))) {
    return 'afternoon';
  }
  if (MORNING_CATEGORIES.has(spot.category) || MORNING_KEYWORDS.some((kw) => haystack.includes(kw))) {
    return 'morning';
  }
  return 'any';
}

/**
 * Nudges a day's already geo-ordered attraction list (from the
 * nearest-neighbor route) toward a natural time-of-day flow — morning
 * spots first, afternoon/indoor spots midday, evening spots (sunset,
 * marina, entertainment) last — without discarding the geographic
 * clustering already computed. Uses a stable sort keyed on time-slot rank,
 * so items sharing a slot keep their existing relative (nearest-neighbor)
 * order; this only reshuffles across slot boundaries, it never re-routes.
 */
function applyTimeOfDayOrdering(dayItems) {
  return dayItems
    .map((item, idx) => ({ item, idx, rank: TIME_SLOT_RANK[getPreferredTimeSlot(item.spot)] }))
    .sort((a, b) => (a.rank - b.rank) || (a.idx - b.idx))
    .map(({ item }) => item);
}

// Target arrival windows + typical visit length for each deliberately-
// scheduled meal type (Part 7). A meal stop that would otherwise land
// before its window opens is nudged forward to wait for it; it's never
// pulled backward, since that would mean arriving somewhere before the
// traveler could realistically get there.
const MEAL_WINDOWS = {
  breakfast: { startMin: 6 * 60, endMin: 10 * 60, visitMinutes: 30 },
  lunch: { startMin: 11 * 60 + 30, endMin: 14 * 60 + 30, visitMinutes: 60 },
  cafe: { startMin: 16 * 60, endMin: 18 * 60, visitMinutes: 30 }, // "Evening Snacks" window (4:00–6:00 PM) — never tea/snacks at lunchtime
  dinner: { startMin: 19 * 60, endMin: 21 * 60, visitMinutes: 60 },
};

/**
 * Weaves deliberate meal stops into a day's ordered attraction list
 * (Part 6/7): lunch is always included once there's a morning's worth of
 * sightseeing to break up, dinner only when the day has enough stops to
 * plausibly run into the evening, and a café only when the traveler wants
 * food featured (Food Explorer style / a "food" interest) and the day has
 * room for a genuine extra stop — never inserted between every single
 * attraction. Returns a flat, schedule-ordered plan of
 * `{ kind: 'attraction', item }` / `{ kind: 'meal', mealType }` entries.
 */
function buildDayPlan(dayItems, { wantsFoodFeatured, tripStartHour = 9 }) {
  const plan = [];
  if (dayItems.length === 0) return plan;

  // Morning Attractions -> Lunch -> Afternoon Attractions -> Snacks -> Evening
  // Attractions -> Dinner (Step 7): breakfast only makes sense when the day
  // genuinely starts in the breakfast window; it's never forced in.
  const includeBreakfast = tripStartHour < 10;
  const includeLunch = true; // every day gets at least a midday break
  const includeDinner = dayItems.length >= 3; // a "full" day plausibly runs into the evening
  const includeCafe = wantsFoodFeatured && dayItems.length >= 4;

  const lunchAfterIndex = Math.max(1, Math.ceil(dayItems.length / 2)) - 1; // 0-based: goes right after this attraction
  const cafeAfterIndex = includeCafe ? Math.min(dayItems.length - 1, Math.ceil(dayItems.length * 0.75) - 1) : null;

  if (includeBreakfast) plan.push({ kind: 'meal', mealType: 'breakfast' });

  dayItems.forEach((item, idx) => {
    plan.push({ kind: 'attraction', item });
    if (includeLunch && idx === lunchAfterIndex) plan.push({ kind: 'meal', mealType: 'lunch' });
    if (includeCafe && idx === cafeAfterIndex && idx !== lunchAfterIndex) plan.push({ kind: 'meal', mealType: 'cafe' });
  });
  if (includeDinner) plan.push({ kind: 'meal', mealType: 'dinner' });

  return plan;
}

/** Returns the ISO (YYYY-MM-DD) date `offsetDays` after `startDate`. */
function addDays(startDate, offsetDays) {
  const d = new Date(startDate);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Thin wrapper so the day-boundary "start fresh from accommodation" leg uses the same speed heuristics as the rest of the app. */
function estimateTravelMinutesFallback(distanceKm, mode) {
  return estimateTravelMinutes(distanceKm, mode);
}

/**
 * Splices the recommended accommodation into a finished stops array as
 * real, routable stops: check-in before day 1's first attraction, a
 * same-day-return stop after each day's last attraction (check-out
 * instead, on the final day), and a same-hotel "start your day" stop
 * before each subsequent day's first attraction. A no-op if there's no
 * accommodation (not requested, or none found).
 *
 * Also recomputes the first real stop of each day's travel leg to
 * originate from the hotel rather than from home/destination-center —
 * the anchor the base engine otherwise assumes for day boundaries — so
 * distance/time figures stay accurate once a real hotel is in the mix.
 */
export function insertAccommodationStops(stops, { accommodation, trip, allowedTransportModes, transportMode }) {
  if (!accommodation || !stops.length) return stops;
  const hotelPoint = { lat: accommodation.latitude, lng: accommodation.longitude };
  if (!Number.isFinite(hotelPoint.lat) || !Number.isFinite(hotelPoint.lng)) return stops;
  const homePoint = {
    lat: trip.start_lat ?? trip.destination_lat,
    lng: trip.start_lng ?? trip.destination_lng,
  };

  const byDay = new Map();
  stops.forEach((s) => {
    const day = s.day ?? 1;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  });
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const lastDay = days[days.length - 1];

  const result = [];
  days.forEach((day, dayIdx) => {
    const dayStops = byDay.get(day);
    const isFirstDay = dayIdx === 0;
    const isLastDay = day === lastDay;
    const firstStop = dayStops[0];
    const lastStop = dayStops[dayStops.length - 1];

    // ---- Morning node: check-in on day 1, otherwise just an anchor
    // marking the day starts from the same hotel (no real travel). ----
    const morningFrom = isFirstDay ? homePoint : hotelPoint;
    let morningLeg = { distanceKm: 0, minutes: 0, mode: null };
    if (Number.isFinite(morningFrom.lat) && Number.isFinite(morningFrom.lng)) {
      const distanceKm = Math.round(haversineKm(morningFrom.lat, morningFrom.lng, hotelPoint.lat, hotelPoint.lng) * 10) / 10;
      const leg = recommendTransportMode(distanceKm, allowedTransportModes, transportMode);
      morningLeg = { distanceKm, minutes: distanceKm > 0 ? estimateTravelMinutesFallback(distanceKm, leg.mode) : 0, mode: leg.mode };
    }
    result.push(buildAccommodationStop(accommodation, {
      subtype: isFirstDay ? 'check_in' : 'day_start',
      name: isFirstDay ? `Check-in — ${accommodation.name}` : accommodation.name,
      day,
      date: firstStop?.date || null,
      arrival_time: firstStop?.arrival_time || null,
      distance_km_from_prev: morningLeg.distanceKm,
      travel_minutes_from_prev: morningLeg.minutes,
      transport_mode: morningLeg.mode,
      tips: isFirstDay
        ? 'Check in and freshen up before heading out — this is your base for the trip.'
        : 'Start the day from your stay.',
    }));

    // Recompute the first real stop's leg so it originates from the
    // hotel instead of whatever anchor the base engine used before an
    // accommodation existed.
    if (firstStop && Number.isFinite(firstStop.latitude) && Number.isFinite(firstStop.longitude)) {
      const distanceKm = Math.round(haversineKm(hotelPoint.lat, hotelPoint.lng, firstStop.latitude, firstStop.longitude) * 10) / 10;
      const leg = recommendTransportMode(distanceKm, allowedTransportModes, transportMode);
      firstStop.distance_km_from_prev = distanceKm;
      firstStop.travel_minutes_from_prev = estimateTravelMinutesFallback(distanceKm, leg.mode);
      firstStop.transport_mode = firstStop.transport_mode || leg.mode;
    }

    result.push(...dayStops);

    // ---- Evening node: return to the hotel, or check out on the last day. ----
    let eveningLeg = { distanceKm: null, minutes: null, mode: null };
    if (lastStop && Number.isFinite(lastStop.latitude) && Number.isFinite(lastStop.longitude)) {
      const distanceKm = Math.round(haversineKm(lastStop.latitude, lastStop.longitude, hotelPoint.lat, hotelPoint.lng) * 10) / 10;
      const leg = recommendTransportMode(distanceKm, allowedTransportModes, transportMode);
      eveningLeg = { distanceKm, minutes: estimateTravelMinutesFallback(distanceKm, leg.mode), mode: leg.mode };
    }
    result.push(buildAccommodationStop(accommodation, {
      subtype: isLastDay ? 'check_out' : 'return',
      name: isLastDay ? `Check-out — ${accommodation.name}` : `Return to ${accommodation.name}`,
      day,
      date: lastStop?.date || null,
      arrival_time: lastStop?.departure_time || null,
      distance_km_from_prev: eveningLeg.distanceKm,
      travel_minutes_from_prev: eveningLeg.minutes,
      transport_mode: eveningLeg.mode,
      tips: isLastDay
        ? 'Check out, collect your luggage, and continue on to your onward journey.'
        : 'Head back for dinner and an overnight stay.',
    }));
  });

  result.forEach((s, i) => { s.order = i + 1; });
  return result;
}

export function buildAccommodationStop(accommodation, { subtype, name, day, date, arrival_time, distance_km_from_prev, travel_minutes_from_prev, transport_mode, tips }) {
  return {
    spot_id: accommodation.place_id || null,
    name,
    category: 'accommodation',
    subtype,
    latitude: accommodation.latitude,
    longitude: accommodation.longitude,
    address: accommodation.address,
    day,
    date,
    order: null, // assigned by insertAccommodationStops once the full sequence is known
    arrival_time,
    departure_time: null,
    visit_minutes: 0,
    distance_km_from_prev,
    travel_minutes_from_prev,
    transport_mode,
    transport_cost_inr: 0,
    entry_cost_inr: 0,
    rating: accommodation.rating ?? null,
    opening_hours: null,
    crowd_level: null,
    best_visit_time: null,
    weather_note: null,
    reasoning: tips,
    tips,
    hidden_gem: false,
    meal_type: null,
    nearby_attractions: [],
    maps_url: accommodation.maps_url,
    phone: accommodation.phone || null,
  };
}

/**
 * Folds the real accommodation cost + recommendation object into a
 * budgetSummary produced by either generation path, and adds a
 * cost-per-traveler figure alongside the existing trip total. A no-op
 * when there's no accommodation.
 */
export function applyAccommodationToBudget(budgetSummary, { accommodation, nights, groupSize }) {
  if (accommodation) {
    const accommodationCostInr = Math.round((accommodation.price_per_night_inr || 0) * (nights || 1));
    const previousAccommodationCostInr = Number(budgetSummary.by_category?.accommodation) || 0;
    budgetSummary.by_category = { ...budgetSummary.by_category, accommodation: accommodationCostInr };
    budgetSummary.ai_extras = { ...budgetSummary.ai_extras, accommodation };

    // budget_validation's total never included accommodation at all
    // (see budget.service.js's validateBudget) — add the real figure now.
    if (budgetSummary.budget_validation) {
      const bv = budgetSummary.budget_validation;
      bv.breakdown = { ...bv.breakdown, accommodation_inr: accommodationCostInr };
      bv.total_estimated_cost_inr = (bv.total_estimated_cost_inr || 0) + accommodationCostInr;
      bv.within_budget = bv.total_budget_inr === 0 ? true : bv.total_estimated_cost_inr <= bv.total_budget_inr;
      bv.overage_inr = bv.within_budget ? 0 : bv.total_estimated_cost_inr - bv.total_budget_inr;
      bv.remaining_budget_inr = bv.within_budget ? bv.total_budget_inr - bv.total_estimated_cost_inr : 0;
    }

    // The Gemini path additionally self-reports its own total (which
    // already baked in its own accommodation guess) — nudge it by the
    // delta rather than double-counting or ignoring the correction.
    if (budgetSummary.ai_extras.total_estimated_cost_inr != null) {
      const delta = accommodationCostInr - previousAccommodationCostInr;
      budgetSummary.ai_extras.total_estimated_cost_inr += delta;
      if (budgetSummary.ai_extras.remaining_budget_inr != null) {
        budgetSummary.ai_extras.remaining_budget_inr -= delta;
      }
    }
  }

  const totalCostInr = budgetSummary.budget_validation?.total_estimated_cost_inr
    ?? budgetSummary.ai_extras?.total_estimated_cost_inr
    ?? null;
  if (totalCostInr != null && groupSize > 0) {
    budgetSummary.cost_per_traveler_inr = Math.round(totalCostInr / groupSize);
  }

  return budgetSummary;
}

/** True if two spots are within radiusKm of each other (used for weather-swap candidates). */
function haversineNear(a, b, radiusKm) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  const dist = R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return dist <= radiusKm;
}

/**
 * Regenerates a single stop in an already-generated itinerary — swaps it
 * for a different candidate spot of the same category that isn't already
 * used elsewhere in the trip, keeping its position/timing slot. Used by the
 * "Regenerate this stop" button so travelers don't have to reroll the
 * whole plan over one stop they don't like.
 */
export async function regenerateStop(trip, itinerary, stopOrder) {
  const stops = [...(itinerary.stops || [])];
  const idx = stops.findIndex((s) => s.order === stopOrder);
  if (idx === -1) throw new Error('Stop not found in this itinerary.');
  const current = stops[idx];

  const { spots: candidates } = await loadSpots({
    city: trip.destination,
    lat: trip.destination_lat,
    lng: trip.destination_lng,
    interests: trip.interests || [],
  });
  const usedIds = new Set(stops.map((s) => s.spot_id));

  const anchor = { lat: current.latitude ?? trip.destination_lat, lng: current.longitude ?? trip.destination_lng };
  const sameCategoryPool = candidates.filter((c) => c.category === current.category && !usedIds.has(c.id));
  const interestLabels = (trip.interests || []).map((i) => i.category);
  const replacement = selectSpots(sameCategoryPool, { interests: trip.interests || [], anchor, limit: 1, tripStyle: trip.trip_style })[0];

  if (!replacement) {
    throw new Error(`No other ${current.category} spots available nearby to swap in.`);
  }

  const entryCost = estimateSpotEntryCost(replacement, {
    adults: trip.adults, kids: trip.kids, elderly: trip.elderly, speciallyAbled: trip.specially_abled,
  });
  const reasoning = await explainSpotChoice(replacement, { interestLabels });

  // "Nearby food recommendation" on non-food attraction stops was removed
  // itinerary-wide (see the same comment in the main generation loop
  // above) — food suggestions now come only from the dedicated meal-time
  // stops, so a regenerated attraction stop shouldn't reintroduce one.
  const mealSuggestion = null;

  const isWeekend = [0, 6].includes(new Date(trip.start_date).getDay());
  const groupSize = trip.adults + trip.kids + trip.elderly + trip.specially_abled;
  const allowedModes = (trip.transport_modes && trip.transport_modes.length) ? trip.transport_modes : [];
  const updatedStop = {
    ...current,
    spot_id: replacement.id,
    name: replacement.name,
    day: current.day,
    date: current.date,
    category: replacement.category,
    latitude: replacement.latitude,
    longitude: replacement.longitude,
    entry_cost_inr: entryCost,
    opening_hours: replacement.opening_hours || null,
    rating: replacement.rating ?? null,
    reasoning,
    meal_suggestion: mealSuggestion,
    best_visit_time: suggestBestVisitTime(replacement.category, isWeekend),
    nearby_attractions: nearbyAttractions(candidates, replacement, usedIds, { limit: 3, maxRadiusKm: 2.5 }),
    weather_alternative: null,
    to_location_name: replacement.name,
  };
  updatedStop.transport = attachTransportPlan({
    distanceKm: updatedStop.distance_km_from_prev,
    fromName: updatedStop.from_location_name,
    toName: updatedStop.name,
    travellers: groupSize,
    allowedModes,
    transportPriority: trip.transport_priority,
    arrivalClock: updatedStop.arrival_time,
    forecast: null,
    destinationName: trip.destination,
  });

  stops[idx] = updatedStop;
  return { stops, replacedStop: updatedStop, previousStopName: current.name };
}

// Rough per-km fare by mode (INR), for budget-validation purposes only —
// not shown to the traveler as a quote, just used to sanity-check the
// stated budget against the itinerary's actual routing.
const TRANSPORT_RATE_INR_PER_KM = {
  walk: 0, bike: 3, auto: 15, cab: 20, car: 18, bus: 2, train: 3, flight: 6,
};

function estimateTransportCostForStops(stops) {
  return Math.round(
    stops.reduce((sum, s) => {
      const rate = TRANSPORT_RATE_INR_PER_KM[s.transport_mode] ?? TRANSPORT_RATE_INR_PER_KM.cab;
      return sum + (s.distance_km_from_prev || 0) * rate;
    }, 0)
  );
}

/**
 * AI Smart Transit Planner integration point: attaches a full ranked,
 * multi-option `transport` object to every stop (and to the journey's final
 * leg), using whatever distance/timing the route-ordering step already
 * computed. Purely additive — never changes distance, timing, or the
 * existing transport_mode/public_transport fields, only adds the richer
 * `stop.transport` object the itinerary timeline/booking page read from.
 */
function attachTransportPlan({ distanceKm, fromName, toName, travellers, allowedModes, transportPriority, arrivalClock, forecast, destinationName }) {
  const arrivalMinutesParsed = parseClockToMinutes(arrivalClock);
  const arrivalHour = arrivalMinutesParsed != null ? Math.floor(arrivalMinutesParsed / 60) % 24 : 9;
  return buildTransportPlan({
    distanceKm: distanceKm || 0,
    fromName: fromName || 'Start',
    toName: toName || 'Destination',
    travellers: Math.max(1, travellers || 1),
    allowedModes: allowedModes || [],
    transportPriority,
    departureClock: arrivalClock || '9:00 AM',
    arrivalHour,
    isWeatherBad: Boolean(forecast?.outdoorUnfriendly),
    hasMetro: destinationHasMetro(destinationName),
    longDistanceLeg: (distanceKm || 0) > 80,
    hasFerryRoute: false,
  });
}

function enrichStopsWithTransportPlans(stops, trip, groupSize, forecast, allowedModes) {
  for (const stop of stops) {
    stop.transport = attachTransportPlan({
      distanceKm: stop.distance_km_from_prev,
      fromName: stop.from_location_name,
      toName: stop.to_location_name || stop.name,
      travellers: groupSize,
      allowedModes,
      transportPriority: trip.transport_priority,
      arrivalClock: stop.arrival_time,
      forecast,
      destinationName: trip.destination,
    });
  }
}

function daysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  return Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
}

// ============================================================
// Full-AI path: let Gemini plan the whole trip, then map its output back
// into the same { stops, budgetSummary, hiddenGems, ... } shape the rest
// of the app (DB save, frontend map/list) already expects.
// ============================================================

async function tryFullAiItinerary(trip, candidates, forecast, learnedPreferences = null, accommodation = null, nights = 1) {
  try {
    // Shopping destinations are only offered to the model when the
    // traveler actually selected a "shopping" interest (Part 8) — otherwise
    // they're left out of the dataset entirely rather than relying on the
    // prompt alone to skip them.
    const wantsShopping = (trip.interests || []).some((i) => i.category === 'shopping');
    const attractionsDataset = candidates
      .filter((s) => s.category !== 'stay' && s.category !== 'food_dining' && (wantsShopping || s.category !== 'shopping'))
      .map(toDatasetRow);
    const restaurantsDataset = candidates.filter((s) => s.category === 'food_dining').map(toDatasetRow);
    const hotelsDataset = candidates.filter((s) => s.category === 'stay').map(toDatasetRow);

    const parsed = await generateFullItinerary(trip, {
      attractionsDataset,
      restaurantsDataset,
      hotelsDataset,
      nearbyBusinessesDataset: [], // no local-business dataset wired up yet
      eventsDataset: [], // optional — not available
      weather: forecast,
    });
    if (!parsed) return null;
    // An empty itinerary array means Gemini couldn't find anything worth
    // recommending for the traveler's exact interest selection — rather
    // than surfacing a blank trip, fall through to the heuristic path
    // below, which has its own fallback to the destination's most famous
    // attractions when interests don't match anything nearby.
    if (!Array.isArray(parsed.itinerary) || parsed.itinerary.length === 0) return null;

    const usedIds = new Set(
      parsed.itinerary.map((item) => findMatchingSpot(candidates, item.place)?.id).filter(Boolean)
    );
    const isWeekend = [0, 6].includes(new Date(trip.start_date).getDay());

    let stops = parsed.itinerary.map((item, i) => {
      const matched = findMatchingSpot(candidates, item.place);
      const category = item.category || matched?.category || 'attraction';
      return {
        spot_id: matched?.id || `ai-${i + 1}`,
        name: item.place || matched?.name || `Stop ${i + 1}`,
        category,
        subcategory: matched?.subcategory || null,
        latitude: matched?.latitude ?? null,
        longitude: matched?.longitude ?? null,
        order: i + 1,
        day: Number.isFinite(item.day) ? item.day : 1,
        date: item.date || null,
        arrival_time: item.time || null,
        departure_time: null,
        visit_minutes: parseDurationMinutes(item.duration) || matched?.avg_visit_minutes || null,
        transport_mode: item.transport?.mode || null,
        distance_km_from_prev: null,
        travel_minutes_from_prev: parseDurationMinutes(item.transport?.travel_time),
        transport_cost_inr: Number(item.transport?.travel_cost) || 0,
        transport_reason: item.transport?.reason || null,
        route_source: 'gemini',
        entry_cost_inr: Number(item.entry_fee) || 0,
        opening_hours: item.opening_time && item.closing_time
          ? `${item.opening_time} – ${item.closing_time}`
          : matched?.opening_hours || null,
        rating: item.rating ?? matched?.rating ?? null,
        crowd_level: normalizeCrowdLevel(item.crowd_level),
        best_visit_time: suggestBestVisitTime(category, isWeekend),
        weather_note: formatWeatherNote(forecast),
        reasoning: item.description || item.tips || '',
        hidden_gem: Boolean(item.hidden_gem),
        restaurant: item.restaurant?.name ? item.restaurant : null,
        nearby_attractions: matched ? nearbyAttractions(candidates, matched, usedIds, { limit: 3, maxRadiusKm: 2.5 }) : [],
        tips: item.tips || null,
      };
    });

    // Safety net for Part 9: the prompt already asks Gemini to avoid
    // back-to-back same-type stops, but re-check and fix it in two steps.
    // Step 1 rebalances WHICH DAY each stop lands on — Gemini's own day
    // assignment can concentrate a whole same-category run (5 restaurants,
    // 2 malls) onto a single day, and no amount of reordering *within*
    // that day can fix it if there's nothing else in that day to swap
    // with. Step 2 then reorders within each (now-balanced) day so same-
    // category/subcategory stops aren't adjacent either.
    stops = rebalanceCategoriesAcrossDays(stops);

    const groupByDay = (list) => {
      const groups = new Map();
      for (const s of list) {
        const key = s.day ?? 1;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
      return [...groups.entries()].sort((a, b) => a[0] - b[0]);
    };

    stops = groupByDay(stops).flatMap(([, dayStops]) => diversifyConsecutive(dayStops, (s) => s.category));
    // Re-group after the category pass so the finer subcategory pass also
    // only compares stops within the same day.
    stops = groupByDay(stops)
      .flatMap(([, dayStops]) => diversifyConsecutive(dayStops, (s) => s.subcategory || s.category))
      .map((s, i) => ({ ...s, order: i + 1 }));

    // Safety net (Part 9 follow-up): diversifyConsecutive above only
    // reorders stops that already differ from their neighbors — it can't
    // fix a trip that's uniformly one category throughout. Re-apply the
    // same per-category cap the heuristic path enforces at selection time,
    // swapping any overflow stop for a genuine unused candidate from one
    // of the traveler's other requested categories.
    const requestedCategoriesForCap = (trip.interests || []).map((i) => i.category).filter(Boolean);
    stops = capStopsByCategory(stops, candidates, requestedCategoriesForCap, {
      anchor: { lat: trip.destination_lat, lng: trip.destination_lng },
    });


    // Gemini estimates travel time in its own text but doesn't compute real
    // leg distances — fill those in from the actual routing service for any
    // consecutive stops whose coordinates we could match, rather than
    // leaving them as mock/absent values.
    const startAnchorForLegs = { lat: trip.start_lat ?? trip.destination_lat, lng: trip.start_lng ?? trip.destination_lng };
    for (let i = 0; i < stops.length; i++) {
      const curr = stops[i];
      if (!Number.isFinite(curr.latitude) || !Number.isFinite(curr.longitude)) continue;
      const prevPoint = i === 0
        ? (Number.isFinite(startAnchorForLegs.lat) && Number.isFinite(startAnchorForLegs.lng) ? startAnchorForLegs : null)
        : (Number.isFinite(stops[i - 1].latitude) && Number.isFinite(stops[i - 1].longitude)
            ? { lat: stops[i - 1].latitude, lng: stops[i - 1].longitude }
            : null);
      if (!prevPoint) continue;
      const result = await routeDistance(prevPoint, { lat: curr.latitude, lng: curr.longitude }, curr.transport_mode || 'cab');
      curr.distance_km_from_prev = Math.round(result.distanceKm * 10) / 10;
      if (!curr.travel_minutes_from_prev) curr.travel_minutes_from_prev = result.durationMinutes;
      curr.route_source = result.source;
    }

    // Final validation (Part 7): even though the datasets handed to Gemini
    // were already filtered to genuine tourist spots, the model can still
    // return a place name that doesn't match anything in the dataset (or,
    // rarely, invent one despite instructions not to) — re-validate every
    // stop and swap out anything invalid for the next best unused
    // candidate spot.
    replaceInvalidStops(stops, candidates, usedIds);

    stops = attachFromToLabels(stops, trip.start_location || trip.destination);

    const geminiGroupSize = trip.adults + trip.kids + trip.elderly + trip.specially_abled;
    const geminiAllowedModes = (trip.transport_modes && trip.transport_modes.length) ? trip.transport_modes : [];
    enrichStopsWithTransportPlans(stops, trip, geminiGroupSize, forecast, geminiAllowedModes);

    // Fold the recommended accommodation into this itinerary as real
    // stops too — same helper the heuristic path uses, so both paths
    // produce identically-structured accommodation nodes.
    const geminiTransportMode = pickPrimaryMode(trip.transport_modes, trip.transport_priority);
    stops = insertAccommodationStops(stops, {
      accommodation, trip, allowedTransportModes: geminiAllowedModes, transportMode: geminiTransportMode,
    });

    const dayCount = Math.max(1, daysBetween(trip.start_date, trip.end_date));
    const tripExtras = await buildTripExtras(trip, forecast, dayCount);

    const bb = parsed.budget_breakdown || {};
    const byCategory = {
      transport: Number(bb.transport) || 0,
      accommodation: Number(bb.accommodation) || 0,
      shopping: Number(bb.shopping) || 0,
      buffer: Number(bb.buffer) || 0,
    };
    const entryFeesTotal = Number(bb.entry_fees) || 0;

    const flaggedGemsPreview = stops.filter((s) => s.hidden_gem).length;
    const confidenceScores = computeConfidenceScores({
      trip, stops, byCategory, entryFeesTotal, forecast, outdoorSwaps: 0,
    });
    const decisionExplanation = buildDecisionExplanation(trip, stops, {
      forecast, outdoorSwaps: 0, hiddenGemCount: flaggedGemsPreview, learnedPreferences,
    });

    const budgetSummary = {
      by_category: byCategory,
      entry_fees_total_inr: entryFeesTotal,
      estimated_food_cost_inr: Number(bb.food) || 0,
      total_budget_inr: trip.total_budget_inr,
      per_spot: stops.map((s) => ({ name: s.name, entry_cost_inr: s.entry_cost_inr })),
      ai_extras: {
        trip_score: parsed.trip_score ?? null,
        summary: parsed.summary || null,
        final_ai_summary: parsed.final_ai_summary || null,
        travel_tips: parsed.travel_tips || [],
        business_recommendations: parsed.business_recommendations || [],
        alternative_places: parsed.alternative_places || [],
        total_estimated_cost_inr: Number(bb.total) || null,
        remaining_budget_inr: Number(bb.remaining_budget) || null,
        weather_forecast: forecast,
        emergency_contacts: tripExtras.emergencyContacts,
        local_events: tripExtras.localEvents,
        packing_list: tripExtras.packingList,
        confidence_scores: confidenceScores,
        decision_explanation: decisionExplanation,
        learned_preferences: learnedPreferences,
      },
    };

    const flaggedGems = stops.filter((s) => s.hidden_gem).map((s) => ({
      id: s.spot_id, name: s.name, category: s.category, rating: s.rating,
      reason: s.reasoning || 'Highlighted by the AI planner as a lesser-known pick that fits your interests.',
    }));
    const hiddenGems = flaggedGems.length > 0
      ? flaggedGems
      : findHiddenGems(candidates, { anchor: { lat: trip.destination_lat, lng: trip.destination_lng } })
          .map((s) => ({ id: s.id, name: s.name, category: s.category, rating: s.rating, reason: hiddenGemReason(s) }));

    const journey = await buildJourney(trip, stops, {
      fallbackTransportMode: stops[stops.length - 1]?.transport_mode || 'cab',
      fallbackTotalDistanceKm: parseDistanceKm(parsed.total_distance),
      fallbackTotalTravelMinutes: parseDurationMinutes(parsed.estimated_duration),
    });
    if (journey.end?.location) {
      journey.end.transport = attachTransportPlan({
        distanceKm: journey.end.distance_km_from_prev,
        fromName: journey.end.from_location_name,
        toName: journey.end.location,
        travellers: geminiGroupSize,
        allowedModes: geminiAllowedModes,
        transportPriority: trip.transport_priority,
        arrivalClock: stops[stops.length - 1]?.arrival_time,
        forecast,
        destinationName: trip.destination,
      });
    }
    budgetSummary.ai_extras.journey = journey;
    budgetSummary.ai_extras.booking_itinerary = buildBookingItinerary(stops, journey);

    const geminiBudgetValidation = validateBudget({
      totalBudgetInr: trip.total_budget_inr,
      transportCostInr: stops.reduce((sum, s) => sum + (Number(s.transport_cost_inr) || 0), 0),
      foodCostInr: budgetSummary.estimated_food_cost_inr,
      entryFeesInr: entryFeesTotal,
    });
    budgetSummary.budget_validation = geminiBudgetValidation;
    budgetSummary.ai_extras.final_validation = runFinalValidation({
      stops, candidates, hiddenGems, budgetValidation: geminiBudgetValidation, tripStartHour: trip.start_time ? parseInt(trip.start_time.split(':')[0], 10) : 9,
      requestedCategories: [...new Set((trip.interests || []).map((i) => i.category).filter(Boolean))],
    });

    applyAccommodationToBudget(budgetSummary, { accommodation, nights, groupSize: geminiGroupSize });

    return {
      stops,
      budgetSummary,
      hiddenGems,
      journey,
      totalDistanceKm: journey.route_summary.total_distance_km,
      totalDurationMinutes: journey.route_summary.total_travel_minutes,
      generatedBy: 'gemini-full',
      spotSource: 'gemini',
    };
  } catch {
    return null; // never let a mapping bug break generation — heuristic path will run instead
  }
}

function toDatasetRow(s) {
  return {
    name: s.name,
    category: s.category,
    subcategory: s.subcategory,
    rating: s.rating,
    entry_fee_inr: s.entry_fee_inr,
    opening_hours: s.opening_hours,
    avg_visit_minutes: s.avg_visit_minutes,
    description: s.description,
  };
}

/** Lowercases, strips punctuation, and collapses whitespace for fuzzy name matching. */
function normalizeSpotName(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Matches a place name Gemini returned back to a real candidate spot from
 * the dataset it was given. Gemini occasionally reformats a name slightly
 * (extra "Chennai" suffix, different punctuation/casing, a shortened or
 * lightly reworded name) — the original exact/substring match was too
 * strict for that and silently returned null, leaving the stop without
 * coordinates (invisible on the map) even though a genuine match existed.
 * This tries, in order: exact normalized match, substring either
 * direction, then significant-word overlap as a last resort.
 */
function findMatchingSpot(candidates, placeName) {
  if (!placeName) return null;
  const needle = normalizeSpotName(placeName);
  if (!needle) return null;

  const exact = candidates.find((s) => normalizeSpotName(s.name) === needle);
  if (exact) return exact;

  const substring = candidates.find((s) => {
    const n = normalizeSpotName(s.name);
    return n.length > 0 && (n.includes(needle) || needle.includes(n));
  });
  if (substring) return substring;

  const needleWords = new Set(needle.split(' ').filter((w) => w.length > 2));
  if (needleWords.size === 0) return null;

  let best = null;
  let bestRatio = 0;
  for (const s of candidates) {
    const candWords = new Set(normalizeSpotName(s.name).split(' ').filter((w) => w.length > 2));
    if (candWords.size === 0) continue;
    let overlap = 0;
    for (const w of needleWords) if (candWords.has(w)) overlap += 1;
    const ratio = overlap / Math.min(needleWords.size, candWords.size);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = s;
    }
  }
  return bestRatio >= 0.6 ? best : null;
}

function normalizeCrowdLevel(level) {
  const l = (level || '').toLowerCase();
  if (l.includes('low')) return 'low';
  if (l.includes('high')) return 'high';
  return 'moderate';
}

function parseDistanceKm(text) {
  if (typeof text === 'number') return text;
  if (!text) return 0;
  const km = /([\d.]+)\s*km/i.exec(text);
  if (km) return parseFloat(km[1]);
  const mi = /([\d.]+)\s*mi/i.exec(text);
  if (mi) return Math.round(parseFloat(mi[1]) * 1.609 * 10) / 10;
  return 0;
}

function parseDurationMinutes(text) {
  if (typeof text === 'number') return text;
  if (!text) return 0;
  let minutes = 0;
  const hrs = /([\d.]+)\s*h/i.exec(text);
  if (hrs) minutes += parseFloat(hrs[1]) * 60;
  const mins = /([\d.]+)\s*m/i.exec(text);
  if (mins) minutes += parseFloat(mins[1]);
  return Math.round(minutes);
}

function pickPrimaryMode(modes, priority) {
  if (modes?.length) return modes[0];
  if (priority === 'cheapest') return 'bus';
  if (priority === 'comfortable') return 'car';
  return 'cab';
}

function minutesToClock(totalMinutes) {
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return `${displayHour}:${String(m).padStart(2, '0')} ${period}`;
}

/** Parses a "9:30 AM"-style clock string (as produced by minutesToClock) back into minutes since midnight. */
function parseClockToMinutes(clockStr) {
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

/** Formats a SQL "time" value (e.g. "09:00" or "09:00:00") as a 12-hour clock string. */
function formatTripStartTime(startTime) {
  if (!startTime || typeof startTime !== 'string') return null;
  const [hStr, mStr] = startTime.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return minutesToClock(h * 60 + m);
}

/**
 * Builds the complete start-to-end journey wrapper around a generated set of
 * stops: the final leg from the last stop to the traveler's chosen end
 * location, and a route summary (total distance/time/stops/duration) that
 * spans the whole trip, not just the stop-to-stop portion. Shared by both
 * the heuristic and full-Gemini generation paths.
 */
async function buildJourney(trip, stops, {
  fallbackTransportMode = 'cab',
  fallbackTotalDistanceKm = null,
  fallbackTotalTravelMinutes = null,
} = {}) {
  const startLocation = trip.start_location || trip.destination;
  const startLat = trip.start_lat ?? trip.destination_lat;
  const startLng = trip.start_lng ?? trip.destination_lng;

  const endLocation = trip.end_location || trip.destination;
  const endLat = trip.end_lat ?? trip.destination_lat;
  const endLng = trip.end_lng ?? trip.destination_lng;

  const lastStop = stops[stops.length - 1] || null;
  const endTransportMode = lastStop?.transport_mode || fallbackTransportMode;

  let endLeg = null;
  if (
    lastStop &&
    Number.isFinite(lastStop.latitude) && Number.isFinite(lastStop.longitude) &&
    Number.isFinite(endLat) && Number.isFinite(endLng)
  ) {
    const result = await routeDistance(
      { lat: lastStop.latitude, lng: lastStop.longitude },
      { lat: endLat, lng: endLng },
      endTransportMode
    );
    endLeg = {
      distance_km: Math.round(result.distanceKm * 10) / 10,
      travel_minutes: result.durationMinutes,
      transport_mode: endTransportMode,
      route_source: result.source,
    };
  }

  const stopsDistanceKm = stops.reduce((sum, s) => sum + (s.distance_km_from_prev || 0), 0);
  const stopsTravelMinutes = stops.reduce((sum, s) => sum + (s.travel_minutes_from_prev || 0), 0);
  const totalVisitMinutes = stops.reduce((sum, s) => sum + (s.visit_minutes || 0), 0);

  let totalDistanceKm = Math.round((stopsDistanceKm + (endLeg?.distance_km || 0)) * 10) / 10;
  let totalTravelMinutes = stopsTravelMinutes + (endLeg?.travel_minutes || 0);

  // If none of the stops carry a real computed distance (e.g. the Gemini
  // path couldn't match coordinates for any stop), fall back to the AI's
  // own total-distance/duration estimate rather than reporting 0.
  if (stopsDistanceKm === 0 && fallbackTotalDistanceKm != null) {
    totalDistanceKm = Math.round((fallbackTotalDistanceKm + (endLeg?.distance_km || 0)) * 10) / 10;
  }
  if (stopsTravelMinutes === 0 && fallbackTotalTravelMinutes != null) {
    totalTravelMinutes = fallbackTotalTravelMinutes + (endLeg?.travel_minutes || 0);
  }

  // Estimated completion time = last stop's departure (or arrival + visit
  // time, if departure wasn't tracked) + the final leg's travel time.
  let completionTime = null;
  if (lastStop && endLeg?.travel_minutes != null) {
    let departureMinutes = parseClockToMinutes(lastStop.departure_time);
    if (departureMinutes == null) {
      const arrivalMinutes = parseClockToMinutes(lastStop.arrival_time);
      if (arrivalMinutes != null) departureMinutes = arrivalMinutes + (lastStop.visit_minutes || 60);
    }
    if (departureMinutes != null) completionTime = minutesToClock(departureMinutes + endLeg.travel_minutes);
  }

  return {
    start: {
      location: startLocation,
      latitude: Number.isFinite(startLat) ? startLat : null,
      longitude: Number.isFinite(startLng) ? startLng : null,
      start_time: trip.start_time || null,
      start_time_display: formatTripStartTime(trip.start_time) || (stops[0]?.arrival_time ?? null),
    },
    end: {
      location: endLocation,
      latitude: Number.isFinite(endLat) ? endLat : null,
      longitude: Number.isFinite(endLng) ? endLng : null,
      from_location_name: lastStop?.name ?? startLocation,
      distance_km_from_prev: endLeg?.distance_km ?? null,
      travel_minutes_from_prev: endLeg?.travel_minutes ?? null,
      transport_mode: endLeg?.transport_mode ?? null,
      route_source: endLeg?.route_source ?? null,
      estimated_completion_time: completionTime,
    },
    route_summary: {
      number_of_stops: stops.length,
      total_distance_km: totalDistanceKm,
      total_travel_minutes: totalTravelMinutes,
      total_visit_minutes: totalVisitMinutes,
      estimated_total_trip_duration_minutes: totalTravelMinutes + totalVisitMinutes,
    },
  };
}

/** Attaches from/to location labels to a plain (non-day-chunked) list of stops, e.g. the full-Gemini path. */
function attachFromToLabels(stops, startLocationName) {
  return stops.map((s, i) => ({
    ...s,
    from_location_name: i === 0 ? startLocationName : stops[i - 1].name,
    to_location_name: s.name,
  }));
}