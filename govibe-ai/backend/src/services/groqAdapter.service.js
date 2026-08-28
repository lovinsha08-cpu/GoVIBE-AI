/**
 * Groq provider adapter.
 *
 * orchestrator.service.js talks to a single provider-agnostic shape:
 *
 *   request:  { contents, systemInstruction, tools, maxOutputTokens, temperature, timeoutMs }
 *   response: { ok: true,  text, functionCalls, modelContent, raw }
 *          or { ok: false, reason, message }
 *
 * That shape is Gemini's (see callGeminiWithTools in ai.service.js). Groq
 * speaks OpenAI's `messages`/`tool_calls` shape instead (see
 * groq.service.js). Rather than teaching groq.service.js to imitate
 * Gemini — which would tangle two unrelated wire formats into one file —
 * this module is the seam between them: it translates a Gemini-shaped
 * request into an OpenAI-shaped one, calls the existing (untouched)
 * `callGroqWithTools`, and translates the OpenAI-shaped result back into
 * the exact response shape orchestrator.service.js already knows how to
 * consume.
 *
 * Nothing in orchestrator.service.js needs to change to use this — that's
 * the point of an adapter. (It isn't wired in as a fallback yet; that's a
 * follow-up task. This module is currently only reachable by calling
 * `callGroqAsGemini` directly, e.g. from a test script.)
 *
 * ---- How the tool round-trip survives the translation ----
 * Gemini's function-call parts and Groq's tool_calls both need a
 * caller-supplied id echoed back on the next turn (Gemini:
 * `functionResponse.id`, Groq: the `tool` message's `tool_call_id`).
 * orchestrator.service.js already forwards `call.id` from `functionCalls`
 * into `functionResponse.id` (see the Gemini 3.x thoughtSignature/id
 * comment in orchestrator.service.js) — it doesn't care whose id it is.
 * So this adapter smuggles Groq's real `tool_calls[].id` through as
 * `functionCalls[].id` in the normalized response. orchestrator dutifully
 * echoes it back as `functionResponse.id` on the next round, and
 * `geminiContentsToOpenAiMessages` below reads it back out to rebuild the
 * exact `tool_call_id` Groq expects. Groq's own id is preserved end to
 * end — nothing is invented.
 */
import { env } from '../config/env.js';
import { callGroqWithTools } from './groq.service.js';
import { toOpenAiDeclarations } from './agentLLM.service.js';

/**
 * Converts the running Gemini-shaped `contents` array (+ optional
 * `systemInstruction` string) into an OpenAI-style `messages` array.
 *
 * `contents` entries look like one of:
 *   { role: 'user',  parts: [{ text }] }                           — plain user turn
 *   { role: 'user',  parts: [{ functionResponse: { name, response, id? } }, ...] }  — tool results
 *   { role: 'model', parts: [{ text }] }                           — plain assistant turn
 *   { role: 'model', parts: [{ functionCall: { name, args, id? } }, ...] }          — assistant tool calls
 * (the last two shapes are only ever ones this adapter itself produced
 * earlier in the same turn loop — see `modelContent` below.)
 */
function geminiContentsToOpenAiMessages(contents, systemInstruction) {
  const messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });

  for (const item of contents || []) {
    const parts = item.parts || [];
    const functionResponseParts = parts.filter((p) => p.functionResponse);
    const functionCallParts = parts.filter((p) => p.functionCall);

    if (functionResponseParts.length) {
      // Tool results going back to the model — one OpenAI `tool` message
      // per result, keyed by the tool_call_id we round-tripped through
      // functionResponse.id.
      //
      // FIX: a `tool` role message's only valid fields in the OpenAI/Groq
      // tool-calling spec are `role`, `tool_call_id`, and `content` — NOT
      // `name` (that was only ever valid on the older, deprecated
      // `function` role). Groq's request validation rejects the extra
      // `name` field with a 400, which silently killed the SECOND call of
      // every tool round trip (both here and in the Gemini fallback, once
      // Groq's failure triggered it) — i.e. every flow that actually calls
      // a tool (get_trip_itinerary, find_nearby, ...), while any flow that
      // never calls a tool (plain chat, RAG-grounded answers) was
      // unaffected. That matches the reported symptom exactly.
      for (const p of functionResponseParts) {
        messages.push({
          role: 'tool',
          tool_call_id: p.functionResponse.id || undefined,
          content: JSON.stringify(p.functionResponse.response ?? {}),
        });
      }
      continue;
    }

    const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n');

    if (item.role === 'model') {
      if (functionCallParts.length) {
        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: functionCallParts.map((p) => ({
            id: p.functionCall.id,
            type: 'function',
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args || {}),
            },
          })),
        });
      } else {
        messages.push({ role: 'assistant', content: text });
      }
    } else {
      messages.push({ role: 'user', content: text });
    }
  }

  return messages;
}

