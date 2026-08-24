// @ts-check
// Recover a UI snapshot when Chrome creates an extension Port before a cold
// MV3 worker has registered onConnect. That orphan Port may remain open without
// ever receiving its initial push, so Port liveness alone is not readiness.

import { makeKernelStateCustody } from './kernel-state-shell.js';

/**
 * @param {Object} deps
 * @param {{runtime:{sendMessage:(message:any)=>Promise<any>}}} deps.browser
 * @param {() => boolean} deps.isCurrent
 * @param {() => boolean} deps.isHydrated
 * @param {(state:any) => boolean|void} deps.adoptState
 * @param {number} [deps.requestTimeoutMs]
 * @param {number} [deps.retryMinMs]
 * @param {number} [deps.retryMaxMs]
 * @param {number} [deps.overallTimeoutMs]
 * @param {number} [deps.maxAttempts]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 * @returns {Promise<boolean>}
 */
export const recoverColdPortState = async ({
  browser,
  isCurrent,
  isHydrated,
  adoptState,
  requestTimeoutMs = 1_000,
  retryMinMs = 100,
  retryMaxMs = 1_000,
  overallTimeoutMs = 60_000,
  maxAttempts = 2,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  if (!browser?.runtime?.sendMessage || typeof isCurrent !== 'function'
      || typeof isHydrated !== 'function' || typeof adoptState !== 'function'
      || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0
      || !Number.isFinite(retryMinMs) || retryMinMs <= 0
      || !Number.isFinite(retryMaxMs) || retryMaxMs < retryMinMs
      || !Number.isFinite(overallTimeoutMs) || overallTimeoutMs <= requestTimeoutMs
      || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4) {
    throw new TypeError('cold-port-recovery-options-invalid');
  }
  if (!isCurrent() || isHydrated()) return false;

  const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeoutFn(resolve, ms));
  const deadlineAt = Date.now() + overallTimeoutMs;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let deadlineTimer = null;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeoutFn(() => resolve({ kind: 'deadline' }), overallTimeoutMs);
  });
  const waitForReply = async (/** @type {string} */ type) => {
    let retryMs = retryMinMs;
    let nextId = 0;
    /** @type {Map<number, Promise<{kind:'reply',id:number,value:any}>>} */
    const active = new Map();
    const launch = () => {
      const id = nextId++;
      active.set(id, Promise.resolve().then(() => browser.runtime.sendMessage({ type })).then(
        (value) => ({ kind: /** @type {const} */ ('reply'), id, value }),
        () => ({ kind: /** @type {const} */ ('reply'), id, value: null }),
      ));
    };
    launch();
    let fallbackAt = Date.now() + requestTimeoutMs;
    while (isCurrent() && !isHydrated() && Date.now() < deadlineAt) {
      const waitMs = Math.max(0, Math.min(fallbackAt, deadlineAt) - Date.now());
      const wake = /** @type {any} */ (await Promise.race([
        ...active.values(), deadline,
        sleep(waitMs).then(() => ({ kind: 'fallback' })),
      ]));
      if (!isCurrent() || isHydrated() || wake?.kind === 'deadline') return null;
      if (wake?.kind === 'reply') {
        active.delete(wake.id);
        if (wake.value?.ok) return wake.value;
        if (nextId < maxAttempts) {
          await sleep(retryMs);
          retryMs = Math.min(retryMaxMs, retryMs * 2);
          launch();
          fallbackAt = Date.now() + requestTimeoutMs;
        } else if (active.size === 0) return null;
        continue;
      }
      if (wake?.kind === 'fallback') {
        if (nextId < maxAttempts) launch();
        fallbackAt = deadlineAt;
      }
    }
    return null;
  };

  try {
    if (!await waitForReply('bootstrap/ready')) return false;
    const reply = await waitForReply('state/get');
    if (!isCurrent() || isHydrated() || !reply?.state) return false;
    return adoptState(reply.state) !== false;
  } finally {
    if (deadlineTimer != null) clearTimeoutFn(deadlineTimer);
  }
};

/**
 * One Port lifecycle for the rich Home and Sidepanel surfaces. It owns the
 * reconnect, cold-state recovery, and authority-source custody; surfaces only
 * define how accepted messages fold and how their transient view state resets.
 *
 * @param {Object} deps
 * @param {{runtime:{connect:(options:{name:string})=>any,sendMessage:(message:any)=>Promise<any>}}} deps.browser
 * @param {string} deps.name
 * @param {() => boolean} deps.isHydrated
 * @param {(message:any) => boolean|void} deps.onMessage
 * @param {() => void} deps.onDisconnect
 * @param {() => void} deps.onStatusChange
 * @param {typeof recoverColdPortState} [deps.recover]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {number} [deps.reconnectMs]
 */
export const makeUiStatePort = ({
  browser,
  name,
  isHydrated,
  onMessage,
  onDisconnect,
  onStatusChange,
  recover = recoverColdPortState,
  setTimeoutFn = setTimeout,
  reconnectMs = 200,
}) => {
  if (!browser?.runtime?.connect || !browser.runtime.sendMessage || !name
      || typeof isHydrated !== 'function' || typeof onMessage !== 'function'
      || typeof onDisconnect !== 'function' || typeof onStatusChange !== 'function') {
    throw new TypeError('ui-state-port-options-invalid');
  }
  const custody = makeKernelStateCustody();
  /** @type {any} */ let port = null;
  let failed = false;
  let started = false;

  /** @param {any} raw @param {number} source @param {boolean} [replace] */
  const receive = (raw, source, replace = false) => {
    if (!raw || typeof raw.type !== 'string') return false;
    let message = raw;
    if (raw.type === 'state') {
      const adoption = custody.adopt(raw.state, source, replace);
      if (!adoption) return false;
      message = { ...raw, state: adoption.state, authorityReplacement: adoption.replaced };
    }
    return onMessage(message) !== false;
  };

  /** @param {any} stale */
  const replace = (stale) => {
    if (port !== stale) return;
    custody.beginReplacement();
    port = null;
    try { stale.disconnect(); } catch { /* already orphaned */ }
    connect();
  };

  const connect = () => {
    if (!started || port) return;
    let connected;
    try { connected = browser.runtime.connect({ name }); }
    catch { failed = true; onStatusChange(); return; }
    const source = custody.capture();
    port = connected;
    failed = false;
    connected.onMessage.addListener((/** @type {any} */ message) => {
      if (port === connected) receive(message, source);
    });
    connected.onDisconnect.addListener(() => {
      if (port !== connected) return;
      custody.beginReplacement();
      port = null;
      failed = false;
      onDisconnect();
      setTimeoutFn(connect, reconnectMs);
    });
    void recover({
      browser,
      isCurrent: () => port === connected,
      isHydrated,
      adoptState: (state) => receive({ type: 'state', state }, source),
    }).then((recovered) => {
      if (port !== connected) return;
      if (recovered) replace(connected);
      else if (!isHydrated()) { failed = true; onStatusChange(); }
    });
  };

  const start = () => { if (!started) { started = true; connect(); } };
  const retry = () => { if (port) replace(port); else connect(); };
  const reconcile = async (/** @type {() => Promise<any>} */ readState) => {
    const source = custody.capture();
    const reply = await readState();
    if (reply?.ok && reply.state) receive({ type: 'state', state: reply.state }, source, true);
    return reply;
  };

  return Object.freeze({
    start,
    retry,
    reconcile,
    get failed() { return failed; },
  });
};
