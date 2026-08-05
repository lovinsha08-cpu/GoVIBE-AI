/**
 * Conversation persistence + long-term user memory (requirement 10).
 *
 * Two layers, on purpose:
 *   - chat_conversations/chat_messages: the actual transcript, used to
 *     rebuild short-term context for a session (and to let the frontend
 *     restore history after a reload).
 *   - user_memory: a small, durable "what we know about this person"
 *     record (interests, preferred transport, budget, food preference)
 *     that persists ACROSS conversations, not just within one.
 *
 * Every function degrades to a harmless no-op/empty-result when Supabase
 * isn't configured, so the assistant still works (just without persistence)
 * in a zero-setup dev environment.
 */
import { supabaseAdmin, isSupabaseConfigured } from '../config/supabase.js';

export async function getOrCreateConversation({ userId, role, tripId = null }) {
  if (!isSupabaseConfigured) return null;

  if (tripId) {
    const { data: existing } = await supabaseAdmin
      .from('chat_conversations')
      .select('*')
      .eq('user_id', userId)
      .eq('trip_id', tripId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return existing;
  } else {
    const { data: existing } = await supabaseAdmin
      .from('chat_conversations')
      .select('*')
      .eq('user_id', userId)
      .is('trip_id', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return existing;
  }

  const { data, error } = await supabaseAdmin
    .from('chat_conversations')
    .insert({ user_id: userId, role, trip_id: tripId, title: tripId ? 'Trip assistant' : 'GoVIBE AI assistant' })
    .select()
    .single();
  if (error) {
    console.error('[memory.service] failed to create conversation:', error.message);
    return null;
  }
  return data;
}

export async function appendMessage(conversationId, { role, content, route = null, toolsUsed = [], sources = [] }) {
  if (!isSupabaseConfigured || !conversationId) return null;
  const { error } = await supabaseAdmin.from('chat_messages').insert({
    conversation_id: conversationId, role, content, route,
    tools_used: toolsUsed, sources,
  });
  if (error) console.error('[memory.service] failed to append message:', error.message);
  await supabaseAdmin.from('chat_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
}

export async function getRecentMessages(conversationId, limit = 12) {
  if (!isSupabaseConfigured || !conversationId) return [];
  const { data, error } = await supabaseAdmin
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data.reverse();
}

export async function getUserMemory(userId) {
  if (!isSupabaseConfigured) return {};
  const { data } = await supabaseAdmin.from('user_memory').select('preferences').eq('user_id', userId).maybeSingle();
  return data?.preferences || {};
}

/** Shallow-merges `patch` into the user's stored preferences. */
export async function updateUserMemory(userId, role, patch) {
  if (!isSupabaseConfigured || !patch || Object.keys(patch).length === 0) return;
  const current = await getUserMemory(userId);
  const merged = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value)) {
      merged[key] = Array.from(new Set([...(current[key] || []), ...value]));
    } else {
      merged[key] = value;
    }
  }
  const { error } = await supabaseAdmin
    .from('user_memory')
    .upsert({ user_id: userId, role, preferences: merged, updated_at: new Date().toISOString() });
  if (error) console.error('[memory.service] failed to update user_memory:', error.message);
}

// ------------------------------------------------------------
// Lightweight preference extraction — deliberately heuristic (regex/keyword)
// rather than another Gemini call on every single turn, to keep the chat
// fast and cheap. Only extracts high-signal, unambiguous mentions.
// ------------------------------------------------------------
const FOOD_KEYWORDS = { vegan: 'vegan', vegetarian: 'veg', veg: 'veg', 'non-veg': 'non_veg', nonveg: 'non_veg', 'non veg': 'non_veg', jain: 'jain' };
const TRANSPORT_KEYWORDS = { cab: 'cab', taxi: 'cab', metro: 'metro', train: 'train', bus: 'bus', bike: 'bike', walk: 'walk', walking: 'walk', flight: 'flight' };
const INTEREST_KEYWORDS = ['nature', 'heritage', 'adventure', 'food', 'shopping', 'family', 'nightlife', 'relaxation', 'photography', 'hidden gems', 'temples', 'beaches', 'trekking', 'museums'];

export function extractPreferencesFromMessage(message) {
  const lower = message.toLowerCase();
  const patch = {};

  for (const [kw, tag] of Object.entries(FOOD_KEYWORDS)) {
    if (lower.includes(kw)) { patch.food_preference = tag; break; }
  }
  for (const [kw, tag] of Object.entries(TRANSPORT_KEYWORDS)) {
    if (new RegExp(`\\b${kw}\\b`).test(lower)) { patch.preferred_transport = tag; break; }
  }
  const interests = INTEREST_KEYWORDS.filter((kw) => lower.includes(kw));
  if (interests.length) patch.interests = interests;

  const budgetMatch = lower.match(/(?:budget|under|around|below)\s*(?:rs\.?|inr|₹)?\s*(\d{3,7})/);
  if (budgetMatch) patch.budget_range = { max: Number(budgetMatch[1]) };

  const cityMatch = lower.match(/\b(?:i live in|i'm based in|i am based in|my city is)\s+([a-z\s]{2,25})/);
  if (cityMatch) patch.home_city = cityMatch[1].trim();

  return patch;
}