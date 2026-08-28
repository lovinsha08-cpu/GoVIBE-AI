/**
 * Small provider-format bridge for the AI Agent (itineraryAgent.service.js).
 *
 * Tool declarations and handlers are authored ONCE, in agentTools.service.js,
 * using the standard OpenAI/JSON-schema tool-calling format (also what Groq
 * speaks natively, being OpenAI-compatible). This module converts that same
 * declaration set into Gemini's FunctionDeclaration shape (uppercase type
 * enums, no top-level `type:'function'`/`function:{...}` wrapper) so the
 * agent can drive either provider without maintaining two copies of every
 * tool's schema.
 */

const TYPE_MAP = {
  object: 'OBJECT',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
};

function convertSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };
  if (out.type && TYPE_MAP[out.type]) out.type = TYPE_MAP[out.type];
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, val]) => [key, convertSchema(val)]),
    );
  }
  if (out.items) out.items = convertSchema(out.items);
  return out;
}

/** OpenAI-format `tools` array -> Gemini FunctionDeclaration array. */
export function toGeminiDeclarations(openAiTools) {
  return openAiTools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: convertSchema(t.function.parameters),
  }));
}

const REVERSE_TYPE_MAP = {
  OBJECT: 'object',
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
};

function convertSchemaReverse(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };
  if (out.type && REVERSE_TYPE_MAP[out.type]) out.type = REVERSE_TYPE_MAP[out.type];
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, val]) => [key, convertSchemaReverse(val)]),
    );
  }
  if (out.items) out.items = convertSchemaReverse(out.items);
  return out;
}

/**
 * Gemini FunctionDeclaration[] -> OpenAI-format `tools` array.
 * Used by orchestrator.service.js, whose tool set (assistantFunctions.service.js)
 * is authored in Gemini format, so it can also drive callGroqWithTools as a
 * live runtime fallback when Gemini is unavailable.
 */
export function toOpenAiDeclarations(geminiDeclarations) {
  return geminiDeclarations.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: convertSchemaReverse(d.parameters),
    },
  }));
}