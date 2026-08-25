// @ts-check

import {
  WEB_ACTOR_SOURCE_PROJECTION_KEY,
  validateWebActorSourceProjection,
} from '../shared/web-actor-source-projection.js';

export const KERNEL_TAB_CUSTODY_OWNER = 'kernel-tab-custody';
export const KERNEL_LIFECYCLE_OWNER = 'kernel-lifecycle';
export const INERT_CHILD_REQUEST_GUARD = Object.freeze({
  onNavigationTarget() {}, onBeforeRequest() { return {}; },
  resolveNavigationTarget() {}, release() {}, reconcile() { return true; },
  ready() { return true; }, status() { return { ok: true }; },
});

/**
 * @param {Object} deps
 * @param {any} deps.browser
 * @param {{event:(key:string,raw:any,owner:string)=>any}} deps.registry
 * @param {boolean} [deps.firefox]
 * @param {(tab:any)=>unknown} deps.onCreated
 * @param {(tabId:number,changeInfo:any,tab:any)=>unknown} deps.onUpdated
 * @param {(tabId:number,removeInfo:any)=>unknown} deps.onRemoved
 * @param {(activeInfo:any)=>unknown} deps.onActivated
 * @param {(details:any)=>unknown} deps.onNavigationTarget
 * @param {(details:any)=>any} [deps.onBeforeRequest]
 */
export const attachKernelTabEvents = ({
  browser, registry, firefox = false, onCreated, onUpdated, onRemoved,
  onActivated, onNavigationTarget, onBeforeRequest,
}) => {
  const common = [onCreated, onUpdated, onRemoved, onActivated, onNavigationTarget];
  if (!browser?.tabs || !browser?.webNavigation || typeof registry?.event !== 'function'
      || common.some((handler) => typeof handler !== 'function')
      || (firefox && typeof onBeforeRequest !== 'function')) {
    throw new TypeError('kernel-tab-events-config-invalid');
  }
  registry.event('tabs.onCreated', browser.tabs.onCreated, KERNEL_TAB_CUSTODY_OWNER)
    ?.addListener(onCreated);
  registry.event('tabs.onUpdated', browser.tabs.onUpdated, KERNEL_TAB_CUSTODY_OWNER)
    ?.addListener(onUpdated);
  registry.event('tabs.onRemoved', browser.tabs.onRemoved, KERNEL_TAB_CUSTODY_OWNER)
    ?.addListener(onRemoved);
  registry.event('tabs.onActivated', browser.tabs.onActivated, KERNEL_TAB_CUSTODY_OWNER)
    ?.addListener(onActivated);
  registry.event(
    'webNavigation.onCreatedNavigationTarget',
    browser.webNavigation.onCreatedNavigationTarget,
    KERNEL_TAB_CUSTODY_OWNER,
  )?.addListener(onNavigationTarget);
  if (firefox) {
    const blocking = registry.event(
      'webRequest.onBeforeRequest', browser.webRequest?.onBeforeRequest,
      KERNEL_TAB_CUSTODY_OWNER,
    );
    if (typeof blocking?.addListener !== 'function') {
      throw new TypeError('kernel-firefox-child-request-guard-unavailable');
    }
    blocking.addListener(onBeforeRequest, { urls: ['<all_urls>'] }, ['blocking']);
  }
  return Object.freeze({ owner: KERNEL_TAB_CUSTODY_OWNER });
};

/** @param {any} deps */
export const attachKernelLifecycleEvents = ({
  browser, registry, firefox = false, selfHostedChrome = false,
  onStartup, alarmName, onAlarm, onSessionChanged, onUpdateAvailable,
}) => {
  if (!browser?.runtime || !browser?.alarms || typeof registry?.event !== 'function'
      || typeof onStartup !== 'function' || typeof onAlarm !== 'function'
      || typeof alarmName !== 'string' || !alarmName
      || (onSessionChanged !== undefined && typeof onSessionChanged !== 'function')
      || (selfHostedChrome && typeof onUpdateAvailable !== 'function')) {
    throw new TypeError('kernel-lifecycle-events-config-invalid');
  }
  registry.event('runtime.onStartup', browser.runtime.onStartup, KERNEL_LIFECYCLE_OWNER)
    ?.addListener(onStartup);
  registry.event('alarms.onAlarm', browser.alarms.onAlarm, KERNEL_LIFECYCLE_OWNER)
    ?.addListener((/** @type {any} */ alarm) =>
      alarm?.name === alarmName ? onAlarm(alarm) : undefined);
  if (firefox && onSessionChanged) {
    registry.event(
      'storage.session.onChanged', browser.storage?.session?.onChanged, KERNEL_LIFECYCLE_OWNER,
    )?.addListener(onSessionChanged);
  }
  if (selfHostedChrome) {
    registry.event(
      'runtime.onUpdateAvailable', browser.runtime.onUpdateAvailable, KERNEL_LIFECYCLE_OWNER,
    )?.addListener(onUpdateAvailable);
  }
  return Object.freeze({ owner: KERNEL_LIFECYCLE_OWNER });
};

