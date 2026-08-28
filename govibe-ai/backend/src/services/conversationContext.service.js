/**
 * Canonical, dependency-free context model for the general assistant.
 *
 * This deliberately does not try to be an LLM. It extracts only stable,
 * actionable facts and resolves references from prior turns before a tool is
 * considered. The LLM receives this compact state for nuanced reasoning;
 * deterministic operations use it to construct safe tool arguments.
 */
const CATEGORY_RULES = [
  [/\b(?:cafes?|coffee)\b/i, 'cafe'],
  [/\b(?:restaurants?|restaur\w*|food|eater(?:y|ies)|dining|non[- ]?veg(?:etarian)?|nonveg|lunch|dinner|breakfast|eat|eating)\b/i, 'restaurant'],
  [/\b(?:hotels?|stay|accommodation)\b/i, 'hotel'],
  [/\b(?:shops?|malls?|markets?|business(?:es)?)\b/i, 'shopping'],
  [/\b(?:hospitals?|clinics?|doctors?|medical(?: stores?)?)\b/i, 'hospital'],
  [/\b(?:pharmacies?|chemists?)\b/i, 'pharmacy'],
  [/\b(?:atms?|cash)\b/i, 'atm'],
  [/\b(?:petrol pumps?|fuel stations?|gas stations?)\b/i, 'petrol'],
  [/\b(?:museums?|parks?|beaches|temples?|trampoline|activities|activity|attractions?|places?|spots?|things to do|tourist places?|sightseeing)\b/i, 'activity'],
];

const MODE_RULES = [
  /\bbus\b/i,
  /\btrain\b/i,
  /\bmetro\b/i,
  /\bwalk(?:ing)?\b/i,
  /\bcab|taxi\b/i,
  /\bauto(?:-rickshaw)?\b/i,
];

const REFERENCE_RULES = [
  [/\b(?:this|that)\s+(?:place|restaurant|activity|stop|one)\b/i, 'last_entity'],
  [/\b(?:the list above|these|those|nearby ones?|cheaper ones?|instead)\b/i, 'last_results'],
  [/\b(?:first|second|third|fourth|fifth)\s+(?:one|place|activity|stop)\b/i, 'ordinal_entity'],
  [/\b(?:near there|there)\b/i, 'last_location'],
];

function categoryIn(text) {
  return (
    CATEGORY_RULES.find(([re]) => re.test(text))?.[1] || null
  );
}

function modeIn(text) {
  const hit = MODE_RULES.find((re) => re.test(text));

  return hit
    ? hit.source
        .replace(/\\b|\\|\(\?:|\)|\[.*?\]|\?/g, '')
        .split('|')[0]
    : null;
}

