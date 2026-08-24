// @ts-check

export const PROVIDER_AUTHORITY = Object.freeze([
  Object.freeze({ name: 'anthropic', label: 'Anthropic', secretName: 'anthropic_api_key',
    defaultModel: 'claude-sonnet-4-6', defaultRunnerModel: 'claude-haiku-4-5',
    probeKind: 'anthropic', probeEndpoint: 'https://api.anthropic.com/v1/messages' }),
  Object.freeze({ name: 'openrouter', label: 'OpenRouter', secretName: 'openrouter_api_key',
    defaultModel: 'z-ai/glm-5.1', defaultRunnerModel: 'anthropic/claude-haiku-4.5',
    probeKind: 'openai', probeEndpoint: 'https://openrouter.ai/api/v1/chat/completions' }),
  Object.freeze({ name: 'openai', label: 'OpenAI', secretName: 'openai_api_key',
    defaultModel: 'gpt-5.1', defaultRunnerModel: 'gpt-5.1-mini',
    probeKind: 'openai', probeEndpoint: 'https://api.openai.com/v1/chat/completions' }),
  Object.freeze({ name: 'glm', label: 'Z.ai', secretName: 'glm_api_key',
    defaultModel: 'glm-5.2', defaultRunnerModel: 'glm-4.5-air',
    probeKind: 'openai', probeEndpoint: 'https://api.z.ai/api/paas/v4/chat/completions' }),
  Object.freeze({ name: 'ollama', label: 'Ollama', secretName: null,
    defaultModel: 'qwen3:8b', defaultRunnerModel: 'qwen3:8b',
    probeKind: 'ollama', probeEndpoint: null }),
  Object.freeze({ name: 'local-webgpu', label: 'Local (WebGPU)', secretName: null,
    defaultModel: 'gemma-4-e2b', defaultRunnerModel: 'gemma-4-e2b',
    probeKind: 'none', probeEndpoint: null }),
]);

export const PROVIDER_MODEL_CATALOG = Object.freeze({
  anthropic: Object.freeze([
    Object.freeze({ model: 'claude-opus-4-8', label: 'Claude Opus 4.8' }),
    Object.freeze({ model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }),
    Object.freeze({ model: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }),
  ]),
  openrouter: Object.freeze([
    Object.freeze({ model: 'z-ai/glm-5.1', label: 'GLM-5.1 (open · tool-calling)' }),
    Object.freeze({ model: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6 (open)' }),
    Object.freeze({ model: 'minimax/minimax-m2', label: 'MiniMax M2 (open · cheap)' }),
    Object.freeze({ model: 'openai/gpt-4o', label: 'GPT-4o' }),
  ]),
  openai: Object.freeze([
    Object.freeze({ model: 'gpt-5.1', label: 'GPT-5.1' }),
    Object.freeze({ model: 'gpt-5.1-mini', label: 'GPT-5.1 mini (cheap)' }),
    Object.freeze({ model: 'gpt-5', label: 'GPT-5' }),
    Object.freeze({ model: 'o4-mini', label: 'o4-mini (reasoning)' }),
  ]),
  glm: Object.freeze([
    Object.freeze({ model: 'glm-5.2', label: 'GLM-5.2 (1M · agentic)' }),
    Object.freeze({ model: 'glm-4.6', label: 'GLM-4.6' }),
    Object.freeze({ model: 'glm-4.5-air', label: 'GLM-4.5 Air (fast · cheap)' }),
  ]),
});

export const LOCAL_MODEL_LABELS = Object.freeze({
  'gemma-4-e2b': 'Gemma 4 E2B',
  'muse-glimmer-30b': 'Muse Glimmer 30B',
});

export const OPENROUTER_POPULAR = Object.freeze(
  ('z-ai/glm-5.1 z-ai/glm-5.2 moonshotai/kimi-k2.6 minimax/minimax-m2 qwen/qwen3-coder '
  + 'anthropic/claude-haiku-4.5 google/gemini-3-flash openai/gpt-4o openai/gpt-4o-mini '
  + 'openai/o4-mini anthropic/claude-3.7-sonnet anthropic/claude-3.5-sonnet '
  + 'anthropic/claude-3.5-haiku google/gemini-2.5-pro google/gemini-2.5-flash '
  + 'google/gemini-2.0-flash-001 meta-llama/llama-3.3-70b-instruct '
  + 'meta-llama/llama-3.1-8b-instruct deepseek/deepseek-chat deepseek/deepseek-r1 '
  + 'mistralai/mistral-large mistralai/mistral-nemo qwen/qwen-2.5-72b-instruct x-ai/grok-2 '
  + 'x-ai/grok-beta cohere/command-r-plus nousresearch/hermes-3-llama-3.1-70b').split(' '),
);

/** @param {unknown} value */
export const normalizeOpenRouterModels = (value) => {
  const rows = value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {{data?:unknown}} */ (value).data : null;
  return (Array.isArray(rows) ? rows : []).slice(0, 2_000).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = /** @type {any} */ (entry);
    const model = typeof row.id === 'string' ? row.id.trim() : '';
    if (!model || model.length > 256) return [];
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const label = name && name.length <= 512 ? name : model;
    const finite = (/** @type {unknown} */ number) => {
      const parsed = Number(number);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return [{
      model, label,
      contextLength: finite(row.context_length),
      promptPrice: finite(row.pricing?.prompt),
      completionPrice: finite(row.pricing?.completion),
    }];
  }).sort((a, b) => a.label.localeCompare(b.label));
};

/** @param {unknown} name */
export const providerAuthority = (name) => typeof name === 'string'
  ? PROVIDER_AUTHORITY.find((row) => row.name === name) ?? null : null;

/** @param {unknown} value */
export const maskProviderKey = (value) => {
  const key = String(value ?? '');
  return key.length <= 11 ? `${key.length} chars`
    : `${key.slice(0, 7)}…${key.slice(-3)} · ${key.length} chars`;
};
