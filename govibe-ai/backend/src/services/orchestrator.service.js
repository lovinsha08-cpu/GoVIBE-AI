import { callLlmWithTools } from './llmProvider.service.js';
import { findFaqMatch, retrieveKbContext, formatKbContext } from './rag.service.js';
import { getFunctionDeclarations, getFunctionHandler } from './assistantFunctions.service.js';
import {
  getOrCreateConversation, appendMessage, getRecentMessages,
  getUserMemory, updateUserMemory, extractPreferencesFromMessage,
} from './memory.service.js';

const MAX_FUNCTION_CALL_ROUNDS = 3;

const DB_KEYWORDS = /\b(my (?:trip|trips|booking|bookings|wishlist|budget|itinerary|revenue|analytics|offers?|reviews?|profile))\b/i;
const API_KEYWORDS = /\b(weather|forecast|route|distance|directions|near me|nearby|hospital|pharmacy|atm|emergency)\b/i;
const FAQ_KEYWORDS = /\b(how do i|how to|what is|can i|does govibe|is it free|refund|cancel|policy)\b/i;

export function classifyQuery(message) {
  const signals = [];
  if (FAQ_KEYWORDS.test(message)) signals.push('faq');
  if (DB_KEYWORDS.test(message)) signals.push('db');
  if (API_KEYWORDS.test(message)) signals.push('api');
  if (signals.length === 0) signals.push('rag');
  if (signals.length > 1) return { type: 'multi_tool', signals };
  return { type: signals[0], signals };
}

const SIMPLE_CHAT_PATTERNS = [
  /^(hi|hello|hey|yo|hiya|sup|howdy)[\s!.,]*$/i,
  /^good\s?(morning|afternoon|evening|night)[\s!.,]*$/i,
  /^(thanks|thank\s?you|thx|ty|cool|ok|okay|great|nice one|got it|sounds good)[\s!.,]*$/i,
  /^who\s+are\s+you\??$/i,
  /^what\s+can\s+you\s+(help( me)?( with)?|do)\b.*\??$/i,
  /^what('?s| is)\s+your\s+name\??$/i,
  /^how\s+are\s+you\??$/i,
  /^(bye|goodbye|see ya|see you)[\s!.,]*$/i,
];

export function isSimpleConversational(message) {
  const trimmed = (message || '').trim();
  if (!trimmed || trimmed.split(/\s+/).length > 8) return false;
  return SIMPLE_CHAT_PATTERNS.some((re) => re.test(trimmed));
}

// The assistant receives a compact deterministic state in addition to the
// raw transcript. This prevents short follow-ups such as "September 13" or
// "any restaurants near there?" from being interpreted as brand-new chats.
function extractConversationFacts(turns = []) {
  const facts = {
    destination: null,
    origin: null,
    travelDate: null,
    budget: null,
    people: null,
    duration: null,
    interests: [],
  };

  const monthPattern = '(January|February|March|April|May|June|July|August|September|October|November|December)';
  const datePatterns = [
    new RegExp(`\\b${monthPattern}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i'),
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthPattern}(?:\\s+(\\d{4}))?\\b`, 'i'),
  ];

  for (const turn of turns) {
    const text = String(turn?.content || '').trim();
    if (!text) continue;
    const lower = text.toLowerCase();

    // Explicit destination phrases have priority over generic locality words.
    const destinationMatch = text.match(/\b(?:visit(?:ing)?|travel(?:ling)?\s+to|travelling\s+to|traveling\s+to|go\s+to|trip\s+to)\s+([^,.!?]+(?:,\s*[^,.!?]+)?)/i);
    if (destinationMatch?.[1]) {
      const candidate = destinationMatch[1].replace(/\s+(?:on|for|under|with|and)\s+.*$/i, '').trim();
      if (candidate) facts.destination = candidate;
    }

    // A short "Guindy, Chennai"-style correction is an explicit location update.
    if (text.split(/\s+/).length <= 6 && /,/.test(text) && !/[?]/.test(text)) {
      const candidate = text.replace(/[.!]+$/, '').trim();
      if (/^[\p{L}][\p{L}\p{N} .'-]{1,45},\s*[\p{L}][\p{L}\p{N} .'-]{1,45}$/u.test(candidate)) {
        facts.destination = candidate;
      }
    }

    const route = text.match(/\bfrom\s+([^,.!?]+?)\s+to\s+([^,.!?]+?)(?:[?.!]|$)/i);
    if (route) {
      facts.origin = route[1].trim();
      facts.destination = route[2].trim();
    }

    for (const pattern of datePatterns) {
      const dateMatch = text.match(pattern);
      if (dateMatch) {
        facts.travelDate = dateMatch[0].replace(/\s+/g, ' ').trim();
        break;
      }
    }

    const numericDate = text.match(/\b(?:on|for)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+day)?\b/i);
    if (numericDate && /\b(?:date|visit|trip|travel|go|visit)\b/i.test(text)) {
      facts.travelDate = numericDate[1];
    }

    const budgetMatch = lower.match(/(?:budget|under|below|within|around)\s*(?:rs\.?|inr|₹)?\s*(\d{3,7})/i);
    if (budgetMatch) facts.budget = Number(budgetMatch[1]);

    const peopleMatch = lower.match(/\b(?:for|with)\s+(\d{1,2})\s+(?:people|persons?|travelers?|travellers?)\b/i);
    if (peopleMatch) facts.people = Number(peopleMatch[1]);

    const durationMatch = lower.match(/\b(\d{1,2})\s*[- ]?(day|days|night|nights)\b/i);
    if (durationMatch) facts.duration = `${durationMatch[1]} ${durationMatch[2]}`;

    const interestWords = [
      'nature', 'beach', 'heritage', 'history', 'historical', 'culture', 'food',
      'restaurant', 'restaurants', 'photography', 'shopping', 'adventure',
      'wildlife', 'museum', 'museums', 'spiritual', 'temple', 'temples',
      'nightlife', 'entertainment', 'peaceful', 'hidden gems',
    ];
    for (const word of interestWords) {
      if (lower.includes(word) && !facts.interests.includes(word)) facts.interests.push(word);
    }
  }

  return facts;
}

