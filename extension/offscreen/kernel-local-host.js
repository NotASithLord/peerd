// @ts-check

import {
  LOCAL_MODEL_LABELS,
  OPENROUTER_POPULAR,
  PROVIDER_AUTHORITY,
  PROVIDER_MODEL_CATALOG,
  normalizeOpenRouterModels,
  providerAuthority,
} from '/shared/provider-authority-policy.js';

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

const modelOptions = async (/** @type {any} */ message, /** @type {any} */ context) => {
  const snapshot = await effect(context, 'local.models.snapshot', {
    sessionId: typeof message?.sessionId === 'string' ? message.sessionId : null,
  });
  const settings = snapshot.settings;
  const lockedProvider = snapshot.session?.provider ?? null;
  /** @type {Array<any>} */ const options = [];
  for (const provider of PROVIDER_AUTHORITY) {
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
      catalog = cleanModels(reply.models);
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
        const selected = providerAuthority(settings.providerName)
          ?? PROVIDER_AUTHORITY.find((row) => row.name === 'anthropic') ?? PROVIDER_AUTHORITY[0];
        return { name: selected.name, model: settings.providerModel || selected.defaultModel };
      })();
  const selected = `${active.name}::${active.model}`;
  if (!options.some((row) => row.value === selected)) {
    const policy = providerAuthority(active.name);
    options.unshift({ provider: active.name, providerLabel: policy?.label ?? active.name,
      model: active.model, label: `${active.model} (${lockedProvider ? 'current' : 'currently unavailable'})`,
      value: selected, ...(!lockedProvider ? { unavailable: true } : {}) });
  }
  return { ok: true, options, selected, sessionProvider: lockedProvider };
};

const modelRoute = (/** @type {string} */ method,
  /** @type {(message:any)=>Record<string,unknown>} */ project) => (
  /** @type {any} */ message = {}, /** @type {any} */ context,
) => effect(context, `local.model.${method}`, project(message));

const testProvider = async (/** @type {any} */ message, /** @type {any} */ context) => {
  const policy = providerAuthority(message.provider);
  if (!policy) return { ok: false, error: 'unknown-provider' };
  const result = await effect(context, 'local.provider.test', { provider: policy.name });
  if (result.error) return result;
  if (result.status >= 300 && result.status < 400) return { ok: false, error: 'unreachable' };
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, error: result.status === 401 ? 'invalid-key' : `http-${result.status}` };
  }
  if (policy.probeKind === 'ollama') {
    const models = Array.isArray(result.body?.models)
      ? result.body.models.filter((/** @type {any} */ row) =>
        typeof row?.name === 'string' && row.name).length : 0;
    return models > 0 ? { ok: true, reachable: true, models }
      : { ok: false, reachable: true, error: 'no-models', models: 0 };
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
  return { ok: true, models: normalizeOpenRouterModels(result.body), popular: OPENROUTER_POPULAR };
};

export const routes = Object.freeze({
  'provider/test': testProvider,
  'models/options': modelOptions,
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
