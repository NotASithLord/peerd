// @ts-check
// Small, kernel-local cold-event receipts. This is deliberately not a generic
// host bridge: browser events stay in the authority realm, only fixed
// secretless hints persist, and recovery asks the owning kernel module to
// re-read current state.

import { coldEventKeysFor, KERNEL_COLD_EVENTS } from './cold-kernel-inventory.js';
import {
  bindKernelIdentity,
  kernelIdentityMatches,
  parseKernelIdentity,
} from '../shared/kernel-identity.js';
import { makeSerialLane } from '../shared/cold-util.js';

export const KERNEL_COLD_RECEIPTS_KEY = 'kernel.coldReceipts.v1';
export const KERNEL_GENERATION_SESSION_KEY = 'authority-kernel.generation.v1';
const SCHEMA = 1;
const DEFAULT_MAX = 256;
const INVENTORY = new Map(KERNEL_COLD_EVENTS.map((entry) => [entry.key, entry]));
const RECOVERABLE = new Set(KERNEL_COLD_EVENTS.filter(({ placement }) =>
  placement === 'durable-hint' || placement === 'kernel-authority').map(({ key }) => key));

const ownerValid = (/** @type {unknown} */ value) => typeof value === 'string'
  && value.length >= 3 && value.length <= 128;
const safeId = (/** @type {unknown} */ value) =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;
const safeString = (/** @type {unknown} */ value, /** @type {number} */ max = 128) =>
  typeof value === 'string' && value.length <= max ? value : null;

/** @param {string} key @param {any[]} args */
const sanitizeKernelColdEvent = (key, args) => {
  if (key === 'runtime.onStartup') return {};
  if (key === 'alarms.onAlarm') return {
    name: safeString(args[0]?.name, 256),
    scheduledTime: Number.isFinite(args[0]?.scheduledTime) ? args[0].scheduledTime : null,
    periodInMinutes: Number.isFinite(args[0]?.periodInMinutes)
      ? args[0].periodInMinutes : null,
  };
  if (key === 'runtime.onUpdateAvailable') {
    return { version: safeString(args[0]?.version, 64) };
  }
  if (key === 'storage.session.onChanged') {
    return {
      // Values may contain the mirrored vault data key. Persist names only.
      keys: Object.keys(args[0] ?? {})
        .filter((item) => item.length <= 256)
        .slice(0, 128),
    };
  }
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
    tabId: safeId(args[0]?.tabId),
    windowId: safeId(args[0]?.windowId),
  };
  if (key === 'windows.onFocusChanged') return { windowId: safeId(args[0]) };
  if (key === 'webNavigation.onCreatedNavigationTarget') return {
    sourceTabId: safeId(args[0]?.sourceTabId),
    sourceFrameId: safeId(args[0]?.sourceFrameId),
    tabId: safeId(args[0]?.tabId),
  };
  return {};
};

const validEntry = (/** @type {any} */ entry) => entry
  && typeof entry.id === 'string'
  && typeof entry.event === 'string'
  && (entry.event === 'kernel.queueOverflow' || INVENTORY.has(entry.event))
  && Number.isFinite(entry.capturedAt)
  && entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload);

const emptyQueue = (/** @type {import('../shared/kernel-identity.js').KernelIdentity} */ identity) => ({
  schema: SCHEMA,
  ownerIdentity: identity,
  nextSequence: 1,
  entries: [],
});

