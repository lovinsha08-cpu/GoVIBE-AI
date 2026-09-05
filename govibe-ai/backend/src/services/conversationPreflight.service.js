/**
 * Deterministic conversation preflight.
 *
 * The LLM should answer nuanced questions, but a few intents are too
 * important to leave to probabilistic routing. This layer resolves obvious
 * follow-ups before the model sees the turn:
 *   - date-only corrections ("September 13")
 *   - named-place discovery ("restaurants near Elliot's Beach")
 *   - continuation location phrases ("in Chennai")
 *   - explicit current-location statements ("I am now in Velachery")
 *
 * It deliberately does NOT attempt full itinerary generation. It only
 * prevents deterministic misroutes and unnecessary clarification loops.
 */
import { getFunctionHandler } from './assistantFunctions.service.js';
import { geocodePlace } from './geocoding.service.js';
import { getOrCreateConversation, appendMessage } from './memory.service.js';

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DATE_ONLY_RE = new RegExp(`^\\s*(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\s*[.!]?\\s*$`, 'i');
const LOCATION_STATEMENT_RE = /^\\s*(?:i(?:'m| am)|we(?:'re| are))\\s+(?:now\\s+)?(?:in|at)\\s+(.+?)\\s*[.!]?\\s*$/i;
const NAMED_NEARBY_RE = /\\b(?:restaurants?|caf(?:e|es)|hotels?|resorts?|parks?|gardens?|botanical gardens?|beaches?|museums?|shopping|shops?|hospitals?|pharmacies?|atms?|petrol pumps?|activities?|places?)\\b[\\s\S]*?\\b(?:near|around|by|close to)\\s+([^?.!]+?)(?:[?.!]*)$/i;
const LOCATION_SUFFIX_RE = /^\\s*(?:in|at|around|near)\\s+([A-Za-z][A-Za-z0-9 .,'&-]{1,60})[.!]?\\s*$/i;

function cleanPlace(value) {
  return String(value || '')
    .replace(/\\b(?:please|pls|now|today|tomorrow)\\b/gi, '')
    .replace(/\\s+/g, ' ')
    .trim()
    .replace(/[,.]+$/, '');
}

function lastUserText(history) {
  return [...(history || [])].reverse().find((m) => m?.role === 'user')?.content || '';
}

function previousTopic(history) {
  const text = lastUserText(history).toLowerCase();
  if (/\\brestaurant|cafe|food|eat|dining\\b/.test(text)) return 'restaurants';
  if (/\\bpark|garden|botanical|nature|green space|jogging\\b/.test(text)) return 'nature';
  if (/\\bhotel|stay|resort|accommodation\\b/.test(text)) return 'hotels';
  if (/\\bmuseum|heritage|history|culture\\b/.test(text)) return 'museums';
  return null;
}

function isPlanningContext(history) {
  const text = (history || []).map((m) => m?.content || '').join(' ').toLowerCase();
  return /\\b(?:visit|trip|travel|plan|itinerary|go to|tour)\\b/.test(text);
}

function formatNearbyReply(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  if (!rows.length) {
    return `I couldn't find any verified ${result?.resolved_category || 'places'} near ${result?.searched_near || 'that location'} right now.`;
  }

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

function stripInternalMarkup(text) {
  return String(text || '')
    .replace(/```(?:svg|xml)[\\s\\S]*?```/gi, '')
    .replace(/<svg[\\s\\S]*?<\\/svg>/gi, '')
    .replace(/^\\s*svg\\s*$/gim, '')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
}

async function persistHandledTurn({ userId, role, message, reply, route }) {
  if (!userId) return;
  try {
    const conversation = await getOrCreateConversation({ userId, role, tripId: null });
    if (!conversation) return;
    await appendMessage(conversation.id, { role: 'user', content: message, route });
    await appendMessage(conversation.id, { role: 'assistant', content: reply, route });
  } catch {
    // Chat must remain usable even when optional persistence fails.
  }
}

async function executeNearby({ userId, role, message, query, near }) {
  const handler = getFunctionHandler('find_nearby', role);
  if (!handler) return null;
  try {
    const result = await handler({ query, near, radius_meters: 5000 }, { userId, role, lat: null, lng: null });
    if (!result || result.error) return null;
    const reply = formatNearbyReply(result);
    await persistHandledTurn({ userId, role, message, reply, route: 'deterministic_nearby' });
    return { handled: true, reply, route: 'deterministic_nearby', toolsUsed: [{ name: 'find_nearby', args: { query, near, radius_meters: 5000 } }] };
  } catch {
    return null;
  }
}

/**
 * Returns null when the normal LLM orchestrator should handle the turn.
 * Returns a response object when this layer can resolve the turn safely.
 */
export async function runConversationPreflight({ userId, role, message, clientHistory = [] }) {
  const history = Array.isArray(clientHistory) ? clientHistory : [];
  const text = String(message || '').trim();
  if (!text) return null;

  // 1) A bare date is a correction to the active trip date, never a weather
  // query. We intentionally keep the date textual so the model can preserve
  // the user's wording and resolve the year from the surrounding trip.
  if (DATE_ONLY_RE.test(text) && isPlanningContext(history)) {
    const previous = lastUserText(history);
    const destination = previous.match(/\\b(?:visit|visiting|trip to|go to|travel(?:ing|ling)? to)\\s+([^,.!?]+(?:,\\s*[^,.!?]+)?)/i)?.[1]?.trim();
    const reply = destination
      ? `Got it — I’ve updated your trip date to **${text.replace(/[.!]$/, '')}** for **${destination}**. I’ll use this date for the trip plan, not as a weather request.`
      : `Got it — I’ve updated the trip date to **${text.replace(/[.!]$/, '')}**.`;
    await persistHandledTurn({ userId, role, message: text, reply, route: 'deterministic_date_update' });
    return { handled: true, reply, route: 'deterministic_date_update', toolsUsed: [] };
  }

  // 2) Explicit named-place discovery must never require browser GPS.
  // Examples: "restaurants near Elliot's Beach", "parks near Guindy".
  const namedMatch = text.match(NAMED_NEARBY_RE);
  if (namedMatch) {
    const near = cleanPlace(namedMatch[1]);
    const query = text
      .replace(namedMatch[0], '')
      .replace(/\\b(?:near|around|by|close to)\\s+.*$/i, '')
      .trim();
    const normalizedQuery = query || previousTopic(history) || 'places';
    const result = await executeNearby({ userId, role, message: text, query: normalizedQuery, near });
    if (result) return result;
  }

  // 3) "in Chennai" / "in Velachery" should refine the immediately previous
  // discovery request instead of resetting the conversation.
  const suffix = text.match(LOCATION_SUFFIX_RE);
  if (suffix) {
    const place = cleanPlace(suffix[1]);
    const topic = previousTopic(history);
    if (topic) {
      const result = await executeNearby({ userId, role, message: text, query: topic, near: place });
      if (result) return result;
    }
  }

  // 4) A current-location statement is useful state, but it should not erase
  // an explicit target from the preceding turn. For now acknowledge it and
  // let the next request use the same conversation context.
  const currentLocation = text.match(LOCATION_STATEMENT_RE);
  if (currentLocation) {
    const place = cleanPlace(currentLocation[1]);
    const previous = lastUserText(history);
    if (previous && /\\b(?:near|around|close to)\\b/i.test(previous)) {
      const reply = `Got it — you’re currently in **${place}**. I’ll keep that as your current location and won’t replace the place you explicitly asked about.`;
      await persistHandledTurn({ userId, role, message: text, reply, route: 'deterministic_location_update' });
      return { handled: true, reply, route: 'deterministic_location_update', toolsUsed: [] };
    }
  }

  return null;
}

export { stripInternalMarkup };
