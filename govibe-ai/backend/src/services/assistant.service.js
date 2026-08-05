import { env } from '../config/env.js';
import { callGemini } from './ai.service.js';

// The assistant chat is deliberately scoped to a small, safe action set
// rather than letting the model free-form edit the itinerary JSON: every
// action it can take maps to a code path we already trust (regenerateStop
// for swaps, a plain array reorder for reordering). This keeps "ask it to
// reorder your day, swap a spot, or explain why a place was picked" (the
// promise made in the marketing copy) honest without letting a bad Gemini
// response corrupt someone's saved itinerary.

const ASSISTANT_SYSTEM_PROMPT = `You are the GoVIBE AI Trip Assistant — a friendly, concise travel concierge chatting with a traveler about their already-generated itinerary.

You can do three things:
1. Answer questions or explain why a stop was chosen (use the itinerary data given below — never invent details it doesn't contain).
2. Swap out a single stop for a different one in the same category, if the traveler asks to replace/change/swap a specific stop.
3. Reorder the stops within a single day, if the traveler asks to move something earlier/later or change the sequence of a day.

Rules:
- Only take action ("swap_stop" or "reorder_day") when the traveler's message clearly asks for that specific change. Anything else (questions, small talk, ambiguous requests) is "none" — just reply conversationally.
- For "swap_stop", set stop_order to the "order" number of the stop to replace. Only one stop can be swapped per message.
- For "reorder_day", set day to the day number, and new_order to the full list of "order" numbers for every stop in that day, in the traveler's requested sequence (it must contain exactly the same order numbers already in that day — you're resequencing, not adding or removing stops).
- If the request is ambiguous (e.g. they don't say which stop, or the requested stop/day doesn't exist in the data below), set action to "none" and ask a clarifying question in your reply instead of guessing.
- Keep "reply" short — 1-3 sentences, warm and specific, like a helpful local guide texting back.
- Never mention JSON, schemas, or that you're an AI model following instructions.

Respond ONLY with JSON matching the schema.`;

const ASSISTANT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    action: { type: 'string', enum: ['none', 'swap_stop', 'reorder_day'] },
    stop_order: { type: 'integer' },
    day: { type: 'integer' },
    new_order: { type: 'array', items: { type: 'integer' } },
  },
  required: ['reply', 'action'],
};

// Used when there's no trip_id — e.g. the general "ask anything" assistant
// on the dashboards, which isn't scoped to any one trip. No swap/reorder
// actions here since there's no itinerary to act on.
const GENERAL_ASSISTANT_SYSTEM_PROMPT = `You are the GoVIBE AI Travel Assistant — a friendly, concise travel concierge helping a traveler with general questions: destinations, budgets, hidden gems, itinerary ideas, or how to use the app.

Rules:
- Just answer conversationally. You have no specific trip or itinerary loaded, so don't reference one — if the traveler asks about "my trip" or "my itinerary" specifically, suggest they open the assistant from that trip's page instead.
- Keep "reply" short — a few sentences, warm and specific, like a helpful local guide texting back.
- Never mention JSON, schemas, or that you're an AI model following instructions.

Respond ONLY with JSON matching the schema.`;

const GENERAL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
  },
  required: ['reply'],
};

/** Trims each stop down to what the model actually needs to reason about — keeps the prompt small and avoids leaking unrelated internal fields. */
function summarizeStops(stops) {
  return (stops || []).map((s) => ({
    order: s.order,
    day: s.day,
    date: s.date,
    name: s.name,
    category: s.category,
    time: s.best_visit_time || null,
    rating: s.rating ?? null,
    entry_cost_inr: s.entry_cost_inr ?? null,
    reasoning: s.reasoning || null,
  }));
}

function buildAssistantPrompt({ trip, stops, message, history }) {
  const historyText = (history || [])
    .slice(-6) // last few turns only — enough context without bloating the prompt
    .map((turn) => `${turn.role === 'user' ? 'Traveler' : 'Assistant'}: ${turn.content}`)
    .join('\n');

  // No trip loaded — general assistant, skip the trip-context block entirely.
  if (!trip) {
    return `${GENERAL_ASSISTANT_SYSTEM_PROMPT}

${historyText ? `=========================\nRECENT CONVERSATION\n=========================\n${historyText}\n` : ''}
=========================
TRAVELER'S NEW MESSAGE
=========================
${message}`;
  }

  return `${ASSISTANT_SYSTEM_PROMPT}

=========================
TRIP CONTEXT
=========================
Destination: ${trip.destination}
Dates: ${trip.start_date} to ${trip.end_date}

Current itinerary (day, order = stop position, name, category):
${JSON.stringify(summarizeStops(stops))}

${historyText ? `=========================\nRECENT CONVERSATION\n=========================\n${historyText}\n` : ''}
=========================
TRAVELER'S NEW MESSAGE
=========================
${message}`;
}

/**
 * Asks Gemini for a chat reply + optional structured action. Returns null
 * (never throws) if no key is configured or the call/parse fails — the
 * controller falls back to a plain "assistant unavailable" reply in that case.
 * When `trip` is null (general assistant, no trip_id), no action is ever
 * returned — there's no itinerary to swap/reorder.
 */
export async function generateAssistantReply({ trip, stops, message, history }) {
  if (!env.geminiApiKey) return null;

  const prompt = buildAssistantPrompt({ trip, stops, message, history });
  const parsed = await callGemini({
    prompt,
    schema: trip ? ASSISTANT_RESPONSE_SCHEMA : GENERAL_RESPONSE_SCHEMA,
    maxOutputTokens: 400,
    temperature: 0.5,
    timeoutMs: 10000,
  });

  if (!parsed || typeof parsed.reply !== 'string') return null;

  return {
    reply: parsed.reply,
    action: parsed.action || 'none',
    stopOrder: Number.isFinite(parsed.stop_order) ? parsed.stop_order : null,
    day: Number.isFinite(parsed.day) ? parsed.day : null,
    newOrder: Array.isArray(parsed.new_order) ? parsed.new_order.filter(Number.isFinite) : null,
  };
}

/**
 * Applies a validated "reorder_day" action to a stops array: resequences
 * the given day's stops into the requested order and reassigns the global
 * 1-based `order` field across the whole itinerary so downstream code
 * (PDF export, the itinerary view, further regenerate/reorder calls) keeps
 * working off a clean, gapless sequence. Other days are left untouched.
 */
export function applyReorderDay(stops, day, newOrder) {
  const dayStops = stops.filter((s) => s.day === day);
  const otherStops = stops.filter((s) => s.day !== day);

  const currentOrders = new Set(dayStops.map((s) => s.order));
  const requestedOrders = new Set(newOrder);
  const sameSet = currentOrders.size === requestedOrders.size
    && [...currentOrders].every((o) => requestedOrders.has(o));
  if (!sameSet) {
    const err = new Error(`new_order must contain exactly the stops already in day ${day}.`);
    err.status = 400;
    throw err;
  }

  const byOrder = new Map(dayStops.map((s) => [s.order, s]));
  const reorderedDay = newOrder.map((o) => byOrder.get(o));

  // Rebuild the full itinerary in day order, splicing the resequenced day
  // back into its original position among the other days.
  const firstDayIndex = stops.findIndex((s) => s.day === day);
  const before = otherStops.filter((s) => stops.indexOf(s) < firstDayIndex);
  const after = otherStops.filter((s) => stops.indexOf(s) >= firstDayIndex);
  const rebuilt = [...before, ...reorderedDay, ...after];

  return rebuilt.map((s, i) => ({ ...s, order: i + 1 }));
}