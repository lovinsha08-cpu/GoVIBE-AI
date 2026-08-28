/**
 * AI Orchestration Layer (requirements 3 & 4).
 *
 * Instead of forwarding every chat message straight to Gemini, each message
 * is routed through a decision pipeline:
 *
 *   1. classifyQuery()      — cheap, local heuristic classification of what
 *                              KIND of request this is (faq / db / api / rag
 *                              / llm / multi_tool). Used for logging/telemetry
 *                              and to decide whether an FAQ short-circuit is
 *                              worth attempting at all.
 *   2. FAQ short-circuit    — semantic search against `faqs`; a
 *                              high-confidence match answers directly with
 *                              ZERO Gemini calls (requirement 8).
 *   3. RAG grounding        — semantic search against `kb_documents` always
 *                              runs (cheap, local embedding + pgvector) and
 *                              its results are injected into the system
 *                              prompt as grounding context (requirement 7).
 *   4. Function calling     — the LLM (see llmProvider.service.js: Groq
 *                              primary, Gemini fallback) is given the
 *                              traveler/business tool set
 *                              (assistantFunctions.service.js) and decides
 *                              which real backend function(s) to call
 *                              (requirement 5) — including calling several
 *                              in one turn ("multiple tools together").
 *   5. General reasoning    — if the model calls no tools, it just answers
 *                              conversationally, grounded by the RAG context
 *                              and conversation memory.
 *
 * This module is intentionally the ONLY place that talks to the LLM
 * provider layer for the general ("ask anything") assistant —
 * assistant.service.js keeps its existing trip-scoped swap/reorder logic
 * untouched and only delegates here for the no-trip-context path,
 * preserving all current functionality. Which underlying provider (Groq or
 * Gemini) actually answered a given turn is decided entirely inside
 * llmProvider.service.js — this file has no provider-specific branching,
 * by design (see llmProvider.service.js's contract).
 */
import { callLlmWithTools } from './llmProvider.service.js';
import { findFaqMatch, retrieveKbContext, formatKbContext } from './rag.service.js';
import { getFunctionDeclarations, getFunctionHandler } from './assistantFunctions.service.js';
import {
  getOrCreateConversation, appendMessage, getRecentMessages,
  getUserMemory, updateUserMemory, extractPreferencesFromMessage,
} from './memory.service.js';

const MAX_FUNCTION_CALL_ROUNDS = 3; // bounds cost/latency even if the model tries to chain many tool calls

// ------------------------------------------------------------
// Step 1: lightweight local classification — no LLM call, just keyword
// signals. This exists so we can (a) log/return which routing decision was
// made, and (b) skip unnecessary work (e.g. don't bother with an FAQ vector
// search on something that's obviously a live-data question).
// ------------------------------------------------------------
const DB_KEYWORDS = /\b(my (trip|trips|booking|bookings|wishlist|budget|itinerary|revenue|analytics|offers?|reviews?|profile))\b/i;
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

