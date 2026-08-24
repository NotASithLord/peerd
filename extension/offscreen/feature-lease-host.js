// @ts-check
// Offscreen half of the production feature-lease protocol. No lease means no
// keepalive port, heartbeat, controller offer, DOM/media operation, or dweb
// network. The service worker remains the authority owner; this host only
// executes exact generation-bound receipts.

import {
  FEATURE_LEASE_HOST_PROTOCOL,
  FEATURE_LEASE_KEEPALIVE_PORT,
  OFFSCREEN_FEATURE_LEASE_SCOPES,
} from '../shared/feature-lease-protocol.js';
import {
  kernelIdentityIsSuccessor,
  parseKernelIdentity,
} from '../shared/kernel-identity.js';

export {
  FEATURE_LEASE_HOST_PROTOCOL,
  FEATURE_LEASE_KEEPALIVE_PORT,
  OFFSCREEN_FEATURE_LEASE_SCOPES,
};

const SCOPES = new Set(OFFSCREEN_FEATURE_LEASE_SCOPES);
// Only the explicitly durable dweb network survives a kernel generation. A
// controller may hold a committed turn/tool effect, so re-adopting it after
// heartbeat loss would blur outcome custody; retire it and require fresh demand.
const ADOPTABLE_AFTER_KERNEL_LOSS = new Set(['dweb']);
const safeId = (/** @type {unknown} */ value, /** @type {number} */ max = 192) =>
  typeof value === 'string' && value.length >= 8 && value.length <= max
  && !/[\u0000-\u001f\u007f]/.test(value);

/** @typedef {{
 * scope:string,leaseId:string,generation:number,buildId:string,kernelEpoch:string,
 * hostEpoch:string,schema?:1,bootId?:string,
 * }} ParsedFeatureLease */

/**
 * @param {unknown} value
 * @returns {Readonly<ParsedFeatureLease>|null}
 */
const parseLease = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lease = /** @type {Record<string, unknown>} */ (value);
  const carriesStrictIdentity = lease.schema !== undefined || lease.bootId !== undefined;
  const strictIdentity = carriesStrictIdentity ? parseKernelIdentity({
    schema: lease.schema,
    buildId: lease.buildId,
    bootId: lease.bootId,
    kernelEpoch: lease.kernelEpoch,
  }) : null;
  if (!SCOPES.has(/** @type {string} */ (lease.scope))
      || !safeId(lease.leaseId)
      || !Number.isSafeInteger(lease.generation) || Number(lease.generation) <= 0
      || !safeId(lease.buildId)
      || !safeId(lease.kernelEpoch)
      || !safeId(lease.hostEpoch)
      || (carriesStrictIdentity && !strictIdentity)) return null;
  return /** @type {Readonly<ParsedFeatureLease>} */ (Object.freeze({
    scope: /** @type {string} */ (lease.scope),
    leaseId: /** @type {string} */ (lease.leaseId),
    generation: Number(lease.generation),
    ...(strictIdentity ?? {
      buildId: /** @type {string} */ (lease.buildId),
      kernelEpoch: /** @type {string} */ (lease.kernelEpoch),
    }),
    hostEpoch: /** @type {string} */ (lease.hostEpoch),
  }));
};

/** @param {ReturnType<typeof parseLease>} left @param {ReturnType<typeof parseLease>} right */
const sameLease = (left, right) => !!left && !!right
  && left.scope === right.scope
  && left.leaseId === right.leaseId
  && left.generation === right.generation
  && left.buildId === right.buildId
  && left.bootId === right.bootId
  && left.kernelEpoch === right.kernelEpoch
  && left.hostEpoch === right.hostEpoch;

