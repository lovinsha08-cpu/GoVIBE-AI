/**
 * LLM Provider Layer — the ONE place orchestrator.service.js asks for a
 * tool-calling completion. Everything provider-specific (Groq vs Gemini,
 * OpenAI message format vs Gemini contents/parts format, tool_call_id vs
 * functionResponse.id) is resolved *inside* this file and the adapters it
 * calls. orchestrator.service.js only ever sees one contract:
 *
 *   request:  { contents, systemInstruction, tools, maxOutputTokens, temperature, timeoutMs }
 *   response: { ok: true,  text, functionCalls, modelContent, provider, raw }
 *          or { ok: false, reason, message, provider }
 *
 * This is the same contract callGeminiWithTools already used (see
 * ai.service.js) and that groqAdapter.service.js normalizes Groq into —
 * this module doesn't invent a new shape, it just decides *which* adapter
 * produced it and adds `provider` for logging/telemetry.
 *
 * Policy: Groq primary, Gemini fallback.
 *   - Groq succeeds (`ok: true`, including a legitimate empty-text /
 *     no-tool-call answer)              → return Groq's result. Gemini is
 *                                          never called.
 *   - Groq fails (`ok: false` — timeout, network, 4xx/5xx, rate limit, or
 *     not configured)                   → try Gemini for this same round.
 *   - Gemini also fails                 → return ok:false (caller shows a
 *                                          safe fallback message).
 *
 * "Fails" here means the PROVIDER call itself didn't return usable output
 * (`ok: false`) — never "the model chose to answer with no tool calls" or
 * "the model's answer happens to be a short/empty string", both of which
 * are valid successful completions and must not trigger a fallback call.
 */
import { env } from '../config/env.js';
import { callGroqAsGemini } from './groqAdapter.service.js';
import { callGeminiWithTools } from './ai.service.js';

export async function callLlmWithTools(params) {
  let groqReason = 'not_configured';

  if (env.groqApiKey) {
    const groqResult = await callGroqAsGemini(params);
    if (groqResult.ok) {
      return { ...groqResult, provider: 'groq' };
    }
    groqReason = groqResult.reason;
    // groqAdapter.service.js (via groq.service.js) already logged the
    // concrete failure detail server-side. Log just the routing decision
    // here — no need to duplicate the detail, and definitely no secrets.
    console.error(`[llm.provider] groq failed (reason=${groqReason}) — falling back to gemini`);
  } else {
    console.error('[llm.provider] groq not configured (GROQ_API_KEY unset) — using gemini');
  }

  const geminiResult = await callGeminiWithTools(params);
  if (geminiResult.ok) {
    return { ...geminiResult, provider: 'gemini' };
  }

  console.error(`[llm.provider] gemini also failed (reason=${geminiResult.reason}) — both providers unavailable this round`);
  return {
    ok: false,
    reason: geminiResult.reason,
    message: geminiResult.message,
    provider: 'gemini',
    // Kept for server-side diagnostics only (never surfaced to the user) —
    // lets you tell "Groq down, Gemini covered it" apart from "both down"
    // apart from "Groq wasn't even configured" in your logs.
    groqReason,
  };
}