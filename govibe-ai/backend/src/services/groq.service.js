/**
 * Groq API client (OpenAI-compatible chat completions + tool calling).
 * Used by itineraryAgent.service.js as an alternative LLM provider to
 * Gemini for the AI Agent's tool-calling loop — see env.agentLlmProvider.
 *
 * Kept intentionally symmetrical with ai.service.js's callGeminiWithTools:
 * same never-throws contract, same { text, toolCalls, raw } return shape,
 * just adapted to OpenAI's message/tool_call format instead of Gemini's
 * contents/functionCall format.
 */
import { env } from '../config/env.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * One turn of a Groq tool-calling conversation.
 * `messages` is the full running OpenAI-style message history:
 *   [{ role: 'system'|'user'|'assistant'|'tool', content, tool_calls?, tool_call_id?, name? }]
 * `tools` is OpenAI-format: [{ type: 'function', function: { name, description, parameters } }]
 *
 * Returns { text, toolCalls: [{ id, name, args }], assistantMessage, raw }
 * — `assistantMessage` is the raw assistant message object, needed so the
 * caller can push it back into `messages` verbatim (tool_call ids must
 * round-trip exactly). Resolves to null (never throws) on failure.
 */
export async function callGroqWithTools({ messages, tools, maxTokens = 1024, temperature = 0.4, timeoutMs = 15000 }) {
  if (!env.groqApiKey) return null;

  const body = {
    model: env.groqModel,
    messages,
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    max_tokens: maxTokens,
    temperature,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.groqApiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      console.error(`[groq.service] Groq request failed: ${res.status} ${errorBody}`.trim());
      return null;
    }
    const data = await res.json();
    const assistantMessage = data.choices?.[0]?.message || null;
    if (!assistantMessage) return null;

    const toolCalls = (assistantMessage.tool_calls || []).map((tc) => {
      let args = {};
      try {
        args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      return { id: tc.id, name: tc.function?.name, args };
    });

    return {
      text: (assistantMessage.content || '').trim(),
      toolCalls,
      assistantMessage,
      raw: data,
    };
  } catch (err) {
    console.error('[groq.service] Groq call error:', err.name === 'AbortError' ? 'timeout/abort' : err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}