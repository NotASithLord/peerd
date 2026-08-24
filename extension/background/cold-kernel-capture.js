// @ts-check
// Synchronous cold-event capture for the future authority kernel. This layer
// owns no semantic route implementation and imports no semantic barrel.

import {
  LEGACY_COLD_EVENTS,
  LEGACY_PORT_CLASSES,
} from './cold-kernel-inventory.js';
import { structuredClonePayloadFits } from '../shared/structured-clone-size.js';
import {
  kernelIdentityMatches,
  parseKernelIdentity,
} from '../shared/kernel-identity.js';

const QUEUE_SCHEMA = 1;
export const COLD_QUEUE_KEY = 'cold-kernel.queue.v1';
const DEFAULT_QUEUE_MAX = 256;
const DEFAULT_PENDING_PORT_MAX = 16;
const DEFAULT_RPC_DEADLINE_MS = 30_000;
const DEFAULT_RPC_PENDING_MAX = 64;
const DEFAULT_RPC_BYTES_MAX = 256 * 1024;

const safeId = (/** @type {unknown} */ value) => typeof value === 'number' && Number.isInteger(value)
  ? value : null;
const safeString = (/** @type {unknown} */ value, /** @type {number} */ max = 128) =>
  typeof value === 'string' && value.length <= max ? value : null;
const eventAt = (/** @type {any} */ root, /** @type {string} */ key) => {
  const parts = key.split('.');
  let value = root;
  for (const part of parts) value = value?.[part];
  return value;
};

/** @param {string} key @param {any[]} args */
export const sanitizeColdEvent = (key, args) => {
  if (key === 'runtime.onStartup') return {};
  if (key === 'alarms.onAlarm') return {
    name: safeString(args[0]?.name, 256),
    scheduledTime: Number.isFinite(args[0]?.scheduledTime) ? args[0].scheduledTime : null,
    periodInMinutes: Number.isFinite(args[0]?.periodInMinutes) ? args[0].periodInMinutes : null,
  };
  if (key === 'runtime.onUpdateAvailable') return { version: safeString(args[0]?.version, 64) };
  if (key === 'storage.session.onChanged') return {
    // Values can include the session DK mirror. Re-read behind host authority;
    // never copy a storage value into the queue.
    keys: Object.keys(args[0] ?? {}).filter((item) => item.length <= 256).slice(0, 128),
  };
  if (key === 'tabs.onCreated') return {
    tabId: safeId(args[0]?.id),
    windowId: safeId(args[0]?.windowId),
    openerTabId: safeId(args[0]?.openerTabId),
    pendingUrlPresent: typeof args[0]?.pendingUrl === 'string',
  };
  if (key === 'tabs.onUpdated') return {
    tabId: safeId(args[0]),
    status: ['loading', 'complete'].includes(args[1]?.status) ? args[1].status : null,
    urlChanged: typeof args[1]?.url === 'string',
  };
  if (key === 'tabs.onRemoved') return {
    tabId: safeId(args[0]),
    windowId: safeId(args[1]?.windowId),
    isWindowClosing: args[1]?.isWindowClosing === true,
  };
  if (key === 'tabs.onActivated') return {
    tabId: safeId(args[0]?.tabId), windowId: safeId(args[0]?.windowId),
  };
  if (key === 'windows.onFocusChanged') return { windowId: safeId(args[0]) };
  if (key === 'webNavigation.onCreatedNavigationTarget') return {
    sourceTabId: safeId(args[0]?.sourceTabId),
    sourceFrameId: safeId(args[0]?.sourceFrameId),
    tabId: safeId(args[0]?.tabId),
  };
  return {};
};

const defaultQueue = (/** @type {string} */ ownerEpoch,
  /** @type {ReturnType<typeof parseKernelIdentity>} */ identity = null) => ({
  schema: QUEUE_SCHEMA,
  ownerEpoch,
  ...(identity ? { ownerIdentity: identity } : {}),
  nextSequence: 1,
  entries: [],
});
const validEntry = (/** @type {any} */ value) => value
  && typeof value.id === 'string'
  && typeof value.kernelEpoch === 'string'
  && typeof value.event === 'string'
  && (value.event === 'kernel.queueOverflow'
    || LEGACY_COLD_EVENTS.some((entry) => entry.key === value.event))
  && Number.isFinite(value.capturedAt)
  && structuredClonePayloadFits(value.payload, 16 * 1024);
