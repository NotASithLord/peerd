// @ts-check

import {
  kernelIdentityMatches,
  parseKernelIdentity,
} from '../shared/kernel-identity.js';
import { makeSerialLane } from '../shared/cold-util.js';

export const FEATURE_LEASE_INTENT_KEY = 'feature-leases.intent.v1';
export const FEATURE_LEASE_SCOPES = Object.freeze([
  'controller',
  'dweb',
  'recovery',
  'goal',
  'schedule',
  'dom-host',
  'media-host',
  'model-host',
  'vault-authority',
]);

const SCOPES = new Set(FEATURE_LEASE_SCOPES);
const REASONS = new Set([
  'vault-initialize', 'vault-unlock', 'vault-resume', 'feature-demand',
  'boot-reconcile', 'vault-lock', 'feature-disabled', 'host-replaced',
]);
const SCHEMA = 1;

/** @typedef {{ scope: string, desired: true, reason: string }} FeatureLeaseIntent */
/** @typedef {{
 *   schema: number,
 *   buildId: string,
 *   ownerBootId: string,
 *   ownerKernelEpoch: string,
 *   intents: FeatureLeaseIntent[],
 * }} FeatureLeaseIntentDocument */

const validId = (/** @type {unknown} */ value) => typeof value === 'string'
  && value.length > 0 && value.length <= 160;
const outcome = (/** @type {boolean} */ ok, /** @type {string} */ code,
  /** @type {boolean} */ outcomeKnown, /** @type {Record<string, any>} */ extra = {}) =>
  Object.freeze({ ok, code, outcomeKnown, ...extra });

/** @returns {FeatureLeaseIntentDocument} */
const emptyDocument = (/** @type {import('../shared/kernel-identity.js').KernelIdentity} */ identity) => ({
  schema: SCHEMA,
  buildId: identity.buildId,
  ownerBootId: identity.bootId,
  ownerKernelEpoch: identity.kernelEpoch,
  intents: [],
});

/** @returns {FeatureLeaseIntentDocument} */
const parseDocument = (/** @type {any} */ value,
  /** @type {import('../shared/kernel-identity.js').KernelIdentity} */ identity) => {
  if (!value || value.schema !== SCHEMA || value.buildId !== identity.buildId
      || !Array.isArray(value.intents)) return emptyDocument(identity);
  const seen = new Set();
  /** @type {FeatureLeaseIntent[]} */
  const intents = [];
  for (const intent of value.intents) {
    if (!SCOPES.has(intent?.scope) || seen.has(intent.scope)
        || intent.desired !== true || !REASONS.has(intent.reason)) continue;
    seen.add(intent.scope);
    intents.push({ scope: intent.scope, desired: true, reason: intent.reason });
  }
  return {
    schema: SCHEMA,
    buildId: identity.buildId,
    ownerBootId: identity.bootId,
    ownerKernelEpoch: identity.kernelEpoch,
    intents,
  };
};

/** @typedef {{
 *   prepare: (request: any) => Promise<{ dispatch: (signal: AbortSignal) => Promise<any>|any }>|{ dispatch: (signal: AbortSignal) => Promise<any>|any },
 *   stop?: (request: any) => Promise<any>|any,
 * }} FeatureLeaseDispatcher
 */

/**
 * @param {Object} deps
 * @param {import('../shared/kernel-identity.js').KernelIdentity} deps.identity
 * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void> }} deps.store
 * @param {Record<string, FeatureLeaseDispatcher>} deps.dispatchers
 * @param {(scope: string) => Promise<string>|string} deps.resolveHostEpoch
 * @param {() => string} [deps.newId]
 * @param {() => number} [deps.now]
 * @param {boolean} [deps.vaultUnlocked]
 */
