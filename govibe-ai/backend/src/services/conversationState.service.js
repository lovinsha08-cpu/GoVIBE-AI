/**
 * Canonical short-term conversational state for the GoVIBE assistant.
 * Deterministic extraction only; routing and generation consume this state.
 */
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
const DATE_RE = new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'i');

const INTERESTS = [
  'nature', 'beach', 'heritage', 'history', 'historical', 'culture', 'food', 'photography',
  'shopping', 'adventure', 'wildlife', 'museum', 'museums', 'spiritual', 'temple', 'temples',
  'church', 'nightlife', 'entertainment', 'park', 'parks', 'garden', 'gardens', 'jogging',
  'botanical garden', 'peaceful', 'scenic', 'hidden gems',
];

const CATEGORY_RULES = [
  [/\\b(?:restaurant|restaurants|cafe|cafes|food|dining|eat|eating)\\b/i, 'restaurants'],
  [/\\b(?:park|parks|garden|gardens|botanical garden|nature|green space|jogging)\\b/i, 'nature'],
  [/\\b(?:museum|museums|heritage|history|historical|culture)\\b/i, 'heritage'],
  [/\\b(?:beach|beaches)\\b/i, 'beaches'],
  [/\\b(?:hotel|hotels|resort|resorts|stay|accommodation)\\b/i, 'hotels'],
  [/\\b(?:shopping|shops?|mall|malls|market|markets)\\b/i, 'shopping'],
  [/\\b(?:hospital|hospitals|clinic|clinics)\\b/i, 'hospitals'],
  [/\\b(?:pharmacy|pharmacies|chemist|chemists)\\b/i, 'pharmacies'],
  [/\\b(?:atm|atms|cash)\\b/i, 'ATMs'],
  [/\\b(?:petrol|fuel|gas station)\\b/i, 'petrol pumps'],
];

function clean(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim().replace(/^[,.:;\\-]+|[,.:;\\-]+$/g, '');
}
function normalizeDate(value) { return clean(value).replace(/\\s+/g, ' '); }
function extractDate(text) { const m = String(text || '').match(DATE_RE); return m ? normalizeDate(m[0]) : null; }
function extractBudget(text) { const m = String(text || '').match(/\\b(?:budget|under|below|within|around)\\s*(?:rs\\.?|inr|₹)?\\s*(\\d{3,7})\\b/i); return m ? Number(m[1]) : null; }
function extractPeople(text) { const m = String(text || '').match(/\\b(?:for|with)\\s+(\\d{1,2})\\s+(?:people|persons?|travelers?|travellers?)\\b/i); return m ? Number(m[1]) : null; }
function extractDuration(text) { const m = String(text || '').match(/\\b(\\d{1,2})\\s*[- ]?(day|days|night|nights)\\b/i); return m ? `${m[1]} ${m[2]}` : null; }

function extractRoute(text) {
  const raw = String(text || '');
  const standard = raw.match(/\\bfrom\\s+(.+?)\\s+to\\s+(.+?)(?=[?.!]|$)/i);
  if (standard) return { origin: clean(standard[1]), destination: clean(standard[2]) };
  const reverse = raw.match(/\\b(?:reach|get to|go to|travel to)\\s+(.+?)\\s+from\\s+(.+?)(?=[?.!]|$)/i);
  if (reverse) return { origin: clean(reverse[2]), destination: clean(reverse[1]) };
  return null;
}

function extractDestination(text) {
  const raw = String(text || '');
  const match = raw.match(/\\b(?:visit|visiting|trip\\s+to|go\\s+to|travel(?:ing|ling)?\\s+to|plan(?:\\s+my)?\\s+(?:a\\s+)?trip\\s+to)\\s+([^,.!?]+(?:,\\s*[^,.!?]+)?)/i);
  if (!match?.[1]) return null;
  return clean(match[1].replace(/\\s+(?:on|for|under|within|around|with|and)\\s+.*$/i, ''));
}

function extractCurrentLocation(text) {
  const match = String(text || '').match(/^\\s*(?:i(?:'m| am)|we(?:'re| are))\\s+(?:now\\s+)?(?:in|at)\\s+(.+?)\\s*[.!]?\\s*$/i);
  return match ? clean(match[1]) : null;
}

