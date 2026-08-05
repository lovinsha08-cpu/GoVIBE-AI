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
 *   4. Function calling     — Gemini is given the traveler/business tool set
 *                              (assistantFunctions.service.js) and decides
 *                              which real backend function(s) to call
 *                              (requirement 5) — including calling several
 *                              in one turn ("multiple tools together").
 *   5. General reasoning    — if Gemini calls no tools, it just answers
 *                              conversationally, grounded by the RAG context
 *                              and conversation memory.
 *
 * This module is intentionally the ONLY place that talks to Gemini for the
 * general ("ask anything") assistant — assistant.service.js keeps its
 * existing trip-scoped swap/reorder logic untouched and only delegates here
 * for the no-trip-context path, preserving all current functionality.
 */
import { callGeminiWithTools } from './ai.service.js';
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
  const faqMatch = await findFaqMatch(message, role);
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
  const kbChunks = await retrieveKbContext(message, { audience: role, city: memory?.home_city || null, limit: 5 });
  const kbContext = formatKbContext(kbChunks);

  // ---- Step 4/5: function calling + reasoning ----
  const systemInstruction = buildSystemInstruction({ role, memory, kbContext, location });
  const tools = getFunctionDeclarations(role);
  const contents = [...historyToGeminiContents(history), { role: 'user', parts: [{ text: message }] }];

  const toolsUsed = [];
  let round = 0;
  let finalText = null;

  while (round < MAX_FUNCTION_CALL_ROUNDS) {
    const result = await callGeminiWithTools({ contents, systemInstruction, tools, maxOutputTokens: 700, temperature: 0.5, timeoutMs: 15000 });
    if (!result) break; // Gemini unavailable — fall through to the generic fallback below

    if (!result.functionCalls?.length) {
      finalText = result.text;
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
      responseParts.push({ functionResponse: { name: call.name, response } });
    }
    contents.push({ role: 'user', parts: responseParts });
    round += 1;
  }

  const reply = finalText
    || (toolsUsed.length
      ? "I found some information but had trouble putting together a reply — please try asking again."
      : "I can't reach the assistant right now — try again in a moment.");

  const route = toolsUsed.length ? (toolsUsed.length > 1 || classification.type === 'multi_tool' ? 'multi_tool' : 'api_or_db') : (kbChunks.length ? 'rag' : 'llm');

  if (conversation) {
    await appendMessage(conversation.id, {
      role: 'assistant', content: reply, route, toolsUsed,
      sources: kbChunks.map((c) => ({ type: 'kb', title: c.title, source: c.source })),
    });
  }

  return { reply, route, toolsUsed, sources: kbChunks };
}