// @ts-check

import {
  createFeatureLeaseCoordinator,
  FEATURE_LEASE_INTENT_KEY,
  FEATURE_LEASE_SCOPES,
} from './feature-lease-coordinator.js';
import {
  FEATURE_LEASE_HOST_PROTOCOL,
  OFFSCREEN_FEATURE_LEASE_SCOPES,
} from '../shared/feature-lease-protocol.js';
import { makeSerialLane, withDeadline } from '../shared/cold-util.js';

const OFFSCREEN_SCOPES = new Set(OFFSCREEN_FEATURE_LEASE_SCOPES);
export const FEATURE_HOST_RETIREMENT_KEY = 'feature-leases.host-retirement.v1';
const HOST_RETIREMENT_SCHEMA = 1;
const LEASE_KEYS = Object.freeze([
  'schema', 'scope', 'leaseId', 'generation', 'buildId', 'bootId',
  'kernelEpoch', 'hostEpoch',
]);
const leaseCapability = (/** @type {any} */ result) => Object.freeze(
  Object.fromEntries(LEASE_KEYS.map((key) => [key, result[key]])),
);

/** @param {any} lease @param {any} result */
const localReceipt = (lease, result) => ({ ok: true, ...lease, result });

/**
 * @param {Object} deps
 * @param {import('../shared/kernel-identity.js').KernelIdentity} deps.identity
 * @param {{get:(key:string)=>Promise<any>,set:(key:string,value:any)=>Promise<void>}} deps.store
 * @param {(scope:string)=>Promise<void>} deps.ensureOffscreen
 * @param {()=>Promise<boolean>|boolean} deps.hasOffscreen
 * @param {()=>Promise<void>} deps.closeOffscreen
 * @param {(message:any)=>Promise<any>} deps.sendHostMessage
 * @param {(ms:number)=>Promise<void>} [deps.wait]
 * @param {number} [deps.hostStatusTimeoutMs]
 * @param {number} [deps.hostEffectTimeoutMs]
 * @param {number} [deps.recoveryAttempts]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 * @param {Partial<Record<'goal'|'recovery'|'schedule', {
 *   start:(lease:any,signal:AbortSignal)=>Promise<any>|any,
 *   stop?:(lease:any)=>Promise<any>|any,
 * }>>} [deps.logical]
 * @param {() => string} [deps.newId]
 * @param {boolean} [deps.vaultUnlocked]
 */
