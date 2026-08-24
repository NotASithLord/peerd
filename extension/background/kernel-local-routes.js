// @ts-check
import {
  LOCAL_MODEL_LABELS,
  OPENROUTER_POPULAR,
  PROVIDER_AUTHORITY,
  PROVIDER_MODEL_CATALOG,
  normalizeOpenRouterModels,
  providerAuthority,
} from '../shared/provider-authority-policy.js';
import {
  LOCAL_MODEL_CHANNEL_OFFER,
  LOCAL_MODEL_CHANNEL_PROTOCOL,
  LOCAL_MODEL_CHANNEL_RESULT,
  localModelMethodIsRead,
  parseLocalModelChannelOffer,
} from '../shared/feature-lease-protocol.js';

/** @param {any} deps */
export const makeKernelProviderSetKeyRoute = ({
  vault, settingsStore, auditLog, pushState,
}) => async (/** @type {any} */ message = {}) => {
  const policy = providerAuthority(message.provider);
  if (!policy) return { ok: false, error: 'unknown-provider' };
  if (policy.secretName === null) return { ok: false, error: 'keyless-provider' };
  const key = typeof message.plaintext === 'string' ? message.plaintext.trim() : '';
  if (key.length < 8) return { ok: false, error: 'key-too-short' };
  try {
    const prior = await vault.getSecret(policy.secretName);
    if (prior !== key) {
      await vault.setSecret(policy.secretName, key);
      auditLog.append({ type: 'provider_added', details: { provider: policy.name } }).catch(() => {});
    }
    const active = providerAuthority(settingsStore.get().providerName);
    let activeUsable = active?.secretName === null;
    if (!activeUsable && active?.secretName) {
      try { activeUsable = !!(await vault.getSecret(active.secretName)); }
      catch { activeUsable = false; }
    }
    if (message.activate !== false && !activeUsable && active?.name !== policy.name) {
      await settingsStore.update({ providerName: policy.name, providerModel: '' });
    }
    Promise.resolve(pushState()).catch(() => {});
    return { ok: true };
  } catch (cause) {
    if (vault.isLocked?.()) return { ok: false, error: 'locked' };
    const unknown = cause instanceof Error ? cause : new Error(String(cause));
    Object.assign(unknown, { outcomeKnown: false });
    throw unknown;
  }
};

const cleanModels = (/** @type {unknown} */ rows) => Array.isArray(rows)
  ? rows.slice(0, 200).flatMap((row) => {
      const source = row && typeof row === 'object' ? /** @type {any} */ (row) : null;
      const model = typeof source?.model === 'string' ? source.model.trim()
        : typeof source?.name === 'string' ? source.name.trim() : '';
      const label = typeof source?.label === 'string' ? source.label.trim() : model;
      return model && model.length <= 200 && label.length <= 300 ? [{ model, label }] : [];
    }) : [];
