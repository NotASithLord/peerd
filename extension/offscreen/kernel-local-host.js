// @ts-check

import {
  LOCAL_MODEL_LABELS,
  OPENROUTER_POPULAR,
  PROVIDER_METADATA,
  PROVIDER_MODEL_CATALOG,
  normalizeOpenRouterModels,
  providerMetadata,
} from '/peerd-provider/controller.js';

class LocalEffectError extends Error {
  /** @param {string} operation @param {any} result */
  constructor(operation, result) {
    super(result?.error ?? result?.code ?? operation);
    this.code = result?.code ?? 'local-effect-failed';
    this.outcomeKnown = result?.outcomeKnown === true;
  }
}
const effect = async (/** @type {any} */ context, /** @type {string} */ operation,
  /** @type {Record<string,unknown>} */ payload) => {
  const result = await context.effects.call(operation, payload);
  if (result?.ok !== true || result.outcomeKnown !== true) throw new LocalEffectError(operation, result);
  return result.value;
};
const cleanModels = (/** @type {unknown} */ rows) => Array.isArray(rows)
  ? rows.slice(0, 200).flatMap((row) => {
      const source = row && typeof row === 'object' ? /** @type {any} */ (row) : null;
      const model = typeof source?.model === 'string' ? source.model.trim()
        : typeof source?.name === 'string' ? source.name.trim() : '';
      const label = typeof source?.label === 'string' ? source.label.trim() : model;
      return model && model.length <= 200 && label.length <= 300 ? [{ model, label }] : [];
    }) : [];
const projectionJson = (/** @type {any} */ projection) => {
  if (!projection || !(projection.body instanceof Uint8Array)) return null;
  try { return JSON.parse(new TextDecoder().decode(projection.body)); }
  catch { return null; }
};
const observeOllama = async (/** @type {any} */ context,
  /** @type {{status?:number,body?:Uint8Array}|null} */ projection) => {
  const reachable = !!projection && Number(projection.status) >= 200
    && Number(projection.status) < 300;
  const body = reachable ? projectionJson(projection) : null;
  const models = reachable ? cleanModels(body?.models).map((row) => row.model) : null;
  await effect(context, 'local.models.observe-ollama', {
    known: true,
    reachable,
    count: models?.length ?? null,
    models,
  });
  return { body, models: models ?? [] };
};

const modelOptions = async (/** @type {any} */ message, /** @type {any} */ context) => {
  const snapshot = await effect(context, 'local.models.snapshot', {
    sessionId: typeof message?.sessionId === 'string' ? message.sessionId : null,
  });
  const settings = snapshot.settings;
  const lockedProvider = snapshot.session?.provider ?? null;
  /** @type {Array<any>} */ const options = [];
  for (const provider of PROVIDER_METADATA) {
    if (!snapshot.localModels && provider.name === 'local-webgpu') continue;
    if (lockedProvider && provider.name !== lockedProvider) continue;
    if (!snapshot.usable.includes(provider.name) && !lockedProvider) continue;
    let catalog = cleanModels(PROVIDER_MODEL_CATALOG[/** @type {keyof typeof PROVIDER_MODEL_CATALOG} */ (provider.name)]
      ?? [{ model: provider.defaultModel, label: provider.defaultModel }]);
    if (provider.name === 'openrouter') {
      const curated = cleanModels((Array.isArray(settings.openrouterModels)
        ? settings.openrouterModels : []).map((/** @type {any} */ model) => ({ model, label: model })));
      if (curated.length) catalog = curated;
    } else if (provider.name === 'local-webgpu') {
      catalog = snapshot.downloaded.map((/** @type {any} */ model) => ({
        model, label: LOCAL_MODEL_LABELS[/** @type {keyof typeof LOCAL_MODEL_LABELS} */ (model)],
      }));
      if (!catalog.length) continue;
    } else if (provider.name === 'ollama') {
      const reply = await effect(context, 'local.models.ollama', {});
      const observed = await observeOllama(context, reply);
      catalog = cleanModels(observed.body?.models);
      if (!catalog.length && !lockedProvider) continue;
      if (!catalog.length) catalog = [{ model: provider.defaultModel, label: provider.defaultModel }];
    }
    for (const item of catalog) options.push({
      provider: provider.name, providerLabel: provider.label,
      model: item.model, label: item.label, value: `${provider.name}::${item.model}`,
    });
    const configured = settings.providerName === provider.name
      && typeof settings.providerModel === 'string' ? settings.providerModel.trim() : '';
    if (configured && !options.some((row) => row.value === `${provider.name}::${configured}`)) {
      options.push({ provider: provider.name, providerLabel: provider.label,
        model: configured, label: `${configured} (custom)`, value: `${provider.name}::${configured}` });
    }
  }
  const active = lockedProvider
    ? { name: lockedProvider, model: snapshot.session?.model }
    : (() => {
        const configured = providerMetadata(settings.providerName);
        if (configured) return {
          name: configured.name,
          model: settings.providerModel || configured.defaultModel,
        };
        const first = options[0];
        return first ? { name: first.provider, model: first.model } : { name: '', model: '' };
      })();
  if (!active.name || !active.model) {
    return { ok: false, error: 'no-provider', options: [], selected: '',
      sessionProvider: lockedProvider };
  }
  const selected = `${active.name}::${active.model}`;
  if (!options.some((row) => row.value === selected)) {
    const policy = providerMetadata(active.name);
    options.unshift({ provider: active.name, providerLabel: policy?.label ?? active.name,
      model: active.model, label: `${active.model} (${lockedProvider ? 'current' : 'currently unavailable'})`,
      value: selected, ...(!lockedProvider ? { unavailable: true } : {}) });
  }
  return { ok: true, options, selected, sessionProvider: lockedProvider };
};

