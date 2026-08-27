// @ts-check
// Authority-kernel half of the lazy Chrome controller channel.

import {
  CONTROLLER_CHANNEL_OFFER,
  CONTROLLER_CHANNEL_PROTOCOL,
  CONTROLLER_PHASE,
  CONTROLLER_BUILD_DIGEST,
  isControllerBuildDigest,
  isControllerChannelMessage,
  payloadFitsControllerCap,
  parseControllerAuthority,
  parseControllerCaps,
} from '../shared/structured-clone-size.js';
import {
  controllerCallMaxDuration,
  controllerOperationAllowedAfterCancel,
  controllerOuterPayloadCap,
  controllerPayloadAllowed,
  controllerRenewalIdleCap,
  controllerCustodyIsAuthoritative,
  createControllerKernelQuota,
  normalizeControllerCustody,
} from '../shared/controller-kernel-quota.js';
import { parseKernelIdentity } from '../shared/kernel-identity.js';
import {
  OUTCOME_UNKNOWN_USER_FAILURE,
  STARTUP_UNAVAILABLE_USER_FAILURE,
} from '../shared/bounded-module-load.js';
import {
  KERNEL_FEATURE_DISPATCH_CAPABILITY,
  parseKernelFeatureCall,
} from '../shared/kernel-feature-policy.js';
import {
  RUNTIME_DISPATCH_CAPABILITY,
  RUNTIME_DISPATCH_OUTER_BYTES,
  createRuntimeEffectQuota,
  parseRuntimeDispatch,
} from '../shared/kernel-runtime-policy.js';

export class ControllerChannelError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'ControllerChannelError';
    this.code = code;
  }
}

const startupChannelError = (/** @type {string} */ code) => Object.assign(
  new ControllerChannelError(STARTUP_UNAVAILABLE_USER_FAILURE, code),
  { outcomeKnown: true, phase: 'startup', retryable: true },
);
const startupResult = (/** @type {string} */ code) => ({
  ok: false, code, error: STARTUP_UNAVAILABLE_USER_FAILURE,
  outcomeKnown: true, phase: 'startup', retryable: true,
});

const controllerGenerationMustRetire = (/** @type {any} */ result) =>
  result?.outcomeKnown === true && (result.code === 'module-load-timeout'
    || typeof result.code === 'string' && (result.code.endsWith('-load-timeout')
      || result.code.startsWith('feature-host-generation-')));

/**
 * @template {{ url?: string }} T
 * @param {T[]} candidates
 * @param {string} expectedUrl
 * @returns {T | null}
 */
export const selectExactControllerHost = (candidates, expectedUrl) => {
  const exact = candidates.filter((candidate) => candidate.url === expectedUrl);
  return exact.length === 1 ? exact[0] : null;
};

const stopped = (/** @type {string} */ code, /** @type {boolean} */ known) => ({
  ok: false,
  code,
  outcomeKnown: known,
  phase: known ? 'startup' : 'run',
});

/**
 * @param {Object} deps
 * @param {() => Promise<void>} deps.ensureOffscreen
 * @param {() => Promise<{ postMessage: (message: any, transfer: Transferable[]) => void } | null>} deps.findHost
 * @param {string[]} deps.capabilities
 * @param {string} deps.buildDigest
 * @param {unknown} [deps.lease]
 * @param {import('../shared/kernel-identity.js').KernelIdentity} [deps.kernelIdentity]
 * @param {(capability: string, payload: unknown) => unknown} deps.authorizeCall
 * @param {(operation: string, payload: unknown, context: {
 *   capability: string,
 *   authority: NonNullable<ReturnType<typeof parseControllerAuthority>>,
 *   signal: AbortSignal,
 *   deadlineAt: number,
 * }) => Promise<any>|any} [deps.handleKernelCall]
 * @param {() => MessageChannel} [deps.createChannel]
 * @param {() => string} [deps.newId]
 * @param {number} [deps.handshakeTimeoutMs]
 * @param {number} [deps.callTimeoutMs]
 * @param {number} [deps.cancelSettleTimeoutMs]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 * @param {(capability:string,payload:unknown)=>any} [deps.createQuota]
 */
