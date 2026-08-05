import { supabaseAdmin } from '../config/supabase.js';
import { generateAssistantReply, applyReorderDay } from '../services/assistant.service.js';
import { regenerateStop } from '../services/itineraryEngine.service.js';
import { orchestrateChat } from '../services/orchestrator.service.js';
import { getRecentMessages, getOrCreateConversation } from '../services/memory.service.js';

// Detects whether the logged-in user is a traveler or a business (requirement
// 2). Authoritative source is which profile table actually has a row for
// this auth user — falls back to the `role` set at signup time
// (req.user.user_metadata.role, see auth.controller.js) if neither table
// has a row yet (e.g. mid-signup race). Defaults to 'traveler'.
async function detectUserRole(user) {
  if (!user) return 'traveler';
  const [{ data: traveler }, { data: business }] = await Promise.all([
    supabaseAdmin.from('travelers').select('id').eq('id', user.id).maybeSingle(),
    supabaseAdmin.from('businesses').select('id').eq('id', user.id).maybeSingle(),
  ]);
  if (business) return 'business';
  if (traveler) return 'traveler';
  return user.user_metadata?.role === 'business' ? 'business' : 'traveler';
}

// POST /api/assistant/chat  { trip_id?, message, history? }
// trip_id is OPTIONAL. When provided, the assistant is scoped to that
// trip's itinerary and can take actions (swap a stop, reorder a day).
// When omitted — e.g. the general "ask anything" assistant on the
// traveler/business dashboards, which isn't tied to any one trip — it
// just answers conversationally with no trip context and no actions.
//
// history is an optional array of { role: 'user'|'assistant', content }
// from earlier turns in this chat session — the frontend keeps it in
// memory and echoes it back so the assistant has short-term context
// without needing a new chat-messages table.
export async function chat(req, res, next) {
  try {
    const { trip_id, message, history, location } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    // No trip_id — general "ask anything" assistant, no trip/itinerary to
    // load. This is now the full AI orchestration layer: role detection,
    // FAQ short-circuit, RAG grounding, and function calling against real
    // backend data (requirements 2–10) — instead of a single direct Gemini
    // call. `location` is optional { lat, lng } from the browser's
    // geolocation, used for "near me" and emergency-services queries.
    if (!trip_id) {
      const role = await detectUserRole(req.user);
      const result = await orchestrateChat({
        userId: req.user?.id || null,
        role,
        message: message.trim(),
        location: location?.lat != null && location?.lng != null ? location : null,
      });

      return res.json({
        reply: result.reply,
        action: 'none',
        itinerary: null,
        role,
        route: result.route,          // which orchestration path answered (faq | rag | api_or_db | multi_tool | llm)
        toolsUsed: result.toolsUsed,  // real backend functions invoked this turn, for UI transparency
      });
    }

    const { data: trip, error: tripError } = await supabaseAdmin
      .from('trips')
      .select('*')
      .eq('id', trip_id)
      .eq('traveler_id', req.user.id)
      .single();
    if (tripError || !trip) return res.status(404).json({ error: 'Trip not found' });

    const { data: itinerary, error: itinError } = await supabaseAdmin
      .from('itineraries')
      .select('*')
      .eq('trip_id', trip_id)
      .order('version', { ascending: false })
      .limit(1)
      .single();
    if (itinError || !itinerary) return res.status(404).json({ error: 'No itinerary found for this trip yet — generate one first.' });

    const assistantResult = await generateAssistantReply({
      trip, stops: itinerary.stops || [], message: message.trim(), history,
    });

    if (!assistantResult) {
      return res.json({
        reply: "I can't reach the assistant right now — try again in a moment. In the meantime you can swap or regenerate stops directly from the itinerary view.",
        action: 'none',
        itinerary: null,
      });
    }

    const { reply, action, stopOrder, day, newOrder } = assistantResult;

    // "none" — just a conversational answer, nothing to save.
    if (action === 'none') {
      return res.json({ reply, action: 'none', itinerary: null });
    }

    if (action === 'swap_stop') {
      if (!Number.isFinite(stopOrder)) {
        return res.json({ reply, action: 'none', itinerary: null });
      }
      try {
        const { stops, replacedStop, previousStopName } = await regenerateStop(trip, itinerary, stopOrder);
        const { data: updated, error: updateError } = await supabaseAdmin
          .from('itineraries')
          .update({ stops })
          .eq('id', itinerary.id)
          .select()
          .single();
        if (updateError) return res.status(400).json({ error: updateError.message });

        return res.json({ reply, action: 'swap_stop', itinerary: updated, replacedStop, previousStopName });
      } catch (swapErr) {
        // A bad/unavailable swap shouldn't break the chat — surface it conversationally.
        return res.json({
          reply: `${reply} (I wasn't able to make that swap: ${swapErr.message})`,
          action: 'none',
          itinerary: null,
        });
      }
    }

    if (action === 'reorder_day') {
      if (!Number.isFinite(day) || !Array.isArray(newOrder) || newOrder.length === 0) {
        return res.json({ reply, action: 'none', itinerary: null });
      }
      try {
        const stops = applyReorderDay(itinerary.stops || [], day, newOrder);
        const { data: updated, error: updateError } = await supabaseAdmin
          .from('itineraries')
          .update({ stops })
          .eq('id', itinerary.id)
          .select()
          .single();
        if (updateError) return res.status(400).json({ error: updateError.message });

        return res.json({ reply, action: 'reorder_day', itinerary: updated });
      } catch (reorderErr) {
        return res.json({
          reply: `${reply} (I wasn't able to make that change: ${reorderErr.message})`,
          action: 'none',
          itinerary: null,
        });
      }
    }

    // Unknown action value — treat as a plain reply.
    return res.json({ reply, action: 'none', itinerary: null });
  } catch (err) {
    next(err);
  }
}

// GET /api/assistant/history — restores the general assistant's persisted
// conversation (requirement 11: "conversation history") so a page reload
// or a new device doesn't lose context. Trip-scoped chats intentionally
// stay session-only (frontend-held `history`), matching existing behavior.
export async function getHistory(req, res, next) {
  try {
    const role = await detectUserRole(req.user);
    const conversation = await getOrCreateConversation({ userId: req.user.id, role, tripId: null });
    if (!conversation) return res.json({ messages: [] });
    const messages = await getRecentMessages(conversation.id, 30);
    res.json({ messages: messages.map((m) => ({ role: m.role, content: m.content })) });
  } catch (err) {
    next(err);
  }
}