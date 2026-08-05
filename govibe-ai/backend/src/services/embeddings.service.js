/**
 * Gemini text-embedding-004 wrapper — powers RAG (FAQs + knowledge base).
 * Every function resolves to null (never throws) if there's no API key or
 * the call fails, so the orchestrator can always fall back to the plain
 * LLM-reasoning path when embeddings are unavailable.
 */
import { env } from '../config/env.js';

const EMBED_MODEL = 'text-embedding-004';
const EMBED_URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`;

/** Embeds a single piece of text. Returns number[768] | null. */
export async function embedText(text) {
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
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[embeddings.service] Gemini embed failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const values = data.embedding?.values;
    return Array.isArray(values) ? values : null;
  } catch (err) {
    console.error('[embeddings.service] embed error:', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Embeds many texts sequentially (small batches only — FAQ/KB seeding). */
export async function embedBatch(texts) {
  const out = [];
  for (const t of texts) {
    out.push(await embedText(t));
  }
  return out;
}