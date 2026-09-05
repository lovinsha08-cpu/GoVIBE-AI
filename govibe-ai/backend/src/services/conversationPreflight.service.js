/**
 * Deterministic conversational preflight and routing boundary.
 *
 * This is the single routing gate for high-confidence conversational actions.
 * It consumes the canonical conversation context built by conversationContext
 * when available, while retaining the older state extractor as a compatibility
 * fallback for callers/tests that do not provide it.
 */
import { getFunctionHandler } from './assistantFunctions.service.js';
import { getOrCreateConversation, appendMessage } from './memory.service.js';
import { buildTripFromConversation, formatGeneratedTripReply } from './chatTripPlanner.service.js';
import { buildConversationState, isBareDate, isCurrentLocationStatement, isExplicitWeatherRequest, isPlanningRequest, missingPlanningData } from './conversationState.service.js';
import { buildConversationContext } from './conversationContext.service.js';
import { searchWeb } from './webSearch.service.js';

const NAMED_NEARBY_RE = /\b(?:restaurants?|caf(?:e|es)|hotels?|resorts?|parks?|gardens?|botanical gardens?|beaches?|museums?|shopping|shops?|hospitals?|pharmacies?|atms?|petrol pumps?|activities?|places?)\b[\s\S]*?\b(?:near|around|by|close to)\s+([^?.!]+?)(?:[?.!]*)$/i;
const CATEGORY_LOCATION_RE = /\b(?:in|at)\s+([A-Za-z][A-Za-z0-9 .,'&-]{1,60})\s*[?.!]?$/i;
const CATEGORY_NEAR_RE = /\b(?:near|around|by|close to)\s+([A-Za-z][A-Za-z0-9 .,'&-]{1,60})\s*[?.!]?$/i;
const LOCATION_SUFFIX_RE = /^\s*(?:in|at|around|near)\s+([A-Za-z][A-Za-z0-9 .,'&-]{1,60})[.!]?\s*$/i;

function cleanPlace(value) {
  return String(value || '')
    .replace(/\b(?:please|pls|now|today|tomorrow)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[,.]+$/, '');
}

function lastUserText(history) {
  return [...(history || [])].reverse().find((m) => m?.role === 'user')?.content || '';
}

function allUserText(history, current = '') {
  return [...(history || []), { role: 'user', content: current }]
    .filter((m) => m?.role === 'user')
    .map((m) => String(m.content || ''))
    .join(' ');
}

function previousCategory(history, state) {
  if (state?.category) return state.category;
  for (const turn of [...(history || [])].reverse()) {
    if (turn?.role !== 'user') continue;
    const text = String(turn.content || '').toLowerCase();
    if (/\brestaurant|cafe|food|eat|dining\b/.test(text)) return 'restaurants';
    if (/\bpark|garden|botanical|nature|green space|jogging\b/.test(text)) return 'parks and botanical gardens';
    if (/\bhotel|stay|resort|accommodation\b/.test(text)) return 'hotels';
    if (/\bmuseum|heritage|history|culture\b/.test(text)) return 'museums';
  }
  return null;
}

function categoryFromText(text) {
  const lower = String(text || '').toLowerCase();
  if (/\brestaurant|restaurants|cafe|cafes|food|eat|dining\b/.test(lower)) return 'restaurants';
  if (/\bbotanical garden|garden|gardens|park|jogging|nature|green space\b/.test(lower)) return 'parks and botanical gardens';
  if (/\bhotel|hotels|resort|resorts|stay|accommodation\b/.test(lower)) return 'hotels';
  if (/\bmuseum|museums|heritage|history|culture\b/.test(lower)) return 'museums';
  if (/\bhospital|hospitals\b/.test(lower)) return 'hospitals';
  if (/\bpharmacy|pharmacies\b/.test(lower)) return 'pharmacies';
  if (/\batm|atms\b/.test(lower)) return 'ATMs';
  if (/\bpetrol|fuel|gas station\b/.test(lower)) return 'petrol pumps';
  return null;
}

function previousNearbyPlace(history) {
  for (const turn of [...(history || [])].reverse()) {
    const text = String(turn?.content || '');
    if (turn?.role === 'user') {
      const direct = text.match(NAMED_NEARBY_RE);
      if (direct?.[1]) return cleanPlace(direct[1]);
      const near = text.match(CATEGORY_NEAR_RE);
      if (near?.[1] && categoryFromText(text)) return cleanPlace(near[1]);
    }
    if (turn?.role === 'assistant') {
      const listed = text.match(/(?:options near|near)\s+\*\*([^*]+)\*\*/i);
      if (listed?.[1]) return cleanPlace(listed[1]);
    }
  }
  return null;
}

function formatNearbyReply(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  if (!rows.length) return `I couldn't find any verified ${result?.resolved_category || 'places'} near ${result?.searched_near || 'that location'} right now.`;
  const lines = rows.slice(0, 8).map((r, i) => {
    const bits = [`${i + 1}. **${r.name}**`];
    if (r.distance_km != null) bits.push(`${Number(r.distance_km).toFixed(1)} km`);
    if (r.rating != null) bits.push(`⭐ ${r.rating}`);
    if (r.address) bits.push(r.address);
    if (r.is_govibe_partner) bits.push('GoVIBE partner');
    return bits.join(' · ');
  });
  return `Here are verified options near **${result.searched_near}**:\n\n${lines.join('\n')}`;
}

function formatWebFallbackReply({ query, near, answer, results }) {
  const rows = Array.isArray(results) ? results.filter((r) => r?.url).slice(0, 6) : [];
  if (!rows.length && !answer) return null;
  const lines = rows.map((r, i) => `${i + 1}. **${r.title || 'Web result'}** — ${r.content || 'See source'}\n   Source: ${r.url}`);
  const intro = `I couldn't get enough structured local data for **${query} near ${near}**, so I checked current web sources.`;
  return `${intro}${answer ? `\n\n${answer}` : ''}${lines.length ? `\n\n${lines.join('\n')}` : ''}\n\nI’ve kept these as web-sourced results rather than treating them as verified GoVIBE listings.`;
}

function stripInternalMarkup(text) {
  return String(text || '')
    .replace(/```(?:svg|xml)[\s\S]*?```/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/^\s*svg\s*$/gim, '')
    .replace(/^\s*(?:xml|<\?xml[^>]*>)\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function persistHandledTurn({ userId, role, message, reply, route, toolsUsed = [], sources = [] }) {
  if (!userId) return;
  try {
    const conversation = await getOrCreateConversation({ userId, role, tripId: null });
    if (conversation) {
      await appendMessage(conversation.id, { role: 'user', content: message, route });
      await appendMessage(conversation.id, { role: 'assistant', content: reply, route, toolsUsed, sources });
    }
  } catch {
    // Persistence is non-critical to the current turn.
  }
}

async function executeNearby({ userId, role, message, query, near, location = null }) {
  const handler = getFunctionHandler('find_nearby', role);
  if (!handler || !near) return null;

  try {
    const result = await handler(
      { query, near, radius_meters: 5000 },
      {
        userId,
        role,
        lat: location?.lat ?? null,
        lng: location?.lng ?? null,
      },
    );
    if (!result || result.error) return null;

    // The local/structured sources are always preferred. Only when they return
    // no results do we use Tavily as an evidence-backed fallback.
    if (Array.isArray(result.results) && result.results.length > 0) {
      const reply = stripInternalMarkup(formatNearbyReply(result));
      await persistHandledTurn({
        userId, role, message, reply,
        route: 'deterministic_nearby',
        toolsUsed: [{ name: 'find_nearby', args: { query, near, radius_meters: 5000 } }],
      });
      return {
        handled: true,
        reply,
        route: 'deterministic_nearby',
        toolsUsed: [{ name: 'find_nearby', args: { query, near, radius_meters: 5000 } }],
      };
    }

    const web = await searchWeb(`${query} near ${near}, Chennai`, { maxResults: 6, topic: 'general' });
    if (!web.error) {
      const webReply = stripInternalMarkup(formatWebFallbackReply({
        query, near, answer: web.answer, results: web.results,
      }));
      if (webReply) {
        const sources = (web.results || []).map((r) => ({ type: 'web', title: r.title, url: r.url, source: r.source }));
        await persistHandledTurn({
          userId, role, message, reply: webReply,
          route: 'web_search_fallback',
          toolsUsed: [{ name: 'find_nearby', args: { query, near, radius_meters: 5000 } }, { name: 'web_search', args: { query: `${query} near ${near}, Chennai` } }],
          sources,
        });
        return {
          handled: true,
          reply: webReply,
          route: 'web_search_fallback',
          toolsUsed: [
            { name: 'find_nearby', args: { query, near, radius_meters: 5000 } },
            { name: 'web_search', args: { query: `${query} near ${near}, Chennai` } },
          ],
          sources,
        };
      }
    }

    const reply = stripInternalMarkup(formatNearbyReply(result));
    await persistHandledTurn({
      userId, role, message, reply,
      route: 'deterministic_nearby_empty',
      toolsUsed: [{ name: 'find_nearby', args: { query, near, radius_meters: 5000 } }],
    });
    return {
      handled: true,
      reply,
      route: 'deterministic_nearby_empty',
      toolsUsed: [{ name: 'find_nearby', args: { query, near, radius_meters: 5000 } }],
    };
  } catch {
    return null;
  }
}

async function handlePlanningTurn({ userId, role, message, state }) {
  if (isExplicitWeatherRequest(message) && !isPlanningRequest(message)) return null;
  const missing = missingPlanningData(state);
  if (missing.length) {
    const known = [];
    if (state.destination) known.push(`destination **${state.destination}**`);
    if (state.travelDate) known.push(`date **${state.travelDate}**`);
    if (state.duration) known.push(`duration **${state.duration}**`);
    if (state.budget) known.push(`budget **₹${state.budget}**`);
    if (state.origin || state.currentLocation) known.push(`starting point **${state.origin || state.currentLocation}**`);
    const reply = `${known.length ? `Got it — I have ${known.join(', ')}.` : 'Got it.'} To build the actual trip plan, I still need your **${missing.join(', ')}**.`;
    await persistHandledTurn({ userId, role, message, reply, route: 'deterministic_planning' });
    return { handled: true, reply, route: 'deterministic_planning', toolsUsed: [] };
  }
  const result = await buildTripFromConversation({ userId, state });
  const reply = stripInternalMarkup(result.ok ? formatGeneratedTripReply(result) : result.message);
  const route = result.ok ? 'conversation_trip_generation' : `conversation_trip_error:${result.code}`;
  await persistHandledTurn({ userId, role, message, reply, route });
  return result.ok
    ? { handled: true, reply, route, toolsUsed: [{ name: 'generate_conversational_itinerary', args: { trip_id: result.trip.id } }], itinerary: result.itinerary, trip: result.trip }
    : { handled: true, reply, route, toolsUsed: [] };
}

export async function runConversationPreflight({ userId, role, message, clientHistory = [], location = null, canonicalContext = null }) {
  const history = Array.isArray(clientHistory) ? clientHistory : [];
  const text = String(message || '').trim();
  if (!text) return null;

  const extractedState = buildConversationState(history, text);
  const canonical = canonicalContext || buildConversationContext(history, text, role);
  const state = {
    ...extractedState,
    currentLocation: canonical.location || extractedState.currentLocation,
    category: canonical.category || extractedState.category,
    activeTopic: canonical.category || extractedState.activeTopic,
    canonicalIntent: canonical.intent || null,
    searchLocation: canonical.location || null,
  };

  const planningContext = isPlanningRequest(text) || /\b(?:visit|travel|go to|trip)\b/i.test(allUserText(history, ''));

  if (isBareDate(text) && planningContext) {
    const reply = state.destination
      ? `Got it — I’ve updated your trip date to **${text.replace(/[.!]$/, '')}** for **${state.destination}**.`
      : `Got it — I’ve updated the trip date to **${text.replace(/[.!]$/, '')}**.`;
    await persistHandledTurn({ userId, role, message: text, reply, route: 'deterministic_date_update' });
    return { handled: true, reply, route: 'deterministic_date_update', toolsUsed: [] };
  }

  if (isCurrentLocationStatement(text)) {
    const place = state.currentLocation;
    const previous = lastUserText(history);
    if (previous && /\b(?:near|around|close to|nearby)\b/i.test(previous)) {
      const reply = `Got it — you’re currently in **${place}**. I’ll keep that as your current location and won’t replace the place you explicitly asked about.`;
      await persistHandledTurn({ userId, role, message: text, reply, route: 'deterministic_location_update' });
      return { handled: true, reply, route: 'deterministic_location_update', toolsUsed: [] };
    }
  }

  if (/\bnear there\b/i.test(text)) {
    const near = previousNearbyPlace(history) || canonical.location;
    const query = categoryFromText(text) || previousCategory(history, state);
    if (near && query) {
      const result = await executeNearby({ userId, role, message: text, query, near, location });
      if (result) return result;
    }
  }

  const namedMatch = text.match(NAMED_NEARBY_RE);
  if (namedMatch && cleanPlace(namedMatch[1]).toLowerCase() !== 'there') {
    const near = cleanPlace(namedMatch[1]);
    const query = categoryFromText(text) || previousCategory(history, state) || 'places';
    const result = await executeNearby({ userId, role, message: text, query, near, location });
    if (result) return result;
  }

  const category = categoryFromText(text);
  const inMatch = text.match(CATEGORY_LOCATION_RE);
  if (category && inMatch) {
    const near = cleanPlace(inMatch[1]);
    const result = await executeNearby({ userId, role, message: text, query: category, near, location });
    if (result) return result;
  }

  const categoryNearMatch = text.match(CATEGORY_NEAR_RE);
  if (category && categoryNearMatch && cleanPlace(categoryNearMatch[1]).toLowerCase() !== 'there') {
    const result = await executeNearby({ userId, role, message: text, query: category, near: cleanPlace(categoryNearMatch[1]), location });
    if (result) return result;
  }

  if (category && !isPlanningRequest(text) && !inMatch && !categoryNearMatch) {
    const near = canonical.location || previousNearbyPlace(history) || state.currentLocation || state.destination;
    if (near) {
      const result = await executeNearby({ userId, role, message: text, query: category, near, location });
      if (result) return result;
    }
  }

  const suffix = text.match(LOCATION_SUFFIX_RE);
  if (suffix) {
    const place = cleanPlace(suffix[1]);
    const topic = previousCategory(history, state);
    if (topic) {
      const result = await executeNearby({ userId, role, message: text, query: topic, near: place, location });
      if (result) return result;
    }
  }

  if (/\b(?:near me|nearby)\b/i.test(text)) {
    const near = state.currentLocation || canonical.location;
    const query = categoryFromText(text) || previousCategory(history, state);
    if (near && query) {
      const result = await executeNearby({ userId, role, message: text, query, near, location });
      if (result) return result;
    }
  }

  if (isPlanningRequest(text)) {
    const result = await handlePlanningTurn({ userId, role, message: text, state });
    if (result) return result;
  }

  return null;
}

export { stripInternalMarkup };