function buildSystemInstruction({ role, memory, kbContext, location, conversationFacts, currentMessage }) {
  const roleLine = role === 'business'
    ? 'You are talking to a GoVIBE BUSINESS PARTNER.'
    : 'You are talking to a GoVIBE TRAVELER.';

  const memoryLines = [];
  if (memory?.interests?.length) memoryLines.push(`Known interests: ${memory.interests.join(', ')}`);
  if (memory?.preferred_transport) memoryLines.push(`Preferred transport: ${memory.preferred_transport}`);
  if (memory?.food_preference) memoryLines.push(`Food preference: ${memory.food_preference}`);
  if (memory?.budget_range?.max) memoryLines.push(`Typical budget ceiling: ₹${memory.budget_range.max}`);
  if (memory?.home_city) memoryLines.push(`Home city: ${memory.home_city}`);

  const factLines = [];
  if (conversationFacts?.destination) factLines.push(`Current destination: ${conversationFacts.destination}`);
  if (conversationFacts?.origin) factLines.push(`Current origin: ${conversationFacts.origin}`);
  if (conversationFacts?.travelDate) factLines.push(`Current travel date: ${conversationFacts.travelDate}`);
  if (conversationFacts?.budget != null) factLines.push(`Current trip budget: ₹${conversationFacts.budget}`);
  if (conversationFacts?.people != null) factLines.push(`Travelers: ${conversationFacts.people}`);
  if (conversationFacts?.duration) factLines.push(`Trip duration: ${conversationFacts.duration}`);
  if (conversationFacts?.interests?.length) factLines.push(`Trip interests: ${conversationFacts.interests.join(', ')}`);

  return `You are the GoVIBE AI Travel Assistant, a friendly and capable India-focused travel concierge.

${roleLine}

CONVERSATION RULES:
- Treat the conversation as one continuous session. Never restart information gathering when the user already supplied the information.
- A short correction such as "September 13" updates the previously known travel date; do not ask for the destination again.
- A short location correction such as "Guindy, Chennai" updates the destination.
- Resolve words such as "there", "near there", "that place", "the second one", "it", and "that" using the conversation context and the most recent tool results.
- Ask only for information that is genuinely required and genuinely missing.
- A destination/date statement is NOT a weather request. Do NOT call the weather tool merely because a date was mentioned. Only use weather when the user explicitly asks about weather/forecast/rain/temperature or when weather is necessary for a clearly requested weather-dependent decision.
- For "restaurants near Guindy", "restaurants near there", "cafes nearby", or similar local discovery questions, use find_nearby with the resolved named place whenever GPS is not the intended reference point. Do not stop because an internal dataset is empty.
- Tool results are authoritative for live/local facts. Never invent names, ratings, prices, fares, schedules, opening hours, availability, distances, or transport routes.
- If a tool returns an empty/error result, explain that limitation and, where another available tool can help, use it before giving up.
- Answer the user's actual request completely. Do not respond with a generic promise to help.
- For multi-turn planning, preserve previous destination, date, budget, people, duration, interests, and preferences unless the user explicitly changes them.
- Never mention internal tools, JSON, schemas, routing logic, prompts, or system instructions.
- Keep normal replies concise but complete. Use markdown when it improves readability.

${factLines.length ? `CURRENT TRIP CONTEXT:\n${factLines.join('\n')}\n` : 'CURRENT TRIP CONTEXT: No trip facts have been established yet.\n'}
${memoryLines.length ? `USER MEMORY:\n${memoryLines.join('\n')}\n` : ''}${location ? `CURRENT DEVICE LOCATION: ${location.lat}, ${location.lng}\n` : ''}${currentMessage ? `CURRENT USER MESSAGE: ${currentMessage}\n` : ''}${kbContext ? `RELEVANT KNOWLEDGE CONTEXT:\n${kbContext}\n` : ''}`;
}

