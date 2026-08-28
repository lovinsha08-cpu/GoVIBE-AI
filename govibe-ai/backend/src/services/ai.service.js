import { env } from '../config/env.js';
import { getTripStylePromptGuidance } from './tripStyle.service.js';

// Model is configurable via GEMINI_MODEL (see .env.example) so it can be
// bumped (e.g. to a newer/faster/cheaper Gemini release) without a code
// change. Defaults to a current, structured-output-capable flash model.
const GEMINI_MODEL = env.geminiModel || 'gemini-3.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Caps on how many rows of each dataset we inline into the prompt. Sending
// every spot in a city (which only grows as spot data is seeded) bloats
// the prompt, slows the call down, and risks crowding out the model's
// output budget. Top-N by rating keeps the prompt focused on the spots
// actually worth recommending while staying within a predictable token
// budget regardless of city size.
const DATASET_CAPS = { attractions: 60, restaurants: 30, hotels: 15 };

/**
 * Trims a dataset to its top-N highest-rated rows before it goes into a
 * prompt. Kept generic so it can cap attractions, restaurants, or hotels.
 */
function capDataset(rows, limit) {
  if (!Array.isArray(rows)) return [];
  return [...rows]
    .sort((a, b) => (b.rating || 0) - (a.rating || 0))
    .slice(0, limit);
}

/**
 * Low-level Gemini call shared by every AI feature in this file: builds the
 * request, applies a timeout, retries once on transient failure (network
 * blip / 5xx / rate limit), and always resolves to either a parsed value or
 * null — callers never need their own try/catch, and a bad Gemini response
 * never throws past this boundary.
 */
export async function callGemini({ prompt, schema, maxOutputTokens = 2048, temperature = 0.4, timeoutMs = 12000, thinkingLevel = null }) {
  if (!env.geminiApiKey) return null;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature,
      maxOutputTokens,
      ...(schema ? { responseSchema: schema } : {}),
      // Gemini 3.x models "think" before answering by default (thinkingLevel
      // defaults to 'medium' server-side when unset). Left unset here so
      // generateFullItinerary's default call keeps its existing quality —
      // callers that want a faster/cheaper pass (short conversational
      // replies) can opt in with e.g. thinkingLevel: 'low'.
      ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
    },
  };

  const attempt = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${GEMINI_URL}?key=${env.geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        // Surface the response body — this is where Google explains *why*
        // (invalid key, model not found, quota exceeded, region-blocked,
        // etc.) rather than just a bare status code.
        const errorBody = await res.text().catch(() => '');
        const err = new Error(`Gemini request failed: ${res.status} ${errorBody}`.trim());
        err.retryable = retryable;
        throw err;
      }
      const data = await res.json();
      // Thinking models (Gemini 3.x+) can return the answer split across
      // several parts, and may include reasoning-summary parts (marked
      // `thought: true`) ahead of the actual answer — so parts[0] is no
      // longer reliably the answer. Concatenate every non-thought text part
      // instead of only reading the first one.
      const responseParts = data.candidates?.[0]?.content?.parts || [];
      const text = responseParts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
      if (!text) {
        console.error('[ai.service] Gemini returned no text content. Full response:', JSON.stringify(data));
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        console.error('[ai.service] Gemini response was not valid JSON:', parseErr.message, '| raw text:', text);
        return null;
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    return await attempt();
  } catch (firstErr) {
    // Only retry on things likely to be transient (timeout/abort, 429, 5xx).
    // A bad API key or a malformed request will fail the same way twice, so
    // don't waste the latency retrying those.
    const isAbort = firstErr.name === 'AbortError';
    console.error(`[ai.service] Gemini call failed (${isAbort ? 'timeout/abort' : firstErr.message})${!isAbort && !firstErr.retryable ? ' — not retrying' : ' — retrying once'}`);
    if (!isAbort && !firstErr.retryable) return null;
    await new Promise((r) => setTimeout(r, 400));
    try {
      return await attempt();
    } catch (secondErr) {
      console.error(`[ai.service] Gemini retry also failed: ${secondErr.name === 'AbortError' ? 'timeout/abort' : secondErr.message} — giving up, falling back to heuristic path`);
      return null;
    }
  }
}

