// @ts-check
// background/model-catalog.js — the per-chat model picker's catalog assembly.
//
// Extracted from the SW (which is wiring, not logic — its own header rule):
// the static curated catalog, the live-inventory cache (Ollama /api/tags), the
// OpenRouter curated-selection mapping, the live per-model context window, and
// buildModelOptions, which folds all of it into the picker's options list.
//
// Import-free, deps-injected factory (same shape as background/routes/*): every
// collaborator arrives via `deps`, so the assembly is Bun-unit-testable with
// fakes and the SW keeps its role as the one place concrete instances meet.
//
// why `localModelAvailable` is a thunk: localModelState is created later in the
// SW's assembly order than this factory is convenient to call; a thunk defers
// the read to call time without forcing a wiring reorder.

/**
 * @param {Object} deps
 * @param {() => Array<any>} deps.listProviders
 * @param {(name: string, opts: any) => Promise<Array<{model:string,label:string}> | null>} deps.listProviderModels
 * @param {(provider: string, model: string, opts: any) => Promise<number | null | undefined>} deps.providerModelContextWindow
 * @param {string} deps.localModelId              LOCAL_MODEL_ID (the WebGPU model's id)
 * @param {() => boolean} deps.localModelAvailable  is the local WebGPU model downloaded + resident?
 * @param {{ get: () => any }} deps.settingsStore
 * @param {{ getSecret: (name: string) => Promise<string | null> }} deps.vault
 * @param {{ get: (id: string) => Promise<any> }} deps.sessions
 * @param {() => { name: string, model: string }} deps.resolveActiveProvider
 * @param {(name: string) => Promise<string | null>} deps.getSecret
 * @param {any} deps.safeFetch
 * @param {() => void} [deps.onLiveModelsChanged]
 */
