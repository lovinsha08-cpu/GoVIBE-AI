import { loadSpots } from './spotData.service.js';
import {
  selectBalancedSpots, findHiddenGems, hiddenGemReason, nearestInCategory,
  splitRouteAndMealPools, diversifyConsecutive,
} from './spotMatching.service.js';
import { filterGenuineTouristSpots, isValidItineraryStop } from './attractionFilter.service.js';
import { classifyAttractionTier } from './attractionRanking.service.js';
import { getTripStylePacing } from './tripStyle.service.js';
import { orderSpotsRoute, estimateCrowdLevel, suggestPublicTransport, suggestBestVisitTime, recommendTransportMode } from './routing.service.js';
import { splitBudget, estimateSpotEntryCost, estimateMealCost, validateBudget } from './budget.service.js';
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
  const accommodation = trip.needs_accommodation
    ? await findAccommodationRecommendation({ trip, groupSize, nights })
    : null;

  // 1. Fetch candidate spots within range of the destination.
  //    (A tighter PostGIS radius query would replace this once spot volume grows.)
  //    Falls back to the bundled sample dataset when Supabase isn't configured/seeded yet.
  const { spots: rawCandidates, source: spotSource } = await loadSpots({
    city: trip.destination,
    lat: trip.destination_lat,
    lng: trip.destination_lng,
  });
  // Belt-and-braces: loadSpots already filters by source, but re-validate
  // here too so every entry point into itinerary generation is protected.
  const candidates = filterGenuineTouristSpots(rawCandidates);
  if (candidates.length === 0) {
    throw new Error('No genuine tourist spots available yet for this destination — spot data needs to be seeded.');
  }

  const tripStylePacing = getTripStylePacing(trip.trip_style);

  // 1b. Live weather forecast for the destination on the trip's start date —
  //     fetched once up front so both the Gemini path and the heuristic
  //     path below can use it for weather-aware adjustments.
  const forecast = await getDailyForecast({
    lat: trip.destination_lat, lng: trip.destination_lng, date: trip.start_date,
  });

  // 1c'. Personalized learning: look at this traveler's past trips (if any)
  //      and softly boost interest categories they've consistently liked,
  //      so itineraries get more personalized the more the traveler uses
  //      the app — without overriding what they explicitly chose this trip.
  const learnedPreferences = await learnTravelerPreferences(trip.traveler_id, trip.id);
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
    || (trip.interests || []).some((i) => i.category === 'food');
  const wantsShopping = (trip.interests || []).some((i) => i.category === 'shopping');

  const dayCount = Math.max(1, daysBetween(trip.start_date, trip.end_date));
  const stopsPerDay = Math.max(1, Math.round(3 * tripStylePacing.stopsPerDayMultiplier)); // ~3 stops/day, reshaped by Trip Style
  const spotLimit = Math.min(candidates.length, dayCount * stopsPerDay);
  const selected = selectBalancedSpots(candidates, {
    interests: boostedInterests,
    anchor,
    limit: spotLimit,
    tripStyle: trip.trip_style,
    includeShopping: wantsShopping,
    featureFood: wantsFoodFeatured,
  });

  if (selected.length === 0) {
    throw new Error('No matching spots found for the selected interests near this destination.');
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
      const nearestMeal = nearestInCategory(mealPool, 'food', { lat: anchorPoint.lat, lng: anchorPoint.lng }, {
        maxRadiusKm: 5, exclude: usedMealSpotIds,
      });
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

    const reasoning = await explainSpotChoice(spot, { interestLabels });

    // Restaurant/meal suggestion near this stop — skip for stops that are
    // themselves food spots or lodging, and for stops immediately next to
    // a deliberately-scheduled meal stop (that's already covered above).
    let mealSuggestion = null;
    if (!mealTypeLabel && !['food', 'stay'].includes(spot.category)) {
      const nearby = nearestInCategory(candidates, 'food', { lat: spot.latitude, lng: spot.longitude }, {
        maxRadiusKm: 3, exclude: usedSpotIds,
      });
      if (nearby) {
        mealSuggestion = {
          name: nearby.spot.name,
          distance_km: nearby.distanceKm,
          rating: nearby.spot.rating ?? null,
          avg_cost_inr: nearby.spot.entry_fee_inr || null,
          description: nearby.spot.description || null,
        };
      }
    }
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
  const budgetSplit = splitBudget({
    totalBudgetInr: trip.total_budget_inr,
    interests: boostedInterests,
    needsAccommodation: trip.needs_accommodation,
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

  // 6c. Step 10 — Final Validation: run the full checklist. If the only
  // thing that failed is the budget check, auto-regenerate just that
  // section (drop the single most expensive non-essential — i.e. not
  // Must Visit tier, not a meal — stop) rather than surfacing a poor
  // itinerary or discarding the whole plan over one overshoot.
  let finalValidation = runFinalValidation({ stops, candidates, hiddenGems, budgetValidation, tripStartHour });
  if (!finalValidation.passed && finalValidation.failedCheckIds.length === 1 && finalValidation.failedCheckIds[0] === 'budget_respected') {
    const trimmable = stops
      .filter((s) => !s.meal_type && s.category !== 'accommodation' && classifyAttractionTier(candidates.find((c) => c.id === s.spot_id) || {}) !== 'must_visit')
      .sort((a, b) => (b.entry_cost_inr || 0) - (a.entry_cost_inr || 0));
    if (trimmable.length > 0) {
      const drop = trimmable[0];
      const idx = stops.findIndex((s) => s.spot_id === drop.spot_id && s.order === drop.order);
      if (idx !== -1) {
        stops.splice(idx, 1);
        stops.forEach((s, i) => { s.order = i + 1; });
        totalEntryCost -= drop.entry_cost_inr || 0;
        budgetValidation = validateBudget({
          totalBudgetInr: trip.total_budget_inr,
          transportCostInr: estimateTransportCostForStops(stops),
          foodCostInr: estimatedFoodCost,
          entryFeesInr: totalEntryCost,
        });
        finalValidation = runFinalValidation({ stops, candidates, hiddenGems, budgetValidation, tripStartHour });
      }
    }
  }

  const budgetSummary = {
    by_category: budgetSplit,
    entry_fees_total_inr: totalEntryCost,
    estimated_food_cost_inr: estimatedFoodCost,
    total_budget_inr: trip.total_budget_inr,
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
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    if (isValidItineraryStop(stop)) continue;

    const sameCategoryReplacement = candidates.find(
      (c) => c.category === stop.category && !usedSpotIds.has(c.id) && isValidItineraryStop(c)
    );
    const anyReplacement = sameCategoryReplacement
      || candidates.find((c) => !usedSpotIds.has(c.id) && isValidItineraryStop(c));

    if (!anyReplacement) {
      // Nothing left to swap in — drop the invalid stop rather than show it.
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
  for (let i = 0; i < orderedStops.length; i++) {
    const bucketIdx = Math.min(count - 1, Math.floor(i / perDay));
    buckets[bucketIdx].push(orderedStops[i]);
  }
  return buckets;
}

// Part 8 — Time Awareness: which part of the day a category/subcategory
// naturally belongs to. Matched against category first (cheap, reliable),
// then subcategory/name keywords for the cross-cutting cases (a "sunset
// point" is nature/heritage by category but unmistakably an evening spot).
// Anything that matches nothing stays 'any' and is left wherever the
// geographic ordering already put it.
const TIME_SLOT_RANK = { morning: 0, any: 1, afternoon: 2, evening: 3 };

const MORNING_CATEGORIES = new Set(['heritage', 'nature']);
const MORNING_KEYWORDS = ['temple', 'garden', 'beach', 'sunrise', 'park', 'lake'];

const AFTERNOON_CATEGORIES = new Set(['shopping']);
const AFTERNOON_KEYWORDS = ['museum', 'gallery', 'aquarium', 'indoor', 'planetarium', 'mall'];

const EVENING_CATEGORIES = new Set(['nightlife']);
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

  const { spots: candidates } = await loadSpots({ city: trip.destination });
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

  let mealSuggestion = current.meal_suggestion || null;
  if (!['food', 'stay'].includes(replacement.category)) {
    const nearby = nearestInCategory(candidates, 'food', { lat: replacement.latitude, lng: replacement.longitude }, {
      maxRadiusKm: 3, exclude: usedIds,
    });
    if (nearby) {
      mealSuggestion = {
        name: nearby.spot.name, distance_km: nearby.distanceKm, rating: nearby.spot.rating ?? null,
        avg_cost_inr: nearby.spot.entry_fee_inr || null, description: nearby.spot.description || null,
      };
    }
  }

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
      .filter((s) => s.category !== 'stay' && s.category !== 'food' && (wantsShopping || s.category !== 'shopping'))
      .map(toDatasetRow);
    const restaurantsDataset = candidates.filter((s) => s.category === 'food').map(toDatasetRow);
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
    // back-to-back same-type stops, but re-check and locally reshuffle
    // within each day in case it didn't fully comply — day groupings and
    // dates from Gemini are preserved, only the order within a day shifts.
    const dayGroups = new Map();
    for (const s of stops) {
      const key = s.day ?? 1;
      if (!dayGroups.has(key)) dayGroups.set(key, []);
      dayGroups.get(key).push(s);
    }
    stops = [...dayGroups.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([, dayStops]) => diversifyConsecutive(dayStops, (s) => s.category))
      .map((s, i) => ({ ...s, order: i + 1 }));

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

function findMatchingSpot(candidates, placeName) {
  if (!placeName) return null;
  const needle = placeName.trim().toLowerCase();
  return candidates.find((s) => s.name.trim().toLowerCase() === needle)
    || candidates.find((s) => s.name.toLowerCase().includes(needle) || needle.includes(s.name.toLowerCase()))
    || null;
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