/**
 * Asks Gemini for a short, specific reason a spot fits this trip.
 * Falls back to a templated heuristic sentence if no API key is set,
 * the call fails, or it times out — the itinerary should never break
 * because the AI call had a bad day.
 */
export async function explainSpotChoice(spot, context) {
  if (!env.geminiApiKey) {
    return heuristicReason(spot, context);
  }

  const prompt = `In one short sentence (under 20 words), explain why "${spot.name}" (category: ${spot.category}, rating: ${spot.rating}) fits a traveler interested in ${context.interestLabels?.join(', ') || 'general sightseeing'}. Be specific and concrete, not generic. Respond with just the sentence as a JSON string.`;

  const result = await callGemini({ prompt, maxOutputTokens: 120, timeoutMs: 4000 });
  const text = typeof result === 'string' ? result.trim() : null;
  return text || heuristicReason(spot, context);
}

function heuristicReason(spot, context) {
  // Accommodation is never chosen for "interest match" — it's a place to
  // sleep, picked on rating/location/budget. Using interestLabels[0]
  // unconditionally here used to produce nonsense like "Matches your
  // interest in religious_spiritual" on a hotel just because that
  // happened to be the traveler's first selected interest category.
  if (spot.category === 'stay' || spot.category === 'accommodation') {
    return `A well-rated stay${spot.rating ? ` (${spot.rating}★)` : ''} near your planned route.`;
  }
  // Only claim an "interest match" for an interest that actually applies
  // to this spot's category — not just whichever interest the traveler
  // happened to select first.
  const matched = context.interestLabels?.find((label) => label === spot.category) || null;
  if (matched) {
    return `Matches your interest in ${matched.toLowerCase()}, rated ${spot.rating || 'well'} by visitors.`;
  }
  return `A ${spot.category} spot rated ${spot.rating || 'well'} by visitors near your route.`;
}

/**
 * Builds a short "why this itinerary fits you" summary without calling
 * Gemini — used on the heuristic path (no key configured, or the full-AI
 * call fell through) so the traveler still gets an AI-style trip summary.
 */
export function buildHeuristicTripSummary(trip, stops, { hiddenGemCount = 0, outdoorSwaps = 0 } = {}) {
  const interestLabels = (trip.interests || []).map((i) => i.category);
  const interestPhrase = interestLabels.length
    ? `built around your interest in ${interestLabels.slice(0, 3).join(', ').toLowerCase()}`
    : 'built around the highest-rated spots near your destination';

  const parts = [
    `This ${stops.length}-stop plan for ${trip.destination} is ${interestPhrase}, ordered to minimize backtracking between stops.`,
  ];
  if (hiddenGemCount > 0) {
    parts.push(`It includes ${hiddenGemCount} lesser-known spot${hiddenGemCount > 1 ? 's' : ''} alongside the well-known highlights.`);
  }
  if (outdoorSwaps > 0) {
    parts.push(`${outdoorSwaps} outdoor stop${outdoorSwaps > 1 ? 's were' : ' was'} swapped for an indoor alternative based on the forecast.`);
  }
  parts.push(`Budget and timing are estimated for your group of ${trip.adults + trip.kids + trip.elderly + trip.specially_abled} traveler(s).`);
  return parts.join(' ');
}

// ============================================================
// Gemini function calling (used by the AI orchestration layer /
// orchestrator.service.js). Kept separate from callGemini() above because
// tool-calling responses have a different shape (functionCall parts instead
// of a single JSON blob) and because a tool round-trip needs to send the
// running `contents` array back and forth across turns.
// ============================================================

/**
 * One turn of a Gemini function-calling conversation. `contents` is the
 * full running turn history in Gemini's { role, parts } shape. `tools` is
 * an array of function declarations (see assistantFunctions.service.js).
 *
 * Returns { ok: true, text, functionCalls, modelContent, raw } on success —
 * `functionCalls` is [] when the model just answered directly. On failure
 * returns { ok: false, reason, message } and NEVER throws. `reason` is one
 * of: 'no_api_key' | 'timeout' | 'network' | 'gemini_4xx' | 'gemini_5xx' |
 * 'rate_limited' | 'unknown_error' — callers can log/branch on it without
 * treating every failure as "the assistant is unavailable".
 *
 * `thinkingLevel` defaults to 'low': Gemini 3.x models think before
 * answering by default (server-side default is 'medium' when unset), and
 * that default reasoning pass — especially with a full tool/function
 * declaration list attached for the model to consider — was regularly
 * pushing simple messages ("hello") past the timeout and surfacing as
 * `Gemini tool call error: timeout/abort` even though Gemini itself was
 * reachable and the API key was valid. This is an interactive chat path;
 * 'low' trades a bit of reasoning depth for reliably fast, on-time replies.
 * Callers can still pass a higher level for turns that need deeper
 * reasoning.
 */