export const makeModelCatalog = (deps) => {
  const {
    listProviders, listProviderModels, providerModelContextWindow,
    localModelId, localModelAvailable, settingsStore, vault, sessions,
    resolveActiveProvider, getSecret, safeFetch, onLiveModelsChanged,
  } = deps;

  // Curated model options per provider, for the per-chat model picker.
  // Conservative on purpose — only ids we're confident resolve, so the
  // picker never offers a 404. Exotic models go through the free-form
  // model field in Settings. The picker also appends whatever model the
  // user has configured in Settings if it isn't already listed here.
  const MODEL_CATALOG = Object.freeze({
    anthropic: [
      { model: 'claude-opus-4-8',            label: 'Claude Opus 4.8' },
      { model: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6' },
      { model: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5' },
    ],
    // The fallback set shown until the user curates their own (openrouterChatCatalog).
    // Led by the current best open-weights tool-calling models (mid-2026), so a
    // fresh OpenRouter user gets a strong default without curating first.
    openrouter: [
      { model: 'z-ai/glm-5.1',          label: 'GLM-5.1 (open · tool-calling)' },
      { model: 'moonshotai/kimi-k2.6',  label: 'Kimi K2.6 (open)' },
      { model: 'minimax/minimax-m2',    label: 'MiniMax M2 (open · cheap)' },
      { model: 'openai/gpt-4o',         label: 'GPT-4o' },
    ],
    // Direct OpenAI (api.openai.com). Led by the current flagship + its cheap
    // sibling so a fresh OpenAI user gets a strong default before curating.
    openai: [
      { model: 'gpt-5.1',      label: 'GPT-5.1' },
      { model: 'gpt-5.1-mini', label: 'GPT-5.1 mini (cheap)' },
      { model: 'gpt-5',        label: 'GPT-5' },
      { model: 'o4-mini',      label: 'o4-mini (reasoning)' },
    ],
    // Z.ai GLM direct API — small, known lineup of bare ids (`glm-*`). No live
    // inventory fetch: GLM exposes a handful of models, not the gateway-scale
    // catalog that justified OpenRouter's curation picker.
    glm: [
      { model: 'glm-5.2',      label: 'GLM-5.2 (1M · agentic)' },
      { model: 'glm-4.6',      label: 'GLM-4.6' },
      { model: 'glm-4.5-air',  label: 'GLM-4.5 Air (fast · cheap)' },
    ],
    // Local WebGPU — only surfaced once downloaded/resident (gated in buildModelOptions).
    'local-webgpu': [
      { model: localModelId, label: 'Gemma 4 E2B' },
    ],
  });

  // Live model inventory cache (providers with `liveModels`, i.e. Ollama
  // /api/tags). Short TTL: chat-view mounts call models/options freely, and
  // hammering the local daemon buys nothing. A FAILED probe (daemon down)
  // is cached as null for the same TTL so the picker degrades quietly
  // instead of retry-storming localhost.
  const LIVE_MODELS_TTL_MS = 30_000;
  /** @type {Map<string, { at: number, list: Array<{model:string,label:string}> | null }>} */
  const liveModelsCache = new Map();
  /** @type {Map<string, number>} */
  const liveModelsGeneration = new Map();
  const providerCacheScope = (/** @type {string} */ name) => name === 'ollama'
    ? `${name}::${settingsStore.get().ollamaHost ?? ''}`
    : name;
  const liveProviderModels = async (/** @type {string} */ name, { force = false } = {}) => {
    const cacheKey = providerCacheScope(name);
    if (force) liveModelsCache.delete(cacheKey);
    const hit = liveModelsCache.get(cacheKey);
    if (hit && Date.now() - hit.at < LIVE_MODELS_TTL_MS) return hit.list;
    const generation = (liveModelsGeneration.get(cacheKey) ?? 0) + 1;
    liveModelsGeneration.set(cacheKey, generation);
    let list = null;
    // ollamaHost (issue #104) lets the live inventory fetch a remote daemon's
    // /api/tags; non-ollama adapters ignore it.
    try { list = await listProviderModels(name, { safeFetch, ollamaHost: settingsStore.get().ollamaHost }); }
    catch { list = null; }
    // A normal catalog read can be overtaken by an explicit Test/refresh for
    // the same host. Only the newest request may publish into the shared cache;
    // otherwise the older response can land last and make the UI stale again.
    if (liveModelsGeneration.get(cacheKey) === generation) {
      const previous = liveModelsCache.get(cacheKey)?.list;
      liveModelsCache.set(cacheKey, { at: Date.now(), list });
      const changed = JSON.stringify(previous) !== JSON.stringify(list);
      if (changed) onLiveModelsChanged?.();
    }
    return list;
  };
  const invalidateLiveProviderModels = (/** @type {string} */ name) => {
    const prefix = `${name}::`;
    const keys = new Set([
      providerCacheScope(name),
      ...liveModelsCache.keys(),
      ...liveModelsGeneration.keys(),
    ]);
    for (const key of keys) {
      if (key === name || key.startsWith(prefix)) {
        liveModelsGeneration.set(key, (liveModelsGeneration.get(key) ?? 0) + 1);
        liveModelsCache.delete(key);
      }
    }
  };
  const liveProviderModelStatus = (/** @type {string} */ name) => {
    const hit = liveModelsCache.get(providerCacheScope(name));
    if (!hit) {
      return Object.freeze({ known: false, reachable: null, count: null });
    }
    return Object.freeze({
      known: true,
      reachable: Array.isArray(hit.list),
      count: Array.isArray(hit.list) ? hit.list.length : null,
      models: Array.isArray(hit.list) ? hit.list.map((entry) => entry.model) : null,
      stale: Date.now() - hit.at >= LIVE_MODELS_TTL_MS,
    });
  };

  // OpenRouter's chat catalog = the user's CURATED selection (Settings →
  // Providers), each id mapped to a picker option. why curated and not the live
  // ~300-model list: the gateway has too many models to dump into a chat
  // dropdown. Until the user curates, fall back to the small static set we KNOW
  // resolves, so a fresh OpenRouter user still gets a working picker (no 404).
  const openrouterChatCatalog = () => {
    const picked = Array.isArray(settingsStore.get().openrouterModels) ? settingsStore.get().openrouterModels : [];
    const ids = picked.filter((/** @type {any} */ id) => typeof id === 'string' && id.trim()).map((/** @type {any} */ id) => id.trim());
    if (ids.length === 0) return MODEL_CATALOG.openrouter;
    return ids.map((/** @type {any} */ id) => ({ model: id, label: id }));
  };

  // Live per-model context window, for the dynamic trim trigger. A model's
  // window is effectively constant for its id, so once we learn it we keep it
  // for the LIFETIME of this service worker — no timer, no TTL. The cache is a
  // plain Map checked lazily when a turn needs the value; the MV3 SW's own
  // frequent teardown (idle reclaim wipes module state) is what eventually
  // re-fetches, so a time-based expiry would be redundant theater on top of it.
  //
  // why NON-BLOCKING: the lookup is a network round-trip and the trigger has a
  // correct static-table fallback, so blocking the turn on it would add latency
  // for no correctness gain. A cache MISS returns undefined (the turn uses the
  // table) and kicks off a one-shot background fetch; the live value refines
  // LATER turns — the mechanical-fallback-then-async-refine shape used
  // elsewhere (trim enrichment). We cache only SUCCESSES; a failed/null lookup
  // is left UNCACHED so a transient failure (locked vault, daemon briefly down)
  // is retried next turn instead of sticking.
  /** @type {Map<string, any>} */ const contextWindowCache = new Map();
  const liveContextWindow = (/** @type {string} */ provider, /** @type {string} */ model) => {
    if (!provider || !model) return undefined;
    const hostScope = provider === 'ollama' ? `::${settingsStore.get().ollamaHost ?? ''}` : '';
    const key = `${provider}${hostScope}::${model}`;
    const hit = contextWindowCache.get(key);
    if (hit && typeof hit.window === 'number') return hit.window; // learned → keep for SW lifetime
    if (hit && hit.fetching) return undefined;                    // in-flight → don't fire a second
    contextWindowCache.set(key, { fetching: true });
    // ollamaHost (issue #104): the live per-model window comes from the daemon's
    // /api/show, so a remote Ollama needs its host or it would query localhost and
    // silently fall back to the static table; other adapters ignore it.
    providerModelContextWindow(provider, model, { getSecret, safeFetch, ollamaHost: settingsStore.get().ollamaHost })
      .then((w) => {
        if (typeof w === 'number') contextWindowCache.set(key, { window: w });
        else contextWindowCache.delete(key); // miss → drop so the next turn retries
      })
      .catch(() => contextWindowCache.delete(key));
    return undefined;
  };

  /**
   * Build the per-chat model options + the currently-selected value
   * (`provider::model`). The side panel shows a picker above the composer when
   * there are 2+ options.
   *
   * Two modes:
   *   - FRESH chat (no sessionId, or the session doesn't exist): every
   *     key-configured provider's catalog + the Settings-configured model;
   *     `selected` follows the active provider; `sessionProvider` is null.
   *   - MID-SESSION (sessionId resolves to a session): scoped to THAT session's
   *     provider only (model-only switching — the provider is fixed once a chat
   *     starts); `selected` is the session's current model and is always present
   *     even if it's a custom id; `sessionProvider` names the locked provider.
   *
   * Keyless/live providers (Ollama): the "has a key" gate becomes "the daemon
   * answered" — its real pulled-model inventory is the catalog. OpenRouter uses
   * the curated catalog above.
   *
   * @param {{ sessionId?: string | null }} [opts]
   */
  const buildModelOptions = async ({ sessionId = null } = {}) => {
    const sess = sessionId ? await sessions.get(sessionId).catch(() => null) : null;
    const lockProvider = sess?.provider ?? null;

    const options = [];
    for (const p of listProviders()) {
      // Mid-session is model-only within the session's provider.
      if (lockProvider && p.name !== lockProvider) continue;
      let hasKey = false;
      if (p.keyless) {
        hasKey = true;
      } else {
        try { hasKey = !!(await vault.getSecret(/** @type {string} */ (p.vaultSecretName))); }
        catch { hasKey = false; }
      }
      // why: when locked to a session whose provider key was since removed we
      // still surface that provider's models (and the current one) rather than
      // render an empty picker; the missing-key skip applies to fresh chats only.
      if (!hasKey && !lockProvider) continue;
      // The local WebGPU model only appears once downloaded + resident (the
      // offscreen engine reports `available`); otherwise selecting it would error
      // on the first turn ("local model not loaded"). Hardware capability is gated
      // earlier, at download time (Settings → WebGPU models).
      if (p.name === 'local-webgpu' && !localModelAvailable()) continue;
      let catalog = (/** @type {any} */ (MODEL_CATALOG))[p.name] ?? [{ model: p.defaultModel, label: p.defaultModel }];
      if (p.name === 'openrouter') catalog = openrouterChatCatalog();
      if (p.liveModels) {
        const live = await liveProviderModels(p.name);
        if (Array.isArray(live) && live.length > 0) catalog = live;
        else if (!lockProvider) continue; // unreachable → offer nothing, not a guess
      }
      for (const c of catalog) {
        options.push({
          provider: p.name,
          providerLabel: p.label,
          model: c.model,
          label: c.label,
          value: `${p.name}::${c.model}`,
        });
      }
      // Append the user's Settings-configured model for this provider if
      // it's a custom id not already in the catalog.
      if (settingsStore.get().providerName === p.name && settingsStore.get().providerModel
          && !options.some((o) => o.value === `${p.name}::${settingsStore.get().providerModel}`)) {
        options.push({
          provider: p.name,
          providerLabel: p.label,
          model: settingsStore.get().providerModel,
          label: `${settingsStore.get().providerModel} (custom)`,
          value: `${p.name}::${settingsStore.get().providerModel}`,
        });
      }
    }

    /** @type {any} */ let selected;
    let sessionProvider = null;
    if (sess?.provider) {
      sessionProvider = sess.provider;
      selected = `${sess.provider}::${sess.model}`;
      // Always keep the session's CURRENT model selectable, even if it's a
      // custom id outside the catalog — otherwise the dropdown would show the
      // wrong value as selected.
      if (!options.some((o) => o.value === selected)) {
        options.push({
          provider: sess.provider,
          providerLabel: listProviders().find((p) => p.name === sess.provider)?.label ?? sess.provider,
          model: sess.model,
          label: `${sess.model} (current)`,
          value: selected,
        });
      }
    } else {
      const active = resolveActiveProvider();
      selected = `${active.name}::${active.model}`;
      // Keep an explicit selection visible even when it is temporarily
      // unavailable. Falling back only the dropdown is dangerous: the first
      // send still binds to the explicit provider, so the UI would promise a
      // different model than the one that actually receives the prompt.
      if (!options.some((o) => o.value === selected)) {
        options.unshift({
          provider: active.name,
          providerLabel: listProviders().find((p) => p.name === active.name)?.label ?? active.name,
          model: active.model,
          label: `${active.model} (currently unavailable)`,
          value: selected,
          unavailable: true,
        });
      }
    }
    return { options, selected, sessionProvider };
  };

  return {
    liveProviderModels,
    liveProviderModelStatus,
    invalidateLiveProviderModels,
    openrouterChatCatalog,
    liveContextWindow,
    buildModelOptions,
  };
};
