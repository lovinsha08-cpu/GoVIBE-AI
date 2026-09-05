/**
 * Deterministic conversation preflight.
 *
 * The LLM should answer nuanced questions, but a few high-confidence travel
 * intents should never be allowed to drift into weather, generic chat, or an
 * unnecessary "where are you?" question. This layer resolves those turns
 * before the model sees them.
 */
import { getFunctionHandler } from './assistantFunctions.service.js';
import { getOrCreateConversation, appendMessage } from './memory.service.js';

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DATE_ONLY_RE = new RegExp(`^\\s*(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\s*[.!]?\\s*$`, 'i');
const LOCATION_STATEMENT_RE = /^\\s*(?:i(?:'m| am)|we(?:'re| are))\\s+(?:now\\s+)?(?:in|at)\\s+(.+?)\\s*[.!]?\\s*$/i;
const NAMED_NEARBY_RE = /\\b(?:restaurants?|caf(?:e|es)|hotels?|resorts?|parks?|gardens?|botanical gardens?|beaches?|museums?|shopping|shops?|hospitals?|pharmacies?|atms?|petrol pumps?|activities?|places?)\\b[\\s\\S]*?\\b(?:near|around|by|close to)\\s+([^?.!]+?)(?:[?.!]*)$/i;
const IN_LOCATION_RE = /\\b(?:in|at)\\s+([A-Za-z][A-Za-z0-9 .,'&-]{1,60})\\s*[?.!]?$/i;
const LOCATION_SUFFIX_RE = /^\\s*(?:in|at|around|near)\\s+([A-Za-z][A-Za-z0-9 .,'&-]{1,60})[.!]?\\s*$/i;
const PLANNING_RE = /\\b(?:plan|planning|itinerary|trip plan|plan a trip|visit|travell?ing|go to)\\b/i;

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

function allUserText(history, current = '') {
  return [...(history || []), { role: 'user', content: current }]
    .filter((m) => m?.role === 'user')
    .map((m) => String(m.content || ''))
    .join(' ');
}

function previousTopic(history) {
  const text = lastUserText(history).toLowerCase();
  if (/\\brestaurant|cafe|food|eat|dining\\b/.test(text)) return 'restaurants';
  if (/\\bpark|garden|botanical|nature|green space|jogging\\b/.test(text)) return 'parks and botanical gardens';
  if (/\\bhotel|stay|resort|accommodation\\b/.test(text)) return 'hotels';
  if (/\\bmuseum|heritage|history|culture\\b/.test(text)) return 'museums';
  return null;
}

function categoryFromText(text) {
  const lower = text.toLowerCase();
  if (/\\brestaurant|restaurants|cafe|cafes|food|eat|dining\\b/.test(lower)) return 'restaurants';
  if (/\\bbotanical garden|garden|gardens|park|jogging|nature|green space\\b/.test(lower)) return 'parks and botanical gardens';
  if (/\\bhotel|hotels|resort|resorts|stay|accommodation\\b/.test(lower)) return 'hotels';
  if (/\\bmuseum|museums|heritage|history|culture\\b/.test(lower)) return 'museums';
  if (/\\bhospital|hospitals\\b/.test(lower)) return 'hospitals';
  if (/\\bpharmacy|pharmacies\\b/.test(lower)) return 'pharmacies';
  if (/\\batm|atms\\b/.test(lower)) return 'ATMs';
  if (/\\bpetrol|fuel|gas station\\b/.test(lower)) return 'petrol pumps';
  return null;
}

function currentLocationFromHistory(history) {
  for (const item of [...(history || [])].reverse()) {
    if (item?.role !== 'user') continue;
    const match = String(item.content || '').match(LOCATION_STATEMENT_RE);
    if (match) return cleanPlace(match[1]);
  }
  return null;
}

function isPlanningContext(history, current = '') {
  return PLANNING_RE.test(allUserText(history, current));
}

function extractDate(text) {
  const match = text.match(new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'i'));
  return match ? match[0].replace(/\\s+/g, ' ').trim() : null;
}

function extractDestination(text) {
  const match = text.match(/\\b(?:visit|visiting|trip\\s+to|go\\s+to|travel(?:ing|ling)?\\s+to|plan(?:\\s+my)?\\s+(?:a\\s+)?trip\\s+to)\\s+([^,.!?]+(?:,\\s*[^,.!?]+)?)/i);
  if (!match?.[1]) return null;
  return cleanPlace(match[1].replace(/\\s+(?:on|for|under|with|and)\\s+.*$/i, ''));
}

function hasBudget(text) {
  return /(?:budget|under|below|within|around)\\s*(?:rs\\.?|inr|₹)?\\s*\\d{3,7}/i.test(text);
}

function hasDuration(text) {
  return /\\b\\d{1,2}\\s*[- ]?(?:day|days|night|nights)\\b/i.test(text);
}

function hasOrigin(text) {
  return /\\bfrom\\s+[^,.!?]+\\s+to\\s+[^,.!?]+/i.test(text) || /\\b(?:starting|start)\\s+(?:from|at)\\s+/i.test(text);
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
    // Persistence is helpful but must never make chat fail.
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

async function handlePlanningTurn({ userId, role, message, history }) {
  const combined = allUserText(history, message);
  const destination = extractDestination(combined);
  const travelDate = extractDate(combined);
  if (!destination && !travelDate) return null;

  const missing = [];
  if (!destination) missing.push('destination');
  if (!travelDate) missing.push('travel date');
  if (!hasDuration(combined)) missing.push('trip duration');
  if (!hasBudget(combined)) missing.push('budget');
  if (!hasOrigin(combined)) missing.push('starting location');

  // If the user only supplied destination/date, do not fake an itinerary.
  // Ask for the minimum missing inputs required by the real trip schema.
  if (missing.length) {
    const known = [];
    if (destination) known.push(`destination **${destination}**`);
    if (travelDate) known.push(`date **${travelDate}**`);
    const reply = `Got it — I have ${known.join(' and ')}. To build the actual trip plan, I still need your **${missing.join(', ')}**.`;
    await persistHandledTurn({ userId, role, message, reply, route: 'deterministic_planning' });
    return { handled: true, reply, route: 'deterministic_planning', toolsUsed: [] };
  }

  return null;
}

/** Returns null when the normal LLM orchestrator should handle the turn. */
export async function runConversationPreflight({ userId, role, message, clientHistory = [] }) {
  const history = Array.isArray(clientHistory) ? clientHistory : [];
  const text = String(message || '').trim();
  if (!text) return null;

  // 1) Bare date = correction to the active trip date, never weather.
  if (DATE_ONLY_RE.test(text) && isPlanningContext(history)) {
    const combined = allUserText(history, '');
    const destination = extractDestination(combined);
    const reply = destination
      ? `Got it — I’ve updated your trip date to **${text.replace(/[.!]$/, '')}** for **${destination}**. I’ll use this as the trip date.`
      : `Got it — I’ve updated the trip date to **${text.replace(/[.!]$/, '')}**.`;
    await persistHandledTurn({ userId, role, message: text, reply, route: 'deterministic_date_update' });
    return { handled: true, reply, route: 'deterministic_date_update', toolsUsed: [] };
  }

  // 2) Explicit named-place discovery never requires browser GPS.
  const namedMatch = text.match(NAMED_NEARBY_RE);
  if (namedMatch) {
    const near = cleanPlace(namedMatch[1]);
    const query = categoryFromText(text) || previousTopic(history) || 'places';
    const result = await executeNearby({ userId, role, message: text, query, near });
    if (result) return result;
  }

  // 3) Broad discovery: "nature places in Chennai", "restaurants in Chennai".
  const category = categoryFromText(text);
  const inMatch = text.match(IN_LOCATION_RE);
  if (category && inMatch) {
    const near = cleanPlace(inMatch[1]);
    const result = await executeNearby({ userId, role, message: text, query: category, near });
    if (result) return result;
  }

  // 4) A short location refinement continues the previous discovery intent.
  const suffix = text.match(LOCATION_SUFFIX_RE);
  if (suffix) {
    const place = cleanPlace(suffix[1]);
    const topic = previousTopic(history);
    if (topic) {
      const result = await executeNearby({ userId, role, message: text, query: topic, near: place });
      if (result) return result;
    }
  }

  // 5) "restaurants near me" can use a location previously stated in chat.
  if (/\\b(?:near me|nearby)\\b/i.test(text)) {
    const rememberedPlace = currentLocationFromHistory(history);
    const query = categoryFromText(text) || previousTopic(history);
    if (rememberedPlace && query) {
      const result = await executeNearby({ userId, role, message: text, query, near: rememberedPlace });
      if (result) return result;
    }
  }

  // 6) Current-location statement should not erase a previously explicit target.
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

  // 7) Planning requests are handled last so discovery questions containing
  // words like "visit" don't get swallowed. This prevents destination/date
  // statements from ever being interpreted as weather requests.
  if (PLANNING_RE.test(text)) {
    const result = await handlePlanningTurn({ userId, role, message: text, history });
    if (result) return result;
  }

  return null;
}

export { stripInternalMarkup };