const ollamaTagsUrl = (/** @type {any} */ value) => {
  try {
    const origin = new URL(value || 'http://localhost:11434');
    return ['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password
      ? new URL('/api/tags', origin.origin) : null;
  } catch { return null; }
};

/**
 * One exact, lease-bound request to the lazy offscreen WebGPU owner. The
 * service worker never imports the model engine and no extension-wide reply
 * race is possible.
 * @param {any} deps
 */
export const makeKernelLocalModelRoutes = ({
  featureHost, offscreenUrl, pushState, available = true,
  clientsApi = (/** @type {any} */ (globalThis)).clients,
  createChannel = () => new MessageChannel(),
  timeoutMs = 15_000, newId = () => crypto.randomUUID(),
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
}) => {
  const unavailable = () => ({
    ok: false, error: 'runtime_capability_unavailable', performed: false,
    facility: 'localWebGpuHost', reasonCode: 'host_unsupported', retryable: false,
    alternative: 'use_ollama',
  });
  let catalogSignature = '';
  const call = async (/** @type {string} */ method, /** @type {any} */ args, /** @type {any} */ lease) => {
    const matches = (await clientsApi.matchAll({ type: 'window', includeUncontrolled: true }))
      .filter((/** @type {any} */ client) => client?.url === offscreenUrl);
    if (matches.length !== 1) throw Object.assign(new Error('local model host unavailable'), {
      outcomeKnown: true, code: 'local-model-host-unavailable',
    });
    const offer = {
      type: LOCAL_MODEL_CHANNEL_OFFER, protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
      channelId: newId(), method, args, lease,
    };
    if (!parseLocalModelChannelOffer(offer)) throw new Error('local model offer invalid');
    const { port1, port2 } = createChannel();
    return new Promise((resolve, reject) => {
      let settled = false;
      let dispatched = false;
      const finish = (/** @type {any} */ value, /** @type {boolean} */ ok) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timer);
        try { port1.close(); } catch {}
        if (ok) resolve(value); else reject(value);
      };
      const lost = (/** @type {string} */ code) => finish(Object.assign(
        new Error('local model host response was lost'), {
          code, outcomeKnown: localModelMethodIsRead(method) || !dispatched,
          ...(localModelMethodIsRead(method) || !dispatched ? {} : {
            outcomeKind: 'unknown', retryable: false,
          }),
        },
      ), false);
      const timer = setTimeoutFn(() => lost('local-model-host-timeout'), timeoutMs);
      port1.onmessage = (/** @type {MessageEvent} */ event) => {
        const reply = event.data;
        if (reply?.type !== LOCAL_MODEL_CHANNEL_RESULT
            || reply.protocol !== LOCAL_MODEL_CHANNEL_PROTOCOL
            || reply.channelId !== offer.channelId || typeof reply.ok !== 'boolean') return;
        const { type: _type, protocol: _protocol, channelId: _channelId, ...result } = reply;
        finish(result, true);
      };
      port1.onmessageerror = () => lost('local-model-host-reply-invalid');
      port1.addEventListener?.('close', () => lost('local-model-host-channel-closed'), { once: true });
      port1.start();
      try { matches[0].postMessage(offer, [port2]); dispatched = true; }
      catch { lost('local-model-host-dispatch-failed'); }
    });
  };
  const run = async (/** @type {string} */ method, /** @type {any} */ args = {}) => {
    if (!available) return unavailable();
    let entered = false;
    const result = await featureHost.runtime.runWithLease('model-host', async (/** @type {any} */ lease) => {
      entered = true;
      return call(method, args, lease);
    }, { reason: 'local-model-demand' });
    return entered ? result : result?.ok === false ? result : unavailable();
  };
  const init = async (/** @type {any} */ args = {}) => {
    if (!available) return unavailable();
    const lease = await featureHost.runtime.acquire('model-host', {
      reason: 'local-model-resident',
    });
    if (!lease?.ok) return lease;
    return call('init', args, lease.lease);
  };
  const observe = async (/** @type {string} */ method, /** @type {any} */ args = {}) => {
    const reply = await run(method, args);
    if (reply?.ok && (method === 'catalog' || method === 'status')) {
      const rows = method === 'catalog' ? reply.models : [reply];
      const signature = JSON.stringify(rows?.map((/** @type {any} */ row) =>
        [row?.model, !!row?.downloaded, !!row?.available, !!row?.loading]));
      if (signature !== catalogSignature) {
        catalogSignature = signature;
        void Promise.resolve(pushState()).catch(() => {});
      }
    }
    return reply;
  };
  return Object.freeze({
    'local-model/status': (/** @type {any} */ message = {}) => observe('status', {
      model: message.model, includeSupport: message.includeSupport === true,
    }),
    'local-model/catalog': (/** @type {any} */ message = {}) => observe('catalog', {
      includeSupport: message.includeSupport !== false,
    }),
    'local-model/probe': () => run('probe'),
    'local-model/init': (/** @type {any} */ message = {}) => init({ model: message.model }),
  });
};

