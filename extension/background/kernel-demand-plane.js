// @ts-check

import { makeBoundedModuleLoader } from '../shared/bounded-module-load.js';
import {
  KERNEL_ADMINISTRATIVE_ROUTE_NAMES,
  KERNEL_CREDENTIAL_ROUTE_NAMES,
  KERNEL_DEMAND_SUPPORT_ROUTE_NAMES,
  KERNEL_DWEB_ROUTE_NAMES,
  KERNEL_EXECUTABLE_ROUTE_NAMES,
  KERNEL_SEMANTIC_OWNER_ROUTE_NAMES,
} from '../shared/kernel-feature-route-inventory.js';
import { createKernelAdministrativeControl } from './kernel-administrative-control.js';
import { createKernelDemandSupport } from './kernel-demand-support.js';
import { createKernelExecutableControl } from './kernel-executable-owner.js';
import { createKernelExecutableRuntime } from './kernel-executable-runtime.js';
import { createKernelMemoryInitProbe } from './kernel-memory-init-probe.js';
import { createKernelRichEffectAuthority } from './kernel-rich-effect-authority.js';
import { createKernelSemanticRuntime } from './kernel-semantic-runtime.js';
import { createKernelSkillPersistence } from './kernel-skill-persistence.js';
import { createKernelTurnCustody } from './kernel-turn-custody.js';
import { createLocalModelGenerationAuthority } from './local-model-generation-authority.js';
import { makeKernelDemandRoutes } from './kernel-demand-routes.js';
import { createProviderEgressAuthority } from './provider-egress-authority.js';
import { HARDCODED_ALLOWLIST, makeSafeFetch } from '/peerd-egress/background.js';
import { costOf, hasPricing } from '/peerd-provider/background.js';

const OPTIONAL_CONTROLLER_ROUTES = new Set([
  'provider/test', 'models/options', 'openrouter/models',
  'local-model/catalog', 'local-model/init', 'local-model/probe', 'local-model/status',
]);

