/**
 * Permitted web/search tool for the AI Agent (see itineraryAgent.service.js).
 *
 * This is a FALLBACK, not a primary data source: the agent should only
 * reach for it when GoVIBE's own datasets/APIs (spotData, googlePlaces,
 * events.service, weather.service, nearbySearch) genuinely don't have the
 * answer — current-year closures, festivals, newly opened places, or other
 * time-sensitive tourism info.
 *
 * Deliberately uses a structured search API (Tavily) rather than fetching
 * and scraping arbitrary web pages:
 *   - no crawling, no bypassing robots.txt/auth/paywalls
 *   - results are short, pre-extracted snippets + source URLs, not full
 *     page bodies — the model gets facts to reason over, not raw HTML to
 *     copy from
 *   - every fact is traceable back to a real source URL, so the agent can
 *     (and should) attribute what it tells the traveler
 *
 * Never throws — degrades to `{ error }` so a missing key or a flaky
 * network call can't break the agent's turn.
 */
import { env } from '../config/env.js';

const TAVILY_URL = 'https://api.tavily.com/search';
const MAX_SNIPPET_CHARS = 400; // keep results short — facts to reason over, not pages to reproduce

export const isWebSearchConfigured = Boolean(env.tavilyApiKey);

/**
 * @param {string} query - natural-language search query
 * @param {{ maxResults?: number, topic?: 'general'|'news' }} opts
 * @returns {Promise<{ query: string, answer: string|null, results: Array<{title,url,content,source}>, source: 'tavily' } | { error: string }>}
 */
export async function searchWeb(query, { maxResults = 5, topic = 'general' } = {}) {
  const q = (query || '').trim();
  if (!q) return { error: 'A search query is required.' };
  if (!env.tavilyApiKey) {
    return { error: 'Web search is not configured (no TAVILY_API_KEY set) — answer using GoVIBE data only, or tell the traveler this specific current-info lookup isn\'t available right now.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: env.tavilyApiKey,
        query: q,
        topic,
        search_depth: 'basic',
        include_answer: true,
        max_results: Math.min(Math.max(maxResults, 1), 8),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[webSearch] Tavily request failed: ${res.status} ${body}`.trim());
      return { error: `Web search request failed (${res.status}).` };
    }
    const data = await res.json();
    const results = (data.results || []).map((r) => ({
      title: r.title || null,
      url: r.url,
      // Truncate — the tool returns extracted facts, never a full-page copy.
      content: (r.content || '').slice(0, MAX_SNIPPET_CHARS),
      source: safeHostname(r.url),
    }));
    return { query: q, answer: data.answer || null, results, source: 'tavily' };
  } catch (err) {
    console.error('[webSearch] error:', err.name === 'AbortError' ? 'timeout/abort' : err.message);
    return { error: 'Web search timed out or failed.' };
  } finally {
    clearTimeout(timeout);
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}