/**
 * @param {Object} deps
 * @param {string} deps.expectedBuildId
 * @param {(scope:string, lease:any) => Promise<any>|any} deps.startScope
 * @param {(scope:string, lease:any) => Promise<any>|any} deps.stopScope
 * @param {(scope:string, prior:any, next:any) => Promise<any>|any} [deps.adoptScope]
 * @param {() => import('webextension-polyfill').Runtime.Port} deps.connectPort
 * @param {() => string} [deps.newId]
 * @param {number} [deps.heartbeatMs]
 * @param {number} [deps.reconnectMs]
 * @param {number} [deps.heartbeatAckTimeoutMs]
 * @param {typeof setInterval} [deps.setIntervalFn]
 * @param {typeof clearInterval} [deps.clearIntervalFn]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const createOffscreenFeatureLeaseHost = ({
  expectedBuildId,
  startScope,
  stopScope,
  adoptScope = async () => ({}),
  connectPort,
  newId = () => crypto.randomUUID(),
  heartbeatMs = 20_000,
  reconnectMs = 500,
  heartbeatAckTimeoutMs = 2_000,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  if (!safeId(expectedBuildId) || typeof startScope !== 'function'
      || typeof stopScope !== 'function' || typeof connectPort !== 'function') {
    throw new TypeError('feature-lease-host-config-invalid');
  }
  const hostEpoch = newId();
  if (!safeId(hostEpoch)) throw new TypeError('feature-lease-host-epoch-invalid');
  /** @type {Map<string, {lease:NonNullable<ReturnType<typeof parseLease>>,orphaned:boolean}>} */
  const active = new Map();
  /** @type {import('webextension-polyfill').Runtime.Port|null} */
  let port = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let heartbeatTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let reconnectTimer = null;
  let closing = false;
  let heartbeatSequence = 0;
  let heartbeatProbePending = false;
  /** @type {Map<string, {resolve:()=>void,reject:(cause:Error)=>void,timer:ReturnType<typeof setTimeout>}>} */
  const heartbeatWaiters = new Map();

  const publicLease = (/** @type {{lease:any,orphaned:boolean}} */ entry) => Object.freeze({
    ...entry.lease,
    orphaned: entry.orphaned,
  });
  const snapshot = () => Object.freeze({
    protocol: FEATURE_LEASE_HOST_PROTOCOL,
    buildId: expectedBuildId,
    hostEpoch,
    leases: Object.freeze([...active.values()].map(publicLease)),
  });
  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) clearIntervalFn(heartbeatTimer);
    heartbeatTimer = null;
  };
  const cancelReconnect = () => {
    if (reconnectTimer !== null) clearTimeoutFn(reconnectTimer);
    reconnectTimer = null;
  };
  /** @param {string} code */
  const rejectHeartbeatWaiters = (code) => {
    for (const [heartbeatId, waiter] of heartbeatWaiters) {
      heartbeatWaiters.delete(heartbeatId);
      clearTimeoutFn(waiter.timer);
      waiter.reject(new Error(code));
    }
  };

  /** @param {string} reason @param {import('webextension-polyfill').Runtime.Port|null} [lostPort] */
  const onPortLost = (reason, lostPort = port) => {
    if (closing || active.size === 0) return;
    // A delayed timeout/disconnect from a retired Port has no authority over a
    // successor connection or leases adopted through it.
    if (lostPort && port !== lostPort) return;
    const previous = port;
    port = null;
    stopHeartbeat();
    rejectHeartbeatWaiters(reason);
    for (const [scope, entry] of [...active]) {
      if (ADOPTABLE_AFTER_KERNEL_LOSS.has(scope)) {
        entry.orphaned = true;
        continue;
      }
      active.delete(scope);
      Promise.resolve(stopScope(scope, { ...entry.lease, reason })).catch(() => {});
    }
    // A missed ACK is not a browser disconnect. Explicitly sever the old Port
    // so the kernel observes authenticated host loss and replays durable dweb
    // intent; otherwise the host stays orphaned while the coordinator remains
    // falsely active forever.
    if (reason !== 'kernel-port-disconnected') {
      try { previous?.disconnect(); } catch { /* already disconnected */ }
    }
    if (active.size > 0 && reconnectTimer === null) {
      reconnectTimer = setTimeoutFn(() => {
        reconnectTimer = null;
        ensurePort();
        void probeKernel();
      }, reconnectMs);
    }
  };

  const probeKernel = async () => {
    if (heartbeatProbePending || closing || active.size === 0) return;
    heartbeatProbePending = true;
    try {
      await awaitHeartbeatAck((lostPort) => onPortLost(
        'kernel-heartbeat-unacknowledged', lostPort,
      ));
    } catch { /* timeout callback already retired the unresponsive Port */ }
    finally { heartbeatProbePending = false; }
  };

  const ensurePort = () => {
    if (closing || active.size === 0 || port) return;
    cancelReconnect();
    try {
      const next = connectPort();
      port = next;
      next.onMessage.addListener((/** @type {any} */ message) => {
        if (port !== next
            || message?.type !== 'feature-lease/heartbeat-ack'
            || message?.protocol !== FEATURE_LEASE_HOST_PROTOCOL
            || message?.hostEpoch !== hostEpoch
            || typeof message?.heartbeatId !== 'string') return;
        const waiter = heartbeatWaiters.get(message.heartbeatId);
        if (!waiter) return;
        heartbeatWaiters.delete(message.heartbeatId);
        clearTimeoutFn(waiter.timer);
        waiter.resolve();
      });
      next.onDisconnect.addListener(() => onPortLost('kernel-port-disconnected', next));
      heartbeatTimer = setIntervalFn(() => { void probeKernel(); }, heartbeatMs);
    } catch {
      onPortLost('kernel-port-connect-failed');
    }
  };

  const awaitHeartbeatAck = (/** @type {(port:import('webextension-polyfill').Runtime.Port)=>void} */ onTimeout = () => {}) =>
    new Promise((resolve, reject) => {
    ensurePort();
    if (!port) {
      reject(new Error('feature-lease-heartbeat-port-unavailable'));
      return;
    }
    const heartbeatPort = port;
    const heartbeatId = `${hostEpoch}:heartbeat:${++heartbeatSequence}`;
    const timer = setTimeoutFn(() => {
      if (!heartbeatWaiters.delete(heartbeatId)) return;
      onTimeout(heartbeatPort);
      reject(new Error('feature-lease-heartbeat-timeout'));
    }, heartbeatAckTimeoutMs);
    heartbeatWaiters.set(heartbeatId, {
      resolve: /** @type {() => void} */ (resolve), reject, timer,
    });
    try {
      heartbeatPort.postMessage({
        type: 'feature-lease/heartbeat',
        heartbeatId,
        ...snapshot(),
      });
    } catch { /* timeout/disconnect path owns retirement */ }
    });

  /** @param {NonNullable<ReturnType<typeof parseLease>>} lease @param {string} reason */
  const retireUnacknowledged = async (lease, reason) => {
    const current = active.get(lease.scope);
    if (!current || !sameLease(current.lease, lease)) return;
    active.delete(lease.scope);
    try { await stopScope(lease.scope, { ...lease, reason }); } catch { /* unknown remains conservative */ }
    if (active.size === 0) {
      stopHeartbeat();
      cancelReconnect();
      rejectHeartbeatWaiters(reason);
      const previous = port;
      port = null;
      try { previous?.disconnect(); } catch { /* already closed */ }
    }
  };

  const receipt = (/** @type {any} */ lease,
    /** @type {Record<string, any>} */ extra = {}) => Object.freeze({
    ok: true,
    protocol: FEATURE_LEASE_HOST_PROTOCOL,
    ...lease,
    ...extra,
  });
  const refuse = (/** @type {string} */ error,
    /** @type {Record<string, any>} */ extra = {}) => Object.freeze({
    ok: false,
    protocol: FEATURE_LEASE_HOST_PROTOCOL,
    hostEpoch,
    error,
    ...extra,
  });

  const start = async (/** @type {unknown} */ value) => {
    const lease = parseLease(value);
    if (!lease || lease.buildId !== expectedBuildId || lease.hostEpoch !== hostEpoch) {
      return refuse('feature-lease-host-binding-invalid');
    }
    const current = active.get(lease.scope);
    if (current) {
      if (sameLease(current.lease, lease)) {
        current.orphaned = false;
        try {
          await awaitHeartbeatAck();
          return receipt(lease, { active: true, coalesced: true });
        } catch (cause) {
          await retireUnacknowledged(lease, 'heartbeat-unacknowledged');
          return refuse('feature-lease-host-heartbeat-unacknowledged', {
            scope: lease.scope,
            errorDetail: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      const strictSuccessor = current.lease.bootId !== undefined || lease.bootId !== undefined
        ? kernelIdentityIsSuccessor(current.lease, lease)
        : current.lease.buildId === lease.buildId
          && current.lease.kernelEpoch !== lease.kernelEpoch;
      if (!current.orphaned || !ADOPTABLE_AFTER_KERNEL_LOSS.has(lease.scope)
          || !strictSuccessor) {
        return refuse('feature-lease-host-conflict', {
          scope: lease.scope,
          activeKernelEpoch: current.lease.kernelEpoch,
        });
      }
      try {
        const result = await adoptScope(lease.scope, current.lease, lease);
        active.set(lease.scope, { lease, orphaned: false });
        await awaitHeartbeatAck();
        return receipt(lease, { active: true, adopted: true, result });
      } catch (cause) {
        await retireUnacknowledged(lease, 'heartbeat-unacknowledged');
        return refuse('feature-lease-host-adopt-failed', {
          scope: lease.scope,
          errorDetail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    try {
      const result = await startScope(lease.scope, lease);
      active.set(lease.scope, { lease, orphaned: false });
      await awaitHeartbeatAck();
      return receipt(lease, { active: true, result });
    } catch (cause) {
      await retireUnacknowledged(lease, 'heartbeat-unacknowledged');
      return refuse('feature-lease-host-start-failed', {
        scope: lease.scope,
        errorDetail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const stop = async (/** @type {unknown} */ value) => {
    const lease = parseLease(value);
    if (!lease || lease.buildId !== expectedBuildId || lease.hostEpoch !== hostEpoch) {
      return refuse('feature-lease-host-binding-invalid');
    }
    const current = active.get(lease.scope);
    if (!current) return receipt(lease, { active: false, coalesced: true });
    if (!sameLease(current.lease, lease)) {
      return refuse('feature-lease-host-stop-stale', { scope: lease.scope });
    }
    try {
      const result = await stopScope(lease.scope, lease);
      if (sameLease(active.get(lease.scope)?.lease ?? null, lease)) active.delete(lease.scope);
      if (active.size === 0) {
        stopHeartbeat();
        cancelReconnect();
        const previous = port;
        port = null;
        rejectHeartbeatWaiters('feature-lease-stopped');
        try { previous?.disconnect(); } catch { /* already closed */ }
      }
      return receipt(lease, { active: false, result });
    } catch (cause) {
      return refuse('feature-lease-host-stop-failed', {
        scope: lease.scope,
        errorDetail: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const handleMessage = async (/** @type {any} */ message) => {
    if (message?.protocol !== FEATURE_LEASE_HOST_PROTOCOL) {
      return refuse('feature-lease-host-protocol-invalid');
    }
    if (message.type === 'feature-lease/host-status') return { ok: true, ...snapshot() };
    if (message.type === 'feature-lease/host-start') return start(message.lease);
    if (message.type === 'feature-lease/host-stop') return stop(message.lease);
    return refuse('feature-lease-host-message-unknown');
  };

  const close = async () => {
    if (closing) return;
    closing = true;
    stopHeartbeat();
    cancelReconnect();
    rejectHeartbeatWaiters('feature-lease-host-closing');
    const entries = [...active.values()];
    active.clear();
    await Promise.allSettled(entries.map((entry) => stopScope(
      entry.lease.scope,
      { ...entry.lease, reason: 'host-closing' },
    )));
    const previous = port;
    port = null;
    try { previous?.disconnect(); } catch { /* already closed */ }
  };

  return Object.freeze({
    hostEpoch,
    snapshot,
    handleMessage,
    isActive: (/** @type {string} */ scope) => active.has(scope),
    ownsLease: (/** @type {string} */ scope, /** @type {unknown} */ value) => {
      const lease = parseLease(value);
      return scope === lease?.scope && sameLease(active.get(scope)?.lease ?? null, lease)
        && active.get(scope)?.orphaned === false;
    },
    requireActive: (/** @type {string} */ scope) => {
      const entry = active.get(scope);
      return entry && entry.orphaned === false
        ? null : refuse('feature-lease-required', { scope });
    },
    close,
  });
};
