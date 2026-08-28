/**
 * RAG layer over Supabase pgvector — used by the assistant orchestrator for:
 *   1. Semantic FAQ retrieval (requirement 8): a high-confidence FAQ match
 *      is returned directly, with NO Gemini call at all.
 *   2. Knowledge-base grounding (requirement 7): relevant chunks (travel
 *      guides, platform docs, policies, hidden gems, business docs) are
 *      retrieved and injected into the Gemini prompt as context so answers
 *      are grounded instead of hallucinated.
 *
 * Everything here degrades gracefully: if Supabase or the embedding call
 * isn't available, functions return an empty result rather than throwing —
 * the orchestrator simply falls through to the next stage (function calling
 * / general LLM reasoning).
 */
import { supabaseAdmin, isSupabaseConfigured } from '../config/supabase.js';
import { embedText } from './embeddings.service.js';

// Similarity thresholds — cosine similarity, 0..1. FAQ threshold is high
// on purpose: we only want to skip the LLM entirely when we're confident
// the FAQ genuinely answers the question, not just "vaguely related".
const FAQ_HIGH_CONFIDENCE_THRESHOLD = 0.86;
const FAQ_MATCH_THRESHOLD = 0.75;
const KB_MATCH_THRESHOLD = 0.65;

/**
 * Looks for a semantically matching FAQ. Returns
 * { faq, similarity, highConfidence } or null if nothing matched.
 */
export async function findFaqMatch(query, audience = 'both') {
  if (!isSupabaseConfigured) return null;
  const embedding = await embedText(query);
  if (!embedding) return null;

  const { data, error } = await supabaseAdmin.rpc('match_faqs', {
    query_embedding: embedding,
    match_audience: audience,
    match_threshold: FAQ_MATCH_THRESHOLD,
    match_count: 1,
  });
  if (error || !data?.length) return null;

  const top = data[0];
  return {
    faq: { id: top.id, question: top.question, answer: top.answer, category: top.category },
    similarity: top.similarity,
    highConfidence: top.similarity >= FAQ_HIGH_CONFIDENCE_THRESHOLD,
  };
}

/**
 * Retrieves the top-N knowledge-base chunks relevant to the query, optionally
 * scoped to a city. Returns [] on any failure — safe to always call.
 */
export async function retrieveKbContext(query, { audience = 'both', city = null, limit = 5 } = {}) {
  if (!isSupabaseConfigured) return [];
  const embedding = await embedText(query);
  if (!embedding) return [];

  const { data, error } = await supabaseAdmin.rpc('match_kb_documents', {
    query_embedding: embedding,
    match_audience: audience,
    match_threshold: KB_MATCH_THRESHOLD,
    match_count: limit,
  });
  if (error || !data) return [];

  // City is a soft preference, not a hard filter — a document without a
  // city tag (e.g. general platform docs) is still relevant everywhere.
  const scored = city
    ? [...data].sort((a, b) => {
        const aCity = a.city && a.city.toLowerCase() === city.toLowerCase() ? 1 : 0;
        const bCity = b.city && b.city.toLowerCase() === city.toLowerCase() ? 1 : 0;
        return bCity - aCity || b.similarity - a.similarity;
      })
    : data;

  return scored.map((d) => ({
    title: d.title, content: d.content, source: d.source,
    category: d.category, city: d.city, similarity: d.similarity,
  }));
}

/** Formats retrieved KB chunks into a prompt-ready context block. */
export function formatKbContext(chunks) {
  if (!chunks?.length) return '';
  return chunks
    .map((c, i) => `[Source ${i + 1}: ${c.title}${c.source ? ` — ${c.source}` : ''}]\n${c.content}`)
    .join('\n\n');
}

// ------------------------------------------------------------
// Ingestion helpers — used by scripts/seedKnowledgeBase.js
// ------------------------------------------------------------

export async function upsertFaq({ question, answer, category = null, audience = 'both' }) {
  if (!isSupabaseConfigured) return null;
  const embedding = await embedText(`${question}\n${answer}`, { taskType: 'RETRIEVAL_DOCUMENT' });
  const { data, error } = await supabaseAdmin
    .from('faqs')
    .insert({ question, answer, category, audience, embedding })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function upsertKbDocument({ title, content, source = null, category = null, audience = 'both', city = null }) {
  if (!isSupabaseConfigured) return null;
  const embedding = await embedText(`${title}\n${content}`, { taskType: 'RETRIEVAL_DOCUMENT' });
  const { data, error } = await supabaseAdmin
    .from('kb_documents')
    .insert({ title, content, source, category, audience, city, embedding })
    .select()
    .single();
  if (error) throw error;
  return data;
}