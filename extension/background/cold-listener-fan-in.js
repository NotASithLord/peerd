// @ts-check
// Explicit listener fan-in for cold browser events. Callers still pass the raw
// event and the original service-worker callback, so this changes neither API
// method receivers nor the realm that owns authority.

import { createColdKernelCapture } from './cold-kernel-capture.js';
import { coldEventKeysFor, KERNEL_COLD_EVENTS } from './cold-kernel-inventory.js';

const canonical = (/** @type {any[]} */ value) => JSON.stringify(value);

/** @param {unknown} error */
const reportListenerError = (error) => {
  try {
    if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
    else console.error('[cold-listener-fan-in] listener failed', error);
  } catch { /* reporting cannot suppress a later authority listener */ }
};

/**
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void> }} deps.queueStore
 * @param {boolean} [deps.firefox]
 * @param {boolean} [deps.selfHostedChrome]
 * @param {number} [deps.queueMax]
 * @param {() => string} [deps.newId]
 * @param {() => number} [deps.now]
 * @param {import('../shared/kernel-identity.js').KernelIdentity} [deps.kernelIdentity]
 */
export const createColdListenerFanIn = ({
  queueStore,
  firefox = false,
  selfHostedChrome = false,
  queueMax,
  newId,
  now,
  kernelIdentity,
}) => {
  const allowed = new Set(coldEventKeysFor({ firefox, selfHostedChrome }));
  const inventory = new Map(KERNEL_COLD_EVENTS.map((entry) => [entry.key, entry]));
  const capture = createColdKernelCapture({
    browser: {}, queueStore, authority: {},
    isFirstPartySender: () => false, isFirstPartyPort: () => false,
    firefox, selfHostedChrome, queueMax, newId, now, kernelIdentity,
    registerListeners: false,
  });
  /** @type {Map<string, { listener: Function, options: any[] }[]>} */
  const handlers = new Map();
  /** @type {Map<string, any>} */
  const rawEvents = new Map();
  /** @type {Map<string, any>} */
  const eventFacades = new Map();

  const dispatch = (/** @type {string} */ key, /** @type {any[]} */ args) => {
    const receipt = capture.captureEvent(key, args);
    const results = [];
    let failed = false;
    for (const record of [...(handlers.get(key) ?? [])]) {
      try { results.push(record.listener(...args)); }
      catch (error) { failed = true; reportListenerError(error); }
    }
    const promises = results.filter((value) => value && typeof value.then === 'function');
    if (receipt) {
      void receipt.then(async (entry) => {
        if (!entry || failed) return;
        if (promises.length) {
          const settled = await Promise.allSettled(promises);
          if (settled.some((item) => item.status === 'rejected')) return;
        }
        await capture.settle(entry.id);
      }).catch(() => {});
    }
    if (key === 'runtime.onMessage') {
      if (results.some((value) => value === true)) return true;
      return results.find((value) => value && typeof value.then === 'function');
    }
    return results.find((value) => value !== undefined);
  };

  const event = (/** @type {string} */ key, /** @type {any} */ rawEvent) => {
    if (!allowed.has(key)) return rawEvent;
    if (!rawEvent || typeof rawEvent.addListener !== 'function') return rawEvent;
    const knownRaw = rawEvents.get(key);
    if (knownRaw && knownRaw !== rawEvent) throw new Error(`cold event identity changed: ${key}`);
    rawEvents.set(key, rawEvent);
    const prior = eventFacades.get(key);
    if (prior) return prior;
    let registered = false;
    /** @type {Function|null} */
    let mux = null;
    const facade = Object.freeze({
      addListener(/** @type {Function} */ listener, /** @type {any[]} */ ...options) {
        if (typeof listener !== 'function') throw new TypeError(`${key} listener must be a function`);
        const records = handlers.get(key) ?? [];
        if (records.some((record) => record.listener === listener)) return;
        if (key === 'webRequest.onBeforeRequest') {
          const required = canonical([{ urls: ['<all_urls>'] }, ['blocking']]);
          if (canonical(options) !== required) {
            throw new Error('cold webRequest registration options changed');
          }
        } else if (records.length && canonical(records[0].options) !== canonical(options)) {
          throw new Error(`cold listener option drift: ${key}`);
        }
        records.push({ listener, options });
        handlers.set(key, records);
        if (!registered) {
          mux = (/** @type {any[]} */ ...args) => dispatch(key, args);
          if (key === 'webRequest.onBeforeRequest') {
            rawEvent.addListener(mux, { urls: ['<all_urls>'] }, ['blocking']);
          } else rawEvent.addListener(mux, ...options);
          registered = true;
        }
      },
      removeListener(/** @type {Function} */ listener) {
        const remaining = (handlers.get(key) ?? [])
          .filter((record) => record.listener !== listener);
        handlers.set(key, remaining);
        if (remaining.length === 0 && registered && mux) {
          rawEvent.removeListener?.(mux);
          mux = null;
          registered = false;
        }
      },
      hasListener(/** @type {Function} */ listener) {
        return (handlers.get(key) ?? []).some((record) => record.listener === listener);
      },
      hasListeners() { return (handlers.get(key)?.length ?? 0) > 0; },
    });
    eventFacades.set(key, facade);
    return facade;
  };

  const recover = async (/** @type {(recovery: { entries: any[], fullReconcile: boolean }) => Promise<void>|void} */ reconcile) => {
    await capture.ready();
    const hostEpoch = `legacy-reconcile:${capture.kernelEpoch}`;
    capture.attachHost({
      epoch: hostEpoch,
      ...(capture.kernelIdentity ? { kernelIdentity: capture.kernelIdentity } : {}),
      dispatchMessage: () => { throw new Error('legacy reconcile host has no RPC route'); },
      adoptPort: (port) => { try { port.disconnect(); } catch { /* closed */ } },
      retire: () => {},
    });
    while (true) {
      const delivery = await capture.claim(hostEpoch, 64);
      if (!delivery?.entries?.length) return;
      await reconcile({
        entries: delivery.entries,
        fullReconcile: delivery.entries.some((/** @type {any} */ entry) =>
          entry.event === 'kernel.queueOverflow'
            || inventory.get(entry.event)?.placement === 'kernel-authority'),
      });
      if (!await capture.acknowledge({
        kernelEpoch: capture.kernelEpoch,
        ...(capture.kernelIdentity ? { kernelIdentity: capture.kernelIdentity } : {}),
        hostEpoch,
        deliveryId: delivery.deliveryId,
        ids: delivery.entries.map((/** @type {any} */ entry) => entry.id),
      })) throw new Error('cold listener recovery acknowledgement refused');
    }
  };

  return Object.freeze({
    event,
    recover,
    capture,
    listenerCount: (/** @type {string} */ key) => handlers.get(key)?.length ?? 0,
    registeredKeys: () => Object.freeze([...rawEvents.keys()]),
  });
};

/** @param {any} browser */
export const browserLocalQueueStore = (browser) => Object.freeze({
  async get(/** @type {string} */ key) { return (await browser.storage.local.get(key))?.[key]; },
  async set(/** @type {string} */ key, /** @type {any} */ value) {
    await browser.storage.local.set({ [key]: value });
  },
});
