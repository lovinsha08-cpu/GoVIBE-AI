/**
 * Gemini embedding wrapper — powers RAG (FAQs + knowledge base).
 * Every function resolves to null (never throws) if there's no API key or
 * the call fails, so the orchestrator can always fall back to the plain
 * LLM-reasoning path when embeddings are unavailable.
 *
 * Model: `gemini-embedding-001`. The previous model here, `text-embedding-004`,
 * was shut down by Google on 2026-01-14 — every call to it now returns 404,
 * which is why RAG/FAQ lookups were failing. See
 * https://ai.google.dev/gemini-api/docs/embeddings and
 * https://ai.google.dev/gemini-api/docs/deprecations
 */
import { env } from '../config/env.js';

const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;

// supabase/schema_rag_v2.sql declares `embedding vector(768)` — but
// gemini-embedding-001 outputs 3072 dimensions by default. Without pinning
// outputDimensionality, every insert (upsertFaq/upsertKbDocument) and every
// match_faqs/match_kb_documents RPC call would fail on a dimension mismatch
// against the existing column. 768 keeps the existing schema/data untouched.
const OUTPUT_DIMENSIONALITY = 768;

/**
 * Embeds a single piece of text. Returns number[768] | null.
 *
 * `taskType` tunes the embedding for how it will be used — pass
 * 'RETRIEVAL_DOCUMENT' when embedding content that will later be searched
 * (FAQ/KB ingestion; see rag.service.js's upsertFaq/upsertKbDocument), and
 * leave the default 'RETRIEVAL_QUERY' when embedding an incoming user
 * message. Getting this "wrong" doesn't break anything — it's a quality
 * tuning knob, not a correctness one.
 */
export async function embedText(text, { taskType = 'RETRIEVAL_QUERY' } = {}) {
  if (!env.geminiApiKey || !text || !text.trim()) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${EMBED_URL}?key=${env.geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text: text.slice(0, 8000) }] },
        taskType,
        outputDimensionality: OUTPUT_DIMENSIONALITY,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Surface Google's actual error body (bad model name, quota, region
      // block, etc.) instead of just the bare status code — this is what
      // let us diagnose the 404 as a deprecated model name in the first place.
      const errorBody = await res.text().catch(() => '');
      console.error(`[embeddings.service] Gemini embed failed: ${res.status} ${errorBody}`.trim());
      return null;
    }
    const data = await res.json();
    const values = data.embedding?.values;
    return Array.isArray(values) ? values : null;
  } catch (err) {
    console.error(`[embeddings.service] embed error: ${err.name === 'AbortError' ? 'timeout/abort' : err.message}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Embeds many texts sequentially (small batches only — FAQ/KB seeding). */
export async function embedBatch(texts, opts) {
  const out = [];
  for (const t of texts) {
    out.push(await embedText(t, opts));
  }
  return out;
}