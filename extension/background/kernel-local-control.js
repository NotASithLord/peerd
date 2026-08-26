// @ts-check

import { providerEgressPolicy } from './provider-egress-manifest.js';
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

/** @param {Record<string,any>} deps */
export const createKernelLocalControl = (deps) => {
  if (typeof deps.callFeature !== 'function' || !deps.settingsStore
      || !deps.auditLog || !deps.featureHost || typeof deps.offscreenUrl !== 'string'
      || !deps.providerProjection || !deps.providerEgress) {
    throw new TypeError('kernel-local-control-config-invalid');
  }
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
      if (payload?.provider !== message.provider || !providerEgressPolicy(payload.provider)
          || typeof payload.model !== 'string' || !payload.nativeBody
          || typeof payload.nativeBody !== 'object' || Array.isArray(payload.nativeBody)) {
        return failure('local-effect-substitution', true);
      }
      const owner = context.authority;
      const opened = await deps.providerEgress.openInference({
        providerId: payload.provider,
        modelId: payload.model,
        nativeBody: payload.nativeBody,
      }, {
        owner,
        signal: context.signal,
        maxOutputTokens: 1,
        permits: (/** @type {string} */ providerId, /** @type {string} */ modelId) =>
          providerId === payload.provider && modelId === payload.model,
      });
      if (opened?.ok !== true) return success({
        error: opened.code === 'model-egress-credential-missing' ? 'no-key'
          : opened.code === 'model-egress-credential-unavailable' ? 'locked'
            : opened.error ?? opened.code,
        status: null,
      });
      const streamId = opened.value.streamId;
      await deps.providerEgress.cancelInference({ streamId }, { owner }).catch(() => {});
      const result = {
        status: opened.value.status,
        statusText: opened.value.statusText,
        headers: opened.value.headers,
      };
      if (result.status >= 200 && result.status < 300) {
        deps.auditLog.append({
          type: 'provider_validated', details: { provider: payload.provider },
        }).catch(() => {});
      }
      return success(result);
    }
    if (operation === 'local.models.snapshot') {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
      if (!same(payload, { sessionId })) return failure('local-effect-substitution', true);
      await deps.ready;
      const session = sessionId
        ? await (deps.sessions.getMetadata?.(sessionId) ?? deps.sessions.get(sessionId))
          .catch(() => null) : null;
      return success(await deps.providerProjection.authoritySnapshot(session, false));
    }
    if (operation === 'local.models.ollama') {
      const result = await deps.providerEgress.readModelInventory({ providerId: 'ollama' }, {
        owner: context.authority,
        signal: context.signal,
        permitsProvider: (/** @type {string} */ providerId) => providerId === 'ollama',
      });
      return result?.ok === true ? result : success({
        status: null,
        error: result?.code ?? result?.error ?? 'ollama-unreachable',
      });
    }
    if (operation === 'local.models.observe-ollama') {
      const models = payload.models === null ? null : Array.isArray(payload.models)
        ? payload.models.slice(0, 200).filter((/** @type {unknown} */ model) =>
          typeof model === 'string' && model.length <= 200) : null;
      if (payload.models !== null && (!models || models.length !== payload.models.length)
          || payload.count !== null && (!Number.isSafeInteger(payload.count)
            || payload.count !== models?.length)
          || typeof payload.known !== 'boolean' || typeof payload.reachable !== 'boolean') {
        return failure('local-ollama-status-invalid', true);
      }
      deps.providerProjection.observeOllamaStatus({
        known: payload.known,
        reachable: payload.reachable,
        count: payload.count,
        models,
      });
      return success(null);
    }
    if (operation === 'local.openrouter.models') {
      const result = await deps.providerEgress.readModelInventory({ providerId: 'openrouter' }, {
        owner: context.authority,
        signal: context.signal,
        permitsProvider: (/** @type {string} */ providerId) => providerId === 'openrouter',
      });
      return result?.ok === true ? result : success({
        status: null,
        error: result?.code ?? result?.error ?? 'openrouter-unavailable',
      });
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
    abort: () => {},
  });
};