export async function callGeminiWithTools({ contents, systemInstruction, tools, maxOutputTokens = 1024, temperature = 0.4, timeoutMs = 20000, thinkingLevel = 'low' }) {
  if (!env.geminiApiKey) return { ok: false, reason: 'no_api_key', message: 'GEMINI_API_KEY is not configured' };

  const body = {
    contents,
    ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    ...(tools?.length ? { tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
    generationConfig: {
      temperature,
      maxOutputTokens,
      ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GEMINI_URL}?key=${env.geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      console.error(`[ai.service] Gemini tool call failed: ${res.status} ${errorBody}`.trim());
      const reason = res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'gemini_5xx' : 'gemini_4xx';
      return { ok: false, reason, status: res.status, message: errorBody };
    }
    const data = await res.json();
    // Thinking models (Gemini 3.x+) attach a `thoughtSignature` to each
    // functionCall/text part and require it to be echoed back verbatim on
    // the next turn of a multi-step tool call — otherwise the follow-up
    // request is rejected. Keep the model's original `content` object
    // (modelContent) so the caller can push it straight back into the
    // running `contents` history instead of rebuilding a stripped-down
    // version that drops the signature.
    const modelContent = data.candidates?.[0]?.content || null;
    const parts = modelContent?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    // Reasoning-summary parts are marked `thought: true` — exclude them so
    // internal chain-of-thought never leaks into the user-facing reply.
    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n').trim();
    return { ok: true, text, functionCalls, modelContent, raw: data };
  } catch (err) {
    const isAbort = err.name === 'AbortError';
    const isNetworkError = /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed/i.test(err.message || '');
    const reason = isAbort ? 'timeout' : isNetworkError ? 'network' : 'unknown_error';
    console.error(`[ai.service] Gemini tool call error: ${reason}${isAbort ? ` (>${timeoutMs}ms)` : ` — ${err.message}`}`);
    return { ok: false, reason, message: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Batches spot explanations with limited concurrency so a large itinerary
 * doesn't fire off too many simultaneous Gemini calls.
 */
export async function explainAllSpots(spots, context) {
  const results = [];
  for (const spot of spots) {
    results.push(await explainSpotChoice(spot, context));
  }
  return results;
}

// ============================================================
// Full AI-driven itinerary generation
// ============================================================
// This is the "experienced local tour guide" prompt: instead of just
// explaining one spot, it hands Gemini the whole trip + real datasets and
// asks for a complete, budgeted, timed, DAY-BY-DAY itinerary back as JSON.
// Used as the primary path when a Gemini key is configured;
// itineraryEngine.service.js falls back to the heuristic pipeline if this
// returns null for any reason.

const ITINERARY_SYSTEM_PROMPT = `You are GoVIBE AI, an award-winning travel consultant with over 20 years of experience creating premium, personalized travel experiences for GoVIBE, an intelligent tourism planning platform.

Your goal is not simply to list tourist attractions. Your goal is to generate a highly personalized, realistic, optimized, and budget-friendly itinerary that feels like it was handcrafted by an experienced local guide who deeply understands the destination — practical, exciting, realistic, and personalized, never a generic list.

Think before selecting every destination. For every recommendation ask yourself:
- Does this match the traveler's interests?
- Is it worth visiting?
- Does it fit naturally into the route?
- Is it popular enough to recommend?
- Is it within the traveler's budget?
- Would a local travel expert recommend this?
Never include a place just to fill the itinerary — quality over quantity, every single time.

=========================
YOUR RESPONSIBILITIES
=========================

Generate a complete, DAY-BY-DAY itinerary that includes:

1. Personalized trip summary based on the user's interests.
2. Split the plan across every day of the trip (see "Day-by-day dates" below) — every stop must be tagged with the correct "day" number (1-based) and "date" (YYYY-MM-DD), and each day should be geographically clustered so travelers aren't zig-zagging across the city.
3. Optimize the route within each day to minimize travel time and avoid unnecessary backtracking; assume the traveler returns to their accommodation (or starting point) at the end of each day and starts the next day from there.
4. Recommend the best transport between every destination (walking, bus, metro, auto, cab, bike), with estimated travel time, estimated travel cost, and a reason for the recommendation.
5. Create a detailed timeline per day (e.g. "09:00 AM - Start from hotel", "09:30 AM - Marina Beach"), resetting the clock at the start of each day.
6. For every attraction provide: name, short description, category, rating, opening time, closing time, entry fee, recommended visit duration, best time to visit, crowd level (Low/Medium/High), and photo URL if available.
7. Recommend nearby restaurants after major attractions, with name, cuisine, average cost, rating, distance, and suitability for the user's food preference. Never reuse the same restaurant twice across the whole trip.
8. Prefer famous, well-loved attractions first, then layer in hidden gems that match the user's interests instead of recommending only famous places — spread hidden gems across different days rather than clustered on one day.
8b. In the "tips" field for every stop, briefly explain WHY that attraction was chosen for this specific traveler (interest match, uniqueness, timing, or local reputation) — not a generic filler line. IMPORTANT: only cite "interest match" when the stop's category genuinely is one of the traveler's selected interests below. A hotel/stay is never an "interest match" — explain those on rating, location convenience, or budget fit instead. Never attribute a stop to an interest the traveler didn't select or that doesn't apply to that stop's category.
9. Calculate a complete budget breakdown: transport, food, entry fees, accommodation, shopping allowance, emergency buffer, total estimated cost, remaining budget — for the WHOLE trip across all days.
10. If weather conditions are unfavorable on a given day, replace outdoor attractions with indoor alternatives on that day and explain why the itinerary changed.
11. If a place is closed or overcrowded, recommend an alternative attraction nearby.
12. Include useful travel tips (water, footwear, peak traffic, photography restrictions, local customs).
13. Recommend nearby local businesses that can benefit the traveler (souvenir shops, cafes, local guides, rental services, street food, handicraft shops).
14. At the end generate: total distance, total travel time, total sightseeing time, estimated finish time, trip satisfaction score (1-100), and why this itinerary suits the traveler.

=========================
IMPORTANT RULES
=========================

- Never recommend impossible schedules.
- Respect opening and closing timings.
- Keep travel times realistic.
- Stay within the user's budget.
- Do not exceed the trip duration — use exactly the number of days given, no more, no fewer.
- Prioritize attractions matching the user's interests.
- Coverage: the traveler selected specific interest categories (see "Interests" below) — every one of those categories that has at least one genuine match in the Tourist Attractions Dataset MUST be represented by at least one stop somewhere across the whole trip. Do not let one or two categories dominate the itinerary while a selected interest gets zero stops just because other categories scored higher — spread stops across all selected interests first, then fill any remaining slots with the best overall picks. Only skip an interest entirely if the dataset genuinely has no matching place for it.
- NEVER return an empty itinerary. If the traveler's selected interests genuinely have no (or very few) matches in the datasets for this destination, do not fail or return nothing — instead build the itinerary from the destination's most famous, highest-rated genuine attractions across whatever categories the dataset does have, and say so plainly in "summary" (e.g. "We couldn't find much matching [interest] here, so here are [destination]'s must-see spots instead"). A full itinerary built from the best available places is always better than an empty result.
- Recommend lesser-known places whenever appropriate.
- Avoid duplicate attractions across the whole trip, even on different days.
- Ensure smooth transitions between locations within a day.
- Keep the itinerary practical for real-world travel.
- Only use places that appear in the datasets provided below — do not invent attractions, restaurants, or hotels that aren't listed.
- Every itinerary item MUST include "day" (integer, 1-based) and "date" (YYYY-MM-DD) matching the day-by-day dates given below.
- NEVER recommend a government office, MLA/MP office, police station, fire station, hospital, clinic, school, college, university, bank, ATM, residential building, warehouse, industrial building, administrative building, utility office, petrol pump, bus depot, or any other non-tourism/administrative location. Every "place" in the itinerary must be a genuine tourist attraction, historical site, nature spot, adventure activity, restaurant, café, shopping destination, park, entertainment venue, or family attraction — sourced only from the datasets provided.
- NEVER recommend a fish market, vegetable market, meat market, or other wholesale/functional market — these are working markets for locals, not travel destinations, even if one happens to appear in the Tourist Attractions Dataset. Local markets/bazaars/shopping streets aimed at visitors (souvenirs, handicrafts, textiles) are fine.
- Follow the traveler's selected Trip Style below — it should visibly reshape pacing and place selection, not just the summary text. Two travelers with different Trip Styles for the same destination should get noticeably different itineraries.
- If the stated budget is genuinely unrealistic for the destination, duration, and group size, do NOT silently cut corners — say so plainly in "summary" and "final_ai_summary", explain why (e.g. accommodation or transport costs for this city/group), and suggest a realistic adjustment (either a higher budget figure or a lower-cost alternative plan), while still returning the best itinerary you can within the constraints given.
- Write "summary" and "final_ai_summary" in an elegant, warm, conversational voice — like a professional travel consultant addressing a paying client, not a machine-generated caption. The traveler should finish reading and feel excited to start the journey.

=========================
ACTIVITY BALANCE — build a plan a local guide would give, not a list of nearby places
=========================

- For a typical one-day plan, tourist attractions (nature, heritage, adventure, entertainment, family) should make up roughly 70–80% of that day's stops. Food is a SUPPORTING activity, not the main content of the day — never build a day around eating.
- Unless the traveler's Trip Style is "Food Explorer" or "food" is one of their selected interests, only schedule food as necessary meal breaks: one lunch stop around midday, one dinner stop only if the day genuinely extends into the evening, and a café/snack stop only when it naturally fits a gap — not as a default filler between attractions.
- If Trip Style is "Food Explorer" or the traveler selected a "food" interest, you may feature more restaurants/cafés as real, named stops in their own right — but attractions should still anchor most days.
- NEVER produce a sequence like Restaurant → Café → Restaurant → Café, or otherwise place two food stops back-to-back unless the traveler is clearly a food-focused trip and it's a deliberate, explained choice (e.g. a food-street crawl). A realistic day looks like: Tourist Attraction → Tourist Attraction → Lunch → Museum → Park → Sunset Point.
- Schedule meals at realistic times, not randomly between every attraction: breakfast (if applicable) 7:00–9:00 AM, lunch 12:00–2:00 PM, an optional evening snack/café 4:00–5:30 PM, dinner (only if the day runs into the evening) 7:00–9:00 PM. Shorter days should have fewer meal stops, not one shoehorned in regardless.
- Match the meal SLOT to the right kind of place: lunch and dinner must be a genuine sit-down restaurant (subcategory "Restaurants"), never a café. The evening snack slot must be a café/tea stop (subcategory "Cafés"), never a full restaurant. Never label a café as "Lunch" or "Dinner", and never label a restaurant as the café/snack stop.
- Only include shopping destinations (markets, shopping streets, malls, souvenir shops) if the traveler selected a "shopping" interest — otherwise leave shopping out rather than defaulting to it.
- Avoid two consecutive stops of the same type (e.g. Café → Café, Museum → Museum, Temple → Temple) — mix attraction types across the day while still respecting the traveler's selected interests and Trip Style.
- Diversify subcategories, not just categories, across the WHOLE trip: never include more than one shopping mall in the entire itinerary — if the traveler wants shopping, mix subcategories instead (one mall, plus a street market, a bookstore, or a handicraft/textile store), rather than stacking multiple malls. The same applies to any other narrow, repeatable subcategory (e.g. don't schedule three separate "viewpoints" or three separate "flea markets") — prefer variety of experience over repeating the same type of place, even when several score similarly.
- When the traveler picked several interests together (e.g. shopping, food, beach), actively interleave them across the trip rather than clustering all of one interest on one day and ignoring it elsewhere — the goal is a balanced mix shaped by time available, budget, and route efficiency, not a lopsided plan dominated by whichever category had the most candidates.
- Before finalizing, check your own itinerary array against these rules: is roughly 70–80% of each day genuine attractions, are meals only at realistic times and counts with the correct restaurant-vs-café slot, are there no back-to-back same-type or back-to-back food stops, is no subcategory (e.g. malls) repeated across the trip when a mix was possible, and is every place a genuine tourist/travel destination with no wholesale markets or administrative buildings? Fix anything that fails before returning.

=========================
OUTPUT FORMAT
=========================

Return ONLY valid JSON, matching exactly this shape:

{
  "summary": "",
  "trip_score": 95,
  "total_distance": "",
  "estimated_duration": "",
  "budget_breakdown": {
    "transport": 0, "food": 0, "entry_fees": 0, "accommodation": 0,
    "shopping": 0, "buffer": 0, "total": 0, "remaining_budget": 0
  },
  "itinerary": [
    {
      "day": 1, "date": "", "time": "", "place": "", "category": "", "description": "", "duration": "",
      "opening_time": "", "closing_time": "", "entry_fee": 0, "rating": 0,
      "best_time": "", "crowd_level": "",
      "transport": { "mode": "", "travel_time": "", "travel_cost": 0, "reason": "" },
      "restaurant": { "name": "", "cuisine": "", "rating": 0, "average_cost": 0 },
      "hidden_gem": false, "tips": ""
    }
  ],
  "travel_tips": [],
  "business_recommendations": [],
  "alternative_places": [],
  "final_ai_summary": ""
}`;

// Structured-output schema mirroring the shape above, passed as
// generationConfig.responseSchema. This constrains Gemini's output at the
// API level (not just via prompt instructions), which is far more reliable
// than hoping the model follows the free-text format description —
// especially for the "day"/"date" fields multi-day trips depend on.
const ITINERARY_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    trip_score: { type: 'number' },
    total_distance: { type: 'string' },
    estimated_duration: { type: 'string' },
    budget_breakdown: {
      type: 'object',
      properties: {
        transport: { type: 'number' }, food: { type: 'number' }, entry_fees: { type: 'number' },
        accommodation: { type: 'number' }, shopping: { type: 'number' }, buffer: { type: 'number' },
        total: { type: 'number' }, remaining_budget: { type: 'number' },
      },
    },
    itinerary: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'integer' },
          date: { type: 'string' },
          time: { type: 'string' },
          place: { type: 'string' },
          category: { type: 'string' },
          description: { type: 'string' },
          duration: { type: 'string' },
          opening_time: { type: 'string' },
          closing_time: { type: 'string' },
          entry_fee: { type: 'number' },
          rating: { type: 'number' },
          best_time: { type: 'string' },
          crowd_level: { type: 'string' },
          transport: {
            type: 'object',
            properties: {
              mode: { type: 'string' }, travel_time: { type: 'string' },
              travel_cost: { type: 'number' }, reason: { type: 'string' },
            },
          },
          restaurant: {
            type: 'object',
            properties: {
              name: { type: 'string' }, cuisine: { type: 'string' },
              rating: { type: 'number' }, average_cost: { type: 'number' },
            },
          },
          hidden_gem: { type: 'boolean' },
          tips: { type: 'string' },
        },
        required: ['day', 'place'],
      },
    },
    travel_tips: { type: 'array', items: { type: 'string' } },
    business_recommendations: { type: 'array', items: { type: 'string' } },
    alternative_places: { type: 'array', items: { type: 'string' } },
    final_ai_summary: { type: 'string' },
  },
  required: ['itinerary'],
};