/** @param {any} deps */
export const makeKernelModelOptionsRoute = ({
  ready, vault, settingsStore, sessions, browser, fetchFn = globalThis.fetch.bind(globalThis),
  localModels = true, timeoutMs = 12_000, onOllamaStatus = () => {},
}) => async (/** @type {{sessionId?:unknown}} */ message = {}) => {
  await ready;
  const settings = settingsStore.get();
  const sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
  const session = sessionId
    ? await (sessions.getMetadata?.(sessionId) ?? sessions.get(sessionId)).catch(() => null) : null;
  const lockedProvider = typeof session?.provider === 'string' ? session.provider : null;
  let downloaded = [];
  if (localModels) {
    try {
      const raw = (await browser.storage.local.get('localModelDownloaded'))?.localModelDownloaded;
      downloaded = raw === true ? ['gemma-4-e2b']
        : Array.isArray(raw) ? raw.filter((id) => Object.hasOwn(LOCAL_MODEL_LABELS, id)) : [];
    } catch { downloaded = []; }
  }
  /** @type {Array<any>} */ const options = [];
  for (const provider of PROVIDER_AUTHORITY) {
    if (!localModels && provider.name === 'local-webgpu') continue;
    if (lockedProvider && provider.name !== lockedProvider) continue;
    let usable = provider.secretName === null;
    if (provider.secretName) {
      try { usable = !!(await vault.getSecret(provider.secretName)); } catch { usable = false; }
    }
    if (!usable && !lockedProvider) continue;
    /** @type {readonly {model:string,label:string}[]} */
    const fixed = /** @type {Record<string,readonly any[]>} */ (PROVIDER_MODEL_CATALOG)[provider.name];
    let catalog = cleanModels(fixed ?? [
      { model: provider.defaultModel, label: provider.defaultModel },
    ]);
    if (provider.name === 'openrouter') {
      const curated = cleanModels((Array.isArray(settings.openrouterModels)
        ? settings.openrouterModels : []).map((/** @type {unknown} */ model) => ({ model, label: model })));
      if (curated.length) catalog = curated;
    } else if (provider.name === 'local-webgpu') {
      catalog = downloaded.map((model) => ({
        model, label: LOCAL_MODEL_LABELS[/** @type {keyof typeof LOCAL_MODEL_LABELS} */ (model)],
      }));
      if (!catalog.length) continue;
    } else if (provider.name === 'ollama') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort('ollama-model-options-timeout'), timeoutMs);
      /** @type {{known:boolean,reachable:boolean,count:number|null,models:string[]|null}} */
      let status = { known: true, reachable: false, count: null, models: null };
      try {
        const url = ollamaTagsUrl(settings.ollamaHost);
        if (!url) throw new Error();
        const response = await fetchFn(url, {
          signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
        });
        if (!response.ok || (response.status >= 300 && response.status < 400)) throw new Error();
        catalog = cleanModels((await boundedJson(response))?.models);
        status = {
          known: true, reachable: true, count: catalog.length,
          models: catalog.map((row) => row.model),
        };
      } catch { catalog = []; }
      finally { clearTimeout(timer); onOllamaStatus(status); }
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
    ? { name: lockedProvider, model: session?.model }
    : (() => {
        const chosen = providerAuthority(settings.providerName)
          ?? PROVIDER_AUTHORITY.find((row) => row.name === 'anthropic') ?? PROVIDER_AUTHORITY[0];
        return { name: chosen.name, model: settings.providerModel || chosen.defaultModel };
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

const PROVIDER_PROBE_MAX_BYTES = 512 * 1024;
const boundedJson = async (/** @type {Response} */ response,
  /** @type {number} */ maxBytes = PROVIDER_PROBE_MAX_BYTES) => {
  const reader = response.body?.getReader();
  if (!reader) return null;
  /** @type {Uint8Array[]} */ const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel('provider response too large').catch(() => {});
      throw new Error('provider-response-too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
};

/** @param {any} deps */
export const createKernelOpenRouterModelsRoute = ({
  ready, vault, fetchFn = globalThis.fetch.bind(globalThis), timeoutMs = 12_000,
  maxBytes = 4 * 1024 * 1024, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
}) => {
  /** @type {Promise<any>|null} */ let pending = null;
  /** @type {AbortController|null} */ let controller = null;
  const run = async () => {
    if (vault.isLocked?.()) return { ok: false, status: null, error: 'locked' };
    const active = new AbortController();
    controller = active;
    const timeout = setTimeoutFn(() => active.abort('openrouter-models-timeout'), timeoutMs);
    const aborted = new Promise((_, reject) => active.signal.addEventListener('abort', () =>
      reject(new Error('openrouter-models-aborted')), { once: true }));
    try {
      await Promise.race([ready, aborted]);
      if (active.signal.aborted || vault.isLocked?.()) throw new Error('openrouter-models-aborted');
      let key = null;
      try { key = await Promise.race([vault.getSecret('openrouter_api_key'), aborted]); }
      catch (cause) {
        if (active.signal.aborted || vault.isLocked?.()) throw cause;
        key = null;
      }
      if (active.signal.aborted || vault.isLocked?.()) throw new Error('openrouter-models-aborted');
      /** @type {Record<string,string>} */
      const headers = {
        'http-referer': 'https://peerd.ai', 'x-title': 'peerd.ai',
        'x-openrouter-categories': 'personal-agent',
      };
      if (typeof key === 'string' && key) headers.authorization = `Bearer ${key}`;
      const response = await fetchFn('https://openrouter.ai/api/v1/models', {
        method: 'GET', headers, signal: active.signal,
        redirect: 'manual', credentials: 'omit', cache: 'no-store',
      });
      if (!response.ok || response.status >= 300 && response.status < 400) {
        await response.body?.cancel('openrouter models refused').catch(() => {});
        const status = response.status;
        return { ok: false, status,
          error: status === 401 || status === 403 ? 'invalid-key' : 'unreachable' };
      }
      const models = normalizeOpenRouterModels(await boundedJson(response, maxBytes));
      return { ok: true, models, popular: OPENROUTER_POPULAR };
    } catch {
      return { ok: false, status: null, error: vault.isLocked?.() ? 'locked' : 'unreachable' };
    } finally {
      clearTimeoutFn(timeout);
      if (controller === active) controller = null;
    }
  };
  const route = () => pending ??= run().finally(() => { pending = null; });
  const abortAll = () => controller?.abort('vault-locked');
  return Object.freeze({ route, abortAll });
};

/** @param {any} deps */
export const createKernelProviderTestRoute = ({
  ready, vault, settingsStore, auditLog, fetchFn = globalThis.fetch.bind(globalThis),
  timeoutMs = 20_000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
  onOllamaStatus = () => {},
}) => {
  /** @type {Map<string,Promise<any>>} */ const pending = new Map();
  /** @type {Set<AbortController>} */ const controllers = new Set();
  const abortAll = () => {
    for (const controller of controllers) controller.abort('vault-locked');
    controllers.clear();
  };
  const run = async (/** @type {NonNullable<ReturnType<typeof providerAuthority>>} */ policy) => {
    await ready;
    if (vault.isLocked?.()) return { ok: false, error: 'locked' };
    if (policy.probeKind === 'none') return { ok: false, error: 'no-live-test' };
    let key = null;
    if (policy.probeKind !== 'ollama') {
      try { key = policy.secretName ? await vault.getSecret(policy.secretName) : null; }
      catch { return { ok: false, error: 'locked' }; }
      if (!key) return { ok: false, error: 'no-key' };
    }
    /** @type {string|null} */ let url = policy.probeEndpoint;
    /** @type {RequestInit} */ let init;
    if (policy.probeKind === 'ollama') {
      url = ollamaTagsUrl(settingsStore.get().ollamaHost)?.toString() ?? null;
      if (!url) return { ok: false, error: 'unreachable' };
      init = { method: 'GET' };
    } else {
      const anthropic = policy.probeKind === 'anthropic';
      init = {
        method: 'POST',
        headers: anthropic ? {
          'content-type': 'application/json', 'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        } : {
          'content-type': 'application/json', authorization: `Bearer ${key}`,
          ...(policy.name === 'openrouter' ? {
            'http-referer': 'https://peerd.ai', 'x-title': 'peerd.ai',
            'x-openrouter-categories': 'personal-agent',
          } : {}),
        },
        body: JSON.stringify({
          model: policy.defaultModel, max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }], stream: true,
        }),
      };
    }
    if (vault.isLocked?.()) return { ok: false, error: 'locked' };
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeoutFn(() => controller.abort('provider-test-timeout'), timeoutMs);
    try {
      const response = await fetchFn(url, {
        ...init, signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel('provider redirect blocked').catch(() => {});
        return { ok: false, error: 'unreachable' };
      }
      if (!response.ok) {
        await response.body?.cancel('provider test refused').catch(() => {});
        return { ok: false, error: response.status === 401 ? 'invalid-key' : `http-${response.status}` };
      }
      if (policy.probeKind === 'ollama') {
        const body = await boundedJson(response);
        const modelIds = Array.isArray(body?.models)
          ? body.models.flatMap((/** @type {any} */ row) =>
            typeof row?.name === 'string' && row.name ? [row.name] : []) : [];
        const models = modelIds.length;
        onOllamaStatus({ known: true, reachable: true, count: models, models: modelIds });
        auditLog.append({ type: 'provider_validated', details: { provider: policy.name } }).catch(() => {});
        return models > 0 ? { ok: true, reachable: true, models }
          : { ok: false, reachable: true, error: 'no-models', models: 0 };
      }
      await response.body?.cancel('provider key verified').catch(() => {});
      auditLog.append({ type: 'provider_validated', details: { provider: policy.name } }).catch(() => {});
      return { ok: true };
    } catch {
      return { ok: false, error: 'provider-test-unconfirmed',
        outcomeKnown: false, outcomeKind: 'unknown', retryable: false };
    } finally {
      clearTimeoutFn(timer);
      controllers.delete(controller);
    }
  };
  const route = (/** @type {any} */ message = {}) => {
    const policy = providerAuthority(message.provider);
    if (!policy) return Promise.resolve({ ok: false, error: 'unknown-provider' });
    const active = pending.get(policy.name);
    if (active) return active;
    const operation = run(policy).finally(() => pending.delete(policy.name));
    pending.set(policy.name, operation);
    return operation;
  };
  return Object.freeze({ route, abortAll });
};

/** @param {{vault:any,auditLog:any,
 * ready:Promise<any>,settingsStore:any,pushState:()=>Promise<any>|any,
 * fetchFn?:typeof fetch,
 * sessions?:any,browser?:any,localModels?:boolean,featureHost?:any,offscreenUrl?:string,
 * providerProjection:{view:(session?:any,locked?:boolean)=>Promise<any>,
 * observeOllamaStatus:(status:any)=>void,bumpRevision:()=>void}}} deps */
export const createKernelLocalRoutes = ({
  vault, auditLog, ready, settingsStore, pushState,
  fetchFn, sessions, browser, localModels,
  featureHost, offscreenUrl, providerProjection,
}) => {
  if (!providerProjection) throw new TypeError('providerProjection is required');
  const openRouterModels = createKernelOpenRouterModelsRoute({ ready, vault, fetchFn });
  const onOllamaStatus = providerProjection.observeOllamaStatus;
  const providerTest = createKernelProviderTestRoute({
    ready, vault, settingsStore, auditLog, fetchFn, onOllamaStatus,
  });
  const providerSetKey = makeKernelProviderSetKeyRoute({
    vault, settingsStore, auditLog, pushState: () => {},
  });
  const localModelRoutes = makeKernelLocalModelRoutes({
    featureHost, offscreenUrl, pushState, available: localModels,
  });
  const providerSetKeyRoute = async (/** @type {any} */ message = {}) => {
    const result = await providerSetKey(message);
    if (result.ok) {
      providerProjection.bumpRevision();
      await Promise.resolve(pushState());
    }
    return result;
  };
  const modelOptions = makeKernelModelOptionsRoute({
    ready, vault, settingsStore, sessions, browser, fetchFn, localModels, onOllamaStatus,
  });
  const routes = Object.freeze({
    'provider/setKey': providerSetKeyRoute,
    'provider/test': providerTest.route,
    'models/options': modelOptions,
    'openrouter/models': openRouterModels.route,
    ...localModelRoutes,
  });
  return Object.freeze({
    routes, localModelRoutes, providerSetKey: providerSetKeyRoute,
    modelOptions, openRouterModels: openRouterModels.route, providerTest: providerTest.route,
    abortProviderTests: () => { providerTest.abortAll(); openRouterModels.abortAll(); },
  });
};
