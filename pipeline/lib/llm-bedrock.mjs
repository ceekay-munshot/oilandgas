/**
 * Claude via AWS Bedrock — additive path, not a replacement.
 *
 * Selected only when LLM_PROVIDER=claude (see the one guard clause in
 * lib/llm.mjs's callLLM). Every other value, including unset, leaves the
 * OpenAI branch in lib/llm.mjs as the only one that ever runs, so no existing
 * deployment changes unless someone opts in on purpose.
 *
 * Self-contained by design: this file has no dependency on lib/llm.mjs, so
 * deleting it plus the one guard clause there removes the Claude path
 * completely, leaving the OpenAI logic exactly as it was.
 *
 * Uses the Bedrock Converse API with a forced tool call to get schema-shaped
 * JSON back — Bedrock parses the tool input for us, so there is no
 * code-fence stripping on that path — then normalizes the result to the same
 * `{ ...fields, __model }` shape callLLM returns for OpenAI/Mistral, plus a
 * non-enumerable `__provider` tag so callers can record which engine actually
 * answered without having to know about Bedrock.
 *
 * Model id and region default to what the task brief assumed
 * (us.anthropic.claude-sonnet-4-5-20250929-v1:0 in us-east-1) — ASSUMPTION,
 * not a verified fact about this AWS account. Override with BEDROCK_MODEL_ID
 * / BEDROCK_REGION if the account uses a different region or model access.
 */

import { HttpError, LlmSchemaError, MissingCredentialError } from './errors.mjs';
import { request } from './http.mjs';

const ENV_KEY = 'CLAUDE_BEDROCK_API_KEY';
const DEFAULT_REGION = 'us-east-1';
const DEFAULT_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

/** Local copy of llm.mjs's stripCodeFence so this file stays import-free of it. */
function stripCodeFence(text) {
  const m = String(text).trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : String(text).trim();
}

/**
 * Same call contract as callLLM in lib/llm.mjs (see its jsdoc), so it can be
 * swapped in transparently by the guard clause there.
 *
 * @returns {Promise<object>} parsed JSON reply, tagged with non-enumerable
 *   __model and __provider
 */
export async function callClaudeBedrock({
  model,
  apiKey,
  system,
  user,
  schema,
  schemaName = 'result',
  maxTokens = 2048
}) {
  const key = apiKey || process.env[ENV_KEY];
  if (!key) throw new MissingCredentialError(ENV_KEY);

  const region = process.env.BEDROCK_REGION || DEFAULT_REGION;
  const chosenModel = model || process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL;
  const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(chosenModel)}/converse`;

  const body = {
    messages: [{ role: 'user', content: [{ text: user }] }],
    system: [{ text: system }],
    inferenceConfig: { temperature: 0, maxTokens }
  };

  if (schema) {
    body.toolConfig = {
      tools: [{
        toolSpec: {
          name: schemaName,
          description: `Return ${schemaName} as structured JSON matching the given schema.`,
          inputSchema: { json: schema }
        }
      }],
      toolChoice: { tool: { name: schemaName } }
    };
  }

  // request() already retries 429/5xx with backoff and raises a typed HttpError,
  // same as the OpenAI/Mistral path.
  const res = await request(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 90_000,
    retries: 3
  });

  const payload = await res.json().catch((e) => {
    throw new HttpError('Bedrock returned a non-JSON envelope', {
      status: res.status,
      url: endpoint,
      cause: e
    });
  });

  const content = payload?.output?.message?.content;
  if (!Array.isArray(content)) {
    throw new LlmSchemaError('Reply had no message content', {
      provider: 'claude',
      model: chosenModel,
      raw: JSON.stringify(payload).slice(0, 400)
    });
  }

  let parsed;
  if (schema) {
    const toolUse = content.find((block) => block && block.toolUse)?.toolUse;
    if (!toolUse || typeof toolUse.input !== 'object' || toolUse.input === null) {
      throw new LlmSchemaError('Reply did not use the forced tool', {
        provider: 'claude',
        model: chosenModel,
        raw: JSON.stringify(payload).slice(0, 400)
      });
    }
    parsed = toolUse.input;

    // Bedrock's tool schema enforcement is not guaranteed "strict" the way
    // OpenAI's json_schema mode is, so check the top level ourselves - same
    // defensive check callLLM does for Mistral's json_object mode.
    const missing = (schema.required || []).filter((k) => !(k in parsed));
    if (missing.length) {
      throw new LlmSchemaError(`Reply missing required keys: ${missing.join(', ')}`, {
        provider: 'claude',
        model: chosenModel,
        raw: JSON.stringify(payload).slice(0, 400)
      });
    }
  } else {
    const text = content.filter((block) => typeof block?.text === 'string').map((block) => block.text).join('');
    try {
      parsed = JSON.parse(stripCodeFence(text));
    } catch (e) {
      throw new LlmSchemaError('Reply was not valid JSON', {
        provider: 'claude',
        model: chosenModel,
        raw: text.slice(0, 400),
        cause: e
      });
    }
  }

  // Attached non-enumerably, like callLLM does, so neither ever lands in the
  // JSON written to data/.
  try { Object.defineProperty(parsed, '__model', { value: chosenModel, enumerable: false }); } catch { /* frozen */ }
  try { Object.defineProperty(parsed, '__provider', { value: 'claude', enumerable: false }); } catch { /* frozen */ }
  return parsed;
}

/** Whether the Claude/Bedrock credential is present right now. */
export function claudeAvailable(env = process.env) {
  return Boolean(env[ENV_KEY]);
}