function formatWeatherForPrompt(forecast) {
  if (!forecast) return 'not available for this date — use your general knowledge of the destination\'s typical climate for this time of year';
  const temp = forecast.tempMaxC != null ? `${Math.round(forecast.tempMinC)}–${Math.round(forecast.tempMaxC)}°C` : 'unknown';
  const rain = forecast.precipitationProbability != null ? `${forecast.precipitationProbability}% chance of precipitation` : 'precipitation chance unknown';
  return `${forecast.label}, ${temp}, ${rain}${forecast.outdoorUnfriendly ? ' — conditions are outdoor-unfriendly, prefer indoor alternatives where sensible' : ''}`;
}

/** Builds the "Day 1: 2026-08-01\nDay 2: 2026-08-02\n..." block the prompt uses to anchor day/date tagging. */
function buildDayByDayDates(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const dayCount = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
  const lines = [];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    lines.push(`Day ${i + 1}: ${d.toISOString().slice(0, 10)}`);
  }
  return { dayCount, text: lines.join('\n') };
}

function buildItineraryUserPrompt(trip, datasets, dayByDay) {
  const groupSize = (trip.adults || 0) + (trip.kids || 0) + (trip.elderly || 0) + (trip.specially_abled || 0);
  const interests = (trip.interests || []).map((i) => `${i.category}${i.subcategories?.length ? ` (${i.subcategories.join(', ')})` : ''}`).join('; ');

  return `${ITINERARY_SYSTEM_PROMPT}

=========================
USER INPUT
=========================

Starting Location: ${trip.start_location || trip.destination}
Destination: ${trip.destination}
Ending Location: ${trip.end_location || trip.destination}
Trip Duration: ${dayByDay.dayCount} day(s), from ${trip.start_date} to ${trip.end_date}

Day-by-day dates (tag every itinerary item with the matching "day" number and "date"):
${dayByDay.text}

Number of Travelers: ${groupSize} (adults: ${trip.adults || 0}, kids: ${trip.kids || 0}, elderly: ${trip.elderly || 0}, specially abled: ${trip.specially_abled || 0})
Total Budget: ₹${trip.total_budget_inr}
Preferred Transport: ${trip.transport_modes?.join(', ') || trip.transport_priority || 'no preference'}
Interests: ${interests || 'general sightseeing'}
${getTripStylePromptGuidance(trip.trip_style)}
Food Preference: ${trip.food_preferences?.join(', ') || 'no restriction'}
Trip Pace: Balanced (unless the Trip Style above specifies otherwise — Trip Style takes precedence)
Accommodation Required: ${trip.needs_accommodation ? 'Yes' : 'No'}
Special Requirements: none specified
Weather: ${formatWeatherForPrompt(datasets.weather)}

Tourist Attractions Dataset:
${JSON.stringify(capDataset(datasets.attractionsDataset, DATASET_CAPS.attractions))}

Restaurants Dataset:
${JSON.stringify(capDataset(datasets.restaurantsDataset, DATASET_CAPS.restaurants))}

Hotels Dataset:
${JSON.stringify(capDataset(datasets.hotelsDataset, DATASET_CAPS.hotels))}

Nearby Businesses Dataset:
${JSON.stringify(datasets.nearbyBusinessesDataset || [])}

Events Dataset:
${JSON.stringify(datasets.eventsDataset || [])}`;
}

