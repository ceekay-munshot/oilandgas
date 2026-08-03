/**
 * Provider-agnostic LLM call.
 *
 * Live: the KPI extractor (extract-kpis.mjs) makes one call per company through
 * this. The commentary scorer will be its second consumer.
 *
 * Contract: temperature 0, JSON out, schema enforced where the provider can do
 * it (OpenAI strict `json_schema`) and validated locally where it cannot
 * (Mistral `json_object`). Failures are typed so callers can tell "try again"
 * from "this will never work":
 *
 *   HttpError.retryable === true   429 / 5xx / transport  -> back off and retry
 *   HttpError.retryable === false  401 / 404 / 400        -> config is wrong
 *   LlmSchemaError                 replied, but not to shape -> do not retry blind
 */

import { HttpError, LlmSchemaError, MissingCredentialError } from './errors.mjs';
import { request } from './http.mjs';
import { callClaudeBedrock } from './llm-bedrock.mjs';

/**
 * Models are deliberately NOT the cheap tier.
 *
 * This started on gpt-4o-mini, chosen when the wrapper was a stub with no
 * consumer, and it stayed there once the job became careful numeric extraction:
 * find one specific KPI across four quarters of noisy transcript text, put each
 * number in the right quarter, and refuse to guess when it is not stated. The
 * small models are materially worse at all three, and the whole run is one call
 * per company - 27 calls - so the cheap tier saves cents and costs coverage.
 *
 * Overridable per provider by env (OPENAI_MODEL / MISTRAL_MODEL) so the model can
 * be changed without a deploy.
 */
export const PROVIDERS = {
  openai: {
    envKey: 'OPENAI_API_KEY',
    modelEnvKey: 'OPENAI_MODEL',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o',
    supportsStrictSchema: true
  },
  mistral: {
    envKey: 'MISTRAL_API_KEY',
    modelEnvKey: 'MISTRAL_MODEL',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    defaultModel: 'mistral-large-latest',
    supportsStrictSchema: false
  }
};

/**
 * @param {object}  opts
 * @param {'openai'|'mistral'} opts.provider
 * @param {string} [opts.model]
 * @param {string} [opts.apiKey]   defaults to the provider's env var
 * @param {string}  opts.system
 * @param {string}  opts.user
 * @param {object} [opts.schema]   JSON Schema for the reply object
 * @param {string} [opts.schemaName='result']
 * @param {number} [opts.maxTokens=2048]
 * @returns {Promise<object>} parsed JSON reply
 */
export async function callLLM({
  provider,
  model,
  apiKey,
  system,
  user,
  schema,
  schemaName = 'result',
  maxTokens = 2048
}) {
  // Additive Claude/Bedrock path (lib/llm-bedrock.mjs) - reroutes only when
  // explicitly toggled, so every existing deployment (LLM_PROVIDER unset)
  // hits the OpenAI branch below exactly as before. Delete llm-bedrock.mjs
  // and this guard to remove the Claude path entirely.
  if (provider === 'openai' && process.env.LLM_PROVIDER === 'claude') {
    return callClaudeBedrock({ model, apiKey, system, user, schema, schemaName, maxTokens });
  }

  const spec = PROVIDERS[provider];
  if (!spec) throw new LlmSchemaError(`Unknown provider "${provider}"`, { provider });

  const key = apiKey || process.env[spec.envKey];
  if (!key) throw new MissingCredentialError(spec.envKey);

  const chosenModel = model || (spec.modelEnvKey && process.env[spec.modelEnvKey]) || spec.defaultModel;
  const body = {
    model: chosenModel,
    temperature: 0,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };

  if (schema) {
    body.response_format = spec.supportsStrictSchema
      ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
      : { type: 'json_object' };
  }

  // request() already retries 429/5xx with backoff and raises a typed HttpError.
  const res = await request(spec.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 90_000,
    retries: 3
  });

  const payload = await res.json().catch((e) => {
    throw new HttpError('Provider returned a non-JSON envelope', {
      status: res.status,
      url: spec.endpoint,
      cause: e
    });
  });

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LlmSchemaError('Reply had no message content', {
      provider,
      model: body.model,
      raw: JSON.stringify(payload).slice(0, 400)
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (e) {
    throw new LlmSchemaError('Reply was not valid JSON', {
      provider,
      model: body.model,
      raw: content.slice(0, 400),
      cause: e
    });
  }

  // Providers without strict schema support can return well-formed JSON of the
  // wrong shape, so check the top level ourselves.
  if (schema && !spec.supportsStrictSchema) {
    const missing = (schema.required || []).filter((k) => !(k in parsed));
    if (missing.length) {
      throw new LlmSchemaError(`Reply missing required keys: ${missing.join(', ')}`, {
        provider,
        model: body.model,
        raw: content.slice(0, 400)
      });
    }
  }

  // Attach the model non-enumerably so it never lands in the JSON we write.
  try { Object.defineProperty(parsed, '__model', { value: chosenModel, enumerable: false }); } catch { /* frozen */ }
  return parsed;
}

/** The model a provider will actually use, given env overrides. */
export function resolvedModel(provider, env = process.env) {
  const spec = PROVIDERS[provider];
  if (!spec) return null;
  return (spec.modelEnvKey && env[spec.modelEnvKey]) || spec.defaultModel;
}

/** Models sometimes wrap JSON in ```json fences even when told not to. */
export function stripCodeFence(text) {
  const m = String(text).trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : String(text).trim();
}

/** Which providers have a key present right now. */
export function availableProviders(env = process.env) {
  return Object.entries(PROVIDERS)
    .filter(([, spec]) => Boolean(env[spec.envKey]))
    .map(([name]) => name);
}
