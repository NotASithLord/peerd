// @ts-check

import { controllerPayloadBytes } from '../shared/structured-clone-size.js';

const MAX_SNAPSHOT_BYTES = 220 * 1024;
const MAX_SNAPSHOT_TABS = 8_192;
const TAB_STRING_BYTES = 8_192;

const inactive = () => Object.freeze({
  ok: true, outcomeKnown: true,
  value: Object.freeze({ accepted: false, inactive: true }),
});

/**
 * @param {Object} deps
 * @param {{bootId:string,kernelEpoch:string}} deps.identity
 * @param {(event:string,envelope:Record<string,unknown>)=>Promise<any>} deps.send
 * @param {()=>Promise<Record<string,unknown>>|Record<string,unknown>} deps.readSnapshot
 * @param {<T>(operation:()=>Promise<T>)=>Promise<T>} deps.withRun
 * @param {()=>string} [deps.newId]
 */
export const createKernelProductionEvents = ({
  identity, send, readSnapshot, withRun, newId = () => crypto.randomUUID(),
}) => {
  if (typeof identity?.bootId !== 'string' || typeof identity?.kernelEpoch !== 'string'
      || typeof send !== 'function' || typeof readSnapshot !== 'function'
      || typeof withRun !== 'function') {
    throw new TypeError('kernel-production-events-config-invalid');
  }
  let sequence = 0;
  let running = 0;
  let needsReconcile = true;
  let lane = Promise.resolve();
  const cleanString = (/** @type {unknown} */ value) => typeof value === 'string'
    && new TextEncoder().encode(value).length <= TAB_STRING_BYTES ? value : undefined;
  const projectTab = (/** @type {any} */ tab, idsOnly = false) => {
    if (!Number.isInteger(tab?.id) || tab.id < 0) return null;
    if (idsOnly) return Object.freeze({ id: tab.id });
    return Object.freeze({
      id: tab.id,
      ...(typeof tab.active === 'boolean' ? { active: tab.active } : {}),
      ...(typeof tab.discarded === 'boolean' ? { discarded: tab.discarded } : {}),
      ...(Number.isInteger(tab.openerTabId) && tab.openerTabId >= 0
        ? { openerTabId: tab.openerTabId } : {}),
      ...(Number.isInteger(tab.windowId) ? { windowId: tab.windowId } : {}),
      ...(cleanString(tab.url) === undefined ? {} : { url: cleanString(tab.url) }),
      ...(cleanString(tab.pendingUrl) === undefined
        ? {} : { pendingUrl: cleanString(tab.pendingUrl) }),
      ...(['loading', 'complete', 'unloaded'].includes(tab.status)
        ? { status: tab.status } : {}),
    });
  };
  const projectSnapshot = async () => {
    const raw = /** @type {any} */ (await readSnapshot());
    const all = Array.isArray(raw?.tabs)
      ? raw.tabs.map((/** @type {any} */ tab) => projectTab(tab)).filter(Boolean) : [];
    let tabs = all;
    let tabsComplete = true;
    const base = {
      tabs,
      tabsComplete,
      activeTabId: Number.isInteger(raw?.activeTabId) && raw.activeTabId >= 0
        ? raw.activeTabId : null,
      settings: raw?.settings,
      uiConnected: raw?.uiConnected === true,
    };
    if (controllerPayloadBytes(base) > MAX_SNAPSHOT_BYTES) {
      tabs = all.map((/** @type {any} */ tab) => projectTab(tab, true)).filter(Boolean);
    }
    if (controllerPayloadBytes({ ...base, tabs }) > MAX_SNAPSHOT_BYTES
        || tabs.length > MAX_SNAPSHOT_TABS) {
      const active = tabs.find((/** @type {any} */ tab) => tab?.id === base.activeTabId);
      tabs = tabs.filter((/** @type {any} */ tab) => tab !== active)
        .slice(0, MAX_SNAPSHOT_TABS - (active ? 1 : 0));
      if (active) tabs.unshift(active);
      tabsComplete = false;
    }
    return Object.freeze({ ...base, tabs: Object.freeze(tabs), tabsComplete });
  };
  const projectValue = (/** @type {string} */ event, /** @type {any} */ value) => {
    if (event === 'production/tabs-created') {
      return Object.freeze({ tab: projectTab(value?.tab) });
    }
    if (event === 'production/tabs-updated') {
      const change = value?.change ?? {};
      return Object.freeze({
        tabId: value?.tabId,
        change: Object.freeze({
          ...(['loading', 'complete', 'unloaded'].includes(change.status)
            ? { status: change.status } : {}),
          ...(cleanString(change.url) === undefined ? {} : { url: cleanString(change.url) }),
        }),
        tab: projectTab(value?.tab),
      });
    }
    if (event === 'production/navigation-target') {
      return Object.freeze({
        sourceTabId: value?.sourceTabId, tabId: value?.tabId,
        ...(cleanString(value?.url) === undefined ? {} : { url: cleanString(value.url) }),
      });
    }
    return Object.freeze({ ...(value ?? {}) });
  };
  const envelope = (/** @type {Record<string,unknown>} */ value,
    /** @type {string} */ eventId) => Object.freeze({
    bootId: identity.bootId,
    kernelEpoch: identity.kernelEpoch,
    eventId,
    sequence: ++sequence,
    value: Object.freeze({ ...value }),
  });
  const reconcile = async () => {
    const snapshot = await projectSnapshot();
    const result = await send('production/reconcile', envelope(snapshot, newId()));
    needsReconcile = result?.ok !== true || result?.value?.accepted !== true;
    return result;
  };
  const deliver = async (/** @type {string} */ event,
    /** @type {Record<string,unknown>} */ value) => {
    if (running === 0) return inactive();
    if (needsReconcile) {
      const settled = await reconcile();
      if (settled?.ok !== true || needsReconcile) return settled;
    }
    const eventId = newId();
    const projected = projectValue(event, value);
    let result = await send(event, envelope(projected, eventId));
    if (result?.outcomeKnown === false) {
      needsReconcile = true;
      return result;
    }
    const retry = result?.ok !== true || result?.value?.gap === true
      || result?.code === 'feature-event-reconcile-required';
    if (!retry) return result;
    needsReconcile = true;
    const settled = await reconcile();
    if (settled?.ok !== true || needsReconcile) return result;
    result = await send(event, envelope(projected, eventId));
    if (result?.ok !== true || result?.value?.gap === true) needsReconcile = true;
    return result;
  };
  const emit = (/** @type {string} */ event,
    /** @type {Record<string,unknown>} */ value = {}) => {
    const next = lane.then(() => deliver(event, value), () => deliver(event, value));
    lane = next.then(() => {}, () => {});
    return next;
  };
  const run = (/** @type {()=>Promise<any>} */ operation) => withRun(async () => {
    running += 1;
    try {
      const next = lane.then(reconcile, reconcile);
      lane = next.then(() => {}, () => {});
      const settled = await next;
      if (settled?.ok !== true || settled?.value?.accepted !== true) return settled;
      return await operation();
    } finally { running = Math.max(0, running - 1); }
  });
  const reconcileCurrent = () => {
    if (running === 0) return Promise.resolve(inactive());
    const next = lane.then(reconcile, reconcile);
    lane = next.then(() => {}, () => {});
    return next;
  };
  return Object.freeze({ emit, run, reconcile: reconcileCurrent });
};
