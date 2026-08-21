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
  controllerKernelConcurrentCap,
  controllerOuterPayloadCap,
  controllerRenewalIdleCap,
  createControllerKernelQuota,
} from '../shared/controller-kernel-quota.js';
import { parseKernelIdentity } from '../shared/kernel-identity.js';

export class ControllerChannelError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code) {
    super(message);
    this.name = 'ControllerChannelError';
    this.code = code;
  }
}

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
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const connectOffscreenController = async ({
  ensureOffscreen,
  findHost,
  capabilities,
  buildDigest,
  kernelIdentity: injectedIdentity,
  authorizeCall,
  handleKernelCall,
  createChannel = () => new MessageChannel(),
  newId = () => crypto.randomUUID(),
  handshakeTimeoutMs = 10_000,
  callTimeoutMs = 60_000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
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
    if (call.onAbort) call.signal?.removeEventListener('abort', call.onAbort);
    for (const pending of call.reverse.values()) pending.controller.abort();
    call.reverse.clear();
    call.resolve(result);
  };
  const failAll = (/** @type {string} */ code) => {
    for (const [requestId, call] of calls) {
      finish(requestId, stopped(
        code,
        call.phase === CONTROLLER_PHASE.OPENED || call.phase === CONTROLLER_PHASE.ACCEPTED,
      ));
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    failAll('controller-channel-closed');
    try { port1.close(); } catch { /* already closed */ }
  };
  const renewCall = (/** @type {string} */ requestId, /** @type {any} */ call) => {
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
      finish(requestId, stopped('controller-call-timeout', false));
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
          || call.reverse.size >= controllerKernelConcurrentCap(call.capability)) {
        close();
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
        if (bounded?.outcomeKnown !== true) call.nestedUnknown = true;
        try {
          post({
            type: 'kernel/kernel-result', requestId: message.requestId,
            grantId: call.grantId, rpcId: message.rpcId, result: bounded,
          });
        } catch { call.nestedUnknown = true; }
      };
      if (typeof handleKernelCall !== 'function') {
        settleKernelCall({ ok: false, code: 'kernel-operation-denied', outcomeKnown: true });
        return;
      }
      Promise.resolve(handleKernelCall(message.operation, message.payload, {
        capability: call.capability,
        authority: call.authority,
        signal: controller.signal,
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
      const known = !call.nestedUnknown && message.result?.outcomeKnown === true;
      finish(message.requestId, {
        ...(message.result ?? { ok: false, error: 'controller returned no result' }),
        outcomeKnown: known,
        phase: CONTROLLER_PHASE.SETTLED,
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
  const call = (capability, payload, options = {}) => {
    if (closed) return Promise.resolve(stopped('controller-channel-closed', true));
    if (!activeCaps.includes(capability)) {
      return Promise.resolve(stopped('controller-capability-denied', true));
    }
    if (options.signal?.aborted) return Promise.resolve(stopped('controller-call-aborted', true));
    const outerCap = controllerOuterPayloadCap(capability);
    if (outerCap <= 0 || !payloadFitsControllerCap(payload, outerCap)) {
      return Promise.resolve(stopped('controller-payload-too-large', true));
    }
    const authority = parseControllerAuthority(authorizeCall(capability, payload));
    if (!authority) return Promise.resolve(stopped('controller-authority-invalid', true));
    const requestId = newId();
    const grantId = newId();
    return new Promise((resolve) => {
      const timeoutMs = Math.max(1, options.timeoutMs ?? callTimeoutMs);
      const deadlineAt = Date.now() + timeoutMs;
      const timer = setTimeoutFn(() => {
        const active = calls.get(requestId);
        if (!active) return;
        try { post({ type: 'kernel/cancel', requestId, grantId: active.grantId }); } catch { /* host gone */ }
        finish(requestId, stopped(
          'controller-call-timeout',
          active.phase === CONTROLLER_PHASE.OPENED || active.phase === CONTROLLER_PHASE.ACCEPTED,
        ));
      }, timeoutMs);
      const onAbort = () => {
        const active = calls.get(requestId);
        if (!active) return;
        try { post({ type: 'kernel/cancel', requestId, grantId: active.grantId }); } catch { /* host gone */ }
        finish(requestId, stopped(
          'controller-call-aborted',
          active.phase === CONTROLLER_PHASE.OPENED || active.phase === CONTROLLER_PHASE.ACCEPTED,
        ));
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
        reverse: new Map(),
        quota: createControllerKernelQuota(capability, payload),
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
 * @param {import('../shared/kernel-identity.js').KernelIdentity} [deps.kernelIdentity]
 * @param {(payload:unknown)=>unknown} [deps.authorizeTurnCall]
 * @param {(operation:string,payload:unknown,context:any)=>Promise<any>|any} [deps.handleTurnKernelCall]
 * @param {(payload:unknown)=>unknown} [deps.authorizeSemanticCall]
 * @param {(operation:string,payload:unknown,context:any)=>Promise<any>|any} [deps.handleSemanticKernelCall]
 * @param {<T>(operation:()=>Promise<T>)=>Promise<T>} [deps.withControllerLease]
 * @param {<T>(operation:()=>Promise<T>,options?:{outcomeKnownOnLoss?:boolean,code?:string})=>Promise<T>} [deps.withDirectLifetime]
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
  withControllerLease: withLease,
  withDirectLifetime,
  retireHost = async () => {},
  fetchFn,
  listWindowClients = async () => {
    const clientApi = /** @type {any} */ (globalThis).clients;
    if (typeof clientApi?.matchAll !== 'function') return [];
    return clientApi.matchAll({ type: 'window', includeUncontrolled: true });
  },
}) => {
  if (typeof fetchFn !== 'function') {
    throw new TypeError('semantic controller asset reader is required');
  }
  const hasTurnAuthority = typeof authorizeTurnCall === 'function'
    && typeof handleTurnKernelCall === 'function';
  const hasSemanticAuthority = typeof authorizeSemanticCall === 'function'
    && typeof handleSemanticKernelCall === 'function';
  const ownsLeaseBoundary = typeof withLease === 'function';
  /** @type {<T>(operation:()=>Promise<T>,options?:{outcomeKnownOnLoss?:boolean,code?:string})=>Promise<T>} */
  const withControllerLease = firefoxDirect && typeof withDirectLifetime === 'function'
    ? withDirectLifetime
    : ownsLeaseBoundary
      ? (operation) => withLease(operation)
      : (operation) => operation();
  const semanticCapabilities = Object.freeze([
    'prompt.render',
    ...(hasSemanticAuthority ? ['semantic.dispatch'] : []),
    ...(hasTurnAuthority ? ['turn.run'] : []),
  ]);
  /** @type {Promise<any> | null} */
  let connecting = null;
  /** @type {any | null} */
  let active = null;
  /** @type {Promise<{template:string,dwebBlock:string}> | null} */
  let promptAssets = null;
  const authorizeCall = (
    /** @type {string} */ capability,
    /** @type {unknown} */ payload,
  ) => capability === 'prompt.render' ? {
      ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
      origin: null, target: 'system-prompt', replayClass: 'A',
    }
    : capability === 'turn.run' && hasTurnAuthority ? authorizeTurnCall(payload) : null;
  const authorizeControllerCall = (/** @type {string} */ capability,
    /** @type {unknown} */ payload) => capability === 'semantic.dispatch' && hasSemanticAuthority
      ? authorizeSemanticCall(payload) : authorizeCall(capability, payload);
  const handleControllerKernelCall = (/** @type {string} */ operation,
    /** @type {unknown} */ payload, /** @type {any} */ context) =>
    context?.capability === 'semantic.dispatch' && hasSemanticAuthority
      ? handleSemanticKernelCall(operation, payload, context)
      : hasTurnAuthority ? handleTurnKernelCall(operation, payload, context)
        : { ok: false, code: 'kernel-operation-denied', outcomeKnown: true };

  const connect = async () => {
    if (firefoxDirect) {
      const { connectDirectController } = await import('./direct-controller-client.js');
      return connectDirectController({
        capabilities: [...semanticCapabilities],
        supportedCapabilities: [...semanticCapabilities],
        buildDigest: CONTROLLER_BUILD_DIGEST,
        ...(kernelIdentity ? { kernelIdentity } : {}),
        authorizeCall: authorizeControllerCall,
        handleKernelCall: hasTurnAuthority || hasSemanticAuthority
          ? handleControllerKernelCall : undefined,
        workerUrl: browser.runtime.getURL('offscreen/controller-worker.js'),
      });
    }
    return connectOffscreenController({
      ensureOffscreen,
      capabilities: [...semanticCapabilities],
      buildDigest: CONTROLLER_BUILD_DIGEST,
      ...(kernelIdentity ? { kernelIdentity } : {}),
      authorizeCall: authorizeControllerCall,
      handleKernelCall: hasTurnAuthority || hasSemanticAuthority
        ? handleControllerKernelCall : undefined,
      findHost: async () => selectExactControllerHost(
        await listWindowClients(), browser.runtime.getURL(offscreenUrl),
      ),
    });
  };

  const getClient = async () => {
    if (active) return active;
    connecting ??= connect().then((client) => {
      active = client;
      return client;
    }).catch(async (cause) => {
      if (!firefoxDirect) await retireHost('controller-host-startup-failed');
      throw cause;
    }).finally(() => { connecting = null; });
    return connecting;
  };

  const retire = (/** @type {any} */ client) => {
    if (active !== client) return;
    try { client.close(); } catch { /* already retired */ }
    active = null;
  };

  const loadPromptAssets = () => {
    promptAssets ??= (async () => {
      const base = await fetchFn(browser.runtime.getURL('peerd-provider/system-prompt.txt'));
      if (!base.ok) throw new Error('packaged system-prompt template is unavailable');
      let dwebBlock = '';
      if (dwebEnabled) {
        const dweb = await fetchFn(browser.runtime.getURL('peerd-provider/system-prompt-dweb.txt'));
        const text = dweb.ok ? (await dweb.text()).trim() : '';
        dwebBlock = text ? `\n${text}\n` : '';
      }
      return { template: await base.text(), dwebBlock };
    })().catch((cause) => {
      promptAssets = null;
      throw cause;
    });
    return promptAssets;
  };

  const renderSystemPromptUnleased = async (/** @type {Record<string, unknown>} */ ctx) => {
    const assets = await loadPromptAssets();
    let last;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let client = null;
      try {
        client = await getClient();
        const result = await client.call(
          'prompt.render', { ctx, ...assets }, { timeoutMs: 15_000 },
        );
        if (result?.ok === true && typeof result.prompt === 'string') return result.prompt;
        last = result;
      } catch (cause) {
        last = { error: cause instanceof Error ? cause.message : String(cause) };
      }
      if (client) retire(client);
    }
    throw new Error(
      `semantic prompt renderer unavailable: ${last?.error ?? last?.code ?? 'unknown failure'}`,
    );
  };
  const renderSystemPrompt = (/** @type {Record<string, unknown>} */ ctx) =>
    withControllerLease(async () => {
      try { return await renderSystemPromptUnleased(ctx); }
      finally { if (ownsLeaseBoundary && active) retire(active); }
    });

  const callTurnUnleased = async (
    /** @type {unknown} */ payload,
    /** @type {{signal?:AbortSignal,timeoutMs?:number}} */ options = {},
  ) => {
    if (!hasTurnAuthority) {
      return {
        ok: false, code: 'controller-turn-authority-unavailable',
        outcomeKnown: true, phase: 'startup',
      };
    }
    let client;
    try { client = await getClient(); }
    catch (cause) {
      return {
        ok: false,
        code: 'controller-turn-startup-failed',
        error: cause instanceof Error ? cause.message : String(cause),
        outcomeKnown: true,
        phase: 'startup',
      };
    }
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
    if (result?.outcomeKnown === false) retire(client);
    return result;
  };
  const callTurn = async (
    /** @type {unknown} */ payload,
    /** @type {{signal?:AbortSignal,timeoutMs?:number}} */ options = {},
  ) => {
    try {
      return await withControllerLease(async () => {
        try { return await callTurnUnleased(payload, options); }
        finally { if (ownsLeaseBoundary && active) retire(active); }
      }, {
        outcomeKnownOnLoss: false,
        code: 'controller-firefox-turn-lifetime-lost',
      });
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

  const callSemanticUnleased = async (/** @type {unknown} */ payload) => {
    if (!hasSemanticAuthority) {
      return { ok: false, code: 'semantic-dispatch-authority-unavailable', outcomeKnown: true };
    }
    let client;
    try { client = await getClient(); }
    catch {
      return { ok: false, code: 'semantic-dispatch-startup-failed', outcomeKnown: true };
    }
    try {
      const result = await client.call('semantic.dispatch', payload, { timeoutMs: 30_000 });
      if (result?.outcomeKnown === false) retire(client);
      return result?.ok === true && Object.hasOwn(result, 'semanticResult')
        ? result.semanticResult : result;
    } catch {
      retire(client);
      return { ok: false, code: 'semantic-dispatch-transport-failed', outcomeKnown: false };
    } finally {
      if (ownsLeaseBoundary && active) retire(active);
    }
  };
  const callSemantic = async (/** @type {unknown} */ payload) => {
    try {
      return await withControllerLease(() => callSemanticUnleased(payload), {
        outcomeKnownOnLoss: false,
        code: 'controller-firefox-semantic-lifetime-lost',
      });
    } catch (cause) {
      return {
        ok: false,
        code: /** @type {{code?:string}} */ (cause)?.code
          ?? 'semantic-dispatch-lifetime-failed',
        outcomeKnown: /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown !== false,
      };
    }
  };

  return Object.freeze({
    renderSystemPrompt,
    callTurn,
    callSemantic,
    close: () => {
      if (active) retire(active);
      connecting = null;
    },
  });
};