function extractGenericLocation(text) {
  const raw = String(text || '');
  const match = raw.match(/\\b(?:in|at|near|around|by|close to)\\s+([A-Za-z][A-Za-z0-9 .,'&-]{1,60}?)(?=\\s*(?:[?.!]|$)|\\s+(?:for|with|under|below|within|today|tomorrow|please|suggest|find|show|recommend)\\b)/i);
  return match ? clean(match[1]) : null;
}
function extractCategory(text) { return CATEGORY_RULES.find(([re]) => re.test(String(text || '')))?.[1] || null; }
function extractInterests(text) { const lower = String(text || '').toLowerCase(); return INTERESTS.filter((interest) => lower.includes(interest)); }
function mergeFact(state, key, value) { if (value !== null && value !== undefined && value !== '') state[key] = value; }

export function buildConversationState(history = [], currentMessage = '') {
  const state = {
    destination: null, origin: null, currentLocation: null, travelDate: null,
    budget: null, people: null, duration: null, category: null, interests: [],
    activeTopic: null, lastUserMessage: null,
  };

  const turns = [...(Array.isArray(history) ? history : []), { role: 'user', content: currentMessage }];
  for (const turn of turns) {
    if (turn?.role !== 'user') continue;
    const text = clean(turn.content);
    if (!text) continue;
    state.lastUserMessage = text;

    const route = extractRoute(text);
    if (route) { mergeFact(state, 'origin', route.origin); mergeFact(state, 'destination', route.destination); }
    mergeFact(state, 'destination', extractDestination(text));
    mergeFact(state, 'currentLocation', extractCurrentLocation(text));
    mergeFact(state, 'travelDate', extractDate(text));
    mergeFact(state, 'budget', extractBudget(text));
    mergeFact(state, 'people', extractPeople(text));
    mergeFact(state, 'duration', extractDuration(text));
    mergeFact(state, 'category', extractCategory(text));

    const genericLocation = extractGenericLocation(text);
    // A discovery target ("restaurants near Elliot's Beach") is not a trip
    // destination. A category + "in Chennai" is, however, a useful locality.
    if (genericLocation && !extractCurrentLocation(text)) {
      const isNearbyDiscovery = /\\b(?:near|around|by|close to)\\b/i.test(text) && Boolean(extractCategory(text));
      if (!isNearbyDiscovery) state.destination = state.destination || genericLocation;
    }

    for (const interest of extractInterests(text)) if (!state.interests.includes(interest)) state.interests.push(interest);
  }

  state.activeTopic = state.category || state.interests.at(-1) || null;
  return state;
}

export function isBareDate(message) { return new RegExp(`^\\s*(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\s*[.!]?\\s*$`, 'i').test(String(message || '')); }
export function isCurrentLocationStatement(message) { return Boolean(extractCurrentLocation(message)); }
export function isExplicitWeatherRequest(message) { return /\\b(?:weather|forecast|rain|rainfall|temperature|humid(?:ity)?|sunny|cloudy)\\b/i.test(String(message || '')); }
// "visit/go/travel" are planning signals even when the user has not used
// the literal word "plan". This prevents those messages from being routed to
// weather/general-chat merely because they contain a future date.
export function isPlanningRequest(message) {
  return /\\b(?:plan|planning|itinerary|trip plan|plan a trip|travel plan|getaway|vacation|visit|visiting|go to|travel to|travelling to|traveling to)\\b/i.test(String(message || ''));
}
export function hasEnoughPlanningData(state) { return Boolean(state.destination && state.travelDate && state.duration && state.budget && (state.origin || state.currentLocation)); }
export function missingPlanningData(state) {
  const missing = [];
  if (!state.destination) missing.push('destination');
  if (!state.travelDate) missing.push('travel date');
  if (!state.duration) missing.push('trip duration');
  if (!state.budget) missing.push('budget');
  if (!state.origin && !state.currentLocation) missing.push('starting location');
  return missing;
}
export { extractCategory, extractCurrentLocation, extractDate, extractDestination, extractRoute };