const TAB_EVENTS = Object.freeze([
  'tabs.onCreated', 'tabs.onUpdated', 'tabs.onRemoved', 'tabs.onActivated',
  'webNavigation.onCreatedNavigationTarget',
]);
const thenable = (/** @type {unknown} */ value) => value !== null
  && (typeof value === 'object' || typeof value === 'function')
  && typeof /** @type {{then?:unknown}} */ (value).then === 'function';
/** @param {()=>Promise<unknown>|unknown} operation */
const coalesced = (operation) => {
  /** @type {Promise<unknown>|null} */ let active = null;
  return () => {
    active ??= Promise.resolve().then(operation).finally(() => { active = null; });
    return active;
  };
};

/** @param {any} deps */
export const createKernelBrowserEventOwners = ({
  ready, resumeRecovery, tabCustody, firefox = false, receipts,
}) => {
  if (!thenable(ready) || typeof resumeRecovery !== 'function'
      || !tabCustody || [
        tabCustody.onCreated, tabCustody.onUpdated, tabCustody.onRemoved,
        tabCustody.onActivated, tabCustody.onNavigationTarget, tabCustody.reconcile,
      ].some((method) => typeof method !== 'function')
      || (firefox && typeof tabCustody.onBeforeRequest !== 'function')
      || typeof receipts?.registerRecovery !== 'function') {
    throw new TypeError('kernel-browser-event-owners-config-invalid');
  }
  const resumeCurrentRecovery = coalesced(async () => {
    await ready;
    return resumeRecovery();
  });
  const reconcileCurrentTabs = coalesced(async () => {
    await ready;
    return tabCustody.reconcile();
  });
  for (const event of ['runtime.onStartup', 'alarms.onAlarm']) {
    receipts.registerRecovery({
      event, owner: KERNEL_LIFECYCLE_OWNER, reconcile: resumeCurrentRecovery,
    });
  }
  for (const event of TAB_EVENTS) {
    receipts.registerRecovery({
      event, owner: KERNEL_TAB_CUSTODY_OWNER, reconcile: reconcileCurrentTabs,
    });
  }
  if (firefox) {
    receipts.registerRecovery({
      event: 'webRequest.onBeforeRequest',
      owner: KERNEL_TAB_CUSTODY_OWNER,
      reconcile: reconcileCurrentTabs,
    });
  }
  const blockingDecision = (/** @type {unknown} */ decision) => {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      return { cancel: true };
    }
    const keys = Object.keys(decision);
    if (keys.length === 0) return {};
    if (keys.length === 1 && keys[0] === 'cancel'
        && /** @type {{cancel?:unknown}} */ (decision).cancel === true) {
      return { cancel: true };
    }
    return { cancel: true };
  };
  const onBeforeRequest = firefox ? (/** @type {any} */ details) => {
    try {
      const decision = tabCustody.onBeforeRequest(details);
      if (thenable(decision)) {
        return Promise.resolve(decision).then(blockingDecision, () => ({ cancel: true }));
      }
      return blockingDecision(decision);
    } catch { return { cancel: true }; }
  } : undefined;
  return Object.freeze({
    lifecycle: Object.freeze({
      onStartup: resumeCurrentRecovery,
      onAlarm: resumeCurrentRecovery,
    }),
    tabs: Object.freeze({
      onCreated: (/** @type {any} */ tab) => tabCustody.onCreated(tab),
      onUpdated: (/** @type {number} */ tabId, /** @type {any} */ changeInfo,
        /** @type {any} */ tab) => tabCustody.onUpdated(tabId, changeInfo, tab),
      onRemoved: (/** @type {number} */ tabId, /** @type {any} */ removeInfo) =>
        tabCustody.onRemoved(tabId, removeInfo),
      onActivated: (/** @type {any} */ activeInfo) => tabCustody.onActivated(activeInfo),
      onNavigationTarget: (/** @type {any} */ details) =>
        tabCustody.onNavigationTarget(details),
      ...(onBeforeRequest ? { onBeforeRequest } : {}),
    }),
    readiness: Object.freeze({
      'runtime.onStartup': true,
      'alarms.onAlarm': true,
      ...Object.fromEntries(TAB_EVENTS.map((event) => [event, true])),
      ...(firefox ? { 'webRequest.onBeforeRequest': true } : {}),
    }),
  });
};