/** @param {any} deps */
export const makeKernelGenerationLifecycle = ({ session, identity: candidate }) => {
  const identity = parseKernelIdentity(candidate);
  if (!identity) throw new TypeError('kernel generation identity is invalid');
  let retired = false;
  const claim = async () => {
    await session.sessionSet(KERNEL_GENERATION_SESSION_KEY, identity);
    const observed = await session.sessionGet(KERNEL_GENERATION_SESSION_KEY);
    if (!kernelIdentityMatches(identity, observed)) {
      retired = true;
      throw new Error('kernel-generation-claim-lost');
    }
  };
  const readyPromise = claim();
  const reconcile = async () => {
    await readyPromise;
    if (retired) return { ok: false, error: 'kernel-generation-retired' };
    const observed = await session.sessionGet(KERNEL_GENERATION_SESSION_KEY);
    if (!kernelIdentityMatches(identity, observed)) {
      retired = true;
      return { ok: false, error: 'kernel-generation-retired' };
    }
    return { ok: true, identity };
  };
  const bind = (/** @type {Record<string,unknown>} */ payload) => {
    if (retired) throw new Error('kernel-generation-retired');
    return bindKernelIdentity(identity, payload);
  };
  const bindCurrent = async (/** @type {Record<string,unknown>} */ payload) => {
    const current = await reconcile();
    if (!current.ok) throw new Error(current.error);
    return bind(payload);
  };
  return Object.freeze({ identity, ready: () => readyPromise, reconcile, bind, bindCurrent });
};

/**
 * @param {Object} deps
 * @param {{get:(key:string)=>Promise<any>,set:(key:string,value:any)=>Promise<void>}} deps.store
 * @param {import('../shared/kernel-identity.js').KernelIdentity} deps.identity
 * @param {boolean} [deps.firefox]
 * @param {boolean} [deps.selfHostedChrome]
 * @param {number} [deps.max]
 * @param {()=>number} [deps.now]
 */
