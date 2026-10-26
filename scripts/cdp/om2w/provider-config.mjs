// @ts-check
// Keep benchmark authentication separate from the task/export loop: a local
// inference endpoint must never require, or receive, a cloud provider's key.

const KEY_ENV = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
});

/**
 * @param {{ provider: string, model?: string, runnerModel?: string, ollamaHost?: string, smoke?: boolean,
 *   env?: Record<string, string | undefined> }} options
 */
export const resolveOm2wProviderConfig = ({
  provider, model = '', runnerModel = '', ollamaHost = '', smoke = false, env = {},
}) => {
  if (provider === 'local-webgpu') {
    // why: launchPeerd creates a fresh browser profile, with no cached weights.
    // Claiming keyless support without loading the engine would measure failures.
    throw new Error('local-webgpu needs downloaded weights and a loaded WebGPU engine; this fresh-profile driver does not initialize it. Use the Eval Lab in a prepared browser, or --provider=ollama.');
  }
  if (provider !== 'ollama' && !Object.hasOwn(KEY_ENV, provider)) {
    throw new Error('--provider must be anthropic, openrouter, or ollama');
  }
  if (smoke && provider !== 'ollama') {
    throw new Error('--smoke uses the keyless Ollama wire fixture; omit --provider or use --provider=ollama');
  }
  const keyless = provider === 'ollama';
  /** @type {{ providerName: string, providerModel?: string, runnerModel?: string, ollamaHost?: string }} */
  const settingsPatch = { providerName: provider };
  if (model) settingsPatch.providerModel = model;
  if (runnerModel.trim()) settingsPatch.runnerModel = runnerModel.trim();
  if (ollamaHost) {
    if (!keyless) throw new Error('--ollama-host requires --provider=ollama');
    let url;
    try { url = new URL(ollamaHost); }
    catch { throw new Error('--ollama-host must be an HTTP(S) origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('--ollama-host must be an HTTP(S) origin without credentials, path, query, or fragment');
    }
    settingsPatch.ollamaHost = url.origin;
  }
  // why provider-specific fallback: an Anthropic key in the environment must
  // never be stored as an OpenRouter key (or sent to an Ollama-compatible shim).
  const keyName = KEY_ENV[/** @type {keyof typeof KEY_ENV} */ (provider)];
  const key = keyless ? '' : env.PEERD_BENCH_KEY || env[keyName] || '';
  if (!keyless && !key) {
    throw new Error(`no ${provider} key: set PEERD_BENCH_KEY or ${keyName}, or use --provider=ollama for local inference`);
  }
  return { provider, model, keyless, key, settingsPatch };
};

/**
 * @param {(message: any) => Promise<any>} send
 * @param {ReturnType<typeof resolveOm2wProviderConfig>} config
 * @param {string} [actorSurface]
 */
export const configureOm2wProvider = async (send, config, actorSurface = '') => {
  if (!config.keyless) {
    const set = await send({ type: 'provider/setKey', provider: config.provider, plaintext: config.key });
    if (!set?.ok) throw new Error(`provider/setKey failed: ${JSON.stringify(set)}`);
  }
  const patch = {
    ...config.settingsPatch,
    ...(actorSurface ? { webActorActionSurface: actorSurface } : {}),
  };
  const updated = await send({ type: 'settings/update', patch });
  if (!updated?.ok) throw new Error(`settings/update failed: ${JSON.stringify(updated)}`);
};

/**
 * launchPeerd defaults to intercepting the Ollama wire even without a responder.
 * Only explicit smoke runs may use that fixture; a real local benchmark must
 * reach the configured daemon instead of receiving a fabricated smoke answer.
 * @param {(options: any) => Promise<any>} launch
 * @param {{ smoke?: boolean, modelResponder?: (index: number, request: any) => any }} options
 */
export const launchOm2wBrowser = (launch, { smoke = false, modelResponder } = {}) => {
  if (smoke && typeof modelResponder !== 'function') {
    throw new Error('smoke mode requires an explicit model responder');
  }
  if (!smoke && modelResponder !== undefined) {
    throw new Error('real benchmark runs cannot install a model responder');
  }
  return launch({
    interceptModel: smoke,
    ...(smoke ? { modelResponder } : {}),
  });
};