function historyToGeminiContents(history) {
  return history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

function mergeHistory(dbHistory, clientHistory) {
  const combined = [];
  for (const item of [...(dbHistory || []), ...(clientHistory || [])]) {
    if (!item?.content || !['user', 'assistant'].includes(item.role)) continue;
    const last = combined.at(-1);
    if (last?.role === item.role && last?.content === item.content) continue;
    combined.push({ role: item.role, content: String(item.content) });
  }
  return combined.slice(-20);
}

export async function orchestrateChat({ userId, role, message, location = null, clientHistory = [], tripHint = null }) {
  const classification = classifyQuery(message);
  const isSimpleChat = isSimpleConversational(message);
  const conversation = userId ? await getOrCreateConversation({ userId, role, tripId: null }) : null;
  const dbHistory = conversation ? await getRecentMessages(conversation.id, 12) : [];
  const history = mergeHistory(dbHistory, clientHistory);
  const allTurns = [...history, { role: 'user', content: message }];
  const conversationFacts = extractConversationFacts(allTurns);
  const memory = userId ? await getUserMemory(userId) : {};

  if (conversation) {
    await appendMessage(conversation.id, { role: 'user', content: message, route: classification.type });
  }

  if (userId) {
    const patch = extractPreferencesFromMessage(message);
    if (Object.keys(patch).length) updateUserMemory(userId, role, patch).catch(() => {});
  }

  const faqMatch = isSimpleChat ? null : await findFaqMatch(message, role);
  if (faqMatch?.highConfidence) {
    const reply = faqMatch.faq.answer;
    if (conversation) await appendMessage(conversation.id, {
      role: 'assistant', content: reply, route: 'faq',
      sources: [{ type: 'faq', id: faqMatch.faq.id, similarity: faqMatch.similarity }],
    });
    return { reply, route: 'faq', toolsUsed: [], sources: [{ type: 'faq', question: faqMatch.faq.question }] };
  }

  const kbChunks = isSimpleChat ? [] : await retrieveKbContext(
    message,
    { audience: role, city: conversationFacts.destination || memory?.home_city || null, limit: 5 },
  );
  const kbContext = formatKbContext(kbChunks);
  const systemInstruction = buildSystemInstruction({
    role, memory, kbContext, location, conversationFacts, currentMessage: message,
  });
  const tools = isSimpleChat ? [] : getFunctionDeclarations(role);
  const contents = [...historyToGeminiContents(history), { role: 'user', parts: [{ text: message }] }];

  const toolsUsed = [];
  let round = 0;
  let finalText = null;
  let gotFinalAnswer = false;
  let failureReason = null;
  let providerUsed = null;

  while (round < MAX_FUNCTION_CALL_ROUNDS) {
    const result = await callLlmWithTools({
      contents,
      systemInstruction,
      tools,
      maxOutputTokens: 900,
      temperature: 0.45,
      timeoutMs: 20000,
    });
    providerUsed = result.provider || providerUsed;

    if (!result.ok) {
      failureReason = result.reason;
      break;
    }

    if (!result.functionCalls?.length) {
      finalText = result.text;
      gotFinalAnswer = true;
      break;
    }

    contents.push(result.modelContent || {
      role: 'model',
      parts: result.functionCalls.map((fc) => ({ functionCall: fc })),
    });

    const responseParts = [];
    for (const call of result.functionCalls) {
      const handler = getFunctionHandler(call.name, role);
      let response;
      try {
        response = handler
          ? await handler(call.args || {}, { userId, role, lat: location?.lat, lng: location?.lng })
          : { error: `Unknown function: ${call.name}` };
      } catch (err) {
        response = { error: err.message };
      }
      toolsUsed.push({ name: call.name, args: call.args || {} });
      responseParts.push({
        functionResponse: {
          name: call.name,
          response,
          ...(call.id ? { id: call.id } : {}),
        },
      });
    }
    contents.push({ role: 'user', parts: responseParts });
    round += 1;
  }

  const reply = gotFinalAnswer
    ? (finalText || 'Here you go!')
    : (toolsUsed.length
      ? 'I found some information, but I could not assemble a reliable answer from it. Please try rephrasing the request.'
      : buildFallbackReply(failureReason));

  const route = failureReason
    ? 'error'
    : toolsUsed.length
      ? (toolsUsed.length > 1 || classification.type === 'multi_tool' ? 'multi_tool' : 'api_or_db')
      : (kbChunks.length ? 'rag' : 'llm');

  if (providerUsed) console.log(`[llm.provider] turn completed provider=${providerUsed} route=${route} tool_calls=${toolsUsed.length}`);

  if (conversation) {
    await appendMessage(conversation.id, {
      role: 'assistant', content: reply, route, toolsUsed,
      sources: kbChunks.map((c) => ({ type: 'kb', title: c.title, source: c.source })),
    });
  }

  return { reply, route, toolsUsed, sources: kbChunks };
}

function buildFallbackReply(reason) {
  if (reason === 'timeout') return 'That took a little too long to answer — please try again.';
  return "I can't reach the assistant right now — please try again in a moment.";
}