/** @param {Record<string,any>} deps */
export const createKernelBrowserNetworkOwner = (deps) => {
  if (typeof deps?.createAuthority !== 'function' && typeof deps?.loadAuthority !== 'function') {
    throw new TypeError('kernel-browser-network-owner-config-invalid');
  }
  /** @type {any} */ let authority = null;
  /** @type {Promise<any>|null} */ let authorityLoading = null;
  /** @type {Map<number,symbol>} */ const childGenerations = new Map();
  /** @type {Promise<boolean|null>|null} */ let coldQuarantineReading = null;
  let sourceProjectionReady = false;
  /** @type {Promise<void>|null} */ let sourceProjectionLoading = null;
  /** @type {Map<number,string>|null} */ let restoredSources = null;
  /** @type {Promise<boolean>|null} */ let restoredSourcesLoading = null;
  /** @type {Set<number>} */ const appTabs = new Set();
  /** @type {string|null} */ let sourceProjectionGeneration = null;
  let sourceProjectionRevision = 0;
  const loadTimeoutMs = Number.isFinite(deps.loadTimeoutMs)
    ? Math.max(1, Number(deps.loadTimeoutMs)) : 5_000;
  const bounded = (/** @type {Promise<any>} */ operation, /** @type {string} */ code,
    /** @type {boolean} */ outcomeKnown = false) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error(code), {
        code, outcomeKnown, retryable: outcomeKnown,
        phase: outcomeKnown ? 'startup' : 'run',
      })), loadTimeoutMs);
      operation.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (cause) => { clearTimeout(timer); reject(cause); },
      );
    });
  const isAppTab = (/** @type {any} */ tab) => typeof deps.appTabUrl === 'string'
    && Number.isInteger(tab?.id) && tab.id >= 0 && typeof tab?.url === 'string'
    && tab.url.split('#', 1)[0] === deps.appTabUrl && tab.url.includes('#');
  const reconcileAppTabs = (/** @type {any[]} */ tabs) => {
    appTabs.clear();
    for (const tab of tabs) if (isAppTab(tab)) appTabs.add(tab.id);
  };
  const observeAppTab = (/** @type {any} */ tab) => {
    if (!Number.isInteger(tab?.id) || tab.id < 0) return false;
    if (isAppTab(tab)) appTabs.add(tab.id);
    else appTabs.delete(tab.id);
    return appTabs.has(tab.id);
  };
  const restoreSources = (/** @type {boolean} */ refresh = false) => {
    if (refresh) restoredSources = null;
    if (restoredSources) return Promise.resolve(true);
    if (typeof deps.sessionCache?.sessionGet !== 'function'
        || typeof deps.browser?.tabs?.query !== 'function') return Promise.resolve(false);
    restoredSourcesLoading ??= Promise.all([
      deps.sessionCache.sessionGet('webActorTabBindings'),
      deps.sessionCache.sessionGet(WEB_ACTOR_SOURCE_PROJECTION_KEY),
      deps.browser.tabs.query({}),
    ]).then(([bindings, projection, tabs]) => {
      reconcileAppTabs(tabs);
      const validated = validateWebActorSourceProjection(
        bindings ?? [], projection, tabs, { requireCookieStore: deps.firefox },
      );
      if (!validated) return false;
      restoredSources = validated;
      return true;
    }, () => false).finally(() => { restoredSourcesLoading = null; });
    return restoredSourcesLoading;
  };
  const sourceRelays = Object.freeze({
    isDrivenSource: (/** @type {number} */ tabId) => restoredSources?.has(tabId) === true
      || appTabs.has(tabId),
    webActorSessionForTab: (/** @type {number} */ tabId) => restoredSources?.get(tabId) ?? null,
    isWebActorTab: (/** @type {number} */ tabId) => restoredSources?.has(tabId) === true,
    externalDrivenTabIds: () => [...new Set([
      ...(restoredSources?.keys() ?? []), ...appTabs,
    ])],
    appTabIds: () => [...appTabs],
  });
  void restoreSources();
  const externalReady = () => {
    if (sourceProjectionReady) return Promise.resolve();
    if (sourceProjectionLoading) return sourceProjectionLoading;
    const attempt = (async () => {
      const ready = await restoreSources(true);
      if (!ready) throw new Error('kernel-browser-network-source-projection-unavailable');
      await bounded(Promise.resolve(deps.startupGuard?.reconcileSources?.(
          (/** @type {number} */ tabId) => restoredSources?.has(tabId) === true
            || appTabs.has(tabId),
      )), 'kernel-browser-network-startup-reconcile-timeout');
      sourceProjectionReady = true;
      if (authority) {
        const result = await authority.reconcileExternalProjection?.();
        if (result?.ok === false) {
          sourceProjectionReady = false;
          throw new Error('kernel-browser-network-source-reconcile-failed');
        }
      }
    })();
    sourceProjectionLoading = attempt;
    void attempt.finally(() => {
      if (sourceProjectionLoading === attempt) sourceProjectionLoading = null;
    }).catch(() => {});
    return attempt;
  };
  const authorityConfig = () => ({
    firefox: deps.firefox, browser: deps.browser, dnr: deps.dnr,
    sessionCache: deps.sessionCache, denylist: deps.denylist,
    getExternalTabIds: () => [...new Set([
      ...(restoredSources?.keys() ?? []), ...appTabs,
    ])],
    getAppTabIds: () => [...appTabs],
    isWebActorTab: (/** @type {number} */ tabId) =>
      restoredSources?.has(tabId) === true
      || deps.startupGuard?.hasSourceEvidence?.(tabId) === true,
    ensureExternalReady: externalReady,
    audit: deps.audit,
    onPopupGuarded: (/** @type {{tabId?:number}} */ event) => {
      if (typeof event?.tabId === 'number') deps.releaseChild?.(event.tabId);
    },
    onPopupBlocked: deps.onPopupBlocked,
    onPopupFailed: deps.onPopupFailed,
    onPopupBlank: deps.onPopupBlank,
    startupGuard: deps.startupGuard,
  });
  const get = () => {
    if (authority) return Promise.resolve(authority);
    if (authorityLoading) return authorityLoading;
    const create = deps.createAuthority ?? deps.loadAuthority;
    const pending = Promise.resolve().then(() => create(authorityConfig())).then((owner) => {
      if (!owner || typeof owner.status !== 'function') {
        throw new TypeError('kernel-browser-network-authority-invalid');
      }
      authority = owner;
      return owner;
    }).catch((cause) => {
      const detail = /** @type {{code?:unknown,outcomeKnown?:unknown}} */ (cause);
      if (detail?.outcomeKnown === true) throw cause;
      throw Object.assign(new Error('kernel-browser-network-authority-startup-failed', { cause }), {
        code: typeof detail?.code === 'string' ? detail.code
          : 'kernel-browser-network-authority-startup-failed',
        outcomeKnown: true, retryable: true, phase: 'startup',
      });
    }).finally(() => {
      if (authorityLoading === pending) authorityLoading = null;
    });
    authorityLoading = pending;
    return pending;
  };
  const call = (/** @type {string} */ name, /** @type {any[]} */ args = []) =>
    bounded(get(), `kernel-browser-network-${name}-load-timeout`, true).then((owner) => {
      const event = args[0];
      const tabId = event?.tabId ?? event?.id;
      if (typeof event?.flowToken === 'symbol' && typeof tabId === 'number'
          && childGenerations.get(tabId) !== event.flowToken) return false;
      return bounded(
        Promise.resolve(owner[name](...args)), `kernel-browser-network-${name}-timeout`,
      );
    });
  const loadedCall = (/** @type {string} */ name, /** @type {any[]} */ args = []) =>
    call(name, args).then(() => true);
  const coldQuarantineActive = () => {
    if (typeof deps.dnr?.getSessionRules !== 'function') return Promise.resolve(false);
    coldQuarantineReading ??= bounded(Promise.resolve(deps.dnr.getSessionRules()),
      'kernel-browser-network-quarantine-read-timeout').then((rules) =>
      Array.isArray(rules) && rules.some((rule) => rule?.id === 203
        || (Number.isInteger(rule?.id) && rule.id >= 301 && rule.id <= 330)), () => null);
    const current = coldQuarantineReading;
    void current.finally(() => {
      if (coldQuarantineReading === current) coldQuarantineReading = null;
    }).catch(() => {});
    return current;
  };
  const provenCall = (
    /** @type {string} */ name,
    /** @type {any[]} */ args,
    /** @type {()=>Promise<boolean>|boolean} */ prove,
    /** @type {(cause:unknown,contained:boolean)=>Promise<boolean>|boolean} */ guardedFailure,
    /** @type {()=>boolean} */ alreadyContained = () => false,
    /** @type {()=>Promise<boolean>|boolean} */ noProof = () => false,
  ) => {
    return bounded(Promise.resolve(prove()),
      `kernel-browser-network-${name}-startup-timeout`).then((proven) => proven
      ? call(name, args).then(() => true, (cause) => guardedFailure(cause, true))
      : noProof());
  };
  const childGeneration = (/** @type {number} */ tabId,
    /** @type {symbol|undefined} */ proposed = undefined) => {
    const current = childGenerations.get(tabId) ?? proposed ?? Symbol(`child:${tabId}`);
    childGenerations.set(tabId, current);
    return current;
  };
  const containChild = async (/** @type {any} */ details, /** @type {unknown} */ cause,
    /** @type {symbol} */ generation, /** @type {boolean} */ retryable = false) => {
    const tabId = details?.tabId ?? details?.id;
    const sourceTabId = details?.sourceTabId ?? details?.openerTabId;
    if (typeof tabId !== 'number' || typeof sourceTabId !== 'number') return false;
    let child = childGenerations.get(tabId) === generation ? 'uncontained' : 'closed';
    if (childGenerations.get(tabId) === generation) {
      try {
        await bounded(Promise.resolve(deps.browser.tabs.remove(tabId)),
          'kernel-browser-child-close-timeout');
        if (childGenerations.get(tabId) === generation) childGenerations.delete(tabId);
        child = 'closed';
      } catch {
        if (childGenerations.get(tabId) === generation) {
          try {
            await bounded(Promise.resolve(
              deps.browser.tabs.update(tabId, { url: 'about:blank' })),
            'kernel-browser-child-blank-timeout');
            child = 'left_blank';
          } catch {}
        } else child = 'closed';
      }
    }
    try {
      deps.onPopupFailed?.({
        sourceTabId, tabId,
        reason: cause instanceof Error ? cause.message : 'child_guard_failed',
        child, guarded: false, retryable, flowToken: details.flowToken,
      });
    } catch {}
    return false;
  };
  const reportGuardedChild = (/** @type {any} */ details, /** @type {unknown} */ cause,
    /** @type {symbol} */ generation) => {
    const tabId = details?.tabId ?? details?.id;
    const sourceTabId = details?.sourceTabId ?? details?.openerTabId;
    if (typeof tabId !== 'number' || typeof sourceTabId !== 'number') return false;
    try {
      deps.onPopupFailed?.({
        sourceTabId, tabId,
        reason: 'child_authority_unavailable',
        child: childGenerations.get(tabId) === generation ? 'guarded' : 'closed',
        guarded: true, retryable: true, flowToken: details.flowToken,
      });
    } catch {}
    return false;
  };
  const sourceFor = (/** @type {any} */ details) =>
    details?.sourceTabId ?? details?.openerTabId;
  const sourceIsDriven = async (/** @type {any} */ details) => {
    const sourceTabId = sourceFor(details);
    if (typeof sourceTabId !== 'number') return null;
    if (await restoreSources()) {
      return restoredSources?.has(sourceTabId) === true || appTabs.has(sourceTabId);
    }
    if (!sourceProjectionReady) {
      try {
        await bounded(Promise.resolve(externalReady()),
          'kernel-browser-network-source-classification-timeout');
      } catch { return null; }
    }
    return restoredSources?.has(sourceTabId) === true || appTabs.has(sourceTabId);
  };
  const handleAbsentProof = async (/** @type {any} */ details,
    /** @type {symbol} */ generation, /** @type {string} */ name,
    /** @type {any[]} */ args) => {
    const driven = await sourceIsDriven(details);
    if (driven === true) {
      return containChild(
        details, new Error('kernel-browser-child-source-proof-unavailable'), generation, true,
      );
    }
    if (driven === false) {
      if (await coldQuarantineActive() === false) return false;
      return call(name, args).then(() => true, (cause) => {
        try { deps.onError?.(cause); } catch {}
        return false;
      });
    }
    try {
      deps.onError?.(Object.assign(
        new Error('kernel-browser-child-source-classification-unavailable'),
        {
          code: 'kernel-browser-child-source-classification-unavailable',
          outcomeKnown: false, retryable: true, contained: false,
        },
      ));
    } catch {}
    return false;
  };
  const handleGuardedFailure = async (/** @type {any} */ details,
    /** @type {unknown} */ cause, /** @type {symbol} */ generation,
    /** @type {boolean} */ contained) => {
    const driven = await sourceIsDriven(details);
    if (driven === true) return contained
      ? reportGuardedChild(details, cause, generation)
      : containChild(details, cause, generation);
    if (driven === false && contained) {
      const tabId = details?.tabId ?? details?.id;
      if (typeof tabId === 'number') await deps.startupGuard?.release(tabId, generation);
    }
    try {
      deps.onError?.(Object.assign(
        new Error('kernel-browser-child-authority-unavailable', { cause }),
        { code: 'kernel-browser-child-authority-unavailable', outcomeKnown: false, contained },
      ));
    } catch {}
    return false;
  };
  const handleUncontainedFailure = async (/** @type {any} */ details,
    /** @type {unknown} */ cause, /** @type {symbol} */ generation) => {
    const driven = await sourceIsDriven(details);
    if (driven === true) {
      return containChild(details, cause, generation);
    }
    if (driven === false) {
      const tabId = details?.tabId ?? details?.id;
      if (typeof tabId === 'number') await deps.startupGuard?.release(tabId, generation);
    }
    try { deps.onError?.(cause); } catch {}
    return false;
  };
  const state = () => authority?.status() ?? Object.freeze({
    supported: typeof deps.dnr?.updateSessionRules === 'function',
    lastError: null, ready: false, tabs: Object.freeze([]), origins: Object.freeze([]),
  });
  const admitAppTab = async (/** @type {number} */ tabId, /** @type {string} */ url) => {
    try {
      if (!Number.isInteger(tabId) || tabId < 0 || typeof url !== 'string'
          || typeof deps.browser?.tabs?.get !== 'function') return { ok: false };
      const tab = await bounded(Promise.resolve(deps.browser.tabs.get(tabId)),
        'kernel-browser-app-tab-read-timeout');
      if (!isAppTab(tab) || tab.url !== url) return { ok: false };
      appTabs.add(tabId);
      await call('syncDenylistNetwork');
      const verified = await call('verifyAppNetwork', [tabId]);
      const current = state();
      return verified === true && current.supported === true && current.lastError == null
        && current.tabs?.includes(tabId)
        ? { ok: true }
        : { ok: false };
    } catch {
      return { ok: false };
    }
  };
  const custody = Object.freeze({
    sync: () => call('syncDenylistNetwork'), admitAppTab, state,
    status: state,
  });
  const callFailure = (/** @type {unknown} */ cause, /** @type {string} */ code) => {
    const known = /** @type {{outcomeKnown?:unknown}} */ (cause)?.outcomeKnown === true;
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
      code: /** @type {{code?:string}} */ (cause)?.code ?? code,
      outcomeKnown: known,
      retryable: known,
      phase: known ? 'startup' : 'run',
    };
  };
  const ensureSourceProjection = async () => {
    if (await restoreSources()) return true;
    if (sourceProjectionReady) return true;
    try {
      await bounded(Promise.resolve(externalReady()),
        'kernel-browser-network-source-projection-timeout');
      const result = await (await get()).reconcileExternalProjection?.();
      if (result?.ok === false) return false;
      return sourceProjectionReady && restoredSources !== null;
    } catch {
      return false;
    }
  };
  const updateSourceProjection = async (/** @type {unknown} */ bindings,
    /** @type {unknown} */ projection, /** @type {any} */ identity) => {
    if (!identity || identity.bootId !== deps.kernelIdentity?.bootId
        || identity.kernelEpoch !== deps.kernelIdentity?.kernelEpoch
        || identity.generation !== sourceProjectionGeneration
        || !Number.isSafeInteger(identity.revision)
        || identity.revision <= sourceProjectionRevision) return false;
    const tabs = await bounded(Promise.resolve(deps.browser.tabs.query({})),
      'kernel-browser-network-source-tabs-timeout');
    const validated = validateWebActorSourceProjection(
      bindings, projection, tabs, { requireCookieStore: deps.firefox },
    );
    if (!validated) return false;
    reconcileAppTabs(tabs);
    restoredSources = validated;
    sourceProjectionRevision = identity.revision;
    sourceProjectionReady = true;
    await bounded(Promise.resolve(deps.startupGuard?.reconcileSources?.(
      (/** @type {number} */ tabId) => restoredSources?.has(tabId) === true
        || appTabs.has(tabId),
    )), 'kernel-browser-network-startup-reconcile-timeout');
    if (authority) {
      const result = await authority.reconcileExternalProjection?.();
      if (result?.ok === false) return false;
    }
    return true;
  };
  return Object.freeze({
    call,
    custody,
    relays: () => restoredSources ? sourceRelays : null,
    sourceProjectionReady: () => sourceProjectionReady || restoredSources !== null,
    waitForSourceProjection: () => sourceProjectionReady
      ? Promise.resolve(true)
      : restoreSources().then((ready) => ready || (sourceProjectionLoading
        ? sourceProjectionLoading.then(() => true, () => false) : false)),
    ensureSourceProjection,
    flowToken: (/** @type {number} */ tabId) => childGeneration(tabId),
    onCreated(/** @type {any} */ tab) {
      observeAppTab(tab);
      if (typeof tab?.id !== 'number' || typeof tab?.openerTabId !== 'number') {
        if (!authority) return coldQuarantineActive().then((active) => active
          ? loadedCall('onCreated', [tab]) : false).catch((cause) => {
          try { deps.onError?.(cause); } catch {}
          return false;
        });
        return loadedCall('onCreated', [tab]).catch((cause) => {
          try { deps.onError?.(cause); } catch {}
          return false;
        });
      }
      const generation = childGeneration(tab.id, tab.flowToken);
      deps.beginOutcome?.(tab.openerTabId, tab.id, generation);
      const event = { ...tab, flowToken: generation };
      return provenCall('onCreated', [event], async () => {
        const contained = await (deps.startupGuard?.adopt(
          tab.openerTabId, tab.id, generation) ?? false);
        if (contained) deps.containOutcome?.(tab.openerTabId, tab.id, generation);
        return contained;
      },
      (cause, contained) => handleGuardedFailure(event, cause, generation, contained),
      () => deps.startupGuard?.isGuarded?.(tab.id, generation) === true,
      () => handleAbsentProof(event, generation, 'onCreated', [event]))
        .catch((cause) => handleUncontainedFailure(event, cause, generation))
        .finally(() => { deps.settleOutcome?.(tab.openerTabId, tab.id, generation); });
    },
    onNavigationTarget(/** @type {any} */ details) {
      if (typeof details?.tabId !== 'number' || typeof details?.sourceTabId !== 'number') {
        return authority ? loadedCall('onNavigationTarget', [details]) : false;
      }
      const generation = childGeneration(details.tabId, details.flowToken);
      deps.beginOutcome?.(details.sourceTabId, details.tabId, generation);
      const event = { ...details, flowToken: generation };
      return provenCall('onNavigationTarget', [event], async () => {
        const contained = await (deps.startupGuard?.adopt(
          details.sourceTabId, details.tabId, generation) ?? false);
        if (contained) deps.containOutcome?.(
          details.sourceTabId, details.tabId, generation);
        return contained;
      },
      (cause, contained) => handleGuardedFailure(event, cause, generation, contained),
      () => deps.startupGuard?.isGuarded?.(details.tabId, generation) === true,
      () => handleAbsentProof(event, generation, 'onNavigationTarget', [event]))
        .catch((cause) => handleUncontainedFailure(event, cause, generation))
        .finally(() => {
          deps.settleOutcome?.(details.sourceTabId, details.tabId, generation);
        });
    },
    async onUpdated(/** @type {number} */ tabId, /** @type {any} */ changeInfo,
      /** @type {any} */ tab) {
      observeAppTab({ ...tab, id: tabId, url: changeInfo?.url ?? tab?.url });
      if (!authority && !deps.startupGuard?.tabIds?.().includes(tabId)
          && await coldQuarantineActive() !== true) return false;
      return loadedCall('onUpdated', [tabId, changeInfo, tab]);
    },
    onRemoved(/** @type {number} */ tabId) {
      appTabs.delete(tabId);
      const generation = childGenerations.get(tabId);
      childGenerations.delete(tabId);
      const released = deps.startupGuard?.release(tabId, generation) ?? Promise.resolve();
      deps.releaseOutcome?.(tabId);
      return Promise.resolve(released).then(() => authority
        ? loadedCall('onRemoved', [tabId]) : false);
    },
    reconcile: async () => {
      if (typeof deps.browser?.tabs?.query === 'function') {
        reconcileAppTabs(await deps.browser.tabs.query({}));
      }
      await restoreSources();
      await deps.startupGuard?.reconcileSources?.((/** @type {number} */ tabId) =>
        restoredSources?.has(tabId) === true || appTabs.has(tabId));
      return authority ? loadedCall('reconcile') : false;
    },
    bind(/** @type {string} */ generation) {
      if (typeof generation !== 'string' || generation.length < 8) {
        throw new TypeError('kernel-browser-network-projection-generation-invalid');
      }
      sourceProjectionGeneration = generation;
      sourceProjectionRevision = 0;
      sourceProjectionReady = false;
      void Promise.resolve(sourceProjectionLoading).catch(() => {}).then(externalReady)
        .then(get)
        .then(async (owner) => {
          await owner.reconcileExternalProjection?.();
          await owner.ready();
        })
        .catch(deps.onError ?? (() => {}));
    },
    updateSourceProjection,
    ensureBrowserNetworkGuard: (/** @type {number} */ tabId, /** @type {string} */ url) =>
      call('ensureBrowserNetworkGuard', [tabId, url])
        .catch((cause) => callFailure(cause, 'browser-network-guard-timeout')),
    armBrowserChildQuarantine: (/** @type {number} */ tabId) =>
      call('armBrowserChildQuarantine', [tabId]).catch((cause) => {
        const failure = callFailure(cause, 'browser-child-quarantine-unavailable');
        return {
          ...failure,
          outcomeKind: failure.outcomeKnown
            ? /** @type {const} */ ('pre-effect-failure')
            : /** @type {const} */ ('transport-lost'),
        };
      }),
    acquireBrowserNetworkGuardLease: (/** @type {number} */ tabId) =>
      call('acquireBrowserNetworkGuardLease', [tabId])
        .catch((cause) => callFailure(cause, 'browser-network-guard-timeout')),
    releaseBrowserNetworkGuardLease: (/** @type {any} */ lease) =>
      call('releaseBrowserNetworkGuardLease', [lease]),
    updateBrowserNetworkGuardOrigin: (/** @type {number} */ tabId,
      /** @type {string} */ url) =>
      call('updateBrowserNetworkGuardOrigin', [tabId, url])
        .catch((cause) => callFailure(cause, 'browser-network-guard-timeout')),
  });
};