const providerStateProjection = (/** @type {any} */ snapshot) => {
  const settings = snapshot?.settings ?? {};
  const session = snapshot?.session ?? null;
  const defaults = providerMetadata(settings.providerName) ?? PROVIDER_METADATA[0];
  const defaultModel = typeof settings.providerModel === 'string' && settings.providerModel.trim()
    ? settings.providerModel.trim() : defaults.defaultModel;
  const selected = providerMetadata(session?.provider ?? defaults.name);
  const composerModel = typeof session?.model === 'string' && session.model.trim()
    ? session.model : selected?.name === defaults.name
      ? defaultModel : selected?.defaultModel ?? '';
  const credentialReady = !!selected && snapshot.usable?.includes(selected.name);
  const localReady = selected?.name !== 'local-webgpu'
    || snapshot.localModels === true && snapshot.downloaded?.includes(composerModel);
  const liveOllama = snapshot.ollamaStatus ?? null;
  const ollamaNoModels = selected?.name === 'ollama'
    && liveOllama?.known && liveOllama.reachable && liveOllama.count === 0;
  const ollamaModelMissing = selected?.name === 'ollama'
    && liveOllama?.known && liveOllama.reachable
    && Array.isArray(liveOllama.models) && liveOllama.models.length > 0
    && !liveOllama.models.includes(composerModel)
    && !(!composerModel.split('/').at(-1)?.includes(':')
      && liveOllama.models.includes(`${composerModel}:latest`));
  const reason = snapshot.locked === true ? 'vault-locked' : !selected ? 'unknown-provider'
    : !credentialReady ? 'missing-key'
      : !localReady ? 'local-model-not-installed'
        : ollamaNoModels ? 'ollama-no-models'
          : ollamaModelMissing ? 'ollama-model-missing' : null;
  return {
    providers: {
      current: defaults.name,
      hasKey: snapshot.usable?.includes(defaults.name) === true,
      model: defaultModel,
      defaultRunnerModel: defaults.defaultRunnerModel,
      configRevision: Number(snapshot.configRevision) || 0,
    },
    composer: {
      provider: selected?.name ?? String(session?.provider ?? ''),
      model: composerModel,
      keyless: selected?.keyless === true,
      credentialReady,
      localReady,
      ollamaReady: !ollamaNoModels && !ollamaModelMissing,
      canSend: reason === null,
      reason,
      warning: reason === null && selected?.name === 'ollama'
        && liveOllama?.known && liveOllama.reachable === false
        ? 'ollama-unreachable' : null,
    },
  };
};

const modelRoute = (/** @type {string} */ method,
  /** @type {(message:any)=>Record<string,unknown>} */ project) => (
  /** @type {any} */ message = {}, /** @type {any} */ context,
) => effect(context, `local.model.${method}`, project(message));

const testProvider = async (/** @type {any} */ message, /** @type {any} */ context) => {
  const policy = providerMetadata(message.provider);
  if (!policy) return { ok: false, error: 'unknown-provider' };
  if (policy.name === 'local-webgpu') return { ok: false, error: 'no-live-test' };
  if (policy.name === 'ollama') {
    const observed = await observeOllama(
      context, await effect(context, 'local.models.ollama', {}),
    );
    return observed.models.length > 0 ? {
      ok: true, reachable: true, models: observed.models.length,
    } : observed.body ? {
      ok: false, reachable: true, error: 'no-models', models: 0,
    } : { ok: false, error: 'unreachable' };
  }
  const nativeBody = {
    model: policy.defaultModel,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    ...(policy.name === 'anthropic' ? { system: '' } : {}),
  };
  const result = await effect(context, 'local.provider.test', {
    provider: policy.name,
    model: policy.defaultModel,
    nativeBody,
  });
  if (result.error) return result;
  if (result.status >= 300 && result.status < 400) return { ok: false, error: 'unreachable' };
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, error: result.status === 401 ? 'invalid-key' : `http-${result.status}` };
  }
  return { ok: true };
};

const listOpenRouterModels = async (/** @type {any} */ context) => {
  const result = await effect(context, 'local.openrouter.models', {});
  if (result.error) return result;
  if (result.status < 200 || result.status >= 300) return {
    ok: false, status: result.status,
    error: result.status === 401 || result.status === 403 ? 'invalid-key' : 'unreachable',
  };
  return { ok: true, models: normalizeOpenRouterModels(projectionJson(result)),
    popular: OPENROUTER_POPULAR };
};

export const routes = Object.freeze({
  'provider/test': testProvider,
  'models/options': modelOptions,
  'models/state-projection': (/** @type {any} */ message) => providerStateProjection(message),
  'openrouter/models': (/** @type {any} */ _message, /** @type {any} */ context) =>
    listOpenRouterModels(context),
  'local-model/status': modelRoute('status', ({ model, includeSupport }) => ({
    model: typeof model === 'string' ? model : null, includeSupport: includeSupport === true,
  })),
  'local-model/catalog': modelRoute('catalog', ({ includeSupport }) => ({
    includeSupport: includeSupport !== false,
  })),
  'local-model/probe': modelRoute('probe', () => ({})),
  'local-model/init': modelRoute('init', ({ model }) => ({
    model: typeof model === 'string' ? model : null,
  })),
});