/**
 * One turn of a Groq tool-calling conversation, exposed under the same
 * contract as `callGeminiWithTools`. Never throws.
 *
 * `tools` is the same Gemini FunctionDeclaration[] orchestrator.service.js
 * already builds via assistantFunctions.service.js — converted here to
 * OpenAI's `tools` format via the existing `toOpenAiDeclarations` bridge
 * (agentLLM.service.js) rather than re-implementing schema conversion.
 */
export async function callGroqAsGemini({
  contents,
  systemInstruction,
  tools,
  maxOutputTokens = 1024,
  temperature = 0.4,
  timeoutMs = 20000,
}) {
  // Mirrors callGeminiWithTools's own `no_api_key` short-circuit so a
  // caller can branch on `reason` the same way for either provider.
  // (groq.service.js checks env.groqApiKey itself too, but checking here
  // lets us return the richer `{ ok: false, reason, message }` shape
  // instead of groq.service.js's bare `null`.)
  if (!env.groqApiKey) {
    return { ok: false, reason: 'no_api_key', message: 'GROQ_API_KEY is not configured' };
  }

  const messages = geminiContentsToOpenAiMessages(contents, systemInstruction);
  const openAiTools = tools?.length ? toOpenAiDeclarations(tools) : undefined;

  console.log(`[ai.provider] provider=groq model=${env.groqModel || '(unset)'}`);

  const result = await callGroqWithTools({
    messages,
    tools: openAiTools,
    maxTokens: maxOutputTokens,
    temperature,
    timeoutMs,
  });

  if (!result) {
    console.log('[ai.provider] provider=groq completed=false');
    // groq.service.js already logged the concrete failure (status code /
    // body, or timeout/abort) server-side — see its console.error calls.
    // It returns a bare `null` on every failure kind (by design: it never
    // throws and never leaks Groq wire details to callers), so we can't
    // distinguish quota/auth/network/timeout from here without changing
    // that contract, which would risk the existing itineraryAgent.service.js
    // caller (`if (!result) break;`) that already depends on it. Flagged
    // in the audit as a follow-up if finer-grained reason codes are needed.
    return { ok: false, reason: 'unknown_error', message: 'Groq request failed — see server logs from groq.service.js for detail' };
  }

  // Groq's tool_calls -> Gemini-shaped functionCalls, keeping Groq's own
  // `id` on each one so the round-trip machinery described above works.
  const functionCalls = (result.toolCalls || []).map((tc) => ({
    name: tc.name,
    args: tc.args,
    id: tc.id,
  }));

  // modelContent mirrors Gemini's `candidates[0].content` shape closely
  // enough for orchestrator.service.js to push it back into `contents`
  // verbatim on the next round — it never inspects this beyond that.
  const modelContent = {
    role: 'model',
    parts: [
      ...(result.text ? [{ text: result.text }] : []),
      ...functionCalls.map((fc) => ({ functionCall: fc })),
    ],
  };

  console.log(`[ai.provider] provider=groq tool_calls=${functionCalls.length} completed=true`);

  return {
    ok: true,
    text: result.text,
    functionCalls,
    modelContent,
    raw: result.raw,
  };
}