export const createKernelColdReceipts = ({
  store,
  identity,
  firefox = false,
  selfHostedChrome = false,
  max = DEFAULT_MAX,
  now = Date.now,
}) => {
  const canonicalIdentity = parseKernelIdentity(identity);
  if (!canonicalIdentity || typeof store?.get !== 'function'
      || typeof store?.set !== 'function' || !Number.isInteger(max) || max < 2) {
    throw new TypeError('kernel-cold-receipts-config-invalid');
  }
  /** @type {any} */
  let queue = emptyQueue(canonicalIdentity);
  /** @type {Promise<any>|null} */
  let recovery = null;
  /** @type {Map<string,{owner:string,raw:any,listener:Function|null,facade:any}>} */
  const events = new Map();
  const required = new Set(coldEventKeysFor({ firefox, selfHostedChrome }));
  const requiredRecoveries = new Set([...required].filter((key) => RECOVERABLE.has(key)));
  /** @type {Map<string,{owner:string,reconcile:Function}>} */
  const recoveryOwners = new Map();

  const persist = () => store.set(KERNEL_COLD_RECEIPTS_KEY, structuredClone(queue));
  const hydrate = store.get(KERNEL_COLD_RECEIPTS_KEY).then(async (stored) => {
    queue = emptyQueue(canonicalIdentity);
    if (stored?.schema === SCHEMA && Array.isArray(stored.entries)) {
      queue.nextSequence = Number.isSafeInteger(stored.nextSequence)
        && stored.nextSequence > 0 ? stored.nextSequence : 1;
      queue.entries = stored.entries.filter(validEntry).slice(-max);
    }
    await persist();
  });
  const lane = makeSerialLane();
  const serialized = (/** @type {()=>Promise<any>} */ operation) =>
    lane(() => hydrate.then(operation));
  const assertOwner = async () => {
    const stored = await store.get(KERNEL_COLD_RECEIPTS_KEY);
    if (!kernelIdentityMatches(canonicalIdentity, stored?.ownerIdentity)) {
      throw new Error('kernel-cold-receipts-owner-retired');
    }
  };
  const append = (/** @type {string} */ event, /** @type {any} */ payload) =>
    serialized(async () => {
      await assertOwner();
      const id = `${canonicalIdentity.kernelEpoch}:${queue.nextSequence++}`;
      const entry = { id, event, payload, capturedAt: now() };
      if (event === 'tabs.onUpdated' || event === 'tabs.onActivated'
          || event === 'windows.onFocusChanged' || event === 'storage.session.onChanged') {
        const key = event === 'tabs.onUpdated' ? payload.tabId : event;
        queue.entries = queue.entries.filter((/** @type {any} */ prior) => {
          const priorKey = event === 'tabs.onUpdated' ? prior.payload?.tabId : prior.event;
          return !(prior.event === event && priorKey === key);
        });
      }
      queue.entries.push(entry);
      if (queue.entries.length > max) {
        const lost = queue.entries.length - max + 1;
        queue.entries = queue.entries.slice(-(max - 1));
        queue.entries.unshift({
          id: `${canonicalIdentity.kernelEpoch}:overflow:${queue.nextSequence++}`,
          event: 'kernel.queueOverflow',
          payload: { lost, recovery: 'full-reconcile-required' },
          capturedAt: now(),
        });
      }
      await persist();
      return entry;
    });
  const settle = (/** @type {string} */ id) => serialized(async () => {
    await assertOwner();
    const before = queue.entries.length;
    queue.entries = queue.entries.filter((/** @type {any} */ entry) => entry.id !== id);
    if (before === queue.entries.length) return false;
    await persist();
    return true;
  });
  const capture = (/** @type {string} */ key, /** @type {any[]} */ args) => {
    const placement = INVENTORY.get(key)?.placement;
    if (placement !== 'durable-hint' && placement !== 'kernel-authority') return null;
    return append(key, sanitizeKernelColdEvent(key, args));
  };

  const event = (/** @type {string} */ key, /** @type {any} */ raw,
    /** @type {string} */ owner) => {
    if (!INVENTORY.has(key)) throw new TypeError(`kernel-event-unknown:${key}`);
    if (!ownerValid(owner)) throw new TypeError('kernel-event-owner-invalid');
    if (!required.has(key)) return undefined;
    if (!raw || typeof raw.addListener !== 'function') return undefined;
    const prior = events.get(key);
    if (prior && (prior.owner !== owner || prior.raw !== raw)) {
      throw new Error(`kernel-event-owner-conflict:${key}`);
    }
    if (prior) return prior.facade;
    /** @type {{owner:string,raw:any,listener:Function|null,facade:any}} */
    const record = { owner, raw, listener: null, facade: null };
    const facade = Object.freeze({
      addListener(/** @type {Function} */ listener, /** @type {any[]} */ ...options) {
        if (typeof listener !== 'function') throw new TypeError('kernel-event-listener-invalid');
        if (record.listener && record.listener !== listener) {
          throw new Error(`kernel-event-listener-conflict:${key}`);
        }
        if (record.listener === listener) return;
        if (key === 'webRequest.onBeforeRequest'
            && JSON.stringify(options) !== JSON.stringify([
              { urls: ['<all_urls>'] }, ['blocking'],
            ])) {
          throw new Error('kernel-cold-webrequest-options-invalid');
        }
        const dispatch = (/** @type {any[]} */ ...args) => {
          const receipt = capture(key, args);
          let result;
          try { result = listener(...args); }
          catch (error) {
            try { globalThis.reportError?.(error); } catch { /* reporting only */ }
            return undefined;
          }
          if (receipt) {
            void receipt.then((entry) => Promise.resolve(result)
              .then(() => settle(entry.id), () => {})).catch(() => {});
          }
          return result;
        };
        record.listener = listener;
        record.raw.addListener(dispatch, ...options);
        // Keep the wrapper so removeListener unregisters the exact raw callback.
        Object.defineProperty(record, 'dispatch', { value: dispatch, configurable: true });
      },
      removeListener(/** @type {Function} */ listener) {
        if (record.listener !== listener) return;
        record.raw.removeListener?.(/** @type {any} */ (record).dispatch);
        record.listener = null;
        delete /** @type {any} */ (record).dispatch;
      },
      hasListener(/** @type {Function} */ listener) { return record.listener === listener; },
      hasListeners() { return record.listener !== null; },
    });
    record.facade = facade;
    events.set(key, record);
    return facade;
  };

  const registerRecovery = (/** @type {any} */ { event: key, owner, reconcile }) => {
    if (!INVENTORY.has(key)) throw new TypeError(`kernel-recovery-event-unknown:${key}`);
    if (!ownerValid(owner) || typeof reconcile !== 'function') {
      throw new TypeError('kernel-recovery-owner-invalid');
    }
    if (recoveryOwners.has(key)) throw new Error(`kernel-recovery-owner-conflict:${key}`);
    recoveryOwners.set(key, { owner, reconcile });
  };
  const recoverRegistered = async (/** @type {any} */ { entries, fullReconcile = false }) => {
    const counts = new Map();
    for (const { event: key } of Array.isArray(entries) ? entries : []) {
      if (INVENTORY.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
      else if (key === 'kernel.queueOverflow') fullReconcile = true;
    }
    for (const key of fullReconcile ? requiredRecoveries : counts.keys()) {
      if (!recoveryOwners.has(key)) throw new Error(`kernel-recovery-owner-missing:${key}`);
    }
    const invoked = [];
    for (const { key } of KERNEL_COLD_EVENTS) {
      const record = recoveryOwners.get(key);
      const count = counts.get(key) ?? 0;
      if (!record || (!fullReconcile && count === 0)) continue;
      // Recovery reconciles current state. Update version is the sole bounded
      // payload because the browser cannot re-emit or re-query it after recycle.
      const eventEntries = key === 'runtime.onUpdateAvailable'
        ? (Array.isArray(entries) ? entries : [])
          .filter((entry) => entry?.event === key)
          .map((entry) => Object.freeze({
            event: key,
            payload: Object.freeze({
              version: typeof entry?.payload?.version === 'string'
                && entry.payload.version.length <= 64 ? entry.payload.version : null,
            }),
          }))
        : [];
      await record.reconcile(Object.freeze({
        event: key, count, fullReconcile, entries: Object.freeze(eventEntries),
      }));
      invoked.push(key);
    }
    return Object.freeze(invoked);
  };
  const recover = () => {
    if (recovery) return recovery;
    const run = (async () => {
      const entries = await serialized(async () => {
        await assertOwner();
        return structuredClone(queue.entries);
      });
      if (entries.length === 0) return Object.freeze([]);
      const fullReconcile = entries.some((/** @type {any} */ entry) =>
        entry.event === 'kernel.queueOverflow');
      await recoverRegistered({ entries, fullReconcile });
      const ids = new Set(entries.map((/** @type {any} */ entry) => entry.id));
      await serialized(async () => {
        await assertOwner();
        queue.entries = queue.entries.filter((/** @type {any} */ entry) => !ids.has(entry.id));
        await persist();
      });
      return Object.freeze(entries.map((/** @type {any} */ entry) => entry.id));
    })().finally(() => {
      if (recovery === run) recovery = null;
    });
    recovery = run;
    return run;
  };

  return Object.freeze({
    identity: canonicalIdentity,
    ready: () => hydrate,
    event,
    owners: () => Object.freeze(Object.fromEntries(
      [...events].filter(([, claim]) => claim.listener !== null)
        .map(([key, claim]) => [key, claim.owner]),
    )),
    missing: () => Object.freeze([...required]
      .filter((key) => !events.get(key)?.listener)),
    complete: () => [...required].every((key) => events.get(key)?.listener),
    required: Object.freeze([...required]),
    registerRecovery,
    recoveryOwners: () => Object.freeze(Object.fromEntries(
      [...recoveryOwners].map(([key, { owner }]) => [key, owner]),
    )),
    recover,
    snapshot: () => serialized(async () => structuredClone(queue)),
  });
};