export const connectOffscreenController = async ({
  ensureOffscreen,
  findHost,
  capabilities,
  buildDigest,
  lease,
  kernelIdentity: injectedIdentity,
  authorizeCall,
  handleKernelCall,
  createChannel = () => new MessageChannel(),
  newId = () => crypto.randomUUID(),
  handshakeTimeoutMs = 10_000,
  callTimeoutMs = 60_000,
  cancelSettleTimeoutMs = 2_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  createQuota = createControllerKernelQuota,
}) => {
  const offeredCaps = parseControllerCaps(capabilities);
  if (!offeredCaps) throw new ControllerChannelError('invalid controller capabilities', 'caps-invalid');
  if (!isControllerBuildDigest(buildDigest)) {
    throw new ControllerChannelError('invalid controller build digest', 'build-invalid');
  }
  if (typeof authorizeCall !== 'function') {
    throw new ControllerChannelError('controller authority resolver missing', 'authority-missing');
  }
  const kernelIdentity = injectedIdentity ? parseKernelIdentity(injectedIdentity) : null;
  if (injectedIdentity && !kernelIdentity) {
    throw new ControllerChannelError('invalid kernel identity', 'kernel-identity-invalid');
  }
  await ensureOffscreen();
  const target = await findHost();
  if (!target) throw new ControllerChannelError('exact controller host missing', 'host-missing');

  const channelId = newId();
  const kernelEpoch = kernelIdentity?.kernelEpoch ?? newId();
  const { port1, port2 } = createChannel();
  /** @type {Map<string, {
   *   phase: string,
   *   resolve: (value: any) => void,
   *   timer: ReturnType<typeof setTimeout>,
   *   signal?: AbortSignal,
   *   onAbort?: () => void,
   *   grantId: string,
   *   deadlineAt: number,
   *   capability: string,
   *   authority: NonNullable<ReturnType<typeof parseControllerAuthority>>,
   *   nestedUnknown: boolean,
   *   effectEntered: boolean,
   *   cancelled: boolean,
   *   lifetime: AbortController,
   *   reverse: Map<string, {controller:AbortController,operation:string,payload:unknown}>,
   *   quota: ReturnType<typeof createControllerKernelQuota>,
   * }>} */
  const calls = new Map();
  let ready = false;
  let activeCaps = /** @type {string[]} */ ([]);
  let closed = false;
  let hostEpoch = /** @type {string|null} */ (null);
  let sentSequence = 0;
  let receivedSequence = 0;
  let settleReady = (/** @type {boolean} */ _value) => {};
  const readyPromise = new Promise((resolve) => { settleReady = resolve; });

  const binding = { channelId, buildDigest, kernelEpoch, get hostEpoch() { return hostEpoch; } };
  const post = (/** @type {Record<string, unknown>} */ message) => port1.postMessage({
    protocol: CONTROLLER_CHANNEL_PROTOCOL,
    channelId,
    buildDigest,
    kernelEpoch,
    hostEpoch,
    sequence: ++sentSequence,
    ...message,
  });
  const finish = (/** @type {string} */ requestId, /** @type {any} */ result) => {
    const call = calls.get(requestId);
    if (!call) return;
    calls.delete(requestId);
    clearTimeoutFn(call.timer);
    call.lifetime.abort();
    if (call.onAbort) call.signal?.removeEventListener('abort', call.onAbort);
    for (const pending of call.reverse.values()) pending.controller.abort();
    call.reverse.clear();
    call.resolve(result);
  };
  const pendingCustody = (/** @type {any} */ call) => {
    const settled = typeof call.quota.custody === 'function'
      ? call.quota.custody()
      : { outcomeKnown: false, retryable: false };
    let outcomeKnown = settled?.outcomeKnown === true;
    let retryable = settled?.retryable === true;
    for (const pending of call.reverse.values()) {
      const loss = typeof call.quota.pendingLoss === 'function'
        ? call.quota.pendingLoss(pending.operation, pending.payload)
        : { outcomeKnown: false, retryable: false };
      outcomeKnown &&= loss?.outcomeKnown === true;
      retryable &&= loss?.retryable === true;
    }
    if (call.nestedUnknown && !controllerCustodyIsAuthoritative(call.capability)) {
      return { outcomeKnown: false, retryable: false };
    }
    return { outcomeKnown, retryable };
  };
  const custodyFailure = (/** @type {any} */ call, /** @type {string} */ code) => ({
    ok: false, code, ...pendingCustody(call), phase: 'run',
  });
  const failAll = (/** @type {string} */ code) => {
    for (const [requestId, call] of calls) {
      const preCommit = call.phase === CONTROLLER_PHASE.OPENED
        || call.phase === CONTROLLER_PHASE.ACCEPTED;
      finish(requestId, preCommit ? stopped(code, true)
        : controllerCustodyIsAuthoritative(call.capability) || call.effectEntered
          ? custodyFailure(call, code) : stopped(code, false));
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    failAll('controller-channel-closed');
    try { port1.close(); } catch { /* already closed */ }
  };
  const renewCall = (/** @type {string} */ requestId, /** @type {any} */ call) => {
    if (call.cancelled) return;
    const idleMs = controllerRenewalIdleCap(call.capability);
    if (idleMs <= 0) return;
    const deadlineAt = Date.now() + idleMs;
    call.deadlineAt = deadlineAt;
    clearTimeoutFn(call.timer);
    call.timer = setTimeoutFn(() => {
      const active = calls.get(requestId);
      if (!active) return;
      try { post({ type: 'kernel/cancel', requestId, grantId: active.grantId }); }
      catch { /* host gone */ }
      finish(requestId,
        controllerCustodyIsAuthoritative(active.capability) || active.effectEntered
          ? custodyFailure(active, 'controller-call-timeout')
          : stopped('controller-call-timeout', false));
    }, idleMs);
    post({ type: 'kernel/renew', requestId, grantId: call.grantId, deadlineAt });
  };
  port1.onmessage = (event) => {
    if (!isControllerChannelMessage(event.data, binding) || closed) return;
    const message = /** @type {any} */ (event.data);
    if (message.sequence !== receivedSequence + 1) { close(); settleReady(false); return; }
    receivedSequence = message.sequence;
    if (message.type === 'controller/unavailable' && !ready) {
      close();
      settleReady(false);
      return;
    }
    if (message.type === 'controller/ready' && !ready) {
      if (typeof message.hostEpoch !== 'string' || message.hostEpoch.length < 8) {
        close(); settleReady(false); return;
      }
      const acceptedCaps = parseControllerCaps(message.capabilities);
      if (!acceptedCaps || acceptedCaps.some((cap) => !offeredCaps.includes(cap))) {
        close();
        settleReady(false);
        return;
      }
      hostEpoch = message.hostEpoch;
      activeCaps = acceptedCaps;
      ready = true;
      settleReady(true);
      return;
    }
    if (typeof message.requestId !== 'string') return;
    const call = calls.get(message.requestId);
    if (!call) return;
    if (message.grantId !== call.grantId) { close(); return; }
    if (message.type === 'controller/kernel-call') {
      if ((call.phase !== CONTROLLER_PHASE.COMMITTING
          && call.phase !== CONTROLLER_PHASE.COMMITTED)
          || typeof message.rpcId !== 'string'
          || message.rpcId.length < 1 || message.rpcId.length > 512
          || typeof message.operation !== 'string'
          || !/^[a-z][a-z0-9./-]{0,127}$/.test(message.operation)
          || call.reverse.has(message.rpcId)
          || call.reverse.size >= call.quota.pendingCap) {
        close();
        return;
      }
      if (call.cancelled
          && !controllerOperationAllowedAfterCancel(call.capability, message.operation)) {
        try {
          post({
            type: 'kernel/kernel-result', requestId: message.requestId,
            grantId: call.grantId, rpcId: message.rpcId,
            result: stopped('controller-call-aborted', true),
          });
        } catch { close(); }
        return;
      }
      const admitted = call.quota.admit(message.operation, message.payload);
      if (admitted?.ok !== true) {
        try {
          post({
            type: 'kernel/kernel-result', requestId: message.requestId,
            grantId: call.grantId, rpcId: message.rpcId, result: admitted,
          });
        } catch { close(); }
        return;
      }
      call.effectEntered = true;
      // A reverse call is authenticated, quota-admitted progress. Renew only
      // the idle fuse for this exact committed grant; no unrelated heartbeat
      // can extend controller custody.
      renewCall(message.requestId, call);
      const controller = new AbortController();
      call.reverse.set(message.rpcId, {
        controller, operation: message.operation, payload: message.payload,
      });
      const settleKernelCall = (/** @type {any} */ result) => {
        call.reverse.delete(message.rpcId);
        const observed = call.quota.observe(message.operation, message.payload, result);
        const bounded = observed?.ok === true ? result : observed;
        if (bounded?.outcomeKnown !== true
            && (!controllerCustodyIsAuthoritative(call.capability)
              || pendingCustody(call).outcomeKnown !== true)) call.nestedUnknown = true;
        try {
          post({
            type: 'kernel/kernel-result', requestId: message.requestId,
            grantId: call.grantId, rpcId: message.rpcId, result: bounded,
          });
        } catch {
          if (!controllerCustodyIsAuthoritative(call.capability)
              || pendingCustody(call).outcomeKnown !== true) call.nestedUnknown = true;
        }
      };
      if (typeof handleKernelCall !== 'function') {
        settleKernelCall({ ok: false, code: 'kernel-operation-denied', outcomeKnown: true });
        return;
      }
      Promise.resolve(handleKernelCall(message.operation, message.payload, {
        capability: call.capability,
        authority: call.authority,
        signal: call.lifetime.signal,
        deadlineAt: call.deadlineAt,
      })).then(
        settleKernelCall,
        (cause) => settleKernelCall({
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
          outcomeKnown: false,
        }),
      );
      return;
    }
    if (message.type === 'controller/rejected' && call.phase === CONTROLLER_PHASE.OPENED) {
      finish(message.requestId, {
        ...(message.result ?? { ok: false, code: 'controller-call-rejected' }),
        outcomeKnown: true,
        phase: 'startup',
      });
      return;
    }
    if (message.type === 'controller/accepted' && call.phase === CONTROLLER_PHASE.OPENED) {
      call.phase = CONTROLLER_PHASE.ACCEPTED;
      if (call.signal?.aborted) { call.onAbort?.(); return; }
      // Sending commit transfers custody. A failure from this line onward is
      // conservatively unknown even if the committed acknowledgement is lost.
      call.phase = CONTROLLER_PHASE.COMMITTING;
      post({ type: 'kernel/commit', requestId: message.requestId, grantId: call.grantId });
      return;
    }
    if (message.type === 'controller/committed' && call.phase === CONTROLLER_PHASE.COMMITTING) {
      call.phase = CONTROLLER_PHASE.COMMITTED;
      return;
    }
    if (message.type === 'controller/settled'
        && (call.phase === CONTROLLER_PHASE.COMMITTING
          || call.phase === CONTROLLER_PHASE.COMMITTED)) {
      const pendingEffect = call.reverse.size > 0;
      const custody = controllerCustodyIsAuthoritative(call.capability) || call.effectEntered
        ? pendingCustody(call) : null;
      const result = normalizeControllerCustody(
        call.capability, message.result, custody, pendingEffect,
      );
      finish(message.requestId, {
        ...(result ?? { ok: false, error: 'controller returned no result' }),
        outcomeKnown: result.outcomeKnown === true,
        phase: call.capability === RUNTIME_DISPATCH_CAPABILITY
          && (message.result?.phase === 'startup' || message.result?.phase === 'run')
          ? message.result.phase : CONTROLLER_PHASE.SETTLED,
      });
    }
  };
  port1.onmessageerror = () => { close(); settleReady(false); };
  port1.addEventListener('close', () => { close(); settleReady(false); }, { once: true });
  port1.start();
  try {
    target.postMessage({
      type: CONTROLLER_CHANNEL_OFFER,
      protocol: CONTROLLER_CHANNEL_PROTOCOL,
      channelId,
      buildDigest,
      kernelEpoch,
      ...(kernelIdentity ? { kernelIdentity } : {}),
      ...(lease ? { lease } : {}),
      capabilities: offeredCaps,
    }, [port2]);
  } catch (cause) {
    close();
    throw new ControllerChannelError(
      `controller offer failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      'offer-failed',
    );
  }

  const handshakeTimer = setTimeoutFn(() => settleReady(false), handshakeTimeoutMs);
  const didReady = await readyPromise;
  clearTimeoutFn(handshakeTimer);
  if (!didReady || closed) {
    close();
    throw new ControllerChannelError('controller handshake failed', 'handshake-failed');
  }

  /**
   * @param {string} capability
   * @param {unknown} payload
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   */
  const call = async (capability, payload, options = {}) => {
    if (closed) return Promise.resolve(stopped('controller-channel-closed', true));
    if (!activeCaps.includes(capability)) {
      return Promise.resolve(stopped('controller-capability-denied', true));
    }
    if (options.signal?.aborted) return Promise.resolve(stopped('controller-call-aborted', true));
    let outerCap = controllerOuterPayloadCap(capability);
    let quota = createQuota(capability, payload);
    let maxDurationMs = controllerCallMaxDuration(capability, payload);
    if (capability === RUNTIME_DISPATCH_CAPABILITY) {
      outerCap = RUNTIME_DISPATCH_OUTER_BYTES;
      quota = createRuntimeEffectQuota(payload);
      if (!payloadFitsControllerCap(payload, outerCap)) {
        return stopped('controller-payload-too-large', true);
      }
      const request = parseRuntimeDispatch(payload);
      if (!request) return stopped('controller-payload-invalid', true);
      maxDurationMs = request.policy.maxDurationMs;
    }
    if (closed) return stopped('controller-channel-closed', true);
    if (options.signal?.aborted) return stopped('controller-call-aborted', true);
    if (!controllerPayloadAllowed(capability, payload)) {
      return stopped('controller-payload-invalid', true);
    }
    if (outerCap <= 0 || !payloadFitsControllerCap(payload, outerCap)) {
      return Promise.resolve(stopped('controller-payload-too-large', true));
    }
    const requestedTimeoutMs = options.timeoutMs ?? callTimeoutMs;
    if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
      return stopped('controller-timeout-invalid', true);
    }
    const timeoutMs = Math.max(1, Math.min(Math.floor(requestedTimeoutMs), maxDurationMs));
    const authority = parseControllerAuthority(authorizeCall(capability, payload));
    if (!authority) return Promise.resolve(stopped('controller-authority-invalid', true));
    const requestId = newId();
    const grantId = newId();
    return new Promise((resolve) => {
      const deadlineAt = Date.now() + timeoutMs;
      const timer = setTimeoutFn(() => {
        const active = calls.get(requestId);
        if (!active) return;
        try { post({ type: 'kernel/cancel', requestId, grantId: active.grantId }); } catch { /* host gone */ }
        const preCommit = active.phase === CONTROLLER_PHASE.OPENED
          || active.phase === CONTROLLER_PHASE.ACCEPTED;
        finish(requestId, preCommit
          ? stopped('controller-call-timeout', true)
          : controllerCustodyIsAuthoritative(active.capability) || active.effectEntered
            ? custodyFailure(active, 'controller-call-timeout')
            : stopped('controller-call-timeout', false));
      }, timeoutMs);
      const onAbort = () => {
        const active = calls.get(requestId);
        if (!active) return;
        active.cancelled = true;
        active.lifetime.abort();
        try { post({ type: 'kernel/cancel', requestId, grantId: active.grantId }); } catch { /* host gone */ }
        if (active.phase === CONTROLLER_PHASE.OPENED
            || active.phase === CONTROLLER_PHASE.ACCEPTED) {
          finish(requestId, stopped('controller-call-aborted', true));
          return;
        }
        clearTimeoutFn(active.timer);
        active.timer = setTimeoutFn(() => {
          finish(requestId,
            controllerCustodyIsAuthoritative(active.capability) || active.effectEntered
              ? custodyFailure(active, 'controller-call-aborted')
              : stopped('controller-call-aborted', false));
        }, cancelSettleTimeoutMs);
      };
      calls.set(requestId, {
        phase: CONTROLLER_PHASE.OPENED,
        resolve,
        timer,
        signal: options.signal,
        onAbort,
        grantId,
        deadlineAt,
        capability,
        authority,
        nestedUnknown: false,
        effectEntered: false,
        cancelled: false,
        lifetime: new AbortController(),
        reverse: new Map(),
        quota,
      });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      post({
        type: 'kernel/open', requestId, grantId, deadlineAt,
        capability, authority, payload,
      });
    });
  };

  return Object.freeze({
    call, close, epoch: kernelEpoch, kernelEpoch, kernelIdentity, channelId, buildDigest,
    capabilities: [...activeCaps],
  });
};

const PROMPT_CAPABILITIES = Object.freeze(['prompt.render']);

/**
 * @param {Object} deps
 * @param {any} deps.browser
 * @param {() => Promise<void>} deps.ensureOffscreen
 * @param {string} deps.offscreenUrl
 * @param {boolean} deps.firefoxDirect
 * @param {boolean} deps.dwebEnabled
 * @param {import('../shared/kernel-identity.js').KernelIdentity} deps.kernelIdentity
 * @param {(payload:unknown)=>unknown} [deps.authorizeTurnCall]
 * @param {(operation:string,payload:unknown,context:any)=>Promise<any>|any} [deps.handleTurnKernelCall]
 * @param {(payload:unknown)=>unknown} [deps.authorizeSemanticCall]
 * @param {(operation:string,payload:unknown,context:any)=>Promise<any>|any} [deps.handleSemanticKernelCall]
 * @param {(payload:unknown)=>unknown} [deps.authorizeRuntimeCall]
 * @param {(operation:string,payload:unknown,context:any)=>Promise<any>|any} [deps.handleRuntimeKernelCall]
 * @param {(payload:unknown)=>unknown} [deps.authorizeFeatureCall]
 * @param {(operation:string,payload:unknown,context:any)=>Promise<any>|any} [deps.handleFeatureKernelCall]
 * @param {<T>(operation:(lease?:unknown)=>Promise<T>)=>Promise<T>} [deps.withControllerLease]
 * @param {<T>(operation:()=>Promise<T>,options?:{outcomeKnownOnLoss?:boolean,code?:string,onLost?:(error:Error)=>void,lossGraceMs?:number})=>Promise<T>} [deps.withDirectLifetime]
 * @param {typeof import('./direct-controller-client.js').connectDirectController} [deps.connectDirectController]
 * @param {number} [deps.connectTimeoutMs]
 * @param {number} [deps.promptLoadTimeoutMs]
 * @param {(reason:string)=>Promise<any>} [deps.retireHost]
 * @param {() => Promise<any[]>} [deps.listWindowClients]
 * @param {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} deps.fetchFn
 */
export const makeSemanticControllerClient = ({
  browser,
  ensureOffscreen,
  offscreenUrl,
  firefoxDirect,
  dwebEnabled,
  kernelIdentity,
  authorizeTurnCall,
  handleTurnKernelCall,
  authorizeSemanticCall,
  handleSemanticKernelCall,
  authorizeRuntimeCall,
  handleRuntimeKernelCall,
  authorizeFeatureCall,
  handleFeatureKernelCall,
  withControllerLease: withLease,
  withDirectLifetime,
  connectDirectController: directConnector,
  connectTimeoutMs = 15_000,
  promptLoadTimeoutMs = 10_000,
  retireHost = async () => {},
  fetchFn,
  listWindowClients = async () => {
    const clientApi = /** @type {any} */ (globalThis).clients;
    if (typeof clientApi?.matchAll !== 'function') return [];
    return clientApi.matchAll({ type: 'window', includeUncontrolled: true });
  },
}) => {
  if (typeof fetchFn !== 'function'
      || typeof offscreenUrl !== 'string'
      || !Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0
      || !Number.isFinite(promptLoadTimeoutMs) || promptLoadTimeoutMs <= 0) {
    throw new TypeError('semantic controller asset reader is required');
  }
  if (!parseKernelIdentity(kernelIdentity)) {
    throw new TypeError('semantic controller kernel identity is required');
  }
  if (!firefoxDirect && typeof withLease !== 'function') {
    throw new TypeError('semantic controller lease boundary is required');
  }
  if (firefoxDirect && typeof withDirectLifetime !== 'function') {
    throw new TypeError('semantic controller direct lifetime is required');
  }
  const runtimeRoot = new URL(browser.runtime.getURL(''));
  const controllerHostUrl = new URL(offscreenUrl, runtimeRoot);
  if (controllerHostUrl.protocol !== runtimeRoot.protocol
      || controllerHostUrl.host !== runtimeRoot.host) {
    throw new TypeError('semantic controller host must belong to this extension');
  }
  const hasTurnAuthority = typeof authorizeTurnCall === 'function'
    && typeof handleTurnKernelCall === 'function';
  const hasSemanticAuthority = typeof authorizeSemanticCall === 'function'
    && typeof handleSemanticKernelCall === 'function';
  const hasRuntimeAuthority = typeof authorizeRuntimeCall === 'function';
  const hasRuntimeHandler = typeof handleRuntimeKernelCall === 'function';
  const hasFeatureAuthority = typeof authorizeFeatureCall === 'function'
    && typeof handleFeatureKernelCall === 'function';
  const ownsLeaseBoundary = !firefoxDirect && typeof withLease === 'function';
  // why a leased-user count: the Chrome lease is per bounded operation, but
  // the CLIENT channel is shared. Retiring it when one operation settles
  // while a concurrent leased operation (a live turn) is still on the wire
  // severs that operation mid-flight as outcome-unknown. Only the last user
  // out retires the realm.
  let leasedUsers = 0;
  const enterLeased = () => { leasedUsers += 1; };
  const exitLeased = () => {
    leasedUsers = Math.max(0, leasedUsers - 1);
    if (leasedUsers === 0 && ownsLeaseBoundary && active) retire(active);
  };
  /** @type {<T>(operation:()=>Promise<T>,options?:{outcomeKnownOnLoss?:boolean,code?:string,onLost?:(error:Error)=>void,lossGraceMs?:number})=>Promise<T>} */
  /** @type {<T>(operation:(lease?:unknown)=>Promise<T>,options?:any)=>Promise<T>} */
  const withControllerLease = firefoxDirect && typeof withDirectLifetime === 'function'
    ? withDirectLifetime
    : ownsLeaseBoundary
      ? (operation) => withLease(operation)
      : (operation) => operation();
  const semanticCapabilities = Object.freeze([
    'prompt.render', 'turn.tools.project',
    ...(hasRuntimeAuthority ? [RUNTIME_DISPATCH_CAPABILITY] : []),
    ...(hasSemanticAuthority ? ['semantic.dispatch'] : []),
    ...(hasTurnAuthority ? ['turn.run'] : []),
    ...(hasFeatureAuthority ? [KERNEL_FEATURE_DISPATCH_CAPABILITY] : []),
  ]);
  /** @type {Promise<any> | null} */
  let connecting = null;
  /** @type {any | null} */
  let active = null;
  /** @type {Promise<void>|null} */
  let retirementBarrier = null;
  let retirementBlocked = false;
  /** @type {Promise<{template:string,dwebBlock:string}> | null} */
  let promptAssets = null;
  const authorizeCall = (
    /** @type {string} */ capability,
    /** @type {unknown} */ payload,
  ) => capability === 'prompt.render' || capability === 'turn.tools.project' ? {
      ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
      origin: null,
      target: capability === 'prompt.render' ? 'system-prompt' : 'turn-tool-projection',
      replayClass: 'A',
    }
    : capability === 'turn.run' && hasTurnAuthority ? authorizeTurnCall(payload) : null;
  const authorizeControllerCall = (/** @type {string} */ capability,
    /** @type {unknown} */ payload) => {
    if (capability === RUNTIME_DISPATCH_CAPABILITY && hasRuntimeAuthority) {
      return authorizeRuntimeCall(payload);
    }
    if (capability === KERNEL_FEATURE_DISPATCH_CAPABILITY && hasFeatureAuthority) {
      return authorizeFeatureCall(payload);
    }
    return capability === 'semantic.dispatch' && hasSemanticAuthority
      ? authorizeSemanticCall(payload) : authorizeCall(capability, payload);
  };
  const handleControllerKernelCall = (/** @type {string} */ operation,
    /** @type {unknown} */ payload, /** @type {any} */ context) => {
    if (context?.capability === RUNTIME_DISPATCH_CAPABILITY) {
      return hasRuntimeHandler
        ? handleRuntimeKernelCall(operation, payload, context)
        : { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
    }
    if (context?.capability === KERNEL_FEATURE_DISPATCH_CAPABILITY) {
      return hasFeatureAuthority
        ? handleFeatureKernelCall(operation, payload, context)
        : { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
    }
    if (context?.capability === 'semantic.dispatch') {
      return hasSemanticAuthority
        ? handleSemanticKernelCall(operation, payload, context)
        : { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
    }
    if (context?.capability === 'turn.run') {
      return hasTurnAuthority
        ? handleTurnKernelCall(operation, payload, context)
        : { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
    }
    return { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };
  };

  const connect = async (/** @type {unknown} */ lease) => {
    if (firefoxDirect) {
      if (typeof directConnector !== 'function') {
        throw new ControllerChannelError(
          'Firefox direct controller connector missing', 'direct-connector-missing',
        );
      }
      return directConnector({
        capabilities: [...semanticCapabilities],
        supportedCapabilities: [...semanticCapabilities],
        buildDigest: CONTROLLER_BUILD_DIGEST,
        kernelIdentity,
        authorizeCall: authorizeControllerCall,
        handleKernelCall: hasTurnAuthority || hasSemanticAuthority || hasRuntimeHandler
          || hasFeatureAuthority
          ? handleControllerKernelCall : undefined,
        workerUrl: browser.runtime.getURL('offscreen/controller-worker.js'),
      });
    }
    // why two bounded attempts: lease settlement retires the offscreen
    // document, so a connect can race the successor document's creation. The
    // offer then lands on the dying WindowClient (or none) and the handshake
    // starves. The first attempt fails fast; the one retry re-runs
    // ensureOffscreen + findHost against the then-current exact host with a
    // FRESH channel. A same-epoch re-offer is safe precisely because the
    // failed offer never bound: the host refuses a repeated epoch, so a
    // half-established channel cannot be silently duplicated.
    /** @param {number} handshakeMs */
    const attempt = (handshakeMs) => connectOffscreenController({
      ensureOffscreen,
      capabilities: [...semanticCapabilities],
      buildDigest: CONTROLLER_BUILD_DIGEST,
      lease,
      kernelIdentity,
      authorizeCall: authorizeControllerCall,
      handleKernelCall: hasTurnAuthority || hasSemanticAuthority || hasRuntimeHandler
        || hasFeatureAuthority
        ? handleControllerKernelCall : undefined,
      handshakeTimeoutMs: handshakeMs,
      findHost: async () => selectExactControllerHost(
        await listWindowClients(), controllerHostUrl.href,
      ),
    });
    try {
      return await attempt(2_000);
    } catch (cause) {
      const code = /** @type {{code?:string}} */ (cause)?.code;
      if (code !== 'handshake-failed' && code !== 'host-missing') throw cause;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return attempt(10_000);
    }
  };

  let connectionGeneration = 0;
  const retirePoisonedHost = () => {
    if (retirementBarrier) return retirementBarrier;
    /** @type {ReturnType<typeof setTimeout>} */ let timer;
    const pending = Promise.race([
      Promise.resolve().then(() => retireHost('controller-host-startup-failed'))
        .then(() => true, () => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), connectTimeoutMs);
      }),
    ]).then((retired) => {
      if (!retired) retirementBlocked = true;
    }).finally(() => {
      clearTimeout(timer);
      if (retirementBarrier === pending && !retirementBlocked) retirementBarrier = null;
    });
    retirementBarrier = pending;
    return pending;
  };
  const getClient = async (/** @type {unknown} */ lease) => {
    if (retirementBlocked) throw startupChannelError('controller-host-retirement-failed');
    if (retirementBarrier) await retirementBarrier;
    if (retirementBlocked) throw startupChannelError('controller-host-retirement-failed');
    if (active) return active;
    if (!connecting) {
      const generation = connectionGeneration;
      /** @type {ReturnType<typeof setTimeout>} */ let timer;
      const candidate = connect(lease).then((client) => {
        if (generation !== connectionGeneration) {
          try { client.close(); } catch {}
          throw new ControllerChannelError('controller generation retired', 'generation-retired');
        }
        active = client;
        return client;
      });
      const bounded = Promise.race([
        candidate,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ControllerChannelError(
            'controller connection timed out', 'controller-connect-timeout',
          )), connectTimeoutMs);
        }),
      ]);
      const pending = bounded.catch(async (cause) => {
        if (generation === connectionGeneration) {
          connectionGeneration += 1;
          const retirement = !firefoxDirect ? retirePoisonedHost() : null;
          connecting = null;
          await retirement;
        }
        throw cause;
      }).finally(() => {
        clearTimeout(timer);
        if (connecting === pending) connecting = null;
      });
      connecting = pending;
    }
    return connecting;
  };
  const getClientForTurn = (/** @type {unknown} */ lease,
    /** @type {AbortSignal|undefined} */ signal) => {
    const pending = getClient(lease);
    if (!signal) return pending;
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const aborted = () => resolve(null);
      signal.addEventListener('abort', aborted, { once: true });
      pending.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', aborted);
      });
    });
  };

  const retire = (/** @type {any} */ client) => {
    if (active !== client) return;
    try { client.close(); } catch { /* already retired */ }
    active = null;
  };
  const retireActiveOnLifetimeLoss = () => {
    connectionGeneration += 1;
    connecting = null;
    const client = active;
    if (client) retire(client);
  };

  let promptGeneration = 0;
  const loadPromptAssets = () => {
    if (promptAssets) return promptAssets;
    const generation = promptGeneration;
    const controller = new AbortController();
    /** @type {ReturnType<typeof setTimeout>} */ let timer;
    const loaded = (async () => {
      const base = await fetchFn(
        browser.runtime.getURL('peerd-provider/system-prompt.txt'),
        { signal: controller.signal },
      );
      if (!base.ok) throw new Error('packaged system-prompt template is unavailable');
      let dwebBlock = '';
      if (dwebEnabled) {
        const dweb = await fetchFn(
          browser.runtime.getURL('peerd-provider/system-prompt-dweb.txt'),
          { signal: controller.signal },
        );
        const text = dweb.ok ? (await dweb.text()).trim() : '';
        dwebBlock = text ? `\n${text}\n` : '';
      }
      return { template: await base.text(), dwebBlock };
    })();
    const pending = Promise.race([
      loaded,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(startupChannelError('prompt-assets-load-timeout'));
        }, promptLoadTimeoutMs);
      }),
    ]).then((assets) => {
      if (generation !== promptGeneration) {
        throw new ControllerChannelError(
          'controller prompt generation retired', 'prompt-assets-generation-retired',
        );
      }
      return /** @type {{template:string,dwebBlock:string}} */ (assets);
    }).catch((cause) => {
      if (generation === promptGeneration) promptGeneration += 1;
      throw cause;
    }).finally(() => {
      clearTimeout(timer);
      if (promptAssets === pending && generation !== promptGeneration) promptAssets = null;
    });
    promptAssets = pending;
    return promptAssets;
  };

  const renderSystemPromptUnleased = async (/** @type {Record<string, unknown>} */ ctx,
    /** @type {unknown} */ lease) => {
    const assets = await loadPromptAssets();
    let client = null;
    try {
      client = await getClient(lease);
      const result = await client.call(
        'prompt.render', { ctx, ...assets }, { timeoutMs: 15_000 },
      );
      if (result?.ok === true && typeof result.prompt === 'string') return result.prompt;
    } catch {}
    if (client) retire(client);
    return null;
  };
  const renderSystemPrompt = async (/** @type {Record<string, unknown>} */ ctx) => {
    // why: a retired lease cannot be replayed into the sealed host. A startup
    // retry therefore reacquires the lease boundary instead of reusing the
    // identity that just lost its controller generation.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = await withControllerLease(async (/** @type {unknown} */ lease) => {
        enterLeased();
        try { return await renderSystemPromptUnleased(ctx, lease); }
        finally { exitLeased(); }
      }, {
        outcomeKnownOnLoss: true,
        code: 'controller-firefox-prompt-lifetime-lost',
        onLost: retireActiveOnLifetimeLoss,
      });
      if (typeof prompt === 'string') return prompt;
    }
    throw Object.assign(new Error(STARTUP_UNAVAILABLE_USER_FAILURE), {
      code: 'controller-prompt-startup-failed',
      outcomeKnown: true,
      phase: 'startup',
      retryable: true,
    });
  };

  const projectTurnTools = async (/** @type {Record<string, unknown>} */ input) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tools = await withControllerLease(async (/** @type {unknown} */ lease) => {
        enterLeased();
        try {
          let client = null;
          try {
            client = await getClient(lease);
            const result = await client.call('turn.tools.project', input, { timeoutMs: 15_000 });
            if (result?.ok === true && Array.isArray(result.tools)) return result.tools;
            if (result?.outcomeKnown === true) {
              throw Object.assign(new Error(result.code ?? 'turn-tool-projection-failed'), result);
            }
          } catch (cause) {
            if (/** @type {{outcomeKnown?:unknown}} */ (cause)?.outcomeKnown === true) throw cause;
          }
          if (client) retire(client);
          return null;
        } finally { exitLeased(); }
      }, {
        outcomeKnownOnLoss: true,
        code: 'controller-firefox-tool-projection-lifetime-lost',
        onLost: retireActiveOnLifetimeLoss,
      });
      if (Array.isArray(tools)) return tools;
    }
    throw Object.assign(new Error(STARTUP_UNAVAILABLE_USER_FAILURE), {
      code: 'controller-tool-projection-startup-failed',
      outcomeKnown: true, phase: 'startup', retryable: true,
    });
  };

  const callTurnUnleased = async (
    /** @type {unknown} */ payload,
    /** @type {unknown} */ lease,
    /** @type {{signal?:AbortSignal,timeoutMs?:number}} */ options = {},
  ) => {
    if (!hasTurnAuthority) {
      return {
        ok: false, code: 'controller-turn-authority-unavailable',
        outcomeKnown: true, phase: 'startup',
      };
    }
    let client;
    try { client = await getClientForTurn(lease, options.signal); }
    catch (cause) {
      return {
        ok: false,
        code: /** @type {{code?:string}} */ (cause)?.code === 'controller-direct-load-timeout'
          ? 'controller-direct-load-timeout' : 'controller-turn-startup-failed',
        error: STARTUP_UNAVAILABLE_USER_FAILURE,
        outcomeKnown: true,
        phase: 'startup',
        retryable: true,
      };
    }
    if (!client) return stopped('controller-call-aborted', true);
    let result;
    try {
      result = await client.call('turn.run', payload, options);
    } catch (cause) {
      retire(client);
      return {
        ok: false,
        code: 'controller-turn-transport-failed',
        error: cause instanceof Error ? cause.message : String(cause),
        outcomeKnown: false,
        phase: 'run',
      };
    }
    if (result?.outcomeKnown === false || controllerGenerationMustRetire(result)) retire(client);
    return result;
  };
  const callTurn = async (
    /** @type {unknown} */ payload,
    /** @type {{signal?:AbortSignal,timeoutMs?:number}} */ options = {},
  ) => {
    try {
      // why one startup retry: a bounded lease elsewhere can retire and
      // replace the shared offscreen host between this lease's claim and the
      // channel handshake, stranding the offer on the dying document. A
      // startup-phase failure proves nothing was dispatched (Class A), so one
      // fresh lease + connect against the successor host is replay-safe.
      let attempts = 0;
      for (;;) {
        const result = await withControllerLease(async (/** @type {unknown} */ lease) => {
          enterLeased();
          try { return await callTurnUnleased(payload, lease, options); }
          finally { exitLeased(); }
        }, {
          outcomeKnownOnLoss: false,
          code: 'controller-firefox-turn-lifetime-lost',
          onLost: retireActiveOnLifetimeLoss,
          lossGraceMs: 2_000,
        });
        attempts += 1;
        if (result?.code !== 'controller-turn-startup-failed' || attempts > 1
            || options.signal?.aborted) return result;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (cause) {
      return {
        ok: false,
        code: /** @type {{code?:string}} */ (cause)?.code
          ?? 'controller-turn-lifetime-failed',
        error: cause instanceof Error ? cause.message : String(cause),
        outcomeKnown: /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown !== false,
        phase: /** @type {{phase?:string}} */ (cause)?.phase ?? 'startup',
      };
    }
  };

  const callSemanticUnleased = async (/** @type {unknown} */ payload,
    /** @type {unknown} */ lease) => {
    if (!hasSemanticAuthority) {
      return { ok: false, code: 'semantic-dispatch-authority-unavailable', outcomeKnown: true };
    }
    let client;
    try { client = await getClient(lease); }
    catch (cause) {
      return startupResult(
        /** @type {{code?:string}} */ (cause)?.code === 'controller-direct-load-timeout'
          ? 'controller-direct-load-timeout' : 'semantic-dispatch-startup-failed',
      );
    }
    try {
      const result = await client.call('semantic.dispatch', payload, { timeoutMs: 30_000 });
      if (result?.outcomeKnown === false || controllerGenerationMustRetire(result)) retire(client);
      return result?.ok === true && Object.hasOwn(result, 'semanticResult')
        ? result.semanticResult : result;
    } catch {
      retire(client);
      return { ok: false, code: 'semantic-dispatch-transport-failed', outcomeKnown: false };
    }
  };
  const callSemantic = async (/** @type {unknown} */ payload) => {
    try {
      // Same replay-safe startup retry as callTurn: a startup failure proves
      // the semantic dispatch never left the kernel.
      let attempts = 0;
      for (;;) {
        const result = await withControllerLease(async (/** @type {unknown} */ lease) => {
          enterLeased();
          try { return await callSemanticUnleased(payload, lease); }
          finally { exitLeased(); }
        }, {
          outcomeKnownOnLoss: false,
          code: 'controller-firefox-semantic-lifetime-lost',
          onLost: retireActiveOnLifetimeLoss,
        });
        attempts += 1;
        if (result?.code !== 'semantic-dispatch-startup-failed' || attempts > 1) return result;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (cause) {
      return {
        ok: false,
        code: /** @type {{code?:string}} */ (cause)?.code
          ?? 'semantic-dispatch-lifetime-failed',
        outcomeKnown: /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown !== false,
      };
    }
  };
  const callRuntime = async (
    /** @type {unknown} */ payload,
    /** @type {{signal?:AbortSignal,timeoutMs?:number}} */ options = {},
  ) => {
    if (!hasRuntimeAuthority) {
      return {
        ok: false, code: 'runtime-dispatch-authority-unavailable',
        outcomeKnown: true, phase: 'startup',
      };
    }
    const replayable = parseRuntimeDispatch(payload)?.policy.authority.replayClass === 'A';
    try {
      return await withControllerLease(async (/** @type {unknown} */ lease) => {
        enterLeased();
        try {
          let client;
          try { client = await getClient(lease); }
          catch {
            return startupResult('runtime-dispatch-startup-failed');
          }
          try {
            const result = await client.call(RUNTIME_DISPATCH_CAPABILITY, payload, options);
            if (result?.outcomeKnown === false || controllerGenerationMustRetire(result)) {
              retire(client);
            }
            return result;
          } catch (cause) {
            retire(client);
            return {
              ok: false, code: 'runtime-dispatch-transport-failed',
              error: cause instanceof Error ? cause.message : String(cause),
              outcomeKnown: false, phase: 'run',
            };
          }
        } finally {
          exitLeased();
        }
      }, {
        outcomeKnownOnLoss: replayable,
        code: 'controller-firefox-runtime-lifetime-lost',
        onLost: retireActiveOnLifetimeLoss,
        ...(!replayable ? { lossGraceMs: 2_000 } : {}),
      });
    } catch (cause) {
      const known = /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown !== false;
      return {
        ok: false,
        code: /** @type {{code?:string}} */ (cause)?.code
          ?? 'runtime-dispatch-lifetime-failed',
        error: known ? STARTUP_UNAVAILABLE_USER_FAILURE : OUTCOME_UNKNOWN_USER_FAILURE,
        outcomeKnown: known,
        phase: /** @type {{phase?:string}} */ (cause)?.phase ?? 'startup',
        retryable: known,
      };
    }
  };
  const callFeatureCapability = async (
    /** @type {string} */ capability,
    /** @type {unknown} */ payload,
    /** @type {{signal?:AbortSignal,timeoutMs?:number}} */ options = {},
  ) => {
    if (!hasFeatureAuthority) {
      return {
        ok: false, code: 'feature-dispatch-authority-unavailable',
        outcomeKnown: true, phase: 'startup',
      };
    }
    const replayable = parseKernelFeatureCall(capability, payload)?.policy.replayClass === 'A';
    try {
      let attempts = 0;
      for (;;) {
        const result = await withControllerLease(async (/** @type {unknown} */ lease) => {
          enterLeased();
          try {
            let client;
            try { client = await getClient(lease); }
            catch {
              return startupResult('feature-dispatch-startup-failed');
            }
            try {
              const reply = await client.call(capability, payload, options);
              if (reply?.outcomeKnown === false || controllerGenerationMustRetire(reply)) {
                retire(client);
              }
              return reply;
            } catch (cause) {
              retire(client);
              return {
                ok: false, code: 'feature-dispatch-transport-failed',
                error: cause instanceof Error ? cause.message : String(cause),
                outcomeKnown: false, phase: 'run',
              };
            }
          } finally {
            exitLeased();
          }
        }, {
          outcomeKnownOnLoss: replayable,
          code: 'controller-firefox-feature-lifetime-lost',
          onLost: retireActiveOnLifetimeLoss,
          ...(!replayable ? { lossGraceMs: 2_000 } : {}),
        });
        attempts += 1;
        if (!replayable || result?.code !== 'feature-dispatch-startup-failed'
            || attempts > 1) return result;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } catch (cause) {
      const known = /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown !== false;
      return {
        ok: false,
        code: /** @type {{code?:string}} */ (cause)?.code
          ?? 'feature-dispatch-lifetime-failed',
        error: known ? STARTUP_UNAVAILABLE_USER_FAILURE : OUTCOME_UNKNOWN_USER_FAILURE,
        outcomeKnown: known,
        phase: /** @type {{phase?:string}} */ (cause)?.phase ?? 'startup',
        retryable: known,
      };
    }
  };
  const callFeature = (/** @type {unknown} */ payload,
    /** @type {{signal?:AbortSignal,timeoutMs?:number}} */ options = {}) =>
    callFeatureCapability(KERNEL_FEATURE_DISPATCH_CAPABILITY, payload, options);
  // why the outer leased user: a raw host lease keeps the document alive, but
  // zero client users still retires its channel and sealed Worker between turns.
  const withRun = (/** @type {()=>Promise<any>} */ operation) =>
    withControllerLease(async () => {
      enterLeased();
      try { return await operation(); }
      finally { exitLeased(); }
    }, {
      outcomeKnownOnLoss: false,
      code: 'controller-firefox-run-lifetime-lost',
      onLost: retireActiveOnLifetimeLoss,
    });

  return Object.freeze({
    renderSystemPrompt,
    projectTurnTools,
    callTurn,
    callSemantic,
    callRuntime,
    callFeature,
    withRun,
    retire: retireActiveOnLifetimeLoss,
    close: () => {
      connectionGeneration += 1;
      connecting = null;
      if (active) retire(active);
    },
  });
};