function locationIn(text) {
  const raw = text || '';

  // Prefer explicit travel-destination phrasing before generic "in X".
  // Otherwise phrases such as "visiting Chennai for one day" can be
  // incorrectly captured as "one day".
  const visiting =
    /\b(?:visiting|staying\s+in|travelling\s+to|traveling\s+to)\s+([\p{L}][\p{L}\p{N} .'-]{1,60}?)(?=\s*(?:,|[?.!]|$)|\s+(?:for|with|today|tomorrow|tonight|now|this\s+(?:week|weekend)|under|below|within|including|and|please|suggest|find|show|recommend)\b)/iu.exec(
      raw,
    );

  if (visiting?.[1]) {
    return visiting[1].trim();
  }

  // Destination phrasing such as "plan a trip to Chennai" should populate
  // the location context for later follow-up requests.
  const destinationMatch =
    /\b(?:to|towards)\s+(?:the\s+)?([\p{L}][\p{L}\p{N} .'-]{1,60}?)(?=\s*(?:,|[?.!]|$)|\s+(?:with|for|today|tomorrow|under|below|within|including|and|please|suggest|find|show|recommend)\b)/iu.exec(
      raw,
    );

  if (
    destinationMatch?.[1] &&
    /\b(?:plan|trip|itinerary|travel|visit|going|go)\b/i.test(raw)
  ) {
    return destinationMatch[1].trim();
  }

  // Generic locality phrases.
  const match =
    /\b(?:near|around|in|at)\s+(?:the\s+)?([\p{L}][\p{L}\p{N} .'-]{1,60}?)(?=\s*(?:,|[?.!]|$)|\s+(?:today|tomorrow|tonight|now|this\s+(?:week|weekend)|for|with|under|below|within|including|and|please|suggest|find|show|recommend|that|which|who)\b)/iu.exec(
      raw,
    );

  const candidate = match?.[1]?.trim();

  if (!candidate) {
    return null;
  }

  if (
    /^(?:one|two|three|four|five|\d+)\s+(?:day|days|hour|hours|minute|minutes|night|nights)$/i.test(
      candidate,
    )
  ) {
    return null;
  }

  return candidate;
}

function routeIn(text) {
  const standard =
    /\bfrom\s+([\p{L}][\p{L}\p{N} .'-]{1,60}?)\s+to\s+([\p{L}][\p{L}\p{N} .'-]{1,60}?)(?:[?.!]|$)/iu.exec(
      text,
    );

  if (standard) {
    return {
      origin: standard[1].trim(),
      destination: standard[2].trim(),
    };
  }

  // Handles:
  // "How can I reach Elliot's Beach from Sathyabama University?"
  // "How do I get to Marina Beach from Velachery?"
  const reach =
    /\b(?:reach|get to|go to|travel to)\s+([\p{L}][\p{L}\p{N} .'-]{1,60}?)\s+from\s+([\p{L}][\p{L}\p{N} .'-]{1,60}?)(?:[?.!]|$)/iu.exec(
      text,
    );

  if (reach) {
    return {
      origin: reach[2].trim(),
      destination: reach[1].trim(),
    };
  }

  const modeLed =
    /^\s*(?:which\s+)?(?:bus|train|metro|public transport)\s+(?:from|to)\s+([\p{L}][\p{L}\p{N} .'-]{1,60}?)\s+to\s+([\p{L}][\p{L}\p{N} .'-]{1,60}?)(?:[?.!]|$)/iu.exec(
      text,
    );

  return modeLed
    ? {
        origin: modeLed[1].trim(),
        destination: modeLed[2].trim(),
      }
    : null;
}

function intentIn(text, route) {
  if (
    /\b(?:what(?:\s+else)?\s+can you do|what do you do|how can you help|your capabilities|\bhelp\b)\b/i.test(
      text,
    )
  ) {
    return 'general_help';
  }

  // Matches "my trips", "my saved itinerary", "my current trip budget",
  // "my current itinerary", etc. Previously this required "my"/"saved" to
  // sit IMMEDIATELY before the noun (single \s+, no words in between), so
  // "my current trip budget" or "my current itinerary" fell through this
  // check entirely — "current" broke the adjacency — and were then
  // wrongly caught by the bare-word trip_planning check further below
  // (because the literal word "trip" or "itinerary" is still in the
  // sentence), which treats a question about an EXISTING trip as a
  // request to plan a brand-new one. Allowing up to three filler words
  // between the possessive and the noun fixes that without touching
  // trip_planning's own matching. "allocated"/"how much ... left" are
  // included because budget-breakdown questions ("how much have I
  // allocated for transport?") don't always say "budget" or "my trip"
  // at all.
  if (
    /\b(?:my|saved|current|existing)\s+(?:[\w'-]+\s+){0,3}(?:trips?|bookings?|itinerar(?:y|ies)|budgets?)\b/i.test(
      text,
    ) ||
    /\ballocated\b/i.test(text) ||
    /\bhow much\b.*\b(?:left|remaining|spent)\b/i.test(text)
  ) {
    return 'saved_trip';
  }

  if (
    /\b(?:remove|replace|swap|reorder|recalculate|replan|change day|make it cheaper|keep .*under)\b/i.test(
      text,
    )
  ) {
    return 'itinerary_modification';
  }

  if (
    /\b(?:bus|train|metro|public transport)\b/i.test(text) &&
    route
  ) {
    return 'transit_search';
  }

  if (
    /\b(?:distance|directions|travel time|how far|how long|how can i reach|how do i get|reach|go to|travel to)\b/i.test(
      text,
    ) &&
    route
  ) {
    return 'route_search';
  }

  if (
    /\b(?:open now|opening hours?|entry fee|ticket price|current price|availability)\b/i.test(
      text,
    )
  ) {
    return 'live_factual';
  }

  // Peaceful/relaxed recommendations are direct place-search requests.
  if (
    /\b(?:peaceful|quiet|calm|serene|relax(?:ed|ing)|less[- ]crowded|uncrowded)\b/i.test(
      text,
    ) &&
    /\b(?:place|places|spot|spots|location|locations|things? to (?:see|visit))\b/i.test(
      text,
    )
  ) {
    return 'place_search';
  }

  // "Plan a dinner/lunch in X" is a restaurant search, not a trip plan.
  if (
    categoryIn(text) === 'restaurant' &&
    /\b(?:dinner|lunch|breakfast|eat|eating|restaurant|non[- ]?veg|nonveg)\b/i.test(
      text,
    ) &&
    /\b(?:in|near|around|at)\b/i.test(text)
  ) {
    return 'place_search';
  }

  // Real trip planning takes precedence over secondary preferences.
  if (
    /\b(?:plan|itinerary|trip|travel plan|vacation plan|getaway)\b/i.test(
      text,
    )
  ) {
    return 'trip_planning';
  }

  if (
    /\b(?:tell me about|what is|what are|information about|details about|describe)\b/i.test(
      text,
    ) &&
    /\b(?:in|at|near|around)\b/i.test(text) === false
  ) {
    return 'place_information';
  }

  if (categoryIn(text)) {
    return 'place_search';
  }

  return 'general';
}

// Business-side query detection (Phase 4). This is deliberately heuristic —
// it only needs to catch the shape of questions a logged-in business asks
// about their own GoVIBE presence (offers, performance, profile, traveler
// targeting, promotion ideas) so the orchestrator knows to hand the LLM the
// BUSINESS_DECLARATIONS tool set instead of leaving it toolless (the bug
// this intent exists to fix — see orchestrator.service.js buildSystemInstruction
// and intentNeedsTool below). It is only ever consulted for role === 'business'.
const BUSINESS_QUERY_RULES = [
  /\bmy (?:offers?|business|profile|listing)\b/i,
  /\boffers?\b/i,
  /\b(?:offer|offers)\b.*\b(?:performing|performance|doing|views?|bookings?)\b/i,
  /\b(?:which|what) offer\b/i,
  /\bhow (?:is|are) my\b/i,
  /\btell me about my business\b/i,
  /\b(?:target|targeting|segment|audience)\b/i,
  /\battract (?:more )?(?:travele?rs?|customers?|visitors?|tourists?)\b/i,
  /\bimprove (?:my|this|the) offer\b/i,
  /\brewrite (?:this|my) offer\b/i,
  /\bwhat (?:offer|promotion|discount) should i\b/i,
  /\bwhat kind of travele?rs?\b/i,
  /\bwho should i target\b/i,
];

function isBusinessQuery(text) {
  return BUSINESS_QUERY_RULES.some((re) => re.test(text || ''));
}

function extractExplicitEntity(text) {
  const raw = (text || '').trim();

  if (!raw) {
    return null;
  }

  const patterns = [
    /\b(?:tell me about|information about|details about|describe)\s+(.+?)(?:,|\.|$)/i,
    /\b(?:entry fee|ticket price|opening hours?|open now)\s+(?:for|of)\s+(.+?)(?:,|\.|$)/i,
    /\b(?:near|around|in)\s+(.+?)(?:,|\.|$)/i,
  ];

  for (const re of patterns) {
    const m = re.exec(raw);

    if (m?.[1]) {
      return m[1].trim();
    }
  }

  return null;
}

function referenceIn(text) {
  return REFERENCE_RULES.find(([re]) => re.test(text))?.[1] || null;
}

/** Fold prior turns into the minimum durable state needed for the next turn. */
export function buildConversationContext(history = [], message = '', role = 'traveler') {
  const state = {
    location: null,
    category: null,
    origin: null,
    destination: null,
    mode: null,
    lastTool: null,
    lastEntity: null,
    lastResults: null,
  };

  for (const turn of history) {
    const text = turn?.content || '';

    state.location = locationIn(text) || state.location;
    state.category = categoryIn(text) || state.category;

    const route = routeIn(text);

    if (route) {
      state.origin = route.origin;
      state.destination = route.destination;
    }

    state.mode = modeIn(text) || state.mode;

    if (
      Array.isArray(turn?.tools_used) &&
      turn.tools_used.length
    ) {
      const last = turn.tools_used.at(-1);

      state.lastTool = last?.name || state.lastTool;

      const args = last?.args || {};

      if (last?.name === 'find_nearby') {
        state.lastEntity =
          args.near || state.lastEntity;

        state.location =
          args.near || state.location;

        state.category =
          categoryIn(args.query || '') ||
          state.category;
      } else if (
        last?.name === 'get_route'
      ) {
        state.origin =
          args.origin || state.origin;

        state.destination =
          args.destination ||
          state.destination;

        state.mode =
          args.mode || state.mode;

        state.lastEntity =
          args.destination ||
          args.origin ||
          state.lastEntity;
      } else if (
        last?.name === 'search_web'
      ) {
        state.lastEntity =
          args.query || state.lastEntity;
      } else if (
        last?.name === 'get_weather_forecast'
      ) {
        state.lastEntity =
          args.location ||
          state.lastEntity;
      }
    }
  }

  const route = routeIn(message);
  const reference = referenceIn(message);
  const rawIntent = intentIn(message, route);
  const currentCategory = categoryIn(message);
  const currentLocation = locationIn(message);

  const currentExplicitEntity = reference
    ? null
    : extractExplicitEntity(message);

  const preferenceCategory =
    /\b(?:peaceful|quiet|calm|serene|relax(?:ed|ing)|less[- ]crowded|uncrowded)\b/i.test(
      message,
    )
      ? 'activity'
      : null;

  // A follow-up such as:
  // "non veg restaurant in Chennai"
  // "yeah in Chennai"
  //
  // should update only the location while retaining the previous category.
  const followUpPlaceSearch =
    !currentCategory &&
    currentLocation &&
    state.category;

  // Business-side questions ("how are my offers performing?", "who should
  // I target?", "tell me about my business") get misclassified by the
  // traveler-oriented rules above (e.g. "tell me about my business" looks
  // like a generic place_information request). For a business-role caller,
  // recognized business phrasing always wins so BUSINESS_DECLARATIONS tools
  // actually get attached to the LLM call — see intentNeedsTool below.
  const businessOverride =
    role === 'business' &&
    rawIntent !== 'general_help' &&
    isBusinessQuery(message);

  const intent = businessOverride
    ? 'business_query'
    : rawIntent === 'general' &&
      (reference || followUpPlaceSearch) &&
      state.category
      ? 'place_search'
      : rawIntent;

  const category =
    currentCategory ||
    preferenceCategory ||
    (
      reference ||
      followUpPlaceSearch
        ? state.category
        : null
    );

  const location =
    currentLocation ||
    (reference ? state.location : null);

  return {
    intent,

    category,

    location,

    origin:
      route?.origin ||
      (reference
        ? state.origin
        : null),

    destination:
      route?.destination ||
      (reference
        ? state.destination
        : null),

    mode:
      modeIn(message) ||
      (reference
        ? state.mode
        : null),

    referencedEntity:
      currentExplicitEntity ||
      (
        reference
          ? state.lastEntity
          : null
      ),

    explicitEntity:
      currentExplicitEntity,

    reference,

    budget:
      /\b(?:under|below|budget|cheap|cheaper|affordable)\b/i.test(
        message,
      )
        ? 'constrained'
        : null,

    audience:
      /\b(?:family|kids?|children)\b/i.test(
        message,
      )
        ? 'family'
        : null,

    foodPreference:
      /\b(?:non[- ]?veg(?:etarian)?|nonveg)\b/i.test(
        message,
      )
        ? 'non_veg'
        : null,

    previous: state,
  };
}

/** Only these intents are allowed to receive map/live-data functions. */
export function intentNeedsTool(intent) {
  return new Set([
    'saved_trip',
    'place_search',
    'transit_search',
    'route_search',
    'live_factual',
    'trip_planning',
    'business_query',
  ]).has(intent);
}

/** Tool-result boundary: reject malformed or irrelevant place/route data. */
export function validateToolResult(tool, result) {
  if (
    !result ||
    typeof result !== 'object'
  ) {
    return {
      valid: false,
      reason:
        'empty or malformed tool response',
    };
  }

  if (result.error) {
    return {
      valid: false,
      reason: result.error,
    };
  }

  if (tool === 'find_nearby') {
    return {
      valid: Array.isArray(
        result.results,
      ),
      reason: Array.isArray(
        result.results,
      )
        ? null
        : 'place search returned no results array',
    };
  }

  if (tool === 'get_route') {
    return {
      valid:
        Number.isFinite(
          result.distance_km,
        ) &&
        Number.isFinite(
          result.duration_minutes,
        ),
      reason:
        'route response lacks a numeric distance or duration',
    };
  }

  return {
    valid: true,
    reason: null,
  };
}