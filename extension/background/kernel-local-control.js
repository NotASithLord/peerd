// @ts-check

import {
  LOCAL_MODEL_LABELS,
  providerAuthority,
} from '../shared/provider-authority-policy.js';
import {
  LOCAL_MODEL_CHANNEL_OFFER,
  LOCAL_MODEL_CHANNEL_PROTOCOL,
  LOCAL_MODEL_CHANNEL_RESULT,
  localModelMethodIsRead,
  parseLocalModelChannelOffer,
} from '../shared/feature-lease-protocol.js';
import { KERNEL_LOCAL_ROUTE_NAMES } from '../shared/kernel-feature-route-inventory.js';
import { createKernelFeatureControl } from './kernel-feature-control.js';

const success = (/** @type {unknown} */ value) => Object.freeze({
  ok: true, outcomeKnown: true, value,
});
const failure = (/** @type {string} */ code, /** @type {boolean} */ outcomeKnown,
  /** @type {unknown} */ cause = undefined) => Object.freeze({
  ok: false, code, outcomeKnown,
  error: /** @type {{message?:string}} */ (cause)?.message ?? code,
});
const same = (/** @type {unknown} */ left, /** @type {unknown} */ right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
};
const readJson = async (/** @type {Response} */ response, maxBytes = 512 * 1024) => {
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
const ollamaUrl = (/** @type {unknown} */ value) => {
  try {
    const origin = new URL(String(value || 'http://localhost:11434'));
    return ['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password
      ? new URL('/api/tags', origin.origin) : null;
  } catch { return null; }
};
const boundedFetch = async (/** @type {typeof fetch} */ fetchFn, /** @type {string} */ url,
  /** @type {RequestInit} */ init, /** @type {number} */ timeoutMs,
  /** @type {number} */ maxBytes,
  /** @type {Set<AbortController>|null} */ tracked = null) => {
  const controller = new AbortController();
  tracked?.add(controller);
  const forward = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => controller.abort('provider-timeout'), timeoutMs);
  try {
    const response = await fetchFn(url, {
      ...init, signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store',
    });
    const status = response.status;
    const body = status >= 200 && status < 300 && maxBytes > 0
      ? await readJson(response, maxBytes) : null;
    if (body === null) await response.body?.cancel('provider probe complete').catch(() => {});
    return { status, body };
  } finally {
    clearTimeout(timer);
    tracked?.delete(controller);
    init.signal?.removeEventListener('abort', forward);
  }
};

/** @param {Record<string,any>} deps */
export const createKernelLocalControl = (deps) => {
  if (typeof deps.callFeature !== 'function' || !deps.vault || !deps.settingsStore
      || !deps.auditLog || !deps.featureHost || typeof deps.offscreenUrl !== 'string'
      || !deps.providerProjection) throw new TypeError('kernel-local-control-config-invalid');
  const fetchFn = deps.fetchFn ?? globalThis.fetch.bind(globalThis);
  /** @type {Set<AbortController>} */ const activeFetches = new Set();
  const providerProbe = async (/** @type {string} */ provider,
    /** @type {AbortSignal} */ signal) => {
    const policy = providerAuthority(provider);
    if (!policy) return { error: 'unknown-provider' };
    await deps.ready;
    if (deps.vault.isLocked()) return { error: 'locked' };
    if (policy.probeKind === 'none') return { error: 'no-live-test' };
    let key = null;
    if (policy.secretName) {
      try { key = await deps.vault.getSecret(policy.secretName); }
      catch { return { error: 'locked' }; }
      if (!key) return { error: 'no-key' };
    }
    /** @type {string|null} */ let url = policy.probeEndpoint;
    /** @type {RequestInit} */ let init = { method: 'GET', signal };
    if (policy.probeKind === 'ollama') {
      url = ollamaUrl(deps.settingsStore.get().ollamaHost)?.toString() ?? null;
      if (!url) return { error: 'unreachable' };
    } else {
      const anthropic = policy.probeKind === 'anthropic';
      init = {
        method: 'POST', signal,
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
    try {
      if (!url) return { error: 'unreachable' };
      const result = await boundedFetch(fetchFn, url, init, 20_000,
        policy.probeKind === 'ollama' ? 512 * 1024 : 0, activeFetches);
      if (result.status >= 200 && result.status < 300) {
        deps.auditLog.append({
          type: 'provider_validated', details: { provider: policy.name },
        }).catch(() => {});
        if (policy.probeKind === 'ollama') {
          const models = Array.isArray(result.body?.models)
            ? result.body.models.flatMap((/** @type {any} */ row) =>
              typeof row?.name === 'string' ? [row.name] : []) : [];
          deps.providerProjection.observeOllamaStatus({
            known: true, reachable: true, count: models.length, models,
          });
        }
      }
      return result;
    } catch (cause) {
      throw Object.assign(
        cause instanceof Error ? cause : new Error('provider-test-unconfirmed'),
        { code: 'provider-test-unconfirmed', outcomeKnown: false },
      );
    }
  };
  let catalogSignature = '';
  const localModel = async (/** @type {string} */ method, /** @type {any} */ args,
    /** @type {AbortSignal} */ signal) => {
    if (deps.localModels !== true) return {
      ok: false, error: 'runtime_capability_unavailable', performed: false,
      facility: 'localWebGpuHost', reasonCode: 'host_unsupported', retryable: false,
      alternative: 'use_ollama',
    };
    let entered = false;
    const call = async (/** @type {any} */ lease) => {
      entered = true;
      const clientsApi = deps.clientsApi ?? /** @type {any} */ (globalThis).clients;
      const matches = (await clientsApi.matchAll({ type: 'window', includeUncontrolled: true }))
        .filter((/** @type {any} */ client) => client?.url === deps.offscreenUrl);
      if (matches.length !== 1) throw Object.assign(new Error('local model host unavailable'), {
        outcomeKnown: true, code: 'local-model-host-unavailable',
      });
      const channelId = crypto.randomUUID();
      const offer = {
        type: LOCAL_MODEL_CHANNEL_OFFER, protocol: LOCAL_MODEL_CHANNEL_PROTOCOL,
        channelId, method, args, lease,
      };
      if (!parseLocalModelChannelOffer(offer)) throw new Error('local model offer invalid');
      const { port1, port2 } = new MessageChannel();
      return new Promise((resolve, reject) => {
        let settled = false;
        let dispatched = false;
        const finish = (/** @type {any} */ value, /** @type {boolean} */ ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          try { port1.close(); } catch {}
          if (ok) resolve(value); else reject(value);
        };
        const lost = (/** @type {string} */ code) => finish(Object.assign(
          new Error('local model host response was lost'), {
            code, outcomeKnown: localModelMethodIsRead(method) || !dispatched,
          },
        ), false);
        const abort = () => lost('local-model-host-aborted');
        const timer = setTimeout(() => lost('local-model-host-timeout'), 15_000);
        signal.addEventListener('abort', abort, { once: true });
        port1.onmessage = (event) => {
          const reply = event.data;
          if (reply?.type !== LOCAL_MODEL_CHANNEL_RESULT
              || reply.protocol !== LOCAL_MODEL_CHANNEL_PROTOCOL
              || reply.channelId !== channelId || typeof reply.ok !== 'boolean') return;
          const { type: _type, protocol: _protocol, channelId: _id, ...result } = reply;
          finish(result, true);
        };
        port1.onmessageerror = () => lost('local-model-host-reply-invalid');
        port1.start();
        try { matches[0].postMessage(offer, [port2]); dispatched = true; }
        catch { lost('local-model-host-dispatch-failed'); }
      });
    };
    const reply = method === 'init'
      ? await deps.featureHost.runtime.acquire('model-host', { reason: 'local-model-resident' })
        .then((/** @type {any} */ result) => result?.ok ? call(result.lease) : result)
      : await deps.featureHost.runtime.runWithLease(
        'model-host', call, { reason: 'local-model-demand' },
      );
    const value = entered ? reply : reply?.ok === false ? reply : {
      ok: false, error: 'runtime_capability_unavailable', performed: false,
      facility: 'localWebGpuHost', reasonCode: 'host_unsupported', retryable: false,
      alternative: 'use_ollama',
    };
    if (value?.ok && (method === 'catalog' || method === 'status')) {
      const rows = method === 'catalog' ? value.models : [value];
      const signature = JSON.stringify(rows?.map((/** @type {any} */ row) =>
        [row?.model, !!row?.downloaded, !!row?.available, !!row?.loading]));
      if (signature !== catalogSignature) {
        catalogSignature = signature;
        void Promise.resolve(deps.pushState()).catch(() => {});
      }
    }
    return value;
  };
  const handleEffect = async (/** @type {string} */ operation, /** @type {any} */ payload,
    /** @type {any} */ context) => {
    if (context.signal?.aborted) return failure('local-call-aborted', true);
    const message = context.message ?? {};
    if (operation === 'local.provider.test') {
      if (!same(payload, { provider: message.provider })) {
        return failure('local-effect-substitution', true);
      }
      return success(await providerProbe(payload.provider, context.signal));
    }
    if (operation === 'local.models.snapshot') {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
      if (!same(payload, { sessionId })) return failure('local-effect-substitution', true);
      await deps.ready;
      const settings = deps.settingsStore.get();
      const session = sessionId
        ? await (deps.sessions.getMetadata?.(sessionId) ?? deps.sessions.get(sessionId))
          .catch(() => null) : null;
      const usable = [];
      for (const provider of ['anthropic', 'openrouter', 'openai', 'glm', 'ollama', 'local-webgpu']) {
        const policy = providerAuthority(provider);
        if (policy?.secretName === null) usable.push(provider);
        else if (policy?.secretName) {
          try { if (await deps.vault.getSecret(policy.secretName)) usable.push(provider); } catch {}
        }
      }
      let downloaded = [];
      if (deps.localModels === true) {
        try {
          const value = (await deps.browser.storage.local.get('localModelDownloaded'))
            ?.localModelDownloaded;
          downloaded = value === true ? ['gemma-4-e2b'] : Array.isArray(value)
            ? value.filter((id) => Object.hasOwn(LOCAL_MODEL_LABELS, id)) : [];
        } catch {}
      }
      return success({
        settings: {
          providerName: settings.providerName, providerModel: settings.providerModel,
          openrouterModels: settings.openrouterModels,
        },
        session: session && typeof session === 'object'
          ? { provider: session.provider ?? null, model: session.model ?? null } : null,
        usable, downloaded, localModels: deps.localModels === true,
      });
    }
    if (operation === 'local.models.ollama') {
      const url = ollamaUrl(deps.settingsStore.get().ollamaHost);
      if (!url) return success({ models: [] });
      try {
        const result = await boundedFetch(fetchFn, url.toString(), {
          method: 'GET', signal: context.signal,
        }, 12_000, 512 * 1024, activeFetches);
        const models = result.status >= 200 && result.status < 300
          ? result.body?.models ?? [] : [];
        const ids = Array.isArray(models) ? models.flatMap((row) =>
          typeof row?.name === 'string' && row.name ? [row.name] : []) : [];
        deps.providerProjection.observeOllamaStatus({
          known: true, reachable: result.status >= 200 && result.status < 300,
          count: ids.length, models: ids,
        });
        return success({ models });
      } catch {
        deps.providerProjection.observeOllamaStatus({
          known: true, reachable: false, count: null, models: null,
        });
        return success({ models: [] });
      }
    }
    if (operation === 'local.openrouter.models') {
      await deps.ready;
      if (deps.vault.isLocked()) return success({ error: 'locked', status: null });
      let key = null;
      try { key = await deps.vault.getSecret('openrouter_api_key'); } catch {}
      /** @type {Record<string,string>} */ const headers = {
        'http-referer': 'https://peerd.ai', 'x-title': 'peerd.ai',
        'x-openrouter-categories': 'personal-agent',
      };
      if (key) headers.authorization = `Bearer ${key}`;
      try {
        return success(await boundedFetch(fetchFn, 'https://openrouter.ai/api/v1/models', {
          method: 'GET', headers, signal: context.signal,
        }, 12_000, 4 * 1024 * 1024, activeFetches));
      } catch { return success({ error: deps.vault.isLocked() ? 'locked' : 'unreachable', status: null }); }
    }
    const methods = {
      'local.model.status': ['status', {
        model: typeof message.model === 'string' ? message.model : null,
        includeSupport: message.includeSupport === true,
      }],
      'local.model.catalog': ['catalog', { includeSupport: message.includeSupport !== false }],
      'local.model.probe': ['probe', {}],
      'local.model.init': ['init', { model: typeof message.model === 'string' ? message.model : null }],
    };
    const entry = /** @type {[string,Record<string,any>]|undefined} */ (
      methods[/** @type {keyof typeof methods} */ (operation)]
    );
    if (!entry || !same(payload, entry[1])) return failure('local-effect-substitution', true);
    return success(await localModel(entry[0], payload, context.signal));
  };
  const feature = createKernelFeatureControl({
    call: (_capability, payload, options) => deps.callFeature(payload, options),
    handleEffect: async (operation, payload, context) => {
      try { return await handleEffect(operation, payload, context); }
      catch (cause) {
        return failure(
          /** @type {{code?:string}} */ (cause)?.code ?? 'local-operation-failed',
          /** @type {{outcomeKnown?:unknown}} */ (cause)?.outcomeKnown !== false,
          cause,
        );
      }
    },
  });
  const routes = Object.freeze(Object.fromEntries(KERNEL_LOCAL_ROUTE_NAMES.map((route) => [
    route,
    async (/** @type {any} */ message = {}) => {
      const result = await feature.dispatch('local', route, message);
      return result?.ok === true && Object.hasOwn(result, 'value') ? result.value : result;
    },
  ])));
  return Object.freeze({
    routes, authorize: feature.authorize, handleKernelCall: feature.handleKernelCall,
    abort: () => {
      for (const controller of activeFetches) controller.abort('vault-locked');
      activeFetches.clear();
    },
  });
};