/** @param {Record<string,any>} deps */
export const createKernelTabCustody = (deps) => {
  const live = (/** @type {string} */ name, /** @type {any[]} */ args) => {
    const handler = deps.getRelays()?.eventOwners?.[name];
    if (typeof handler === 'function') return handler(...args);
    return undefined;
  };
  const network = (/** @type {string} */ name, /** @type {any[]} */ args = []) => {
    const ingress = deps.network?.[name];
    if (typeof ingress === 'function') return ingress(...args);
    return Promise.resolve(deps.network.call(name, args)).then(() => true);
  };
  const event = async (/** @type {string} */ name, /** @type {any[]} */ args) => {
    let liveResult;
    try { liveResult = live(name, args); }
    catch (cause) { liveResult = Promise.reject(cause); }
    const handled = await network(name, args);
    return Promise.all([handled, liveResult]);
  };
  return Object.freeze({
    onCreated: (/** @type {any} */ tab) => event('onCreated', [tab]),
    onUpdated: (/** @type {number} */ tabId, /** @type {any} */ changeInfo,
      /** @type {any} */ tab) => event('onUpdated', [tabId, changeInfo, tab]),
    onRemoved: (/** @type {number} */ tabId, /** @type {any} */ removeInfo) => {
      deps.child.release(tabId);
      return event('onRemoved', [tabId, removeInfo]);
    },
    onActivated: (/** @type {any} */ activeInfo) => live('onActivated', [activeInfo]),
    onNavigationTarget: (/** @type {any} */ details) => {
      const flowToken = deps.network?.flowToken?.(details?.tabId);
      const ingress = flowToken ? { ...details, flowToken } : details;
      deps.child.onNavigationTarget(ingress);
      const custody = event('onNavigationTarget', [ingress]);
      void custody.then(() => deps.child.resolveNavigationTarget(ingress), () => {});
      return custody;
    },
    onBeforeRequest: deps.child.onBeforeRequest,
    reconcile: async () => {
      const tabs = await deps.browser.tabs.query({});
      deps.child.reconcile(tabs);
      const reconciled = await Promise.all([
        network('reconcile'), live('reconcile', []),
      ]);
      deps.child.reconcile(await deps.browser.tabs.query({}));
      return reconciled;
    },
  });
};