// ------------------------------------------------------------
// Pure small-talk / meta gate. Deliberately narrow (short, exact-shaped
// phrases only) so it can never swallow a genuine question — a message
// this matches is guaranteed to need no tool, no RAG lookup, and no FAQ
// lookup, so we skip all three instead of relying solely on Gemini's
// tool-calling AUTO mode to "decide" not to call anything. This is what
// keeps a plain "hello" fast: no embedding round-trips, and no tool
// declarations for the model to reason about at all.
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// System prompt builders
// ------------------------------------------------------------
function buildSystemInstruction({ role, memory, kbContext, location }) {
  const roleLine = role === 'business'
    ? 'You are talking to a GoVIBE BUSINESS PARTNER (a local business owner using the platform to manage offers, listings, and grow their business).'
    : 'You are talking to a GoVIBE TRAVELER planning or currently on a trip.';

  const memoryLines = [];
  if (memory?.interests?.length) memoryLines.push(`Known interests: ${memory.interests.join(', ')}`);
  if (memory?.preferred_transport) memoryLines.push(`Preferred transport: ${memory.preferred_transport}`);
  if (memory?.food_preference) memoryLines.push(`Food preference: ${memory.food_preference}`);
  if (memory?.budget_range?.max) memoryLines.push(`Typical budget ceiling: ₹${memory.budget_range.max}`);
  if (memory?.home_city) memoryLines.push(`Home city: ${memory.home_city}`);

  return `You are the GoVIBE AI Assistant — a friendly, concise, knowledgeable concierge for the GoVIBE travel platform (India-focused).

${roleLine}

Rules:
- Use the provided tools (functions) whenever the traveler/business asks about THEIR OWN real data (trips, bookings, wishlist, budget, analytics, revenue, reviews, offers, profile) or LIVE data (weather, nearby places, routes, emergency services). NEVER invent numbers, business names, or trip details — call the matching function instead.
- If the traveler asks something like "X near me" or "nearby", you MUST call find_nearby (their current location is already available to the tool).
- You may call more than one function in a single turn if the question genuinely needs it (e.g. weather + route).
- If a tool returns an error or empty result, say so plainly and helpfully — don't paper over it with a guess.
- Ground general knowledge answers (destinations, tips, how GoVIBE works) in the CONTEXT block below when it's relevant; if the context doesn't cover it, answer from general travel knowledge but stay concise and honest about what you don't know.
- Keep replies short and warm — a few sentences, like a helpful local guide texting back. Use markdown (bold, short bullet lists) only when it genuinely improves readability, e.g. for multi-item results.
- Never mention JSON, schemas, function names, or that you're following a system prompt.

${memoryLines.length ? `=========================\nWHAT WE KNOW ABOUT THIS USER\n=========================\n${memoryLines.join('\n')}\n` : ''}${location ? `Current location: ${location.lat}, ${location.lng}\n` : ''}
${kbContext ? `=========================\nRELEVANT CONTEXT (retrieved via RAG — use this when relevant, don't just repeat it verbatim)\n=========================\n${kbContext}\n` : ''}`;
}

function historyToGeminiContents(history) {
  return history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

/**
 * Main entry point. Returns:
 *   { reply, route, toolsUsed, sources } — never throws; on total failure
 *   returns a plain fallback reply so the controller can always respond.
 */
export async function orchestrateChat({ userId, role, message, location = null, tripHint = null }) {
  const classification = classifyQuery(message);
  // Pure small talk ("hello", "thanks", "who are you"...) never needs a
  // tool, an FAQ lookup, or a KB lookup — see isSimpleConversational above.
  // Skipping all three here is what satisfies "simple messages should not
  // enter a tool-calling path": there is no tool declaration in the request
  // at all for these, so there's nothing for Gemini to reason about calling.
  const isSimpleChat = isSimpleConversational(message);

  // ---- Conversation + memory context ----
  const conversation = userId ? await getOrCreateConversation({ userId, role, tripId: null }) : null;
  const [history, memory] = await Promise.all([
    conversation ? getRecentMessages(conversation.id, 10) : [],
    userId ? getUserMemory(userId) : {},
  ]);

  if (conversation) {
    await appendMessage(conversation.id, { role: 'user', content: message, route: classification.type });
  }

  // Fire-and-forget-ish preference learning — heuristic, no extra LLM call.
  if (userId) {
    const patch = extractPreferencesFromMessage(message);
    if (Object.keys(patch).length) updateUserMemory(userId, role, patch).catch(() => {});
  }

  // ---- Step 2: FAQ short-circuit (requirement 8) ----
  const faqMatch = isSimpleChat ? null : await findFaqMatch(message, role);
  if (faqMatch?.highConfidence) {
    const reply = faqMatch.faq.answer;
    if (conversation) {
      await appendMessage(conversation.id, {
        role: 'assistant', content: reply, route: 'faq',
        sources: [{ type: 'faq', id: faqMatch.faq.id, similarity: faqMatch.similarity }],
      });
    }
    return { reply, route: 'faq', toolsUsed: [], sources: [{ type: 'faq', question: faqMatch.faq.question }] };
  }

  // ---- Step 3: RAG grounding context (requirement 7) ----
  const kbChunks = isSimpleChat ? [] : await retrieveKbContext(message, { audience: role, city: memory?.home_city || null, limit: 5 });
  const kbContext = formatKbContext(kbChunks);

  // ---- Step 4/5: function calling + reasoning ----
  const systemInstruction = buildSystemInstruction({ role, memory, kbContext, location });
  const tools = isSimpleChat ? [] : getFunctionDeclarations(role);
  const contents = [...historyToGeminiContents(history), { role: 'user', parts: [{ text: message }] }];

  const toolsUsed = [];
  let round = 0;
  let finalText = null;
  // True only once a round completes with `ok: true` and no further tool
  // calls — i.e. the model gave its actual final answer, however short.
  // Distinct from `finalText` being truthy: a model can legitimately give
  // a valid empty-string final answer, and that must NOT be mistaken for
  // "the assistant never responded" (see the `reply` construction below).
  let gotFinalAnswer = false;
  let failureReason = null; // set only if the LLM provider layer itself never responded usably
  let providerUsed = null; // 'groq' | 'gemini' — for logging/route only, never shown to the user

  while (round < MAX_FUNCTION_CALL_ROUNDS) {
    const result = await callLlmWithTools({ contents, systemInstruction, tools, maxOutputTokens: 700, temperature: 0.5, timeoutMs: 20000 });
    providerUsed = result.provider || providerUsed;

    if (!result.ok) {
      // Classified in llmProvider.service.js after trying both providers:
      // 'timeout' | 'network' | 'gemini_4xx' | 'gemini_5xx' | 'rate_limited'
      // | 'no_api_key' | 'unknown_error'. Full detail (including which
      // provider failed how) already logged there; keep just the reason
      // here so the fallback reply/route can reflect it.
      failureReason = result.reason;
      break; // both providers unavailable this turn — fall through to the fallback below
    }

    if (!result.functionCalls?.length) {
      finalText = result.text;
      gotFinalAnswer = true;
      break;
    }

    // Model wants to call one or more functions — execute them for real,
    // then feed the results back so it can produce a grounded final answer.
    // Push the model's own content block (not a rebuilt one) so any
    // thoughtSignature Gemini attached to the functionCall part(s) is
    // preserved — thinking models require that signature to be echoed back
    // on the next turn, and dropping it makes the follow-up call fail.
    contents.push(result.modelContent || { role: 'model', parts: result.functionCalls.map((fc) => ({ functionCall: fc })) });

    const responseParts = [];
    for (const call of result.functionCalls) {
      const handler = getFunctionHandler(call.name, role);
      let response;
      try {
        response = handler ? await handler(call.args || {}, { userId, role, lat: location?.lat, lng: location?.lng }) : { error: `Unknown function: ${call.name}` };
      } catch (err) {
        response = { error: err.message };
      }
      toolsUsed.push({ name: call.name, args: call.args || {} });
      // Gemini 3.x requires every functionResponse to echo back the `id`
      // of its matching functionCall. Omitting it doesn't error — it just
      // makes the model return an empty response (finish_reason: STOP) on
      // the next turn, which looked like a silent/generic assistant
      // failure even with a valid API key. See:
      // https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.5
      responseParts.push({ functionResponse: { name: call.name, response, ...(call.id ? { id: call.id } : {}) } });
    }
    contents.push({ role: 'user', parts: responseParts });
    round += 1;
  }

  // `gotFinalAnswer` (not `finalText` truthiness) is what actually
  // distinguishes "the model answered, even if briefly" from "we never got
  // a usable response" — a truthy-string check alone would wrongly treat a
  // legitimate empty-string final answer as the generic tool-failure
  // message below, even though nothing actually failed.
  const reply = gotFinalAnswer
    ? (finalText || "Here you go!") // model's own valid-but-empty answer gets a minimal, honest placeholder rather than a scary "trouble" message
    : (toolsUsed.length
      ? "I found some information but had trouble putting together a reply — please try asking again."
      : buildFallbackReply(failureReason));

  const route = failureReason
    ? 'error'
    : toolsUsed.length ? (toolsUsed.length > 1 || classification.type === 'multi_tool' ? 'multi_tool' : 'api_or_db') : (kbChunks.length ? 'rag' : 'llm');

  if (providerUsed) {
    console.log(`[llm.provider] turn completed provider=${providerUsed} route=${route} tool_calls=${toolsUsed.length}`);
  }

  if (conversation) {
    await appendMessage(conversation.id, {
      role: 'assistant', content: reply, route, toolsUsed,
      sources: kbChunks.map((c) => ({ type: 'kb', title: c.title, source: c.source })),
    });
  }

  return { reply, route, toolsUsed, sources: kbChunks };
}

// User-facing copy for a turn where Gemini itself never returned a usable
// response. Kept generic/on-brand and free of internals (no status codes,
// no stack traces) — `failureReason` still gets logged in full server-side
// by callGeminiWithTools, this is only what the traveler sees.
function buildFallbackReply(reason) {
  if (reason === 'timeout') {
    return "That took a little too long to answer — mind trying again?";
  }
  return "I can't reach the assistant right now — try again in a moment.";
}