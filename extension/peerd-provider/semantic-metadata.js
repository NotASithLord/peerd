// @ts-check
// Provider-owned model metadata and response normalization. This file is safe
// for the sealed controller: it contains no endpoint, credential, header, or
// transport policy data.

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
