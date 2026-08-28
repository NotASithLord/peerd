// @ts-check

import { STARTUP_UNAVAILABLE_USER_FAILURE } from '../shared/bounded-module-load.js';

const unavailable = (/** @type {string} */ family) => Object.freeze({
  ok: false,
  code: `kernel-${family}-owner-unavailable`,
  error: STARTUP_UNAVAILABLE_USER_FAILURE,
  outcomeKnown: true,
  phase: 'startup',
  retryable: true,
});

/**
 * @param {Object} deps
 * @param {()=>Promise<((...args:any[])=>any)>} deps.loadController
 * @param {Record<string,any>} deps.controller
 */
export const createKernelControllerGateway = ({ loadController, controller }) => {
  if (typeof loadController !== 'function' || !controller || typeof controller !== 'object') {
    throw new TypeError('kernel-controller-gateway-config-invalid');
  }
  /** @type {Record<'semantic'|'turn'|'compose'|'runtime',any|null>} */
  const slots = { semantic: null, turn: null, compose: null, runtime: null };
  /** @type {Map<string,any>} */
  const features = new Map();
  /** @type {Map<unknown,{binding:any,users:number}>} */
  const featureCalls = new Map();
  let closed = false;

  const bindSlot = (/** @type {'semantic'|'turn'|'compose'|'runtime'} */ family,
    /** @type {any} */ owner) => {
    if (closed || slots[family]) throw new Error(`kernel-${family}-owner-conflict`);
    if (typeof owner?.authorize !== 'function' || typeof owner?.handle !== 'function') {
      throw new TypeError(`kernel-${family}-owner-invalid`);
    }
    const binding = { owner, users: 0, retiring: false };
    slots[family] = binding;
    return binding;
  };
  const bindFeatureSlot = (/** @type {string} */ cluster, /** @type {any} */ owner) => {
    if (closed || !/^[a-z][a-z0-9-]{0,63}$/.test(cluster) || features.has(cluster)) {
      throw new Error('kernel-feature-owner-conflict');
    }
    if (typeof owner?.authorize !== 'function' || typeof owner?.handle !== 'function') {
      throw new TypeError('kernel-feature-owner-invalid');
    }
    const binding = { cluster, owner, users: 0, retiring: false };
    features.set(cluster, binding);
    return binding;
  };
  const release = (/** @type {any} */ binding,
    /** @type {()=>any|null} */ current, /** @type {()=>void} */ clear) => {
    if (binding.retiring) return;
    binding.retiring = true;
    if (binding.users === 0 && current() === binding) clear();
  };
  const use = async (/** @type {any|null} */ binding, /** @type {string} */ family,
    /** @type {(owner:any)=>Promise<any>|any} */ operation) => {
    if (!binding || binding.retiring || closed) return unavailable(family);
    binding.users += 1;
    try { return await operation(binding.owner); }
    finally {
      binding.users = Math.max(0, binding.users - 1);
      if (binding.retiring && binding.users === 0) {
        if (binding.cluster) {
          if (features.get(binding.cluster) === binding) features.delete(binding.cluster);
        } else {
          for (const slot of ['semantic', 'turn', 'compose', 'runtime']) {
            if (slots[/** @type {'semantic'|'turn'|'compose'|'runtime'} */ (slot)] === binding) {
              slots[/** @type {'semantic'|'turn'|'compose'|'runtime'} */ (slot)] = null;
            }
          }
        }
      }
    }
  };
  const activeOwner = (/** @type {'semantic'|'turn'|'compose'|'runtime'} */ family) =>
    slots[family]?.owner ?? null;
  const featureOwner = (/** @type {any} */ context) => {
    const target = context?.authority?.target;
    if (typeof target !== 'string') return null;
    for (const binding of features.values()) {
      if (binding.users > 0
          && target.startsWith(`kernel-feature:${binding.cluster}:`)) {
        return binding.owner;
      }
    }
    return null;
  };
  const authorizeFeature = (/** @type {unknown} */ payload) => {
    const binding = featureCalls.get(payload)?.binding;
    if (!binding || binding.users < 1) return null;
    const grant = binding.owner.authorize(payload);
    const prefix = `kernel-feature:${binding.cluster}:`;
    return typeof grant?.target === 'string' && grant.target.startsWith(prefix) ? grant : null;
  };
  const callFeature = (/** @type {any} */ binding, /** @type {string} */ family,
    /** @type {unknown} */ payload, /** @type {()=>Promise<any>} */ operation) => use(
    binding, family, async () => {
      const activeCall = featureCalls.get(payload);
      if (activeCall && activeCall.binding !== binding) return unavailable(family);
      if (activeCall) activeCall.users += 1;
      else featureCalls.set(payload, { binding, users: 1 });
      try { return await operation(); }
      finally {
        const current = featureCalls.get(payload);
        if (current?.binding === binding) {
          if (current) {
            current.users -= 1;
            if (current.users === 0) featureCalls.delete(payload);
          }
        }
      }
    },
  );
  const clientDeps = Object.freeze({
    ...controller,
    authorizeSemanticCall: (/** @type {unknown} */ payload) =>
      activeOwner('semantic')?.authorize(payload) ?? null,
    handleSemanticKernelCall: (/** @type {string} */ operation,
      /** @type {unknown} */ payload, /** @type {any} */ context) =>
      activeOwner('semantic')?.handle(operation, payload, context)
        ?? { ok: false, code: 'kernel-operation-denied', outcomeKnown: true },
    authorizeTurnCall: (/** @type {unknown} */ payload) =>
      activeOwner('turn')?.authorize(payload) ?? null,
    handleTurnKernelCall: (/** @type {string} */ operation,
      /** @type {unknown} */ payload, /** @type {any} */ context) =>
      activeOwner('turn')?.handle(operation, payload, context)
        ?? { ok: false, code: 'kernel-operation-denied', outcomeKnown: true },
    authorizeComposeCall: (/** @type {unknown} */ payload) =>
      activeOwner('compose')?.authorize(payload) ?? null,
    handleComposeKernelCall: (/** @type {string} */ operation,
      /** @type {unknown} */ payload, /** @type {any} */ context) =>
      activeOwner('compose')?.handle(operation, payload, context)
        ?? { ok: false, code: 'kernel-operation-denied', outcomeKnown: true },
    authorizeRuntimeCall: (/** @type {unknown} */ payload) =>
      activeOwner('runtime')?.authorize(payload) ?? null,
    handleRuntimeKernelCall: (/** @type {string} */ operation,
      /** @type {unknown} */ payload, /** @type {any} */ context) =>
      activeOwner('runtime')?.handle(operation, payload, context)
        ?? { ok: false, code: 'kernel-operation-denied', outcomeKnown: true },
    authorizeFeatureCall: authorizeFeature,
    handleFeatureKernelCall: (/** @type {string} */ operation,
      /** @type {unknown} */ payload, /** @type {any} */ context) =>
      featureOwner(context)?.handle(operation, payload, context)
        ?? { ok: false, code: 'kernel-operation-denied', outcomeKnown: true },
  });
  /** @type {any|null} */
  let client = null;
  /** @type {Promise<any>|null} */
  let clientLoading = null;
  let retirement = 0;
  const getClient = async () => {
    if (closed) throw new Error('kernel-controller-gateway-closed');
    if (client) return client;
    const generation = retirement;
    clientLoading ??= Promise.resolve().then(async () => {
      try {
        const makeController = await loadController();
        if (typeof makeController !== 'function') {
          throw new TypeError('kernel-controller-loader-invalid');
        }
        const candidate = makeController(clientDeps);
        if (['callSemantic', 'callTurn', 'callRuntime', 'callFeature',
          'renderSystemPrompt', 'projectTurnTools', 'planToolsCommand', 'composeTurn',
          'withRun', 'close']
          .some((name) => typeof candidate?.[name] !== 'function')) {
          try { candidate?.close?.(); } catch {}
          throw new TypeError('kernel-controller-client-invalid');
        }
        if (closed) {
          candidate.close();
          throw new Error('kernel-controller-gateway-closed');
        }
        if (generation !== retirement) {
          candidate.close();
          throw Object.assign(new Error('kernel-controller-generation-retired'), {
            code: 'kernel-controller-generation-retired',
            outcomeKnown: true,
            phase: 'startup',
            retryable: true,
          });
        }
        client = candidate;
        return candidate;
      } catch (cause) {
        const detail = /** @type {{code?:unknown,outcomeKnown?:unknown}} */ (cause);
        if (detail?.outcomeKnown === true) throw cause;
        throw Object.assign(new Error(STARTUP_UNAVAILABLE_USER_FAILURE, { cause }), {
          code: typeof detail?.code === 'string' ? detail.code
            : 'kernel-controller-startup-failed',
          outcomeKnown: true, phase: 'startup', retryable: true,
        });
      }
    })
      .finally(() => { clientLoading = null; });
    return clientLoading;
  };
  /** @param {string} method @param {...any} args */
  const clientCall = async (method, ...args) => {
    const active = await getClient();
    return active[method](...args);
  };
  /** @param {string} method @param {...any} args */
  const resultCall = async (method, ...args) => {
    try { return await clientCall(method, ...args); }
    catch (cause) {
      const detail = /** @type {{code?:unknown,outcomeKnown?:unknown,
       * phase?:unknown,retryable?:unknown}} */ (cause);
      if (detail?.outcomeKnown !== true) throw cause;
      return {
        ok: false,
        code: typeof detail.code === 'string' ? detail.code
          : 'kernel-controller-startup-failed',
        error: STARTUP_UNAVAILABLE_USER_FAILURE,
        outcomeKnown: true,
        phase: detail.phase === 'run' ? 'run' : 'startup',
        retryable: detail.retryable !== false,
      };
    }
  };

  const bindSemantic = (/** @type {any} */ owner) => {
    const binding = bindSlot('semantic', owner);
    return Object.freeze({
      callSemantic: (/** @type {unknown} */ payload) => use(
        binding, 'semantic', () => resultCall('callSemantic', payload),
      ),
      release: () => release(binding, () => slots.semantic, () => { slots.semantic = null; }),
    });
  };
  const bindTurn = (/** @type {any} */ owner) => {
    const binding = bindSlot('turn', owner);
    const useTurn = async (/** @type {()=>Promise<any>|any} */ operation) => {
      const result = await use(binding, 'turn', operation);
      if (result?.code === 'kernel-turn-owner-unavailable') {
        throw Object.assign(new Error(STARTUP_UNAVAILABLE_USER_FAILURE), result);
      }
      return result;
    };
    return Object.freeze({
      callTurn: (/** @type {unknown} */ payload, /** @type {any} */ options = {}) => useTurn(
        () => resultCall('callTurn', payload, options),
      ),
      renderSystemPrompt: (/** @type {Record<string,unknown>} */ context) => useTurn(
        () => clientCall('renderSystemPrompt', context),
      ),
      projectTurnTools: (/** @type {Record<string,unknown>} */ context) => useTurn(
        () => clientCall('projectTurnTools', context),
      ),
      planToolsCommand: (/** @type {Record<string,unknown>} */ context) => useTurn(
        () => clientCall('planToolsCommand', context),
      ),
      withRun: (/** @type {()=>Promise<any>} */ operation) => useTurn(
        () => clientCall('withRun', operation),
      ),
      release: () => release(binding, () => slots.turn, () => { slots.turn = null; }),
    });
  };
  const bindCompose = (/** @type {any} */ owner) => {
    const binding = bindSlot('compose', owner);
    return Object.freeze({
      composeTurn: (/** @type {{text:string}} */ payload,
        /** @type {any} */ options = {}) => use(
        binding, 'compose', () => clientCall('composeTurn', payload, options),
      ),
      release: () => release(binding, () => slots.compose, () => { slots.compose = null; }),
    });
  };
  const bindRuntime = (/** @type {any} */ owner) => {
    const binding = bindSlot('runtime', owner);
    return Object.freeze({
      callRuntime: (/** @type {unknown} */ payload, /** @type {any} */ options = {}) => use(
        binding, 'runtime', () => resultCall('callRuntime', payload, options),
      ),
      release: () => release(binding, () => slots.runtime, () => { slots.runtime = null; }),
    });
  };
  const bindFeature = (/** @type {string} */ cluster, /** @type {any} */ owner) => {
    const binding = bindFeatureSlot(cluster, owner);
    return Object.freeze({
      callFeature: (/** @type {unknown} */ payload, /** @type {any} */ options = {}) => callFeature(
        binding, `feature-${cluster}`, payload, () => resultCall('callFeature', payload, options),
      ),
      release: () => release(
        binding, () => features.get(cluster), () => { features.delete(cluster); },
      ),
    });
  };
  return Object.freeze({
    bindSemantic, bindTurn, bindCompose, bindRuntime, bindFeature,
    withRun: (/** @type {()=>Promise<any>} */ operation) => clientCall('withRun', operation),
    retire: () => {
      retirement += 1;
      client?.retire?.();
    },
    close: () => {
      if (closed) return;
      closed = true;
      client?.close();
      client = null;
      slots.semantic = null;
      slots.turn = null;
      slots.compose = null;
      slots.runtime = null;
      features.clear();
      featureCalls.clear();
    },
  });
};