const parseQueue = (/** @type {any} */ value, /** @type {string} */ ownerEpoch,
  /** @type {number} */ max,
  /** @type {ReturnType<typeof parseKernelIdentity>} */ identity = null) => {
  if (!value || value.schema !== QUEUE_SCHEMA || !Array.isArray(value.entries)) {
    return defaultQueue(ownerEpoch, identity);
  }
  return {
    schema: QUEUE_SCHEMA,
    ownerEpoch,
    ...(identity ? { ownerIdentity: identity } : {}),
    nextSequence: Number.isSafeInteger(value.nextSequence) && value.nextSequence > 0
      ? value.nextSequence : 1,
    entries: value.entries.filter(validEntry).slice(-max),
  };
};

/**
 * @typedef {{
 *   epoch: string,
 *   kernelIdentity?: import('../shared/kernel-identity.js').KernelIdentity,
 *   dispatchMessage: (message: any, sender: any, signal: AbortSignal) => Promise<any>|any,
 *   adoptPort: (port: any) => void,
 *   retire: (reason: string) => void,
 * }} ColdHost
 */

/**
 * @param {Object} deps
 * @param {any} deps.browser raw chrome/browser API namespace
 * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void> }} deps.queueStore
 * @param {Record<string, (...args: any[]) => any>} deps.authority synchronous authority handlers by event key
 * @param {(sender: any) => boolean} deps.isFirstPartySender
 * @param {(port: any) => boolean} deps.isFirstPartyPort
 * @param {boolean} [deps.firefox]
 * @param {boolean} [deps.selfHostedChrome]
 * @param {number} [deps.queueMax]
 * @param {number} [deps.pendingPortMax]
 * @param {number} [deps.rpcDeadlineMs]
 * @param {number} [deps.rpcPendingMax]
 * @param {number} [deps.rpcBytesMax]
 * @param {import('../shared/kernel-identity.js').KernelIdentity} [deps.kernelIdentity]
 * @param {() => string} [deps.newId]
 * @param {() => number} [deps.now]
 * @param {boolean} [deps.registerListeners]
 */