export const createFeatureLeaseCoordinator = ({
  identity,
  store,
  dispatchers,
  resolveHostEpoch,
  newId = () => crypto.randomUUID(),
  now = Date.now,
  vaultUnlocked = false,
}) => {
  const canonicalIdentity = parseKernelIdentity(identity);
  if (!canonicalIdentity) throw new Error('feature-lease-identity-invalid');
  const ownsDocument = (/** @type {any} */ value) =>
    value?.ownerKernelEpoch === canonicalIdentity.kernelEpoch
    && value?.ownerBootId === canonicalIdentity.bootId
    && value?.buildId === canonicalIdentity.buildId;
  const receiptIdentityMatches = (/** @type {any} */ receipt) =>
    kernelIdentityMatches(canonicalIdentity, receipt);
  /** @type {Map<string, any>} */
  const states = new Map(FEATURE_LEASE_SCOPES.map((scope) => [scope, {
    scope, generation: 0, status: 'idle', leaseId: null, hostEpoch: null,
    reason: null, durable: false, dispatched: false, poisonedHostEpoch: null, controller: null,
  }]));
  /** @type {Map<string, Promise<any>>} */
  const pending = new Map();
  const disabled = new Set();
  let locked = !vaultUnlocked;
  /** @type {FeatureLeaseIntentDocument} */
  let document = emptyDocument(canonicalIdentity);
  const serializeStore = makeSerialLane();

  const ready = store.get(FEATURE_LEASE_INTENT_KEY).then(async (stored) => {
    document = parseDocument(stored, canonicalIdentity);
    if (!vaultUnlocked && document.intents.length > 0) {
      document = { ...document, intents: [] };
    }
    await store.set(FEATURE_LEASE_INTENT_KEY, document);
    return true;
  });

  const mutateDocument = (/** @type {(current: any) => any} */ mutate) => {
    return serializeStore(async () => {
      const stored = await store.get(FEATURE_LEASE_INTENT_KEY);
      if (!ownsDocument(stored)) {
        throw new Error('feature-lease-kernel-retired');
      }
      document = mutate(parseDocument(stored, canonicalIdentity));
      await store.set(FEATURE_LEASE_INTENT_KEY, document);
      return document;
    });
  };
  const assertOwner = async () => {
    const stored = await store.get(FEATURE_LEASE_INTENT_KEY);
    if (!ownsDocument(stored)) {
      throw new Error('feature-lease-kernel-retired');
    }
  };

  const persistDesired = (/** @type {string} */ scope, /** @type {boolean} */ desired,
    /** @type {string} */ reason) => mutateDocument((current) => ({
      ...current,
      ownerBootId: canonicalIdentity.bootId,
      ownerKernelEpoch: canonicalIdentity.kernelEpoch,
      intents: desired
        ? [...current.intents.filter((/** @type {any} */ item) => item.scope !== scope),
          { scope, desired: true, reason }]
        : current.intents.filter((/** @type {any} */ item) => item.scope !== scope),
    }));

  const validateReceipt = (/** @type {any} */ receipt, /** @type {any} */ lease) =>
    receipt?.ok === true
    && receiptIdentityMatches(receipt)
    && receipt.hostEpoch === lease.hostEpoch
    && receipt.leaseId === lease.leaseId
    && receipt.generation === lease.generation
    && receipt.scope === lease.scope;

  const finishUnknown = (/** @type {any} */ state, /** @type {any} */ lease,
    /** @type {string} */ code) => {
    if (state.leaseId === lease.leaseId && state.generation === lease.generation) {
      state.status = 'unknown';
      state.poisonedHostEpoch = lease.hostEpoch;
      state.controller = null;
    }
    return outcome(false, code, false, { scope: lease.scope, leaseId: lease.leaseId });
  };

  const start = async (/** @type {string} */ scope, /** @type {any} */ options) => {
    await ready;
    const state = states.get(scope);
    if (!state) return outcome(false, 'feature-lease-scope-invalid', true);
    if (locked && scope !== 'vault-authority') {
      return outcome(false, 'feature-lease-vault-locked', true, { scope });
    }
    if (disabled.has(scope)) return outcome(false, 'feature-lease-disabled', true, { scope });
    if (options.signal?.aborted) return outcome(false, 'feature-lease-cancelled', true, { scope });
    let hostEpoch;
    try {
      hostEpoch = options.hostEpoch ?? await resolveHostEpoch(scope);
    }
    catch {
      return outcome(false, 'feature-lease-host-unavailable', true, { scope });
    }
    if (!validId(hostEpoch)) return outcome(false, 'feature-lease-host-invalid', true, { scope });
    if (state.poisonedHostEpoch === hostEpoch) {
      return outcome(false, 'feature-lease-host-poisoned', false, { scope, hostEpoch });
    }
    if (state.status === 'active') {
      if (state.hostEpoch !== hostEpoch) {
        return outcome(false, 'feature-lease-host-conflict', true, { scope });
      }
      if (options.durable !== false && !state.durable) {
        try {
          await persistDesired(scope, true,
            REASONS.has(options.reason) ? options.reason : 'feature-demand');
          state.durable = true;
        } catch {
          return outcome(false, 'feature-lease-intent-uncertain', false, { scope });
        }
      }
      return outcome(true, 'feature-lease-active', true, {
        scope, leaseId: state.leaseId, generation: state.generation,
        ...canonicalIdentity, hostEpoch, coalesced: true,
      });
    }
    if (state.status === 'starting') {
      return outcome(false, 'feature-lease-host-conflict', true, {
        scope, activeHostEpoch: state.hostEpoch,
      });
    }

    const dispatcher = dispatchers[scope];
    if (!dispatcher?.prepare) return outcome(false, 'feature-lease-host-unavailable', true, { scope });
    state.generation += 1;
    const lease = Object.freeze({
      scope,
      leaseId: newId(),
      generation: state.generation,
      ...canonicalIdentity,
      hostEpoch,
      reason: REASONS.has(options.reason) ? options.reason : 'feature-demand',
      requestedAt: now(),
    });
    state.status = 'starting';
    state.leaseId = lease.leaseId;
    state.hostEpoch = hostEpoch;
    state.reason = lease.reason;
    state.durable = options.durable !== false;
    state.dispatched = false;
    let crossedDispatch = false;
    const controller = new AbortController();
    state.controller = controller;
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener?.('abort', abort, { once: true });

    try {
      if (state.durable) await persistDesired(scope, true, lease.reason);
      else await assertOwner();
      if (controller.signal.aborted || state.leaseId !== lease.leaseId) {
        if (state.durable) await persistDesired(scope, false, 'feature-disabled');
        if (state.leaseId === lease.leaseId) state.status = 'idle';
        return outcome(false, 'feature-lease-cancelled', true, { scope });
      }
      const prepared = await dispatcher.prepare(Object.freeze({ ...lease }));
      if (!prepared || typeof prepared.dispatch !== 'function') {
        if (state.durable) await persistDesired(scope, false, 'feature-disabled');
        state.status = 'idle';
        return outcome(false, 'feature-lease-prepare-invalid', true, { scope });
      }
      if (controller.signal.aborted || state.leaseId !== lease.leaseId) {
        if (state.durable) await persistDesired(scope, false, 'feature-disabled');
        if (state.leaseId === lease.leaseId) state.status = 'idle';
        return outcome(false, 'feature-lease-cancelled', true, { scope });
      }
      await assertOwner();
      crossedDispatch = true;
      state.dispatched = true;
      const receipt = await prepared.dispatch(controller.signal);
      await assertOwner();
      if (controller.signal.aborted || state.leaseId !== lease.leaseId) {
        return finishUnknown(state, lease, 'feature-lease-cancelled-after-dispatch');
      }
      if (!validateReceipt(receipt, lease)) {
        return finishUnknown(state, lease, 'feature-lease-receipt-invalid');
      }
      state.status = 'active';
      state.controller = null;
      return outcome(true, 'feature-lease-started', true, lease);
    } catch (error) {
      if (crossedDispatch) return finishUnknown(state, lease, 'feature-lease-host-lost');
      try { if (state.durable) await persistDesired(scope, false, 'feature-disabled'); }
      catch { return finishUnknown(state, lease, 'feature-lease-intent-uncertain'); }
      if (state.leaseId === lease.leaseId) state.status = 'idle';
      return outcome(false, controller.signal.aborted
        ? 'feature-lease-cancelled' : 'feature-lease-prepare-failed', true, {
        scope, error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      options.signal?.removeEventListener?.('abort', abort);
    }
  };

  const acquire = (/** @type {string} */ scope, /** @type {any} */ options = {}) => {
    if (!SCOPES.has(scope)) return Promise.resolve(outcome(false, 'feature-lease-scope-invalid', true));
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some((key) => !['reason', 'hostEpoch', 'signal', 'durable'].includes(key))
        || (options.durable !== undefined && typeof options.durable !== 'boolean')) {
      return Promise.resolve(outcome(false, 'feature-lease-options-invalid', true, { scope }));
    }
    const key = `${scope}:${options.hostEpoch ?? 'resolved'}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const operation = start(scope, options).finally(() => {
      if (pending.get(key) === operation) pending.delete(key);
    });
    pending.set(key, operation);
    return operation;
  };

  const revokeWithIntent = (/** @type {string} */ scope,
    /** @type {string} */ reason = 'feature-disabled',
    /** @type {Promise<any>|null} */ sharedIntentWrite = null) => {
    const state = states.get(scope);
    if (!state) return Promise.resolve(outcome(false, 'feature-lease-scope-invalid', true));
    const lease = Object.freeze({
      scope,
      leaseId: state.leaseId,
      generation: state.generation,
      ...canonicalIdentity,
      hostEpoch: state.hostEpoch,
      reason: REASONS.has(reason) ? reason : 'feature-disabled',
    });
    const crossedDispatch = state.dispatched || state.status === 'active' || state.status === 'unknown';
    const priorStatus = state.status;
    state.generation += 1;
    state.status = 'revoked';
    state.durable = false;
    state.controller?.abort(reason);
    state.controller = null;
    state.dispatched = false;
    return (async () => {
      await ready;
      try {
        if (sharedIntentWrite) await sharedIntentWrite;
        else await persistDesired(scope, false, lease.reason);
      }
      catch {
        return outcome(false, 'feature-lease-revoke-intent-uncertain', false, { scope });
      }
      if (!crossedDispatch || !lease.leaseId) {
        return outcome(true, 'feature-lease-revoked', true, { scope, priorStatus });
      }
      const stop = dispatchers[scope]?.stop;
      if (typeof stop !== 'function') {
        state.poisonedHostEpoch = lease.hostEpoch;
        return outcome(false, 'feature-lease-stop-unavailable', false, { scope });
      }
      try {
        const receipt = await stop(lease);
        if (!validateReceipt(receipt, lease)) {
          state.poisonedHostEpoch = lease.hostEpoch;
          return outcome(false, 'feature-lease-stop-unknown', false, { scope });
        }
        state.poisonedHostEpoch = null;
        return outcome(true, 'feature-lease-revoked', true, { scope, priorStatus });
      } catch {
        state.poisonedHostEpoch = lease.hostEpoch;
        return outcome(false, 'feature-lease-stop-unknown', false, { scope });
      }
    })();
  };
  const revoke = (/** @type {string} */ scope,
    /** @type {string} */ reason = 'feature-disabled') =>
    revokeWithIntent(scope, reason);

  const lock = () => {
    locked = true;
    const clearIntents = ready.then(() => document.intents.length === 0
      ? document
      : mutateDocument((current) => ({ ...current, intents: [] })));
    return Promise.all(FEATURE_LEASE_SCOPES.map(
      (scope) => revokeWithIntent(scope, 'vault-lock', clearIntents),
    ));
  };
  const unlock = () => { locked = false; };
  const disable = (/** @type {string} */ scope) => {
    disabled.add(scope);
    return revoke(scope, 'feature-disabled');
  };
  const enable = (/** @type {string} */ scope) => {
    if (!SCOPES.has(scope)) return false;
    disabled.delete(scope);
    return true;
  };

  /** @param {string} hostEpoch */
  const hostLost = (hostEpoch) => {
    if (!validId(hostEpoch)) return [];
    const affected = [];
    for (const [scope, state] of states) {
      const liveGeneration = state.hostEpoch === hostEpoch
        && ['starting', 'active', 'unknown'].includes(state.status);
      const poisonedRevocation = state.status === 'revoked'
        && state.poisonedHostEpoch === hostEpoch;
      if (!liveGeneration && !poisonedRevocation) continue;
      const priorStatus = state.status;
      const durable = state.durable === true
        || document.intents.some((intent) => intent.scope === scope);
      state.generation += 1;
      state.status = 'idle';
      state.leaseId = null;
      state.hostEpoch = null;
      state.reason = 'host-replaced';
      state.durable = false;
      state.controller?.abort('host-replaced');
      state.controller = null;
      state.dispatched = false;
      state.poisonedHostEpoch = hostEpoch;
      for (const key of [...pending.keys()]) {
        if (key.startsWith(`${scope}:`)) pending.delete(key);
      }
      affected.push(Object.freeze({ scope, durable, priorStatus }));
    }
    return Object.freeze(affected);
  };

  /** @param {string} hostEpoch */
  const confirmHostRetired = (hostEpoch) => {
    if (!validId(hostEpoch)) return false;
    let changed = false;
    for (const state of states.values()) {
      if (state.poisonedHostEpoch !== hostEpoch) continue;
      state.poisonedHostEpoch = null;
      changed = true;
    }
    return changed;
  };

  const reconcile = async () => {
    await ready;
    if (locked) return [];
    const stored = await store.get(FEATURE_LEASE_INTENT_KEY);
    if (!ownsDocument(stored)) {
      throw new Error('feature-lease-kernel-retired');
    }
    const intents = parseDocument(stored, canonicalIdentity).intents;
    const results = [];
    for (const intent of intents) {
      if (disabled.has(intent.scope)) continue;
      results.push(await acquire(intent.scope, {
        reason: 'boot-reconcile',
        hostEpoch: await resolveHostEpoch(intent.scope),
        durable: true,
      }));
    }
    return results;
  };

  /** @param {'initialize'|'unlock'|'resume'} transition
   * @param {{ dwebEnabled?: boolean }} [options]
   */
  const runTransition = async (transition, { dwebEnabled = false } = {}) => {
    if (!['initialize', 'unlock', 'resume'].includes(transition)) {
      return [outcome(false, 'feature-lease-transition-invalid', true)];
    }
    unlock();
    const reason = transition === 'initialize'
      ? 'vault-initialize' : transition === 'unlock' ? 'vault-unlock' : 'vault-resume';
    const plan = [...(dwebEnabled ? ['dweb'] : []), 'goal', 'recovery', 'schedule'];
    const results = [];
    for (const scope of plan) results.push(await acquire(scope, { reason, durable: true }));
    return results;
  };

  const snapshot = () => Object.freeze({
    ...canonicalIdentity,
    locked,
    disabled: Object.freeze([...disabled]),
    leases: Object.freeze(Object.fromEntries([...states].map(([scope, state]) => [scope, {
      generation: state.generation,
      status: state.status,
      leaseId: state.leaseId,
      hostEpoch: state.hostEpoch,
      durable: state.durable,
      poisonedHostEpoch: state.poisonedHostEpoch,
    }]))),
  });

  return Object.freeze({
    ready, acquire, reconcile, runTransition, revoke, lock, unlock, disable, enable, hostLost,
    confirmHostRetired,
    snapshot,
  });
};