/**
 * Asks Gemini to generate a full structured, day-by-day itinerary in one
 * shot. Returns the parsed JSON object, or null if there's no key, the call
 * fails, times out, or the response isn't valid/parseable JSON — the
 * caller (itineraryEngine.service.js) always falls back to the heuristic
 * pipeline in that case, so this never breaks itinerary generation.
 */
export async function generateFullItinerary(trip, datasets) {
  if (!env.geminiApiKey) return null;

  const dayByDay = buildDayByDayDates(trip.start_date, trip.end_date);
  const prompt = buildItineraryUserPrompt(trip, datasets, dayByDay);

  // Scale both the token budget and the timeout with trip length — a 1-day
  // trip and a 10-day trip shouldn't share the same ceiling. Capped so a
  // pathological input can't stall the request pipeline indefinitely.
  const maxOutputTokens = Math.min(8192, 1500 + dayByDay.dayCount * 700);
  const timeoutMs = Math.min(45000, 12000 + dayByDay.dayCount * 2500);

  const parsed = await callGemini({
    prompt,
    schema: ITINERARY_RESPONSE_SCHEMA,
    maxOutputTokens,
    temperature: 0.4,
    timeoutMs,
  });

  if (!parsed || !Array.isArray(parsed.itinerary)) return null; // malformed — let the caller fall back

  // Belt-and-braces: even with a schema, backfill day/date for any item the
  // model left blank so downstream day-grouping never breaks.
  parsed.itinerary = parsed.itinerary.map((item, i) => ({
    ...item,
    day: Number.isFinite(item.day) ? item.day : 1,
    date: item.date || dayByDay.text.split('\n')[Math.min((item.day || 1) - 1, dayByDay.dayCount - 1)]?.split(': ')[1],
  }));

  return parsed;
}