export const createColdKernelCapture = ({
  browser,
  queueStore,
  authority,
  isFirstPartySender,
  isFirstPartyPort,
  firefox = false,
  selfHostedChrome = false,
  queueMax = DEFAULT_QUEUE_MAX,
  pendingPortMax = DEFAULT_PENDING_PORT_MAX,
  rpcDeadlineMs = DEFAULT_RPC_DEADLINE_MS,
  rpcPendingMax = DEFAULT_RPC_PENDING_MAX,
  rpcBytesMax = DEFAULT_RPC_BYTES_MAX,
  kernelIdentity: injectedIdentity,
  newId = () => crypto.randomUUID(),
  now = Date.now,
  registerListeners = true,
}) => {
  const kernelIdentity = injectedIdentity ? parseKernelIdentity(injectedIdentity) : null;
  if (injectedIdentity && !kernelIdentity) throw new TypeError('cold-kernel-identity-invalid');
  const kernelEpoch = kernelIdentity?.kernelEpoch ?? newId();
  const retiredHosts = new Set();
  const pendingPorts = new Set();
  /** @type {ColdHost|null} */ let host = null;
  let rpcPending = 0;
  /** @type {any} */ let queue = defaultQueue(kernelEpoch, kernelIdentity);
  /** @type {unknown} */ let degraded = null;
  /** @type {{ deliveryId: string, hostEpoch: string, ids: string[] } | null} */
  let activeDelivery = null;
  let tail = Promise.resolve();
  const hydrate = queueStore.get(COLD_QUEUE_KEY)
    .then((stored) => {
      queue = parseQueue(stored, kernelEpoch, queueMax, kernelIdentity);
      return queueStore.set(COLD_QUEUE_KEY, queue);
    })
    .catch((error) => { degraded = error; throw error; });

  const serialized = (/** @type {() => Promise<any>} */ operation) => {
    const run = tail.then(() => hydrate).then(operation);
    tail = run.then(() => {}, () => {});
    return run;
  };
  const persist = () => queueStore.set(COLD_QUEUE_KEY, queue);
  const assertOwner = async () => {
    const stored = await queueStore.get(COLD_QUEUE_KEY);
    if (stored?.ownerEpoch !== kernelEpoch
        || (kernelIdentity && !kernelIdentityMatches(kernelIdentity, stored?.ownerIdentity))) {
      throw new Error('cold-kernel-epoch-retired');
    }
  };
  const append = (/** @type {string} */ event, /** @type {any} */ payload) => serialized(async () => {
    await assertOwner();
    const id = `${kernelEpoch}:${queue.nextSequence}`;
    queue.nextSequence += 1;
    const entry = { id, kernelEpoch, event, payload, capturedAt: now() };
    // Coalesce reconstructible state hints; removals and alarms remain ordered.
    if (event === 'tabs.onUpdated' || event === 'tabs.onActivated'
        || event === 'windows.onFocusChanged' || event === 'storage.session.onChanged') {
      const coalesceKey = event === 'tabs.onUpdated' ? payload.tabId : event;
      queue.entries = queue.entries.filter((/** @type {any} */ prior) => {
        const priorKey = event === 'tabs.onUpdated' ? prior.payload?.tabId : prior.event;
        return !(prior.event === event && priorKey === coalesceKey);
      });
    }
    queue.entries.push(entry);
    if (queue.entries.length > queueMax) {
      const lost = queue.entries.length - queueMax + 1;
      queue.entries = queue.entries.slice(lost);
      queue.entries.unshift({
        id: `${kernelEpoch}:overflow:${queue.nextSequence++}`,
        kernelEpoch,
        event: 'kernel.queueOverflow',
        payload: { lost, recovery: 'full-reconcile-required' },
        capturedAt: now(),
      });
    }
    await persist();
    return entry;
  }).catch((error) => { degraded = error; throw error; });

  const capture = (/** @type {string} */ key, /** @type {any[]} */ args) => {
    const entry = LEGACY_COLD_EVENTS.find((candidate) => candidate.key === key);
    if (!entry) return null;
    if (registerListeners && entry.placement === 'kernel-authority') {
      try { authority[key]?.(...args); }
      catch (error) { degraded = error; }
    }
    if (entry.placement === 'durable-hint' || entry.placement === 'kernel-authority') {
      return append(key, sanitizeColdEvent(key, args));
    }
    return null;
  };

  const settle = (/** @type {string} */ id) => serialized(async () => {
    await assertOwner();
    const before = queue.entries.length;
    queue.entries = queue.entries.filter((/** @type {any} */ entry) => entry.id !== id);
    if (queue.entries.length === before) return false;
    if (activeDelivery?.ids.includes(id)) {
      activeDelivery.ids = activeDelivery.ids.filter((candidate) => candidate !== id);
      if (activeDelivery.ids.length === 0) activeDelivery = null;
    }
    await persist();
    return true;
  });

  const dispatchMessage = (/** @type {any} */ message, /** @type {any} */ sender,
    /** @type {(reply: any) => void} */ sendResponse) => {
    if (!message || typeof message.type !== 'string') {
      sendResponse({ ok: false, error: 'malformed-message', outcomeKnown: true });
      return false;
    }
    if (!isFirstPartySender(sender)) {
      sendResponse({ ok: false, error: 'untrusted-sender', outcomeKnown: true });
      return false;
    }
    if (!structuredClonePayloadFits(message, rpcBytesMax)) {
      sendResponse({ ok: false, error: 'kernel-message-too-large', outcomeKnown: true });
      return false;
    }
    if (message.type === 'bootstrap/ready') {
      sendResponse({
        ok: true, kernelEpoch, ...(kernelIdentity ? { kernelIdentity } : {}),
        hostReady: !!host, degraded: !!degraded,
      });
      return false;
    }
    const target = host;
    if (!target) {
      sendResponse({
        ok: false, error: 'kernel-host-unavailable', retryable: true,
        outcomeKnown: true, kernelEpoch, ...(kernelIdentity ? { kernelIdentity } : {}),
      });
      return false;
    }
    if (rpcPending >= rpcPendingMax) {
      sendResponse({
        ok: false, error: 'kernel-host-capacity', retryable: true, outcomeKnown: true,
      });
      return false;
    }
    rpcPending += 1;
    const abort = new AbortController();
    /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        // The dispatched handler may still land after this deadline. Retiring
        // the epoch prevents a retry from overlapping that unknown operation;
        // the private host adapter must reconnect with a fresh random epoch.
        detachHost(target.epoch, 'deadline');
        reject(new Error('kernel-host-deadline'));
      }, rpcDeadlineMs);
    });
    Promise.race([
      Promise.resolve().then(() => target.dispatchMessage(message, sender, abort.signal)),
      deadline,
    ]).then(
      (reply) => sendResponse(reply),
      (error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        // Dispatch crossed the host boundary. A timeout/throw can follow an
        // effect, so the kernel never tells a caller that retry is safe.
        outcomeKnown: false,
      }),
    ).finally(() => {
      rpcPending = Math.max(0, rpcPending - 1);
      if (timer) clearTimeout(timer);
    });
    return true;
  };

  const onConnect = (/** @type {any} */ port) => {
    if (!isFirstPartyPort(port)) { try { port.disconnect(); } catch { /* closed */ } return; }
    const portClass = LEGACY_PORT_CLASSES.find((candidate) => candidate.name === port.name);
    if (!portClass || portClass.cold === 'disconnect') {
      try { port.disconnect(); } catch { /* closed */ }
      return;
    }
    if (host) {
      try { host.adoptPort(port); } catch { try { port.disconnect(); } catch { /* closed */ } }
      return;
    }
    if (pendingPorts.size >= pendingPortMax) {
      try { port.disconnect(); } catch { /* closed */ }
      return;
    }
    pendingPorts.add(port);
    port.onDisconnect?.addListener?.(() => pendingPorts.delete(port));
    try { port.postMessage({ type: 'kernel/waiting', kernelEpoch }); } catch { pendingPorts.delete(port); }
  };

  const requiredAuthority = registerListeners ? LEGACY_COLD_EVENTS.filter((entry) =>
    (entry.placement === 'kernel-authority' || entry.placement === 'kernel-immediate')
      && (entry.common || (firefox && entry.firefox)
        || (selfHostedChrome && entry.selfHostedChrome))) : [];
  for (const entry of requiredAuthority) {
    if (typeof authority[entry.key] !== 'function') {
      throw new Error(`cold kernel missing synchronous authority: ${entry.key}`);
    }
  }

  const registered = [];
  for (const entry of registerListeners ? LEGACY_COLD_EVENTS : []) {
    if (!(entry.common || (firefox && entry.firefox)
        || (selfHostedChrome && entry.selfHostedChrome))) continue;
    const event = eventAt(browser, entry.key);
    if (typeof event?.addListener !== 'function') continue;
    /** @param {any[]} args */
    const capturedListener = (...args) => capture(entry.key, args);
    /** @param {any[]} args */
    const authorityListener = (...args) => authority[entry.key](...args);
    if (entry.key === 'runtime.onMessage') event.addListener(dispatchMessage);
    else if (entry.key === 'runtime.onConnect') event.addListener(onConnect);
    else if (entry.key === 'webRequest.onBeforeRequest') {
      event.addListener(authorityListener, { urls: ['<all_urls>'] }, ['blocking']);
    } else if (entry.key === 'action.onClicked') {
      event.addListener(authorityListener);
    } else if (entry.key === 'commands.onCommand') {
      event.addListener(authorityListener);
    } else event.addListener(capturedListener);
    registered.push(entry.key);
  }

  const attachHost = (/** @type {ColdHost} */ next) => {
    if (!next || typeof next.epoch !== 'string' || retiredHosts.has(next.epoch)
        || next.epoch === host?.epoch || typeof next.dispatchMessage !== 'function'
        || typeof next.adoptPort !== 'function' || typeof next.retire !== 'function'
        || (kernelIdentity && !kernelIdentityMatches(kernelIdentity, next.kernelIdentity))) return false;
    if (host) {
      retiredHosts.add(host.epoch);
      try { host.retire('replaced'); } catch { /* already lost */ }
    }
    host = next;
    activeDelivery = null;
    for (const port of pendingPorts) {
      pendingPorts.delete(port);
      try { host.adoptPort(port); } catch { try { port.disconnect(); } catch { /* closed */ } }
    }
    return true;
  };
  const detachHost = (/** @type {string} */ epoch, /** @type {string} */ reason = 'detached') => {
    if (host?.epoch !== epoch) return false;
    retiredHosts.add(epoch);
    try { host.retire(reason); } catch { /* already lost */ }
    host = null;
    activeDelivery = null;
    return true;
  };
  const claim = (/** @type {string} */ hostEpoch, limit = 32) => serialized(async () => {
    await assertOwner();
    if (host?.epoch !== hostEpoch || retiredHosts.has(hostEpoch)) return null;
    if (activeDelivery?.hostEpoch === hostEpoch) {
      const live = new Set(queue.entries.map((/** @type {any} */ entry) => entry.id));
      const ids = activeDelivery.ids.filter((id) => live.has(id));
      if (ids.length) {
        const selected = new Set(ids);
        return {
          kernelEpoch,
          ...(kernelIdentity ? { kernelIdentity } : {}),
          hostEpoch,
          deliveryId: activeDelivery.deliveryId,
          entries: structuredClone(queue.entries.filter(
            (/** @type {any} */ entry) => selected.has(entry.id),
          )),
        };
      }
      activeDelivery = null;
    }
    const entries = queue.entries.slice(0, Math.max(1, Math.min(64, limit)));
    const deliveryId = newId();
    activeDelivery = { deliveryId, hostEpoch, ids: entries.map((/** @type {any} */ entry) => entry.id) };
    return {
      kernelEpoch,
      ...(kernelIdentity ? { kernelIdentity } : {}),
      hostEpoch,
      deliveryId,
      entries: structuredClone(entries),
    };
  });
  const acknowledge = (/** @type {{ kernelEpoch: string, kernelIdentity?:unknown, hostEpoch: string, deliveryId: string, ids: string[] }} */ receipt) =>
    serialized(async () => {
      await assertOwner();
      if (receipt?.kernelEpoch !== kernelEpoch || host?.epoch !== receipt?.hostEpoch
          || (kernelIdentity && !kernelIdentityMatches(kernelIdentity, receipt?.kernelIdentity))
          || retiredHosts.has(receipt?.hostEpoch) || !Array.isArray(receipt?.ids)
          || receipt.deliveryId !== activeDelivery?.deliveryId
          || receipt.hostEpoch !== activeDelivery?.hostEpoch) return false;
      const allowed = new Set(activeDelivery.ids);
      const ids = new Set(receipt.ids.filter((id) => typeof id === 'string' && allowed.has(id)));
      queue.entries = queue.entries.filter((/** @type {any} */ entry) => !ids.has(entry.id));
      activeDelivery.ids = activeDelivery.ids.filter((id) => !ids.has(id));
      if (activeDelivery.ids.length === 0) activeDelivery = null;
      await persist();
      return true;
    });

  return Object.freeze({
    kernelEpoch,
    kernelIdentity,
    registered: Object.freeze(registered),
    ready: () => hydrate,
    attachHost,
    detachHost,
    claim,
    acknowledge,
    captureEvent: capture,
    settle,
    degraded: () => degraded,
  });
};
