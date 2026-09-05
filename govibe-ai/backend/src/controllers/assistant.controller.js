import { supabaseAdmin } from '../config/supabase.js';
import { generateAssistantReply, applyReorderDay } from '../services/assistant.service.js';
import { regenerateStop } from '../services/itineraryEngine.service.js';
import { orchestrateChat } from '../services/orchestrator.service.js';
import { getRecentMessages, getOrCreateConversation } from '../services/memory.service.js';
import { runConversationPreflight } from '../services/conversationPreflight.service.js';

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

function cleanAssistantReply(value) {
  return String(value || '')
    .replace(/```(?:svg|xml)[\\s\\S]*?```/gi, '')
    .replace(/<svg[\\s\\S]*?<\\/svg>/gi, '')
    .replace(/^\\s*svg\\s*$/gim, '')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();
}

// POST /api/assistant/chat  { trip_id?, message, history?, location? }
export async function chat(req, res, next) {
  try {
    const { trip_id, message, history, location } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    if (!trip_id) {
      const role = await detectUserRole(req.user);
      const clientHistory = Array.isArray(history) ? history : [];

      // Resolve high-confidence conversational follow-ups before probabilistic
      // routing. This is deliberately before orchestrateChat/classification.
      const preflight = await runConversationPreflight({
        userId: req.user?.id || null,
        role,
        message: message.trim(),
        clientHistory,
      });
      if (preflight?.handled) {
        return res.json({
          reply: cleanAssistantReply(preflight.reply),
          action: 'none',
          itinerary: null,
          role,
          route: preflight.route,
          toolsUsed: preflight.toolsUsed || [],
        });
      }

      const result = await orchestrateChat({
        userId: req.user?.id || null,
        role,
        message: message.trim(),
        clientHistory,
        location: location?.lat != null && location?.lng != null ? location : null,
      });

      return res.json({
        reply: cleanAssistantReply(result.reply),
        action: 'none',
        itinerary: null,
        role,
        route: result.route,
        toolsUsed: result.toolsUsed,
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
        reply: "I couldn't process that itinerary request right now. Please try again — your saved itinerary is unchanged.",
        action: 'none',
        itinerary: null,
      });
    }

    const { reply, action, stopOrder, day, newOrder } = assistantResult;

    if (action === 'none') {
      return res.json({ reply: cleanAssistantReply(reply), action: 'none', itinerary: null });
    }

    if (action === 'swap_stop') {
      if (!Number.isFinite(stopOrder)) {
        return res.json({ reply: cleanAssistantReply(reply), action: 'none', itinerary: null });
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

        return res.json({ reply: cleanAssistantReply(reply), action: 'swap_stop', itinerary: updated, replacedStop, previousStopName });
      } catch (swapErr) {
        return res.json({
          reply: `${cleanAssistantReply(reply)} (I wasn't able to make that swap: ${swapErr.message})`,
          action: 'none',
          itinerary: null,
        });
      }
    }

    if (action === 'reorder_day') {
      if (!Number.isFinite(day) || !Array.isArray(newOrder) || newOrder.length === 0) {
        return res.json({ reply: cleanAssistantReply(reply), action: 'none', itinerary: null });
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

        return res.json({ reply: cleanAssistantReply(reply), action: 'reorder_day', itinerary: updated });
      } catch (reorderErr) {
        return res.json({
          reply: `${cleanAssistantReply(reply)} (I wasn't able to make that change: ${reorderErr.message})`,
          action: 'none',
          itinerary: null,
        });
      }
    }

    return res.json({ reply: cleanAssistantReply(reply), action: 'none', itinerary: null });
  } catch (err) {
    next(err);
  }
}

export async function getHistory(req, res, next) {
  try {
    const role = await detectUserRole(req.user);
    const conversation = await getOrCreateConversation({ userId: req.user.id, role, tripId: null });
    if (!conversation) return res.json({ messages: [] });
    const messages = await getRecentMessages(conversation.id, 30);
    res.json({ messages: messages.map((m) => ({ role: m.role, content: cleanAssistantReply(m.content) })) });
  } catch (err) {
    next(err);
  }
}