export const createProductionFeatureLeaseRuntime = ({
  identity,
  store,
  ensureOffscreen,
  hasOffscreen,
  closeOffscreen,
  sendHostMessage,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hostStatusTimeoutMs = 500,
  hostEffectTimeoutMs = 15_000,
  recoveryAttempts = 6,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logical = {},
  newId,
  vaultUnlocked = false,
}) => {
  if (!Number.isFinite(hostStatusTimeoutMs) || hostStatusTimeoutMs <= 0
      || !Number.isFinite(hostEffectTimeoutMs) || hostEffectTimeoutMs <= 0
      || !Number.isSafeInteger(recoveryAttempts) || recoveryAttempts < 1
      || recoveryAttempts > 12) {
    throw new TypeError('feature-lease-host-timeout-invalid');
  }
  /** @template T @param {()=>Promise<T>|T} operation @param {number} timeoutMs @param {string} phase */
  const withinHostDeadline = (operation, timeoutMs, phase) => withDeadline(
    operation, timeoutMs, () => {
      const error = /** @type {Error & {code?:string,outcomeKnown?:boolean}} */ (
        new Error(`feature lease host ${phase} timed out`)
      );
      error.code = `feature-lease-host-${phase}-timeout`;
      error.outcomeKnown = phase === 'status';
      return error;
    }, setTimeoutFn, clearTimeoutFn,
  );
  const hostStatus = (/** @type {()=>Promise<any>|any} */ operation) =>
    withinHostDeadline(operation, hostStatusTimeoutMs, 'status');
  const hostEffect = (/** @type {()=>Promise<any>|any} */ operation,
    /** @type {'start'|'stop'|'close'|'ensure'} */ phase) =>
    withinHostDeadline(operation, hostEffectTimeoutMs, phase);
  const hostRetirementStore = (/** @type {()=>Promise<any>} */ operation) => withDeadline(
    operation, hostEffectTimeoutMs,
    () => Object.assign(new Error('feature-host-retirement-store-timeout'), {
      code: 'feature-host-retirement-store-timeout', outcomeKnown: false,
    }),
    setTimeoutFn, clearTimeoutFn,
  );
  /** @type {Map<string, number>} */
  const scopedUsers = new Map();
  /** @type {Set<string>} */
  const durableScopes = new Set();
  const withHostLifecycle = makeSerialLane();
  /** @type {{schema:1,buildId:string,hostEpoch:string,reason:string}|null} */
  let hostRetirement = null;
  let hostRetirementLoaded = false;
  /** @type {Map<string, number>} */
  const recoveryTokens = new Map();
  /** @type {string|null} */
  let residentHostEpoch = null;
  const cancelRecovery = (/** @type {string} */ scope) => {
    recoveryTokens.set(scope, (recoveryTokens.get(scope) ?? 0) + 1);
  };
  const waitForOffscreenClosed = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const present = await hostStatus(hasOffscreen).catch(() => true);
      if (!present) return;
      await wait(25);
    }
    throw Object.assign(new Error('feature-lease-host-close-timeout'), {
      code: 'feature-lease-host-close-timeout', outcomeKnown: false,
    });
  };

  const parseHostRetirement = (/** @type {any} */ value) => {
    if (value == null) return null;
    if (value?.schema !== HOST_RETIREMENT_SCHEMA
        || typeof value?.buildId !== 'string' || value.buildId.length < 8
        || typeof value?.hostEpoch !== 'string' || value.hostEpoch.length < 8
        || typeof value?.reason !== 'string' || value.reason.length < 1
        || value.reason.length > 160) {
      throw Object.assign(new Error('feature-host-retirement-record-invalid'), {
        code: 'feature-host-retirement-record-invalid', outcomeKnown: false,
      });
    }
    return Object.freeze({
      schema: /** @type {1} */ (HOST_RETIREMENT_SCHEMA),
      buildId: value.buildId,
      hostEpoch: value.hostEpoch,
      reason: value.reason,
    });
  };

  const readHostRetirementUnsafe = async () => {
    if (hostRetirementLoaded) return hostRetirement;
    try {
      hostRetirement = parseHostRetirement(await hostRetirementStore(
        () => store.get(FEATURE_HOST_RETIREMENT_KEY),
      ));
      hostRetirementLoaded = true;
      return hostRetirement;
    } catch (cause) {
      hostRetirementLoaded = false;
      throw Object.assign(new Error('feature-host-retirement-read-failed', { cause }), {
        code: 'feature-host-retirement-read-failed', outcomeKnown: false,
      });
    }
  };

  /** @param {string} hostEpoch @param {string} reason */
  const writeHostRetirementUnsafe = async (hostEpoch, reason) => {
    if (typeof hostEpoch !== 'string' || hostEpoch.length < 8
        || typeof reason !== 'string' || reason.length < 1 || reason.length > 160) {
      throw new TypeError('feature-host-retirement-invalid');
    }
    const existing = await readHostRetirementUnsafe();
    if (existing && existing.hostEpoch !== hostEpoch) {
      throw Object.assign(new Error('feature-host-retirement-conflict'), {
        code: 'feature-host-retirement-conflict', outcomeKnown: false,
      });
    }
    if (existing) return existing;
    const record = Object.freeze({
      schema: /** @type {1} */ (HOST_RETIREMENT_SCHEMA),
      buildId: identity.buildId,
      hostEpoch,
      reason,
    });
    try {
      await hostRetirementStore(() => store.set(FEATURE_HOST_RETIREMENT_KEY, record));
    }
    catch (cause) {
      hostRetirementLoaded = false;
      throw Object.assign(new Error('feature-host-retirement-write-failed', { cause }), {
        code: 'feature-host-retirement-write-failed', outcomeKnown: false,
      });
    }
    hostRetirement = record;
    hostRetirementLoaded = true;
    return record;
  };

  /** @param {string} hostEpoch */
  const clearHostRetirementUnsafe = async (hostEpoch) => {
    const existing = await readHostRetirementUnsafe();
    if (!existing) return false;
    if (existing.hostEpoch !== hostEpoch) {
      throw Object.assign(new Error('feature-host-retirement-conflict'), {
        code: 'feature-host-retirement-conflict', outcomeKnown: false,
      });
    }
    try {
      await hostRetirementStore(() => store.set(FEATURE_HOST_RETIREMENT_KEY, null));
    }
    catch (cause) {
      hostRetirementLoaded = false;
      throw Object.assign(new Error('feature-host-retirement-clear-failed', { cause }), {
        code: 'feature-host-retirement-clear-failed', outcomeKnown: false,
      });
    }
    hostRetirement = null;
    hostRetirementLoaded = true;
    return true;
  };

  const readHost = async (/** @type {boolean} */ create,
    /** @type {string} */ scope = 'controller') => {
    if (create) await hostEffect(() => ensureOffscreen(scope), 'ensure');
    else if (!await hostStatus(hasOffscreen)) return null;
    const query = () => hostStatus(() => sendHostMessage({
      type: 'feature-lease/host-status', protocol: FEATURE_LEASE_HOST_PROTOCOL,
    }));
    const valid = () => reply?.ok === true
      && reply.protocol === FEATURE_LEASE_HOST_PROTOCOL
      && reply.buildId === identity.buildId
      && typeof reply.hostEpoch === 'string';
    const authenticatedButIncompatible = () => reply?.ok === true
      && (reply.protocol !== FEATURE_LEASE_HOST_PROTOCOL
        || reply.buildId !== identity.buildId
        || typeof reply.hostEpoch !== 'string');
    /** @type {any} */
    let reply = null;
    // why: Chrome exposes the new offscreen context before its module has
    // connected the exact control Port. Wait through that real startup gap.
    const attempts = create ? 40 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      reply = await query().catch(() => null);
      if (valid() || authenticatedButIncompatible()) break;
      if (attempt + 1 < attempts) await wait(25);
    }
    if (!valid() && create && authenticatedButIncompatible()) {
      await hostEffect(closeOffscreen, 'close').catch(() => {});
      await hostEffect(() => ensureOffscreen(scope), 'ensure');
      reply = await query().catch(() => null);
    }
    if (!valid()) {
      throw new Error('feature-lease-host-status-invalid');
    }
    residentHostEpoch = reply.hostEpoch;
    return /** @type {any} */ (reply);
  };

  const offscreenDispatcher = {
    prepare: (/** @type {any} */ lease) => ({
      dispatch: async () => hostEffect(() => sendHostMessage({
        type: 'feature-lease/host-start',
        protocol: FEATURE_LEASE_HOST_PROTOCOL,
        lease,
      }), 'start'),
    }),
    stop: async (/** @type {any} */ lease) => hostEffect(() => sendHostMessage({
      type: 'feature-lease/host-stop',
      protocol: FEATURE_LEASE_HOST_PROTOCOL,
      lease,
    }), 'stop'),
  };

  /** @type {Record<string, any>} */
  const dispatchers = {};
  for (const scope of FEATURE_LEASE_SCOPES) {
    if (OFFSCREEN_SCOPES.has(scope)) {
      dispatchers[scope] = offscreenDispatcher;
      continue;
    }
    const owner = logical[/** @type {'goal'|'recovery'|'schedule'} */ (scope)];
    dispatchers[scope] = {
      prepare: (/** @type {any} */ lease) => ({
        dispatch: async (/** @type {AbortSignal} */ signal) => {
          if (!owner?.start) throw new Error(`feature-lease-${scope}-owner-unavailable`);
          return localReceipt(lease, await owner.start(lease, signal));
        },
      }),
      stop: async (/** @type {any} */ lease) => localReceipt(lease, await owner?.stop?.(lease)),
    };
  }

  const coordinator = createFeatureLeaseCoordinator({
    identity,
    store,
    dispatchers,
    resolveHostEpoch: async (scope) => {
      if (!OFFSCREEN_SCOPES.has(scope)) return `kernel:${scope}:${identity.kernelEpoch}`;
      return (await readHost(true, scope)).hostEpoch;
    },
    ...(newId ? { newId } : {}),
    vaultUnlocked,
  });

  const stopOrphanedHostScopes = async (
    /** @type {Iterable<string>} */ scopes,
  ) => {
    const status = await readHost(false).catch(() => null);
    if (!status) return [];
    const wanted = new Set(scopes);
    const results = [];
    for (const lease of status.leases ?? []) {
      if (!wanted.has(lease?.scope)) continue;
      results.push(await hostEffect(() => sendHostMessage({
        type: 'feature-lease/host-stop',
        protocol: FEATURE_LEASE_HOST_PROTOCOL,
        lease,
      }), 'stop').catch((cause) => ({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      })));
    }
    return results;
  };

  /** @param {string} hostEpoch */
  const retirePhysicalHostUnsafe = async (hostEpoch) => {
    const attempts = Math.min(3, recoveryAttempts);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const present = await hostStatus(hasOffscreen).catch(() => null);
      if (present === false) {
        coordinator.confirmHostRetired(hostEpoch);
        if (residentHostEpoch === hostEpoch) residentHostEpoch = null;
        return true;
      }
      const status = present === true ? await readHost(false).catch(() => null) : null;
      const observedEpoch = status?.hostEpoch ?? residentHostEpoch;
      if (typeof observedEpoch === 'string' && observedEpoch !== hostEpoch) {
        coordinator.confirmHostRetired(hostEpoch);
        return false;
      }
      if (observedEpoch !== hostEpoch) return false;
      await hostEffect(closeOffscreen, 'close').catch(() => {});
      try {
        await waitForOffscreenClosed();
        coordinator.confirmHostRetired(hostEpoch);
        if (residentHostEpoch === hostEpoch) residentHostEpoch = null;
        return true;
      } catch (cause) {
        if (attempt + 1 >= attempts) throw cause;
        await wait(Math.min(500, 50 * (2 ** attempt)));
      }
    }
    return false;
  };

  /**
   * A durable retirement marker is stronger than an ordinary host-loss hint:
   * an unreadable status cannot prove that the effectful renderer disappeared,
   * so close the one physical offscreen realm and verify its absence.
   * @param {string} hostEpoch
   */
  const retireMarkedHostUnsafe = async (hostEpoch) => {
    const attempts = Math.min(3, recoveryAttempts);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const present = await hostStatus(hasOffscreen).catch(() => null);
      if (present === false) {
        coordinator.confirmHostRetired(hostEpoch);
        if (residentHostEpoch === hostEpoch) residentHostEpoch = null;
        return true;
      }
      const status = present === true ? await readHost(false).catch(() => null) : null;
      if (typeof status?.hostEpoch === 'string' && status.hostEpoch !== hostEpoch) {
        coordinator.confirmHostRetired(hostEpoch);
        return true;
      }
      try {
        await hostEffect(closeOffscreen, 'close');
        await waitForOffscreenClosed();
        coordinator.confirmHostRetired(hostEpoch);
        if (residentHostEpoch === hostEpoch) residentHostEpoch = null;
        return true;
      } catch (cause) {
        if (attempt + 1 >= attempts) {
          throw Object.assign(new Error('feature-host-retirement-failed', { cause }), {
            code: 'feature-host-retirement-failed', outcomeKnown: false,
          });
        }
        await wait(Math.min(500, 50 * (2 ** attempt)));
      }
    }
    return false;
  };

  const ensureHostRetirementUnsafe = async () => {
    await coordinator.ready;
    let record;
    try { record = await readHostRetirementUnsafe(); }
    catch (cause) {
      if (/** @type {any} */ (cause)?.cause?.code
          !== 'feature-host-retirement-record-invalid') throw cause;
      // why: a malformed write-ahead marker cannot identify one generation.
      // Retire the single physical realm before clearing it; deleting the
      // marker first could admit work beside an untracked effectful host.
      const attempts = Math.min(3, recoveryAttempts);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const present = await hostStatus(hasOffscreen).catch(() => null);
        if (present !== false) {
          await hostEffect(closeOffscreen, 'close').catch(() => {});
          try { await waitForOffscreenClosed(); }
          catch (retirementCause) {
            if (attempt + 1 < attempts) {
              await wait(Math.min(500, 50 * (2 ** attempt)));
              continue;
            }
            throw Object.assign(new Error('feature-host-retirement-failed', {
              cause: retirementCause,
            }), { code: 'feature-host-retirement-failed', outcomeKnown: false });
          }
        }
        try {
          await hostRetirementStore(() => store.set(FEATURE_HOST_RETIREMENT_KEY, null));
        } catch (clearCause) {
          hostRetirementLoaded = false;
          throw Object.assign(new Error('feature-host-retirement-clear-failed', {
            cause: clearCause,
          }), { code: 'feature-host-retirement-clear-failed', outcomeKnown: false });
        }
        hostRetirement = null;
        hostRetirementLoaded = true;
        residentHostEpoch = null;
        return Object.freeze({ ok: true, retired: true, malformed: true });
      }
      throw new Error('feature-host-retirement-failed');
    }
    if (!record) return Object.freeze({ ok: true, retired: false });
    await retireMarkedHostUnsafe(record.hostEpoch);
    await clearHostRetirementUnsafe(record.hostEpoch);
    return Object.freeze({ ok: true, retired: true, hostEpoch: record.hostEpoch });
  };

  const ensureHostRetirement = () => withHostLifecycle(ensureHostRetirementUnsafe);

  /** @param {string} hostEpoch @param {string} [reason] */
  const armHostRetirement = (hostEpoch, reason = 'dweb-reseed-in-flight') =>
    withHostLifecycle(async () => {
      await coordinator.ready;
      await ensureHostRetirementUnsafe();
      return writeHostRetirementUnsafe(hostEpoch, reason);
    });

  /** @param {string} hostEpoch */
  const disarmHostRetirement = (hostEpoch) => withHostLifecycle(async () => {
    await coordinator.ready;
    return clearHostRetirementUnsafe(hostEpoch);
  });

  const closeHostIfIdleUnsafe = async () => {
    const present = await hostStatus(hasOffscreen).catch(() => null);
    if (present === false) return false;
    const status = present === true ? await readHost(false).catch(() => null) : null;
    if (status && (status.leases?.length ?? 0) > 0) return false;
    // why: the host publishes a lease only after its feature startup settles.
    // A different scope may therefore be starting even when the host snapshot
    // is empty; closing that shared realm would await or cancel unrelated work.
    if (Object.entries(coordinator.snapshot().leases).some(([scope, lease]) =>
      OFFSCREEN_SCOPES.has(scope) && ['starting', 'active'].includes(lease.status))) return false;
    const exactEpoch = status?.hostEpoch ?? residentHostEpoch;
    return typeof exactEpoch === 'string' ? retirePhysicalHostUnsafe(exactEpoch) : false;
  };

  /** @param {string} hostEpoch @param {readonly any[]} affected */
  const recoverAffectedUnsafe = async (hostEpoch, affected) => {
    if (affected.length === 0) return Object.freeze({ hostEpoch, affected, results: [] });
    const results = [];
    // why: dweb startup reads its durable identity through the sealed vault
    // authority. Restore that substrate before replaying dweb intent so the
    // nested bounded read joins an active durable lease instead of tearing its
    // temporary authority down while dweb is still starting.
    const ordered = [...affected].sort((left, right) =>
      Number(right.scope === 'vault-authority') - Number(left.scope === 'vault-authority'));
    for (const item of ordered) {
      if (!item.durable) continue;
      const token = (recoveryTokens.get(item.scope) ?? 0) + 1;
      recoveryTokens.set(item.scope, token);
      let result = null;
      for (let attempt = 0; attempt < recoveryAttempts; attempt += 1) {
        const posture = coordinator.snapshot();
        if (recoveryTokens.get(item.scope) !== token || posture.locked
            || posture.disabled.includes(item.scope)) {
          result = Object.freeze({
            ok: false, code: 'feature-lease-recovery-cancelled',
            outcomeKnown: true, scope: item.scope,
          });
          break;
        }
        result = await acquireUnsafe(item.scope, { reason: 'host-replaced' });
        if (result?.ok || attempt + 1 >= recoveryAttempts) break;
        await closeHostIfIdleUnsafe();
        await wait(Math.min(2_000, 100 * (2 ** attempt)));
      }
      results.push(result);
    }
    await closeHostIfIdleUnsafe();
    return Object.freeze({ hostEpoch, affected, results });
  };

  const poisonedHostEpochs = () => [...new Set(Object.entries(coordinator.snapshot().leases)
    .filter(([scope, state]) => OFFSCREEN_SCOPES.has(scope)
      && typeof state?.poisonedHostEpoch === 'string')
    .map(([, state]) => /** @type {string} */ (state.poisonedHostEpoch)))];

  const retirePoisonedHostsUnsafe = async () => {
    const retirements = [];
    for (const hostEpoch of poisonedHostEpochs()) {
      const affected = coordinator.hostLost(hostEpoch);
      for (const item of affected) durableScopes.delete(item.scope);
      if (affected.length > 0) await retirePhysicalHostUnsafe(hostEpoch);
      retirements.push(Object.freeze({ hostEpoch, affected }));
    }
    return retirements;
  };

  /** @param {readonly {hostEpoch:string,affected:readonly any[]}[]} retirements */
  const recoverRetirements = async (retirements) => {
    const results = [];
    for (const { hostEpoch, affected } of retirements) {
      results.push(await recoverAffectedUnsafe(hostEpoch, affected));
    }
    return results;
  };

  const finishRevocationUnsafe = async (/** @type {string} */ scope,
    /** @type {Promise<any>} */ resultPromise) => {
    const result = await resultPromise;
    if (OFFSCREEN_SCOPES.has(scope)) {
      if (result?.outcomeKnown === false) {
        return Object.freeze({ result, retirements: await retirePoisonedHostsUnsafe() });
      }
      await stopOrphanedHostScopes([scope]);
      await closeHostIfIdleUnsafe();
    }
    return Object.freeze({ result, retirements: [] });
  };

  const revokeUnsafe = (/** @type {string} */ scope,
    /** @type {string} */ reason = 'feature-disabled') => {
    durableScopes.delete(scope);
    return finishRevocationUnsafe(scope, coordinator.revoke(scope, reason));
  };

  const finishLockUnsafe = async (/** @type {Promise<any[]>} */ resultsPromise) => {
    const results = await resultsPromise;
    const retirements = await retirePoisonedHostsUnsafe();
    await stopOrphanedHostScopes(OFFSCREEN_FEATURE_LEASE_SCOPES);
    await closeHostIfIdleUnsafe();
    return Object.freeze({ results, retirements });
  };

  const runWithLease = async (/** @type {string} */ scope,
    /** @type {(lease:any)=>Promise<any>|any} */ operation,
    /** @type {any} */ options = {}) => {
    if (!OFFSCREEN_SCOPES.has(scope) || typeof operation !== 'function') {
      throw new TypeError('feature-lease-scoped-operation-invalid');
    }
    scopedUsers.set(scope, (scopedUsers.get(scope) ?? 0) + 1);
    let acquired = false;
    try {
      const lease = await withHostLifecycle(async () => {
        await ensureHostRetirementUnsafe();
        return coordinator.acquire(scope, { ...options, durable: false });
      });
      if (!lease?.ok) {
        if (lease?.outcomeKnown === false) {
          await retireActiveHost('feature-lease-start-outcome-unknown');
        }
        return lease;
      }
      acquired = true;
      return await operation(leaseCapability(lease));
    } finally {
      const remaining = Math.max(0, (scopedUsers.get(scope) ?? 1) - 1);
      if (remaining === 0) scopedUsers.delete(scope);
      else scopedUsers.set(scope, remaining);
      if (acquired && remaining === 0) {
        const finished = await withHostLifecycle(async () => {
          if (!durableScopes.has(scope)) {
            return revokeUnsafe(scope, 'feature-disabled');
          }
          return null;
        }).catch(() => null);
        if (finished) await recoverRetirements(finished.retirements).catch(() => {});
      }
    }
  };

  const reconcileUnsafe = async () => {
    const results = await coordinator.reconcile();
    for (const result of results) {
      if (result?.ok && OFFSCREEN_SCOPES.has(result.scope)) durableScopes.add(result.scope);
    }
    const stored = await store.get(FEATURE_LEASE_INTENT_KEY).catch(() => null);
    const intended = new Set((stored?.intents ?? []).map((/** @type {any} */ item) => item?.scope));
    const status = await readHost(false).catch(() => null);
    for (const lease of status?.leases ?? []) {
      if (lease?.orphaned !== true || intended.has(lease.scope)) continue;
      await hostEffect(() => sendHostMessage({
        type: 'feature-lease/host-stop', protocol: FEATURE_LEASE_HOST_PROTOCOL, lease,
      }), 'stop').catch(() => null);
    }
    await closeHostIfIdleUnsafe();
    return results;
  };

  const acquireUnsafe = async (/** @type {string} */ scope, /** @type {any} */ options = {}) => {
    let result = await coordinator.acquire(scope, { ...options, durable: true });
    if (result?.ok && OFFSCREEN_SCOPES.has(scope)
        && coordinator.snapshot().leases[scope]?.durable !== true) {
      result = await coordinator.acquire(scope, { ...options, durable: true });
    }
    if (result?.ok && OFFSCREEN_SCOPES.has(scope)) durableScopes.add(scope);
    return result?.ok
      ? Object.freeze({ ...result, lease: leaseCapability(result) })
      : result;
  };

  const runTransitionUnsafe = async (/** @type {'initialize'|'unlock'|'resume'} */ transition,
    /** @type {{dwebEnabled?:boolean}} */ options = {}) => {
    const results = await coordinator.runTransition(transition, options);
    for (const result of results) {
      if (result?.ok && OFFSCREEN_SCOPES.has(result.scope)) durableScopes.add(result.scope);
    }
    return results;
  };

  const acquire = async (/** @type {string} */ scope, /** @type {any} */ options = {}) => {
    const result = await withHostLifecycle(async () => {
      if (OFFSCREEN_SCOPES.has(scope)) await ensureHostRetirementUnsafe();
      return acquireUnsafe(scope, options);
    });
    if (!result?.ok && result?.outcomeKnown === false) {
      await retireActiveHost('feature-lease-start-outcome-unknown');
    }
    return result;
  };
  const finishRevocation = async (/** @type {string} */ scope,
    /** @type {Promise<any>} */ result) => {
    const finished = await withHostLifecycle(() => finishRevocationUnsafe(scope, result));
    await recoverRetirements(finished.retirements);
    return finished.result;
  };
  const revoke = (/** @type {string} */ scope,
    /** @type {string} */ reason = 'feature-disabled') => {
    cancelRecovery(scope);
    durableScopes.delete(scope);
    const result = coordinator.revoke(scope, reason);
    return finishRevocation(scope, result);
  };
  const disable = (/** @type {string} */ scope) => {
    cancelRecovery(scope);
    durableScopes.delete(scope);
    const result = coordinator.disable(scope);
    return finishRevocation(scope, result);
  };
  const lock = async () => {
    for (const scope of FEATURE_LEASE_SCOPES) cancelRecovery(scope);
    durableScopes.clear();
    const results = coordinator.lock();
    const finished = await withHostLifecycle(() => finishLockUnsafe(results));
    await recoverRetirements(finished.retirements);
    return finished.results;
  };
  const reconcile = () => withHostLifecycle(async () => {
    await ensureHostRetirementUnsafe();
    return reconcileUnsafe();
  });
  const runTransition = async (/** @type {'initialize'|'unlock'|'resume'} */ transition,
    /** @type {{dwebEnabled?:boolean}} */ options = {}) => {
    // why: a durable feature may have an intentionally slow startup (the dweb
    // mesh can wait on identity/network). Its per-scope coordinator already
    // serializes that lease. Holding the physical-host lane across the whole
    // transition would head-of-line block the controller and therefore the
    // first agent turn even though both scopes safely share one host.
    if (options.dwebEnabled) {
      await withHostLifecycle(() => ensureHostRetirementUnsafe());
    }
    const results = await runTransitionUnsafe(transition, options);
    if (results.some((result) => result?.outcomeKnown === false
        && OFFSCREEN_SCOPES.has(result?.scope))) {
      await retireActiveHost('feature-transition-start-outcome-unknown');
    }
    return results;
  };
  const handleHostLoss = (/** @type {string} */ hostEpoch) => {
    const affected = coordinator.hostLost(hostEpoch);
    for (const item of affected) durableScopes.delete(item.scope);
    // why: duplicate loss notifications for an already-retired epoch are
    // inert. Consulting physical status here could mistake a stale reply for
    // the old realm and close its replacement while that realm is starting.
    if (affected.length === 0) return recoverAffectedUnsafe(hostEpoch, affected);
    // why: a fresh dweb host must re-enter this lane for its vault-backed
    // identity read. Keep physical retirement serialized, then release the
    // lane before replaying durable scopes just like the normal transition
    // path does for a cold dweb start.
    return withHostLifecycle(() => retirePhysicalHostUnsafe(hostEpoch))
      .then(() => recoverAffectedUnsafe(hostEpoch, affected));
  };

  /** @param {string} hostEpoch @param {string|undefined} reason */
  const retireHostEpoch = (hostEpoch, reason) => withHostLifecycle(async () => {
    await coordinator.ready;
    await writeHostRetirementUnsafe(hostEpoch, reason ?? 'operation-outcome-unknown');
    const affected = coordinator.hostLost(hostEpoch);
    for (const item of affected) durableScopes.delete(item.scope);
    // why: a late operation belongs to the epoch in its lease, not whichever
    // host happens to be current. An observed successor proves the old epoch
    // is gone and must never be closed to settle stale operation cleanup.
    await retireMarkedHostUnsafe(hostEpoch);
    await clearHostRetirementUnsafe(hostEpoch);
    return Object.freeze({ hostEpoch, affected });
  }).then(({ hostEpoch: retiredHostEpoch, affected }) =>
    recoverAffectedUnsafe(retiredHostEpoch, affected));

  const retireActiveHost = (/** @type {string|undefined} */ reason) => {
    const snapshot = coordinator.snapshot();
    const live = Object.entries(snapshot.leases)
      .find(([scope, state]) => OFFSCREEN_SCOPES.has(scope)
        && typeof state?.hostEpoch === 'string'
        && ['starting', 'active', 'unknown'].includes(state.status))?.[1];
    const poisoned = Object.entries(snapshot.leases)
      .find(([scope, state]) => OFFSCREEN_SCOPES.has(scope)
        && typeof state?.poisonedHostEpoch === 'string')?.[1];
    const epoch = live?.hostEpoch ?? poisoned?.poisonedHostEpoch;
    if (typeof epoch !== 'string') {
      return ensureHostRetirement().then((result) => Object.freeze({
        hostEpoch: 'hostEpoch' in result ? result.hostEpoch : null,
        affected: [], results: [],
      }));
    }
    return retireHostEpoch(epoch, reason);
  };

  const resume = async (/** @type {{dwebEnabled?:boolean}} */ {
    dwebEnabled = false,
  } = {}) => {
    if (dwebEnabled) await ensureHostRetirement();
    if (dwebEnabled) coordinator.enable('dweb');
    else await disable('dweb');
    coordinator.unlock();
    const reconciled = await reconcile();
    const transitioned = await runTransition('resume', { dwebEnabled });
    return Object.freeze({ reconciled, transitioned });
  };

  return Object.freeze({
    ready: coordinator.ready,
    acquire,
    revoke,
    disable,
    enable: coordinator.enable,
    lock,
    reconcile,
    runTransition,
    runWithLease,
    handleHostLoss,
    retireHostEpoch,
    retireActiveHost,
    ensureHostRetirement,
    armHostRetirement,
    disarmHostRetirement,
    resume,
    snapshot: coordinator.snapshot,
  });
};