/** @param {Record<string,any>} deps */
export const createKernelDemandPlane = (deps) => {
  if (typeof deps.createProductionRuntime !== 'function'
      || !deps.controllerGateway || typeof deps.controllerGateway.withRun !== 'function') {
    throw new TypeError('kernel-demand-plane-config-invalid');
  }
  const reloadApp = async (/** @type {string} */ appId) => {
    const tabs = await deps.browser.tabs?.query?.({ url: `${deps.appTabUrl}*` }) ?? [];
    const tab = tabs.find((/** @type {any} */ candidate) => {
      if (typeof candidate?.url !== 'string') return false;
      try {
        return new URL(candidate.url).hash.slice(1).split('?', 1)[0] === appId;
      } catch { return false; }
    });
    if (typeof tab?.id !== 'number') return false;
    await deps.browser.tabs.reload(tab.id);
    return true;
  };
  const providerSafeFetch = makeSafeFetch({
    getAllowlist: () => {
      let ollamaOrigin = null;
      try { ollamaOrigin = new URL(deps.settingsStore.get().ollamaHost).origin; }
      catch { ollamaOrigin = null; }
      return ollamaOrigin ? [...HARDCODED_ALLOWLIST, ollamaOrigin] : HARDCODED_ALLOWLIST;
    },
    audit: deps.auditLog.append,
  });
  const localModelAuthority = !deps.firefox ? createLocalModelGenerationAuthority({
    featureHost: deps.featureHost,
    offscreenUrl: deps.offscreenUrl,
  }) : undefined;
  const providerEgress = createProviderEgressAuthority({
    safeFetch: providerSafeFetch,
    vault: deps.vault,
    settingsStore: deps.settingsStore,
    localModelAuthority,
  });
  const withRepositoryHost = async (/** @type {(lease:any)=>Promise<any>} */ operation) => {
    let entered = false;
    const result = await deps.featureHost.runtime.runWithLease('controller', async (
      /** @type {any} */ lease,
    ) => {
      entered = true;
      return operation(lease);
    }, { reason: 'repository-demand' });
    if (entered) return result;
    const refusal = /** @type {any} */ (result);
    const error = /** @type {Error & {code?:string,outcomeKnown?:boolean}} */ (
      new Error(refusal?.code ?? 'repository host unavailable')
    );
    error.code = refusal?.code ?? 'repository-host-unavailable';
    error.outcomeKnown = refusal?.outcomeKnown === true;
    throw error;
  };
  const repositoryAudit = (/** @type {any} */ event) => {
    void deps.auditLog.append(event).catch(() => {});
  };
  const repositoryWebFetch = async (/** @type {string} */ url,
    /** @type {RequestInit} */ init = {}) => {
    const policy = await deps.denylist.ready();
    const target = new URL(url);
    if (!policy.ok || deps.denylist.blocks(target.hostname)) {
      throw new Error('Git network request is blocked by the sensitive-origin policy');
    }
    const response = await globalThis.fetch(url, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel('Git redirects are blocked').catch(() => {});
      throw new Error('Git redirects are blocked');
    }
    repositoryAudit({ type: 'web_fetch', details: {
      origin: target.origin, path: target.pathname, method: init.method ?? 'GET',
    } });
    return response;
  };
  const support = createKernelDemandSupport({
    ...deps,
    denylist: deps.denylist,
    createFirefoxRepositoryClient: deps.firefoxAddon?.createFirefoxRepositoryClient,
    withFirefoxLifetime: (/** @type {()=>Promise<any>} */ operation,
      /** @type {any} */ options) => deps.getFirefoxLifetime()?.run(operation, options)
      ?? operation(),
    withRepositoryHost,
    repositoryWebFetch,
    repositoryAudit,
    retireRepositoryHost: (/** @type {string} */ reason) =>
      deps.featureHost.runtime.retireActiveHost(reason),
    reloadApp,
  });
  const turnCustody = createKernelTurnCustody({
    browser: deps.browser,
    idb: deps.idb,
    kv: deps.kv,
    sessionCache: deps.sessionCache,
    vault: deps.vault,
    auditLog: deps.auditLog,
    settingsStore: deps.settingsStore,
    uiPorts: deps.uiPorts,
    pushState: deps.pushState,
    postChatNote: deps.postChatNote,
    onAbort: (/** @type {string} */ sessionId) =>
      deps.confirmation.declineSession?.(sessionId),
  });
  /** @type {any} */
  let controllerOwner = null;
  /** @type {any} */
  let liveProduction = null;
  /** @type {any} */
  let administrativeControl = null;
  /** @type {WeakMap<Record<string,any>,Record<string,any>>} */
  const productionOwners = new WeakMap();
  const controllerRelays = () => liveProduction?.relays ?? null;
  const richEffects = createKernelRichEffectAuthority({
    scriptRuns: deps.scriptRuns,
    sessions: deps.sessions,
    settingsStore: deps.settingsStore,
    vault: deps.vault,
    auditLog: deps.auditLog,
    contextSnapshots: deps.contextSnapshots,
    kv: deps.kv,
    fetchFn: deps.fetchFn,
    providerEgress,
    costOf,
    hasPricing,
  });
  const loadRichOwner = async (/** @type {any} */ seams) => {
    const sourceProjectionGeneration = crypto.randomUUID();
    let sourceProjectionRevision = 0;
    const runtime = await deps.controllerGateway.withRun(() => deps.createProductionRuntime({
      ...deps,
      seams,
      turnCustody,
      providerEgress,
      resolveProviderSelection: async (/** @type {string|null} */ sessionId = null) =>
        (await loadControllerOwner()).routes['models/options']({ sessionId }),
      confirmation: deps.confirmation,
      denylist: deps.denylist,
      repositories: support.repositories,
      reloadApp,
      appCatalog: support.appCatalog,
      bindAppRegistry: support.appCatalog.bindLiveRegistry,
      getDwebLive: async () => deps.getDwebLive(),
      ready: deps.kernelReady,
      firefoxActorLifetime: deps.getFirefoxLifetime(),
      normalizeSettingsPatch: support.normalizeSettingsPatch,
      syncDenylistNetwork: deps.networkCustody().sync,
      networkCustody: deps.networkCustody(),
      updateBrowserSourceProjection: (/** @type {unknown} */ bindings,
        /** @type {unknown} */ projection) => deps.updateBrowserSourceProjection(
        bindings, projection, Object.freeze({
          bootId: deps.kernelIdentity.bootId,
          kernelEpoch: deps.kernelIdentity.kernelEpoch,
          generation: sourceProjectionGeneration,
          revision: ++sourceProjectionRevision,
        }),
      ),
    }));
    const owner = Object.freeze({
      ...runtime,
      sourceProjectionGeneration,
    });
    productionOwners.set(owner.turnRuntime, owner);
    return owner;
  };
  const loadControllerOwner = makeBoundedModuleLoader(async () => {
    if (controllerOwner) return controllerOwner;
    controllerOwner = createKernelSemanticRuntime({
      ...deps,
      ready: deps.vaultReady,
      appCatalog: support.appCatalog,
      appFiles: support.appFiles,
      repositories: support.repositories,
      localModels: !deps.firefox,
      authorizeFeatureCall: (/** @type {unknown} */ payload) =>
        administrativeControl?.authorize(payload) ?? null,
      handleFeatureKernelCall: (/** @type {string} */ operation,
        /** @type {unknown} */ payload, /** @type {any} */ context) =>
        administrativeControl?.handleKernelCall(operation, payload, context)
          ?? { ok: false, code: 'kernel-operation-denied', outcomeKnown: true },
      handleRichKernelCall: richEffects.handle,
      providerEgress,
      ensureOffscreen: deps.featureHost.ensureOffscreen,
      retireHost: (/** @type {string} */ reason) =>
        deps.featureHost.runtime.retireActiveHost(reason),
      loadTurnRuntime: async (/** @type {any} */ seams) =>
        (await loadRichOwner(seams)).turnRuntime,
      withProductionRun: deps.controllerGateway.withRun,
      onTurnRuntimeLoaded: async (/** @type {any} */ runtime, /** @type {any} */ custody) => {
        const owner = productionOwners.get(runtime);
        if (!owner) throw new Error('kernel-production-owner-missing');
        await runtime.relays.eventOwners.reconcile();
        if (!custody.isCurrent() || !custody.publish()) {
          throw new Error('kernel-production-generation-retired');
        }
        await runtime.relays.eventOwners.reconcile();
        if (!custody.isCurrent()) throw new Error('kernel-production-generation-retired');
        deps.bindNetwork(owner.sourceProjectionGeneration);
        liveProduction = owner;
      },
      withControllerLease: (/** @type {()=>any} */ operation) =>
        deps.featureHost.runtime.runWithLease(
          'controller', operation, { reason: 'semantic-demand' },
        ),
      withDirectLifetime: (/** @type {()=>any} */ operation, /** @type {any} */ options) =>
        deps.getFirefoxLifetime()?.run(operation, options) ?? operation(),
      connectDirectController: deps.firefox
        ? deps.firefoxAddon?.connectDirectController : undefined,
    });
    return controllerOwner;
  }, {
    timeoutMs: 15_000,
    loadCode: 'kernel-semantic-runtime-load-failed',
    timeoutCode: 'kernel-semantic-runtime-load-timeout',
  });
  const getControllerRelays = async () => {
    await (await loadControllerOwner()).getRelays();
    const relays = controllerRelays();
    if (!relays) throw new Error('kernel-rich-owner-unavailable');
    return relays;
  };
  const semanticRoutes = makeKernelDemandRoutes({
    names: KERNEL_SEMANTIC_OWNER_ROUTE_NAMES,
    loadCode: 'kernel-semantic-owner-load-failed',
    timeoutCode: 'kernel-semantic-owner-load-timeout',
    interrupt: {
      name: 'agent/stop', guards: ['agent/send'],
      refusal: () => ({
        ok: false,
        error: 'agent-send-stopped-before-dispatch',
        code: 'agent-send-stopped-before-dispatch',
        outcomeKnown: true,
        phase: 'pre-dispatch',
        retryable: false,
      }),
    },
    beforeLoad: async (name) => {
      if (OPTIONAL_CONTROLLER_ROUTES.has(name)) return null;
      if (deps.firefox && ['actor/spawn', 'agent/send'].includes(name)
          && !deps.childGuard().ready()) {
        return {
          ok: false, error: 'Web automation paused. Retry.',
          code: 'firefox-child-custody-unavailable', outcomeKnown: true,
          retryable: true, phase: 'startup',
        };
      }
      try { await deps.vaultReady; }
      catch {
        return {
          ok: false, error: 'Temporarily unavailable. Try again.',
          code: 'kernel-semantic-startup-failed', outcomeKnown: true,
          retryable: true, phase: 'startup',
        };
      }
      return deps.vault.isLocked() ? { ok: false, error: 'vault-locked' } : null;
    },
    load: async () => (await loadControllerOwner()).routes,
  });
  const getRichOwner = async () => {
    await getControllerRelays();
    if (!liveProduction) throw new Error('kernel-rich-owner-unavailable');
    return liveProduction;
  };
  const executableOwner = createKernelExecutableControl({
    runtimeId: deps.runtimeId,
    firefox: deps.firefox,
    dweb: deps.dwebEnabled,
    privateTransfer: false,
    createRuntime: createKernelExecutableRuntime,
    loadEngineLive: async () => (await getRichOwner()).executableLive,
    loadActorChatRelays: async () => (await getRichOwner()).relays,
    loadAppRuntimeRelays: async () => (await getRichOwner()).relays,
    loadRelayRoutes: async () => {
      const owner = await getRichOwner();
      return { ...owner.relayRoutes, ...owner.relays?.engineRoutes };
    },
    loadTransferLive: async () => (await getRichOwner()).transferLive,
    loadDwebRoutes: async () => (await getRichOwner()).dwebRoutes,
    dispatchRuntimeRelay: async (/** @type {string} */ route,
      /** @type {unknown} */ message) =>
      (await loadControllerOwner()).runtime.relay(route, message),
    owns: {
      home: deps.isHomeSender,
      options: deps.isOptionsSender,
      offscreen: deps.isOffscreenSender,
      app: deps.isAppSender,
    },
    paths: {
      app: deps.appTabUrl,
      notebook: deps.notebookTabUrl,
      vm: deps.vmTabUrl,
      pod: deps.podTabUrl,
      options: deps.optionsUrl,
    },
  });
  const skillPersistence = createKernelSkillPersistence({
    canWrite: () => deps.canWrite('skills'),
    audit: deps.auditLog.append,
    pushState: deps.pushState,
  });
  const memoryInitProbe = createKernelMemoryInitProbe({
    tabs: deps.browser.tabs,
    scripting: deps.browser.scripting,
    resolveTab: async (/** @type {any} */ tab) => {
      if (typeof tab?.id !== 'number') return null;
      const [identity] = await deps.browser.scripting.executeScript({
        target: { tabId: tab.id }, func: () => globalThis.location.href,
      });
      const current = await deps.browser.tabs.get(tab.id);
      const documentId = /** @type {{documentId?:unknown}|undefined} */ (identity)?.documentId;
      if (typeof documentId !== 'string'
          || typeof identity?.result !== 'string'
          || identity.result !== current?.url) return null;
      return { ...current, peerdDocumentId: documentId };
    },
  });
  administrativeControl = createKernelAdministrativeControl({
    callFeature: async (/** @type {unknown} */ payload, /** @type {any} */ options) =>
      (await loadControllerOwner()).callFeature(payload, options),
    kv: deps.kv,
    idb: deps.idb,
    auditLog: deps.auditLog,
    canWrite: deps.canWrite,
    commitSkill: skillPersistence.commit,
    probeMemoryTab: memoryInitProbe.probeTab,
    listApps: support.appCatalog.list,
    confirm: deps.confirmation.confirm,
    currentSessionId: () => deps.sessionCache.sessionGet('currentSessionId'),
    assertMemoryInitAllowed: async () => {
      if (deps.vault.isLocked()) throw new deps.VaultLockedError();
      if (!(await deps.denylist.ready()).ok) throw new Error('denylist policy unavailable');
    },
    postChatNote: deps.postChatNote,
  });
  const debugRoutes = makeKernelDemandRoutes({
    names: ['debug/originLock'],
    loadCode: 'kernel-debug-owner-load-failed',
    timeoutCode: 'kernel-debug-owner-load-timeout',
    load: async () => ({
      'debug/originLock': (await getControllerRelays()).debugOriginLock,
    }),
  });
  const routes = Object.freeze({
    ...support.directRoutes,
    ...support.providerKeyRoutes,
    ...support.credentialRoutes,
    ...semanticRoutes,
    ...executableOwner.routes,
    ...administrativeControl.routes,
    ...debugRoutes,
  });
  const expected = [
    ...KERNEL_DEMAND_SUPPORT_ROUTE_NAMES,
    'provider/setKey',
    ...KERNEL_CREDENTIAL_ROUTE_NAMES,
    ...KERNEL_SEMANTIC_OWNER_ROUTE_NAMES,
    ...KERNEL_EXECUTABLE_ROUTE_NAMES,
    ...(deps.dwebEnabled ? KERNEL_DWEB_ROUTE_NAMES : []),
    ...KERNEL_ADMINISTRATIVE_ROUTE_NAMES,
    'debug/originLock',
  ];
  if (Object.keys(routes).sort().join('\0') !== expected.sort().join('\0')) {
    throw new TypeError('kernel-demand-plane-routes-invalid');
  }
  return Object.freeze({
    routes,
    projectProviderState: async (/** @type {Record<string,any>} */ snapshot) =>
      (await loadControllerOwner()).routes['models/state-projection'](snapshot),
    controllerRelays,
    getControllerRelays,
    makeTransferRoutes: executableOwner.makeTransferRoutes,
    listApps: support.appCatalog.list,
    abortProviderTests: () => controllerOwner?.abortProviderTests?.(),
  });
};
