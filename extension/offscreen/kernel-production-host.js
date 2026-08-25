// @ts-check

import { CHANNEL_DEFAULTS } from '/shared/build-config.js';

const record = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string,any>} */ (value) : null;
const exact = (/** @type {Record<string,any>} */ value,
  /** @type {string[]} */ required, /** @type {string[]} */ optional = []) => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};
const tabId = (/** @type {unknown} */ value) => Number.isInteger(value)
  && Number(value) >= 0;
const PROVIDERS = new Set([
  'anthropic', 'openai', 'openrouter', 'ollama', 'glm', 'local-webgpu',
]);
const validTab = (/** @type {unknown} */ value) => {
  const tab = record(value);
  return !!tab && exact(tab, ['id'], [
    'active', 'discarded', 'openerTabId', 'pendingUrl', 'status', 'url', 'windowId',
  ]) && tabId(tab.id)
    && (tab.openerTabId === undefined || tabId(tab.openerTabId))
    && (tab.windowId === undefined || Number.isInteger(tab.windowId))
    && (tab.active === undefined || typeof tab.active === 'boolean')
    && (tab.discarded === undefined || typeof tab.discarded === 'boolean')
    && (tab.url === undefined || typeof tab.url === 'string')
    && (tab.pendingUrl === undefined || typeof tab.pendingUrl === 'string')
    && (tab.status === undefined || typeof tab.status === 'string');
};
const SETTINGS_KEYS = Object.freeze(Object.keys(CHANNEL_DEFAULTS).sort());
const ENUMS = Object.freeze({
  reasoningEffort: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  webActorActionSurface: Object.freeze(['tools', 'code']),
  frontDoorView: Object.freeze(['panel', 'home']),
  voiceEngine: Object.freeze(['auto', 'web-speech', 'moonshine']),
});
const validPricing = (/** @type {unknown} */ value) => {
  const pricing = record(value);
  if (!pricing || Object.keys(pricing).length > 500) return false;
  return Object.entries(pricing).every(([model, raw]) => {
    const rates = record(raw);
    return model.length > 0 && model.length <= 200 && !!rates
      && Object.keys(rates).length > 0
      && Object.keys(rates).every((key) => ['input', 'output', 'cacheRead', 'cacheWrite'].includes(key))
      && Object.values(rates).every((rate) => Number.isFinite(rate) && Number(rate) >= 0);
  });
};
const uniqueStrings = (/** @type {unknown} */ value, /** @type {number} */ max,
  /** @type {(value:string)=>boolean} */ allowed = () => true) => {
  if (!Array.isArray(value) || value.length > max) return false;
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item || item !== item.trim() || item.length > 200
        || !allowed(item) || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
};
const validSetting = (/** @type {string} */ key, /** @type {unknown} */ setting) => {
  const expected = /** @type {Record<string,any>} */ (CHANNEL_DEFAULTS)[key];
  const enumValues = /** @type {Record<string,readonly string[]>} */ (ENUMS)[key];
  if (enumValues) return typeof setting === 'string' && enumValues.includes(setting);
  if (key === 'pricingOverrides') return validPricing(setting);
  if (key === 'openrouterModels') return uniqueStrings(setting, 200);
  if (key === 'providerFallbacks') {
    return uniqueStrings(setting, 8, (provider) => PROVIDERS.has(provider));
  }
  if (Array.isArray(expected)) return false;
  if (typeof expected === 'number') {
    if (!Number.isFinite(setting) || Number(setting) < 0) return false;
    if (key === 'voiceSilenceMs') {
      return Number.isInteger(setting) && Number(setting) >= 250 && Number(setting) <= 30_000;
    }
    if (key === 'vaultAutoLockMs') {
      return setting === 0 || Number.isInteger(setting)
        && Number(setting) >= 60_000 && Number(setting) <= 24 * 60 * 60 * 1_000;
    }
    if (key === 'auditLogMaxEntries') {
      return Number.isInteger(setting) && Number(setting) >= 1 && Number(setting) <= 1_000_000;
    }
    return key !== 'spendLimitUsd' || Number(setting) <= 100_000;
  }
  if (typeof expected === 'boolean') return typeof setting === 'boolean';
  if (typeof expected !== 'string' || typeof setting !== 'string' || setting.length > 4096) {
    return false;
  }
  if (key === 'providerName') return setting === '' || PROVIDERS.has(setting);
  if (['providerModel', 'runnerModel', 'prewalkExecutorModel'].includes(key)) {
    return setting === setting.trim() && setting.length <= 200;
  }
  if (key === 'voiceVariant') return setting === 'base';
  if (key !== 'ollamaHost') return true;
  try {
    const url = new URL(setting);
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && url.pathname === '/'
      && !url.search && !url.hash && url.origin === setting;
  }
  catch { return false; }
};
const validSettings = (/** @type {unknown} */ value, /** @type {boolean} */ partial) => {
  const settings = record(value);
  const keys = Object.keys(settings ?? {}).sort();
  if (!settings || (partial ? keys.length === 0
    : keys.length !== SETTINGS_KEYS.length
      || keys.some((key, index) => key !== SETTINGS_KEYS[index]))) return false;
  for (const [key, setting] of Object.entries(settings)) {
    if (!Object.hasOwn(CHANNEL_DEFAULTS, key) || !validSetting(key, setting)) return false;
  }
  return true;
};
const accepted = (/** @type {Record<string,unknown>} */ extra = {}) =>
  Object.freeze({ accepted: true, ...extra });
