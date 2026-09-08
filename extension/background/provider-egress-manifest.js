// @ts-check
// Fixed model-egress authority. This module is background-only: semantic
// provider code receives provider ids and response bytes, never these URLs,
// vault bindings, authentication headers, or transport limits.

const MIB = 1024 * 1024;

const policy = (/** @type {any} */ value) => Object.freeze(value);

export const PROVIDER_EGRESS_MANIFEST = Object.freeze({
  anthropic: policy({
    credential: 'anthropic_api_key', authentication: 'anthropic-key',
    inferenceUrl: 'https://api.anthropic.com/v1/messages',
    contextUrl: 'https://api.anthropic.com/v1/models/',
    inventoryUrl: null,
    requestBytes: 32 * MIB, responseBytes: 8 * MIB, chunkBytes: 64 * 1024,
    connectMs: 45_000,
  }),
  openrouter: policy({
    credential: 'openrouter_api_key', authentication: 'bearer-attributed',
    inferenceUrl: 'https://openrouter.ai/api/v1/chat/completions',
    contextUrl: 'https://openrouter.ai/api/v1/models',
    inventoryUrl: 'https://openrouter.ai/api/v1/models',
    requestBytes: 24 * MIB, responseBytes: 8 * MIB, chunkBytes: 64 * 1024,
    connectMs: 45_000,
  }),
  openai: policy({
    credential: 'openai_api_key', authentication: 'bearer',
    inferenceUrl: 'https://api.openai.com/v1/chat/completions',
    contextUrl: null, inventoryUrl: null,
    requestBytes: 24 * MIB, responseBytes: 8 * MIB, chunkBytes: 64 * 1024,
    connectMs: 45_000,
  }),
  glm: policy({
    credential: 'glm_api_key', authentication: 'bearer',
    inferenceUrl: 'https://api.z.ai/api/paas/v4/chat/completions',
    contextUrl: null, inventoryUrl: null,
    requestBytes: 24 * MIB, responseBytes: 8 * MIB, chunkBytes: 64 * 1024,
    connectMs: 45_000,
  }),
  ollama: policy({
    credential: null, authentication: 'none',
    inferenceUrl: null, contextUrl: null, inventoryUrl: null,
    requestBytes: 16 * MIB, responseBytes: 8 * MIB, chunkBytes: 64 * 1024,
    connectMs: 120_000,
  }),
  'local-webgpu': policy({
    credential: null, authentication: 'none',
    inferenceUrl: null, contextUrl: null, inventoryUrl: null,
    requestBytes: 2 * MIB, responseBytes: 8 * MIB, chunkBytes: 64 * 1024,
    connectMs: 120_000,
  }),
});

/** @param {unknown} providerId */
export const providerEgressPolicy = (providerId) => typeof providerId === 'string'
  ? PROVIDER_EGRESS_MANIFEST[/** @type {keyof typeof PROVIDER_EGRESS_MANIFEST} */ (providerId)]
    ?? null
  : null;

/** @param {unknown} value */
const ollamaOrigin = (value) => {
  try {
    const url = new URL(typeof value === 'string' && value ? value : 'http://localhost:11434');
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
      ? url.origin : null;
  } catch { return null; }
};

/**
 * Resolve only the three fixed Ollama routes from the worker-owned setting.
 * @param {'inference'|'inventory'|'context'} kind
 * @param {unknown} configuredOrigin
 */
export const resolveOllamaEgressUrl = (kind, configuredOrigin) => {
  const origin = ollamaOrigin(configuredOrigin);
  if (!origin) return null;
  if (kind === 'inference') return `${origin}/v1/chat/completions`;
  if (kind === 'inventory') return `${origin}/api/tags`;
  if (kind === 'context') return `${origin}/api/show`;
  return null;
};

/** @param {any} policyEntry @param {string|null} credential @returns {Record<string,string>|null} */
export const providerEgressHeaders = (policyEntry, credential) => {
  if (!policyEntry) return null;
  if (policyEntry.credential && !credential) return null;
  const key = typeof credential === 'string' ? credential : '';
  if (policyEntry.authentication === 'anthropic-key') return {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (policyEntry.authentication === 'bearer-attributed') return {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    'http-referer': 'https://peerd.ai',
    'x-title': 'peerd.ai',
    'x-openrouter-categories': 'personal-agent',
  };
  if (policyEntry.authentication === 'bearer') return {
    'content-type': 'application/json', authorization: `Bearer ${key}`,
  };
  return { 'content-type': 'application/json' };
};