const deepFreeze = (/** @type {any} */ value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};
const eventKey = (/** @type {any} */ identity) => identity
  && typeof identity.bootId === 'string' && typeof identity.kernelEpoch === 'string'
  && typeof identity.eventId === 'string'
  ? `${identity.bootId}\0${identity.kernelEpoch}\0${identity.eventId}` : null;
const listenerFailure = () => Object.assign(new Error('production listener incomplete'), {
  code: 'production-listener-incomplete', outcomeKnown: true, retryable: true,
});

export const createKernelProductionHost = () => {
  /** @type {Map<number,Record<string,any>>} */ const tabs = new Map();
  /** @type {Map<(event:string,payload:unknown,identity?:unknown)=>unknown,
   * {generation:string|null,delivered:Set<string>}>} */ const listeners = new Map();
  /** @type {Record<string,any>} */ let settings = {};
  /** @type {number|null} */ let activeTabId = null;
  let tabsComplete = true;
  let uiConnected = false;
  let reconciled = false;
  const requireReconciled = () => {
    if (!reconciled) throw new TypeError('production-reconcile-required');
  };
  const emit = async (/** @type {string} */ event, /** @type {unknown} */ payload,
    /** @type {any} */ identity = undefined) => {
    const key = eventKey(identity);
    const generation = key ? key.split('\0', 2).join('\0') : null;
    const results = await Promise.allSettled([...listeners].map(async ([listener, state]) => {
      if (generation && state.generation !== generation) {
        state.generation = generation;
        state.delivered.clear();
      }
      if (key && state.delivered.has(key)) return;
      await listener(event, payload, identity);
      if (key) {
        state.delivered.add(key);
        const oldest = state.delivered.values().next().value;
        if (state.delivered.size > 512 && typeof oldest === 'string') {
          state.delivered.delete(oldest);
        }
      }
    }));
    if (results.some((result) => result.status === 'rejected')) throw listenerFailure();
  };
  const handlers = Object.freeze({
    'production/reconcile': async (/** @type {unknown} */ value, /** @type {any} */ context) => {
      const input = record(value);
      const ids = new Set(Array.isArray(input?.tabs) ? input.tabs.map((tab) => tab?.id) : []);
      if (!input || !exact(input, [
        'tabs', 'tabsComplete', 'activeTabId', 'settings', 'uiConnected',
      ])
          || !Array.isArray(input.tabs) || !input.tabs.every(validTab)
          || typeof input.tabsComplete !== 'boolean'
          || !(input.activeTabId === null || tabId(input.activeTabId))
          || ids.size !== input.tabs.length
          || input.activeTabId !== null && !ids.has(input.activeTabId)
          || !validSettings(input.settings, false) || typeof input.uiConnected !== 'boolean') {
        throw new TypeError('production-reconcile-invalid');
      }
      tabs.clear();
      for (const tab of input.tabs) tabs.set(tab.id, Object.freeze({ ...tab }));
      activeTabId = input.activeTabId;
      tabsComplete = input.tabsComplete;
      settings = deepFreeze(structuredClone(input.settings));
      uiConnected = input.uiConnected;
      reconciled = true;
      const snapshot = read();
      await emit('production/reconcile', snapshot, context?.identity);
      return accepted({ reconciled: true });
    },
    'production/tabs-created': async (/** @type {unknown} */ value, /** @type {any} */ context) => {
      requireReconciled();
      const input = record(value);
      if (!input || !exact(input, ['tab']) || !validTab(input.tab)) {
        throw new TypeError('production-tab-created-invalid');
      }
      tabs.set(input.tab.id, Object.freeze({ ...input.tab }));
      await emit('production/tabs-created', input, context?.identity);
      return accepted();
    },
    'production/tabs-updated': async (/** @type {unknown} */ value, /** @type {any} */ context) => {
      requireReconciled();
      const input = record(value);
      if (!input || !exact(input, ['tabId', 'change', 'tab']) || !tabId(input.tabId)
          || !record(input.change)
          || !Object.keys(input.change).every((key) => key === 'status' || key === 'url')
          || (input.change.status !== undefined
            && !['loading', 'complete', 'unloaded'].includes(input.change.status))
          || (input.change.url !== undefined && typeof input.change.url !== 'string')
          || !validTab(input.tab) || input.tab.id !== input.tabId) {
        throw new TypeError('production-tab-updated-invalid');
      }
      tabs.set(input.tabId, Object.freeze({ ...input.tab }));
      await emit('production/tabs-updated', input, context?.identity);
      return accepted();
    },
    'production/tabs-removed': async (/** @type {unknown} */ value, /** @type {any} */ context) => {
      requireReconciled();
      const input = record(value);
      if (!input || !exact(input, ['tabId']) || !tabId(input.tabId)) {
        throw new TypeError('production-tab-removed-invalid');
      }
      tabs.delete(input.tabId);
      if (activeTabId === input.tabId) activeTabId = null;
      await emit('production/tabs-removed', input, context?.identity);
      return accepted();
    },
    'production/tabs-activated': async (/** @type {unknown} */ value, /** @type {any} */ context) => {
      requireReconciled();
      const input = record(value);
      if (!input || !exact(input, ['tabId', 'windowId']) || !tabId(input.tabId)
          || !Number.isInteger(input.windowId) || !tabs.has(input.tabId)) {
        throw new TypeError('production-tab-activated-invalid');
      }
      activeTabId = input.tabId;
      await emit('production/tabs-activated', input, context?.identity);
      return accepted();
    },
    'production/navigation-target': async (/** @type {unknown} */ value,
      /** @type {any} */ context) => {
      requireReconciled();
      const input = record(value);
      if (!input || !exact(input, ['sourceTabId', 'tabId'], ['url'])
          || !tabId(input.sourceTabId) || !tabId(input.tabId)
          || (input.url !== undefined && typeof input.url !== 'string')) {
        throw new TypeError('production-navigation-target-invalid');
      }
      await emit('production/navigation-target', input, context?.identity);
      return accepted();
    },
    'production/schedules-resume': async (/** @type {unknown} */ value,
      /** @type {any} */ context) => {
      requireReconciled();
      const input = record(value);
      if (!input || !exact(input, [])) throw new TypeError('production-schedule-invalid');
      await emit('production/schedules-resume', input, context?.identity);
      return accepted();
    },
    'production/ui-connect': async (/** @type {unknown} */ value, /** @type {any} */ context) => {
      requireReconciled();
      const input = record(value);
      if (!input || !exact(input, [])) throw new TypeError('production-ui-connect-invalid');
      uiConnected = true;
      await emit('production/ui-connect', input, context?.identity);
      return accepted();
    },
    'production/ui-quiet': async (/** @type {unknown} */ value, /** @type {any} */ context) => {
      requireReconciled();
      const input = record(value);
      if (!input || !exact(input, [])) throw new TypeError('production-ui-quiet-invalid');
      uiConnected = false;
      await emit('production/ui-quiet', input, context?.identity);
      return accepted();
    },
    'production/settings-changed': async (/** @type {unknown} */ value,
      /** @type {any} */ context) => {
      requireReconciled();
      const input = record(value);
      if (!input || !exact(input, ['patch']) || !validSettings(input.patch, true)
          || Object.keys(input.patch).length === 0) {
        throw new TypeError('production-settings-invalid');
      }
      settings = deepFreeze(structuredClone({ ...settings, ...input.patch }));
      await emit('production/settings-changed', input, context?.identity);
      return accepted();
    },
  });
  function read() {
    return Object.freeze({
      tabs: Object.freeze([...tabs.values()]), activeTabId,
      tabsComplete, settings, uiConnected, reconciled,
    });
  }
  return Object.freeze({
    events: handlers,
    read,
    subscribe: (/** @type {(event:string,payload:unknown,identity?:unknown)=>unknown} */ listener) => {
      if (typeof listener !== 'function') throw new TypeError('production-listener-invalid');
      listeners.set(listener, { generation: null, delivered: new Set() });
      return () => listeners.delete(listener);
    },
  });
};
