// @ts-check

import {
  actorIsolationAvailable,
  actorIsolationCapability,
  actorIsolationRefusal,
  actorIsolationSpawnRefusal,
  actorIsolationTemporarilyUnavailable,
  assembleDebugBundle,
  AUTH_BOUNDARY_STOPPED_MESSAGE,
  AUTH_STATE_UNAVAILABLE_MESSAGE,
  AUTH_WAITING_FOR_USER_MESSAGE,
  authorizeSiteClientRelayOrigin,
  buildAncestry,
  childSessionIdsOf,
  classifyFailure,
  createCommandStore,
  createConversationRegistry,
  createRefRegistry,
  createResultStore,
  createSiteClientStore,
  createSkillStore,
  decideNumericTabAuthority,
  hasDurableSiteClientState,
  IDENTITY_PROVIDER_TRANSIT_ONLY_CODE,
  isAddressableBrowserTab,
  isKnownIdp,
  isKnownIdpHost,
  isUgcHost,
  learnedOriginCovers,
  makeActorMessaging,
  makeApiActorBindings,
  makeAsyncActors,
  makeCredentialScope,
  makeDispatchTracker,
  makeEngineLiveness,
  makeFailClosedTracker,
  makeFixedSiteClientOriginGuard,
  makeJudgeLanding,
  makeLearnedOrigins,
  makeLifecycleBoot,
  makeMeshDispatch,
  makeOriginStateStore,
  makePrewalkController,
  makeTurnAuthorityDriver,
  makeSignInExcursionAuthorizer,
  makeSignInExcursionRevoker,
  makeSignInOriginAuthorizer,
  makeSiteClientOriginAuthorizer,
  makeSiteClientOriginGuard,
  makeWebActorRegistry,
  makeWebActorTabBindings,
  numericTabAuthorityRefusal,
  resolveRuntimeCapabilities,
  retireStoppedRoamingWebActorDurably,
  retryClassForTool,
  SessionNotFoundError,
} from '/peerd-runtime/kernel-turn-authority.js';
import {
  HARDCODED_ALLOWLIST,
  makeAgentSendCustody,
  makeSafeFetch,
  makeWebFetch,
  matchesDenylist,
  withDpopCredentials,
  makeDpopKeyStore,
  getOrCreateDpopKey,
  VaultLockedError,
  withSessionScopedCredentials,
} from '/peerd-egress/background.js';
import { projectSemanticHookManifest } from '/shared/semantic-hook-manifest.js';
import {
  needsWebWriteConfirm,
  WEB_WRITE_CONFIRM_KEY,
} from '/peerd-engine/authority.js';
import { createActorLiveProjection } from './actor-live-projection.js';
import { makeActorOverviewRoutes } from './routes/actor-overview.js';
import { makeActorIsolationStateStore } from './actor-isolation-state.js';
import { makeSiteCaptureManager } from './site-capture-manager.js';
import { makeOffscreenActorChannelClient, selectExactActorHostClient } from './offscreen-actor-channel-client.js';
import { makeOffscreenActorClient } from './offscreen-actor-client.js';
import { makeOffscreenDocClient } from './offscreen-doc-client.js';
import { makeOffscreenJsClient } from './offscreen-js-client.js';
import { makeOffscreenWebClient } from './offscreen-web-client.js';
import { makeAppActorChatHandler } from './app-actor-chat.js';
import { makeActorsRoutes } from './routes/actors.js';
import { makeOriginLockResolver } from './origin-lock-controller.js';
import { actorDeliveryIdsFromMessage, makeActorRecoveryGate } from './actor-recovery-gate.js';
import { isActorHostStartupFailure, runActorWithStartupRetry } from './actor-startup-retry.js';
import { makeTabAffordances } from './tab-affordances.js';
import { createDebuggerPool } from './debugger-pool.js';
import { answerWithSessionConfirmGrant } from './confirm-session-grants.js';
import { a2aConsentOutcome, downgradesActorConfirm } from './a2a-consent.js';
import { makeDwebShare } from './dweb-share.js';
import { createKernelDwebAgentOwner } from './kernel-dweb-agent-owner.js';
import { relayAppRuntimeCall } from './app-runtime-deadline.js';
import {
  appActorSessionMatches,
  canonicalActorOwnerPosture,
  canonicalAppActorManifest,
  canonicalAppOwnerAuthority,
  makeAppRole,
  manifestAppActorTools,
  resolveAppTabOwnerClaim,
  validateAppTabClaim,
} from './app-actor-policy.js';

import { sha256Hex } from '/shared/util.js';
import { CHANNEL_DEFAULTS } from '/shared/channel-config.js';
import { ACTOR_WORKER_PROTOCOL } from '/offscreen/actor-worker-protocol.js';
import {
  WEB_ACTOR_SOURCE_PROJECTION_KEY,
  webActorSourceProjectionRow,
} from '/shared/web-actor-source-projection.js';
import { providerEgressPolicy } from './provider-egress-manifest.js';
import { finalWebRequestConfirmation } from '/shared/web-request-confirmation.js';

// why: silently replacing an unreadable enabled pre-hook policy with an empty
// list fails open. The sealed semantic realm compiles this sentinel into a
// deterministic blocking hook while ordinary empty storage remains `[]`.
const HOOK_RECORDS_UNAVAILABLE = Object.freeze([Object.freeze({
  id: 'user-hook-records-unavailable', event: 'pre-tool-use',
  kind: 'unavailable', enabled: true,
})]);
const ACTOR_EXPOSURE = 'actor';

const originOf = (/** @type {string} */ value) => {
  try { return new URL(value).origin; }
  catch { return ''; }
};

/**
 * @param {Record<string,any>} deps
 * @param {ReturnType<import('/peerd-runtime/controller-turn-semantics.js').createControllerTurnSemantics>} semanticOwners
 */
export const createKernelTurnAuthorityAdapter = (deps, semanticOwners) => {
  if (!deps?.engine || !deps.browser || !deps.vault || !deps.settingsStore
      || !deps.seams || !deps.confirmation || !deps.denylist
      || !deps.scriptRuns || !deps.contextSnapshots
      || !deps.providerEgress || typeof deps.resolveProviderSelection !== 'function') {
    throw new TypeError('kernel-turn-live-config-invalid');
  }
  const {
    describeLandingStop,
    fenceApiActorSummary,
    fenceWebActorSummary,
    finalActorTurnReply,
    finalAssistantText,
    landingStopCard,
    makeSpawnActor,
    meshCallToOp,
    normalizeApiOrigin,
    originPhrase,
    parseSiteHandle,
    safeWebActorSummaryOrigin,
    shapeMeshResult,
    siteHandleFor,
    wrapUntrusted,
  } = semanticOwners.actor;
  const {
    PERMISSION_MODES,
    confirmActionsFromRecord,
    limitExceeded,
    normalizeConfirmActions,
    normalizeMode,
    normalizeTally,
  } = semanticOwners.policy;
  const {
    buildMintInjection,
    digestCapture,
    drainFetchTapInjected,
    installFetchTapInjected,
    parseAppManifest,
    resolveSiteUrl,
  } = semanticOwners.site;
  const {
    DOC_TEXT_MAX_CHARS,
    GOAL_MAX_ITERATIONS,
    applyComposer,
    createSkillRegistry,
    createSuggestionStore,
    formatDocBody,
    localStoreSource,
    makeAutoMemory,
    makeCheapCall,
    makeGoalRunner,
    makeInitOrchestrator,
    makeScheduler,
    makeToolsCommand,
    makeTrimEnricher,
    mergeSources,
    prepareUserAttachmentsWithDocs,
    skillRegistrySource,
  } = semanticOwners.turn;
  const projectToolSurface = async (/** @type {Record<string,unknown>} */ input) => {
    const projected = await deps.seams.projectTurnTools(input);
    if (!projected || !Array.isArray(projected.tools)
        || !Array.isArray(projected.operations)
        || projected.tools.some((/** @type {any} */ tool) => !tool || typeof tool.name !== 'string')
        || projected.operations.some((/** @type {unknown} */ operation) => typeof operation !== 'string')) {
      throw new Error('controller tool projection is invalid');
    }
    return Object.freeze({
      tools: Object.freeze([...projected.tools]),
      operations: Object.freeze([...projected.operations]),
      ...(projected.actorSurface === 'tools' || projected.actorSurface === 'code'
        ? { actorSurface: projected.actorSurface } : {}),
      ...(typeof projected.actorSurfaceFallback === 'string'
        ? { actorSurfaceFallback: projected.actorSurfaceFallback } : {}),
    });
  };
  const projectToolDescriptors = async (/** @type {Record<string,unknown>} */ input) =>
    (await projectToolSurface(input)).tools;
  const engine = deps.engine;
  const scriptRuns = deps.scriptRuns;
  const poisonedAppRuntimeTabs = new Set();
  const projection = createActorLiveProjection();
  const contextSnapshots = deps.contextSnapshots;
  const debuggerPool = createDebuggerPool({ bindTabEvents: false, bindTabRemoval: false });
  const debuggerApiAvailable = () => typeof deps.browser.debugger?.attach === 'function';
  const advancedAutomationOn = () => debuggerApiAvailable()
    && deps.settingsStore.get().advancedAutomationEnabled !== false;
  const siteCapture = deps.siteCapture ?? makeSiteCaptureManager({
    advancedAutomationOn, debuggerPool, scripting: deps.browser.scripting,
    installFetchTapInjected, drainFetchTapInjected, digestCapture,
  });
  const skillRegistry = createSkillRegistry({
    store: createSkillStore({ canWrite: () => deps.canWrite('skills') }),
    audit: deps.auditLog.append,
  });
  const commandStore = createCommandStore({ kv: deps.kv });
  const commandSources = mergeSources([
    localStoreSource(commandStore), skillRegistrySource(skillRegistry),
  ]);
  const safeFetch = makeSafeFetch({
    getAllowlist: () => [...HARDCODED_ALLOWLIST, ...userEndpoints],
    audit: deps.auditLog.append,
  });
  const webFetch = makeWebFetch({
    getDenylist: () => deps.denylist.patterns(),
    matchDenylist: matchesDenylist,
    audit: deps.auditLog.append,
  });
  const runtimeCapabilities = resolveRuntimeCapabilities({
    offscreenDocument: !deps.firefox,
    moonshineVoiceDocument: true,
    dwebPackaged: deps.dwebEnabled,
  });
  const dwebEngagedSessions = new Set();
  const a2aApprovedDids = new Set();
  const a2aApprovedReady = deps.sessionCache.sessionGet('a2aApprovedDids')
    .then((/** @type {unknown} */ stored) => {
      for (const did of Array.isArray(stored) ? stored : []) {
        if (typeof did === 'string') a2aApprovedDids.add(did);
      }
    });
  /** @type {string|null} */
  let dwebActorSessionId = null;
  const dwebActorReady = deps.sessionCache.sessionGet('dwebActorBinding')
    .then((/** @type {unknown} */ stored) => {
      if (typeof stored === 'string') dwebActorSessionId = stored;
    });
  const userEndpoints = new Set();
  const loadUserEndpoints = async () => {
    const stored = await deps.kv.get('provider_endpoints.v1');
    userEndpoints.clear();
    for (const endpoint of Array.isArray(stored?.endpoints) ? stored.endpoints : []) {
      if (typeof endpoint?.url === 'string') userEndpoints.add(endpoint.url);
    }
  };
  const userEndpointsReady = loadUserEndpoints();
  const todoChains = new Map();
  const webActorTabBindings = makeWebActorTabBindings();
  const webActorRegistry = makeWebActorRegistry();
  const apiActorBindings = makeApiActorBindings();
  const siteActorBindings = makeApiActorBindings();
  const appActorBindings = makeApiActorBindings();
  const retiredActorSessions = new Set();
  const landingTurnTokens = new Map();
  const landingStopReports = new Map();
  const landingStopCards = new Map();
  let landingTurnSequence = 0;
  const originStates = makeOriginStateStore({
    save: async (sessionId, state) => {
      if (live) await live.shared.sessions.update(sessionId, { originState: state });
    },
  });
  const siteClientStore = createSiteClientStore();
  const domRefs = createRefRegistry();
  const resultStore = createResultStore();
  const persistEntries = (/** @type {string} */ key, /** @type {any} */ store) => () =>
    deps.sessionCache.sessionSet(key, store.entries()).catch(() => {});
  /** @type {Promise<void>} */
  let webBindingWrite = Promise.resolve();
  const persistWebBindings = () => {
    const entries = webActorTabBindings.entries();
    webBindingWrite = webBindingWrite.then(async () => {
      const sourceRows = (await Promise.all(entries.map(async ([tabId, sessionId]) =>
        webActorSourceProjectionRow(
          await deps.browser.tabs.get(tabId).catch(() => null), sessionId,
        )))).filter(Boolean);
      await deps.sessionCache.sessionSet('webActorTabBindings', entries);
      await deps.sessionCache.sessionSet(WEB_ACTOR_SOURCE_PROJECTION_KEY, sourceRows);
      await deps.updateBrowserSourceProjection(entries, sourceRows);
    }).catch(() => {});
    return webBindingWrite;
  };
  const persistWebActors = persistEntries('webActorRegistry', webActorRegistry);
  const persistApiActors = persistEntries('apiActorBindings', apiActorBindings);
  const persistSiteActors = persistEntries('siteActorBindings', siteActorBindings);
  const persistAppActors = persistEntries('appActorBindings', appActorBindings);
  const hydrateEntries = async (/** @type {string} */ key, /** @type {any} */ store) => {
    const entries = await deps.sessionCache.sessionGet(key).catch(() => null);
    if (Array.isArray(entries)) store.load(entries);
  };
  const bindingReady = Promise.all([
    hydrateEntries('webActorTabBindings', webActorTabBindings),
    hydrateEntries('webActorRegistry', webActorRegistry),
    hydrateEntries('apiActorBindings', apiActorBindings),
    hydrateEntries('siteActorBindings', siteActorBindings),
    hydrateEntries('appActorBindings', appActorBindings),
  ]);
  const keyedOrigins = new Set();
  const refreshKeyedOrigins = async () => {
    if (deps.keyedOriginAuthority) return deps.keyedOriginAuthority.hydrate();
    try {
      const names = await deps.vault.listSecretNames();
      keyedOrigins.clear();
      for (const name of names) {
        if (!String(name).startsWith('origin:')) continue;
        const origin = normalizeApiOrigin(String(name).slice(7));
        if (origin) keyedOrigins.add(origin);
      }
      return true;
    } catch { return false; }
  };
  const learnedOrigins = makeLearnedOrigins({
    load: async () => deps.kv.get('learnedOrigins.v1'),
    save: async (all) => deps.kv.set('learnedOrigins.v1', all),
    onLearn: (host, reason) => {
      deps.auditLog.append({
        type: 'origin_learned_sensitive', details: { host, reason },
      }).catch(() => {});
    },
    onForget: (hosts) => {
      for (const host of hosts) {
        deps.auditLog.append({
          type: 'origin_unlearned_sensitive', details: { host },
        }).catch(() => {});
      }
    },
  });
  const engineLiveness = makeEngineLiveness({ storage: deps.kv });
  const numericTabAuthorityFor = async (/** @type {unknown} */ liveUrl) => {
    await learnedOrigins.hydrate();
    const keyedReady = await refreshKeyedOrigins();
    return decideNumericTabAuthority(liveUrl, {
      policyReady: keyedReady && learnedOrigins.hydrationStatus().ok,
      isKnownIdp: isKnownIdpHost,
      isUgcZone: isUgcHost,
      hasVaultSecret: (origin) => deps.keyedOriginAuthority?.has(origin) ?? keyedOrigins.has(origin),
      learned: learnedOrigins.snapshot(),
    });
  };
  const sensitivitySignals = () => ({
    isKnownIdp: isKnownIdpHost,
    isUgcZone: isUgcHost,
    hasVaultSecret: (/** @type {string} */ origin) =>
      deps.keyedOriginAuthority?.has(origin) ?? keyedOrigins.has(origin),
    getLearned: () => learnedOrigins.snapshot(),
  });
  const lifecycleBoot = makeLifecycleBoot({
    storage: deps.kv,
    appendAudit: (entry) => deps.auditLog.append({ type: entry.event, details: entry }),
    notify: (_sessionId, text) => deps.postChatNote(text),
    resolveNoticeSession: async (sessionId) => {
      let current = sessionId;
      for (let hops = 0; hops < 8; hops += 1) {
        const record = await live?.shared.sessions.get(current).catch(() => null);
        if (!record?.parentSessionId) break;
        current = record.parentSessionId;
      }
      return current;
    },
    nonce: () => crypto.randomUUID(),
  });
  /** @type {ReturnType<typeof makeDispatchTracker> | ReturnType<typeof makeFailClosedTracker> | null} */
  let lifecycleTracker = null;
  const lifecycleArmed = lifecycleBoot.init().then(({ generation }) => {
    lifecycleTracker = makeDispatchTracker({
      operationLog: lifecycleBoot.operationLog,
      generationId: () => generation.id,
      retryClassFor: retryClassForTool,
      classifyFailure,
      resolveOwnerSessionId: async (sessionId) => {
        let current = sessionId;
        for (let hops = 0; hops < 8; hops += 1) {
          const record = await live?.shared.sessions.get(current).catch(() => null);
          if (!record?.parentSessionId) break;
          current = record.parentSessionId;
        }
        return current;
      },
    });
  }).catch((cause) => {
    lifecycleTracker = makeFailClosedTracker({
      reason: cause instanceof Error ? cause.message : String(cause),
      retryClassFor: retryClassForTool,
    });
  });
  /** @type {any} */
  let live = null;
  /** @type {any} */
  let goalRunner = null;

  const resolveActiveProvider = () => {
    const settings = deps.settingsStore.get();
    const provider = providerEgressPolicy(settings.providerName);
    if (!provider || (settings.providerName === 'local-webgpu' && deps.firefox)) {
      throw new Error('no-provider');
    }
    return { name: settings.providerName, model: String(settings.providerModel ?? '') };
  };
  const ensureActiveProvider = async () => {
    await deps.ready;
    const selection = await deps.resolveProviderSelection(null);
    if (selection?.ok !== true || typeof selection.selected !== 'string') {
      throw new Error('no-provider');
    }
    const [name, model, extra] = selection.selected.split('::');
    if (extra !== undefined || !providerEgressPolicy(name)
        || (name === 'local-webgpu' && deps.firefox) || !model) {
      throw new Error('no-provider');
    }
    if (deps.settingsStore.get().providerName !== name) {
      await deps.settingsStore.update({ providerName: name, providerModel: '' });
      deps.providerProjection?.bumpRevision?.();
    }
    return { name, model };
  };
  const resolvePermission = async (/** @type {any} */ session) => {
    let authoritySession = session;
    if (session?.sessionId && (session.kind === 'actor' || session.kind === 'spawned')) {
      const rootSessionId = await rootSessionIdFor(session.sessionId);
      if (!rootSessionId) return { mode: PERMISSION_MODES.PLAN, confirmActions: true };
      authoritySession = await live.shared.sessions.get(rootSessionId).catch(() => null);
      if (!authoritySession || authoritySession.kind !== 'chat') {
        return { mode: PERMISSION_MODES.PLAN, confirmActions: true };
      }
    }
    if (authoritySession?.sessionId && goalRunner?.isActive(authoritySession.sessionId)) {
      return { mode: PERMISSION_MODES.ACT, confirmActions: false };
    }
    return {
      mode: normalizeMode(authoritySession?.permissionMode
        ?? await deps.sessionCache.sessionGet('currentPermissionMode')
        ?? PERMISSION_MODES.ACT),
      confirmActions: normalizeConfirmActions(confirmActionsFromRecord(authoritySession)
        ?? confirmActionsFromRecord({
          confirmActions: await deps.sessionCache.sessionGet('currentConfirmActions'),
        }) ?? false),
    };
  };
  const providerCredentialReady = async (/** @type {string} */ providerName) => {
    const credential = providerEgressPolicy(providerName)?.credential;
    if (credential === null) return true;
    if (typeof credential !== 'string') return false;
    return !!await deps.vault.getSecret(credential).catch(() => null);
  };
  const costChains = new Map();
  const foldSessionCost = (/** @type {string} */ sessionId,
    /** @type {any} */ usage, /** @type {number} */ amount) => {
    const previous = costChains.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const session = await live.shared.sessions.get(sessionId);
      const prior = normalizeTally(session?.cost);
      const addition = normalizeTally({ ...usage, cost: amount });
      await live.shared.sessions.update(sessionId, {
        cost: {
          inputTokens: prior.inputTokens + addition.inputTokens,
          outputTokens: prior.outputTokens + addition.outputTokens,
          cacheReadTokens: prior.cacheReadTokens + addition.cacheReadTokens,
          cacheWriteTokens: prior.cacheWriteTokens + addition.cacheWriteTokens,
          cost: prior.cost + addition.cost,
        },
      });
    });
    costChains.set(sessionId, operation);
    void operation.finally(() => {
      if (costChains.get(sessionId) === operation) costChains.delete(sessionId);
    }).catch(() => {});
    return operation;
  };

  const withLease = (/** @type {string} */ scope, /** @type {any} */ operation,
    /** @type {string} */ reason) => deps.featureHost.runtime.runWithLease(
    scope, operation, { reason },
  );
  const hostMessage = (/** @type {any} */ message, /** @type {string} */ reason) =>
    withLease('dom-host', () => deps.browser.runtime.sendMessage(message), reason);
  const jsOffscreenClient = deps.firefox ? null : makeOffscreenJsClient({
    ensureOffscreen: deps.featureHost.ensureOffscreen,
    sendMessage: (message) => hostMessage(message, 'script-job-demand'),
  });
  const docOffscreenClient = deps.firefox ? null : makeOffscreenDocClient({
    ensureOffscreen: deps.featureHost.ensureOffscreen,
    sendMessage: (message) => hostMessage(message, 'document-extract-demand'),
  });
  const webOffscreenClient = deps.firefox ? null : makeOffscreenWebClient({
    ensureOffscreen: deps.featureHost.ensureOffscreen,
    sendMessage: (message) => hostMessage(message, 'web-extract-demand'),
  });
  /** @type {ReturnType<typeof createKernelDwebAgentOwner>|null} */
  let dwebAgentOwner = null;
  /** @type {Promise<ReturnType<typeof makeDwebShare>>|null} */
  let dwebShareReady = null;
  const dwebTransportOn = () => deps.dwebEnabled
    && deps.settingsStore.get().dwebEnabled === true && !deps.vault.isLocked();
  const dwebShare = async () => {
    dwebShareReady ??= (async () => {
      const dweb = await deps.getDwebLive?.();
      if (typeof dweb?.withIdentityMutation !== 'function') {
        throw new Error('dweb identity runtime unavailable');
      }
      return makeDwebShare({
        enabled: deps.dwebEnabled, active: dwebTransportOn,
        withDwebPublication: engine.withDwebPublication,
        withIdentityMutation: dweb.withIdentityMutation,
        withAppLifecycle: engine.withAppLifecycle,
        withAppWriteLock: (id, operation) => engine.appQuiescence.runUnlocked(
          id, () => engine.appClient.withWriteLock(id, operation),
        ),
        appRegistry: engine.appRegistry, repositories: engine.repositories,
        prepareRuntime: async () => {
          await deps.ensureDwebFeature();
          return deps.browser.runtime.sendMessage({ type: 'dweb/base-host/start' });
        },
        sendMessage: (message) => deps.browser.runtime.sendMessage(message),
      });
    })();
    return dwebShareReady;
  };
  const prepareLocalAppShare = async (/** @type {string} */ appId) =>
    (await dwebShare()).prepare(appId);
  const shareLocalApp = async (/** @type {string} */ appId, /** @type {any} */ prepared) =>
    (await dwebShare())(appId, undefined, prepared);
  const withDwebPublication = (/** @type {(current:()=>boolean)=>Promise<any>} */ operation) =>
    engine.withDwebPublication(async (/** @type {()=>boolean} */ current) => {
      if (!current() || !dwebTransportOn()) return { ok: false, error: 'dweb-disabled' };
      await deps.ensureDwebFeature();
      return operation(current);
    });
  const dwebSurface = deps.dwebEnabled ? Object.freeze({
    prepareShare: prepareLocalAppShare,
    share: shareLocalApp,
    discover: async () => {
      if (!dwebTransportOn()) return { ok: false, error: 'dweb-disabled' };
      await deps.ensureDwebFeature();
      return deps.browser.runtime.sendMessage({ type: 'dweb/base-host/heard' });
    },
    install: (/** @type {any} */ { uri, name } = {}) => withDwebPublication((current) => {
      if (!current()) return Promise.resolve({ ok: false, error: 'dweb-disabled' });
      return deps.browser.runtime.sendMessage({
        type: 'dweb/base-host/install-app', uri, name,
        publicationGeneration: engine.dwebPublicationGeneration(),
      });
    }),
    peers: async () => {
      if (!dwebTransportOn()) return { ok: false, error: 'dweb-disabled' };
      await deps.ensureDwebFeature();
      return deps.browser.runtime.sendMessage({ type: 'dweb/base-host/peers' });
    },
    block: (/** @type {any} */ { did, block = true, reason } = {}) =>
      withDwebPublication(async () => {
        if (block && typeof did === 'string') {
          await /** @type {any} */ (dwebAgentOwner)?.revokePeer(did);
        }
        return deps.browser.runtime.sendMessage({
          type: block ? 'dweb/base-host/ban' : 'dweb/base-host/unblock', did, reason,
        });
      }),
    setDiscovery: (/** @type {any} */ { enabled } = {}) => withDwebPublication(() =>
      deps.browser.runtime.sendMessage({ type: 'dweb/base-host/set-discovery', enabled })),
  }) : null;

  const buildToolContext = async (/** @type {any} */ options = {}) => {
    const shared = live.shared;
    await userEndpointsReady;
    const denylistReady = await deps.denylist.ready();
    if (!denylistReady?.ok) throw new Error('sensitive-origin policy unavailable');
    await lifecycleArmed;
    await deps.syncDenylistNetwork?.();
    const sessionId = options.sessionId
      ?? await deps.sessionCache.sessionGet('currentSessionId');
    const session = sessionId ? await shared.sessions.get(sessionId) : null;
    const permission = await resolvePermission(session);
    /** @type {any} */
    let activeTab;
    if (options.activeTabId != null) {
      const tab = await deps.browser.tabs.get(options.activeTabId).catch(() => null);
      if (tab) activeTab = {
        id: tab.id, windowId: tab.windowId, url: tab.url ?? '', origin: originOf(tab.url ?? ''),
      };
    } else if (options.exposure !== ACTOR_EXPOSURE) {
      const [tab] = await deps.browser.tabs.query({ active: true, currentWindow: true });
      if (tab) activeTab = {
        id: tab.id, windowId: tab.windowId, url: tab.url ?? '', origin: originOf(tab.url ?? ''),
      };
    }
    const providerName = session?.provider ?? resolveActiveProvider().name;
    const actorType = options.actorType;
    const actorBacking = options.actorBacking;
    const requestedActorSurface = options.actorSurface
      ?? (actorType === 'app' ? 'code'
        : deps.settingsStore.get().webActorActionSurface === 'code' ? 'code' : 'tools');
    const actorToolSurface = actorType ? await projectToolSurface({
      surface: 'actor', actorType, backing: actorBacking,
      ...(actorType === 'web' && actorBacking !== 'api'
        ? {
          requestedActorSurface,
          headlessAvailable: !deps.firefox,
        }
        : actorType === 'app' ? { actorSurface: requestedActorSurface } : {}),
      toolManifest: session?.toolManifest,
      runtimeCapabilities,
      inbound: options.synthetic === true && options.trusted !== true,
    }) : null;
    const actorSurface = actorToolSurface?.actorSurface
      ?? (actorType === 'app'
        ? (requestedActorSurface === 'code' ? 'code' : 'tools') : undefined);
    /** @type {any} */
    const ctx = {
      actorIsolation: live.actorIsolation,
      runtimeCapabilities,
      exposure: options.exposure ?? null,
      synthetic: options.synthetic === true,
      inbound: options.synthetic === true && options.trusted !== true,
      lifecycle: lifecycleTracker,
      lifecycleOwnerSessionId: sessionId,
      ...(typeof options.lifecycleTurnId === 'string'
        ? { lifecycleTurnId: options.lifecycleTurnId } : {}),
      lifecycleUserInitiated: options.lifecycleUserInitiated === true,
      ...(options.actorInstanceId ? { actorInstanceId: options.actorInstanceId } : {}),
      ...(actorType ? { actorType } : {}),
      ...(actorBacking ? { backing: actorBacking } : {}),
      ...(actorSurface ? { actorSurface } : {}),
      schemaReply: deps.settingsStore.get().schemaValidatedReplies === true,
      ...(actorType === 'web' ? {
        fenceActorSummary: actorBacking === 'api'
          ? (/** @type {string} */ text) => fenceApiActorSummary(text, { origin: options.actorInstanceId })
          : (/** @type {string} */ text) => fenceWebActorSummary(text, {
            tabOrigin: safeWebActorSummaryOrigin(activeTab?.url, deps.denylist.patterns()),
          }),
      } : {}),
      session: {
        sessionId: sessionId ?? null, depth: session?.depth ?? 0,
        kind: session?.kind ?? 'chat',
        messageCount: session?.messages?.length ?? 0,
        trimCovered: session?.trimSummary?.covered ?? 0,
      },
      permission,
      readAuthorityPermission: async () => resolvePermission(
        sessionId ? await shared.sessions.get(sessionId).catch(() => null) : null,
      ),
      activeTab,
      onToolActivity: shared.pageActivity,
      actorAuthority: Object.freeze({
        spawnSync: (/** @type {any} */ request) => live.spawnActor(request),
        spawnAsync: (/** @type {any} */ request) => live.asyncActors.spawnActorAsync(request),
        listTasks: () => live.asyncActors.actorTasks(sessionId),
        cancelTask: (/** @type {string} */ taskId) =>
          live.asyncActors.actorCancel(sessionId, taskId),
        deliverMessage: (/** @type {any} */ request) => live.actorMessaging.messageActor(request),
      }),
      // why: the sealed-code actor client receives only actor messaging; tool
      // semantics remain in the controller and message custody remains here.
      messageActor: (/** @type {any} */ request) => live.actorMessaging.messageActor(request),
      scriptRuns,
      completeGoalRun: sessionId
        ? (/** @type {string} */ summary) => goalRunner?.complete(sessionId, summary) ?? false : undefined,
      scheduleAdd: (/** @type {any} */ request) => live.scheduler?.add(request)
        ?? { ok: false, error: 'schedule_unavailable' },
      scheduleList: () => live.scheduler?.list() ?? [],
      scheduleRemove: (/** @type {string} */ id) => live.scheduler?.remove(id) ?? false,
      todoStore: sessionId && goalRunner?.isActive(sessionId) ? {
        apply: (/** @type {(todos: any) => any} */ fn) => {
          const next = (todoChains.get(sessionId) ?? Promise.resolve()).then(async () => {
            const record = await shared.sessions.get(sessionId);
            const result = fn(record?.todos);
            if (result?.ok && Array.isArray(result.todos)) {
              await shared.sessions.update(sessionId, { todos: result.todos });
            }
            return result;
          });
          todoChains.set(sessionId, next.catch(() => {}));
          return next;
        },
      } : undefined,
      vm: engine.vmClient,
      vmRegistry: engine.vmRegistry,
      vmTabTracker: engine.vmTabTracker,
      jsClient: engine.jsClient,
      jsRegistry: engine.jsRegistry,
      jsTabTracker: engine.jsTabTracker,
      podClient: engine.podClient,
      podRegistry: engine.podRegistry,
      podTabTracker: engine.podTabTracker,
      appClient: engine.appClient,
      appRegistry: engine.appRegistry,
      appTabTracker: engine.appTabTracker,
      appQuiescence: engine.appQuiescence,
      repositories: engine.repositories,
      jsOffscreenClient,
      docOffscreenClient,
      webOffscreenClient,
      resultStore,
      tabs: deps.browser.tabs,
      scripting: deps.browser.scripting,
      debuggerPool: advancedAutomationOn() ? debuggerPool : undefined,
      cdpUnavailableReason: advancedAutomationOn()
        ? null : deps.browser.debugger ? 'setting_off' : 'browser_unsupported',
      domRefs,
      ensureBrowserNetworkGuard: deps.ensureBrowserNetworkGuard,
      browserChildQuarantineRequired: !deps.firefox,
      armBrowserChildQuarantine: deps.armBrowserChildQuarantine,
      updateBrowserNetworkGuardOrigin: deps.updateBrowserNetworkGuardOrigin,
      acquireBrowserNetworkGuardLease: deps.acquireBrowserNetworkGuardLease,
      releaseBrowserNetworkGuardLease: deps.releaseBrowserNetworkGuardLease,
      consumeBrowserChildPolicyNotice: deps.consumeBrowserChildPolicyNotice,
      waitForBrowserChildPolicyNotice: deps.waitForBrowserChildPolicyNotice,
      hasPendingBrowserChildPolicy: deps.hasPendingBrowserChildPolicy,
      noteTab: (/** @type {number} */ tabId, /** @type {any} */ info,
        /** @type {any} */ noteOptions = {}) => live.tabAffordances.noteAgentTab(
        tabId,
        typeof info === 'string'
          ? { ...(info ? { label: info } : {}), opened: noteOptions.opened !== false }
          : info,
      ),
      hintPullIn: (/** @type {number} */ tabId, /** @type {string} */ url) =>
        live.tabAffordances.scheduleWebTabHint(tabId, url),
      ...(actorType === 'web' && actorBacking !== 'api'
        ? { adoptWebTab: () => live.adoptWebTab(sessionId) } : {}),
      noteLearnedOrigin: (/** @type {string} */ origin, /** @type {any} */ reason) =>
        learnedOrigins.note(origin, reason),
      listApiIntegrations: () => live.listApiIntegrations(sessionId),
      safeFetch,
      webFetch,
      settings: { ...deps.settingsStore.get() },
      settingsStore: deps.settingsStore,
      getSecret: (/** @type {string} */ name) => deps.vault.getSecret(name),
      audit: (/** @type {any} */ entry) => deps.auditLog.append(entry),
      confirm: deps.confirmation.confirm,
      memory: shared.memory,
      kv: deps.kv,
      idb: deps.idb,
      skills: skillRegistry,
      siteClients: siteClientStore,
      dweb: dwebTransportOn() ? dwebSurface : null,
      ...(actorType === 'app' && options.actorInstanceId ? {
        appAgentCall: async (/** @type {'observe'|'act'} */ op,
          /** @type {object} */ args, /** @type {AbortSignal|undefined} */ signal) => {
          const ownerRoot = session?.parentSessionId;
          if (!ownerRoot) {
            return {
              ok: false, error: 'app_runtime_owner_unbound', outcomeKnown: true,
              outcomeKind: 'pre-effect-failure',
            };
          }
          const tabId = engine.appTabTracker.getOwnedTabId(
            options.actorInstanceId, ownerRoot,
          );
          if (tabId == null) {
            return {
              ok: false, error: 'app_runtime_tab_not_open_or_wrong_owner', outcomeKnown: true,
              outcomeKind: 'pre-effect-failure',
            };
          }
          try {
            return await relayAppRuntimeCall({
              tabId,
              message: {
                type: 'app/agent-call', appId: options.actorInstanceId, op, args,
              },
              send: deps.browser.tabs.sendMessage.bind(deps.browser.tabs),
              reload: async (ownedTabId) => {
                engine.appTabTracker.markReloading(options.actorInstanceId);
                return deps.browser.tabs.reload(ownedTabId);
              },
              poisoned: poisonedAppRuntimeTabs,
              signal,
            });
          } catch (cause) {
            return {
              ok: false,
              error: `app_runtime_unreachable: ${/** @type {{message?:string}} */ (cause)?.message ?? String(cause)}`,
              outcomeKnown: false, outcomeKind: 'transport-lost',
            };
          }
        },
      } : {}),
      denylist: Object.freeze([...deps.denylist.patterns()]),
      allowlist: Object.freeze([...HARDCODED_ALLOWLIST, ...userEndpoints]),
      provider: {
        name: providerName,
        model: session?.model ?? resolveActiveProvider().model,
        hasKey: await providerCredentialReady(providerName),
      },
      vault: { isLocked: deps.vault.isLocked() },
      now: Date.now,
    };
    if (options.exposure !== ACTOR_EXPOSURE) return ctx;
    // Exact actor operations are selected by the host grant and finite binder;
    // semantic tool names never authorize this in-service-worker context.
    const restricted = ctx;
    if (actorType === 'web' && actorBacking === 'api') {
      const ownedOrigin = normalizeApiOrigin(options.actorInstanceId);
      restricted.canUseSiteClientOrigin = makeFixedSiteClientOriginGuard(ownedOrigin, {
        isKnownIdp: isKnownIdpHost,
      });
      restricted.authorizeSiteClientOrigin = async (/** @type {string} */ origin) =>
        restricted.canUseSiteClientOrigin(origin);
      restricted.webFetch = withSessionScopedCredentials(webFetch, () => ownedOrigin ?? undefined);
    } else if (actorType === 'web') {
      const hasCustody = hasDurableSiteClientState(session?.originState);
      originStates.hydrate(sessionId, session?.originState);
      const lock = live.originLockFor(sessionId);
      restricted.judgeLanding = lock?.judgeLanding;
      restricted.authorizeSignInOrigin = lock?.authorizeSignInOrigin;
      restricted.authorizeSignInExcursion = lock?.authorizeSignInExcursion;
      restricted.revokeSignInExcursion = lock?.revokeSignInExcursion;
      restricted.canUseSiteClientOrigin = hasCustody
        ? lock?.canUseSiteClientOrigin : () => false;
      restricted.authorizeSiteClientOrigin = hasCustody
        ? lock?.authorizeSiteClientOrigin(() => live.liveLandingFor(sessionId))
        : async () => false;
      restricted.webFetch = withSessionScopedCredentials(
        webFetch,
        lock ? lock.makeScope(() => restricted.activeTab?.origin)
          : () => restricted.activeTab?.origin,
      );
      restricted.repinActiveTab = (/** @type {any} */ tab) => { restricted.activeTab = tab; };
      restricted.siteCapture = siteCapture;
    }
    return restricted;
  };

  const uiConnected = () => live?.shared.uiPorts.size > 0;
  const post = (/** @type {any} */ message) => {
    if (uiConnected()) live.shared.uiPorts.broadcast(message);
  };
  const rootSessionIdFor = async (/** @type {string} */ sessionId) => {
    const seen = new Set();
    let cursor = sessionId;
    for (let hops = 0; cursor && hops < 32 && !seen.has(cursor); hops += 1) {
      seen.add(cursor);
      const record = await live.shared.sessions.get(cursor).catch(() => null);
      if (!record?.parentSessionId) return record ? cursor : null;
      cursor = record.parentSessionId;
    }
    return null;
  };
  const dpopKeys = makeDpopKeyStore({
    get: (/** @type {string} */ store, /** @type {string} */ key) => deps.idb.get(store, key),
    put: (/** @type {string} */ store, /** @type {any} */ row) => deps.idb.put(store, row),
    del: (/** @type {string} */ store, /** @type {string} */ key) => deps.idb.del(store, key),
  });
  const getDpopKey = (/** @type {string} */ origin) => getOrCreateDpopKey(origin, {
    ...dpopKeys,
    audit: (/** @type {any} */ event) => deps.auditLog.append(event),
  });
  /** @type {Map<string,Set<string>>} */
  const sessionConfirmGrants = new Map();
  const confirmAction = async (/** @type {any} */ prompt, /** @type {AbortSignal} */ signal) => {
    if (signal?.aborted) return 'no';
    const sessionId = prompt.sessionId ?? null;
    if (prompt.oneShot !== true && prompt.tool === WEB_WRITE_CONFIRM_KEY
        && deps.settingsStore.get().confirmWebWrites === false) return 'yes_once';
    const ephemeral = sessionId
      ? (await live.shared.sessions.get(sessionId).catch(() => null))?.kind === 'actor' : false;
    const answer = await answerWithSessionConfirmGrant({
      prompt, sessionId, ephemeral, grants: sessionConfirmGrants,
      request: async () => {
        const ownerSessionId = sessionId ? await rootSessionIdFor(sessionId) : null;
        return deps.confirmation.confirm({
          ...prompt, ownerSessionId,
          ...(downgradesActorConfirm(prompt.tool, ephemeral, 'yes_session')
            ? { ephemeral: true } : {}),
        }, signal);
      },
    });
    const normalized = downgradesActorConfirm(prompt.tool, ephemeral, answer)
      ? 'yes_once' : answer;
    if (prompt.tool === WEB_WRITE_CONFIRM_KEY
        && (normalized === 'yes_once' || normalized === 'yes_session')) {
      for (const origin of prompt.origins ?? []) learnedOrigins.note(origin, 'confirmed-write');
    }
    return normalized;
  };
  const ensureCurrentSession = async () => {
    let sessionId = await deps.sessionCache.sessionGet('currentSessionId');
    if (sessionId) return sessionId;
    const active = await ensureActiveProvider();
    const permission = await resolvePermission(null);
    const created = await live.shared.sessions.create({
      provider: active.name, model: active.model,
      permissionMode: permission.mode, confirmActions: permission.confirmActions,
    });
    sessionId = created.sessionId;
    await deps.sessionCache.sessionSet('currentSessionId', sessionId);
    return sessionId;
  };
  const handleSystemCommand = async (/** @type {string} */ raw) => {
    if (deps.vault.isLocked()) throw new VaultLockedError();
    const argument = raw.trim();
    let sessionId = await deps.sessionCache.sessionGet('currentSessionId');
    if (!argument) {
      const current = sessionId ? await live.shared.sessions.get(sessionId) : null;
      deps.postChatNote(current?.customSystemPrompt
        ? `Session instructions active (${current.customSystemPrompt.length} chars): ${current.customSystemPrompt}`
        : 'No session instructions set. "/system <text>" sets them for this chat; "/system clear" removes them.');
      return;
    }
    if (/^clear$/i.test(argument)) {
      if (!sessionId) return;
      await live.shared.sessions.setCustomSystemPrompt(sessionId, null);
      await deps.auditLog.append({ type: 'session_instructions_cleared', sessionId });
      await deps.pushState();
      return;
    }
    sessionId = await ensureCurrentSession();
    await live.shared.sessions.setCustomSystemPrompt(sessionId, argument);
    await deps.auditLog.append({
      type: 'session_instructions_set', sessionId, details: { chars: argument.length },
    });
    await deps.pushState();
  };
  const handleToolsCommand = makeToolsCommand({
    sessions: {
      get: (/** @type {string} */ sessionId) => live.shared.sessions.get(sessionId),
      setToolManifest: (/** @type {string} */ sessionId, /** @type {any} */ manifest) =>
        live.shared.sessions.setToolManifest(sessionId, manifest),
    },
    getCurrentSessionId: () => deps.sessionCache.sessionGet('currentSessionId'),
    ensureSession: ensureCurrentSession,
    postNote: deps.postChatNote,
    audit: deps.auditLog.append,
  });

  const registryEntries = () => [
    ['vm', 'webvm', engine.vmRegistry, engine.vmTabTracker],
    ['notebook', 'notebook', engine.jsRegistry, engine.jsTabTracker],
    ['pod', 'pod', engine.podRegistry, engine.podTabTracker],
    ['app', 'app', engine.appRegistry, engine.appTabTracker],
  ];
  const deriveAppOwnerAuthority = async (/** @type {any} */ owner,
    /** @type {any} */ contract) => {
    const permission = await resolvePermission(owner);
    const surface = await projectToolSurface({
      surface: 'actor', actorType: 'app', actorSurface: 'code',
      toolManifest: owner?.toolManifest, runtimeCapabilities, inbound: false,
    });
    const allow = manifestAppActorTools({
      contract,
      hostTools: surface.tools.map((/** @type {any} */ tool) => tool.name),
      ownerAllowed: null,
    });
    return {
      permission,
      toolManifest: { allow },
      digest: await sha256Hex(canonicalAppOwnerAuthority({
        allow,
      })),
    };
  };
  const deriveActorOwnerPosture = async (/** @type {any} */ owner,
    /** @type {{actorType:string,backing?:string,actorSurface?:string}} */ actor) => {
    const permission = await resolvePermission(owner);
    const surface = await projectToolSurface({
      surface: 'actor', actorType: actor.actorType, backing: actor.backing,
      ...(actor.actorType === 'web' && actor.backing !== 'api'
        ? {
          requestedActorSurface: actor.actorSurface
            ?? (deps.settingsStore.get().webActorActionSurface === 'code' ? 'code' : 'tools'),
          headlessAvailable: !deps.firefox,
        }
        : actor.actorSurface ? { actorSurface: actor.actorSurface } : {}),
      toolManifest: owner?.toolManifest, runtimeCapabilities, inbound: false,
    });
    const allow = surface.tools.map((/** @type {any} */ tool) => tool.name);
    return {
      permission,
      digest: await sha256Hex(canonicalActorOwnerPosture({
        allow,
      })),
    };
  };
  const mintActor = async (/** @type {any} */ entry, /** @type {any} */ record,
    /** @type {string} */ ownerSessionId, /** @type {Record<string,any>} */ options = {}) => {
    const owner = await live.shared.sessions.get(ownerSessionId);
    if (!owner || owner.archivedAt) throw new Error('actor-owner-unavailable');
    let permission = await resolvePermission(owner);
    let toolManifest = owner.toolManifest;
    let ownerSemanticPostureDigest;
    let appManifestDigest;
    let appOwnerAuthorityDigest;
    let appRole;
    if (entry[1] === 'app') {
      const contract = options.contract
        ?? parseAppManifest(await engine.appClient.readFile({ appId: record.id, path: 'peerd.json' }));
      const authority = options.ownerAuthority
        ?? await deriveAppOwnerAuthority(owner, contract);
      permission = authority.permission;
      toolManifest = authority.toolManifest;
      appOwnerAuthorityDigest = authority.digest;
      appManifestDigest = options.manifestDigest
        ?? await sha256Hex(canonicalAppActorManifest(contract));
      appRole = makeAppRole({ contract, record, manifestDigest: appManifestDigest });
      ownerSemanticPostureDigest = authority.digest;
    } else {
      ownerSemanticPostureDigest = (await deriveActorOwnerPosture(owner, {
        actorType: entry[1],
        ...(entry[1] === 'web' ? { backing: record.backing ?? 'tab' } : {}),
      })).digest;
    }
    const created = await live.shared.sessions.create({
      kind: 'actor', parentSessionId: ownerSessionId,
      provider: owner.provider, model: owner.model,
      permissionMode: permission.mode, confirmActions: permission.confirmActions,
      depth: (owner.depth ?? 0) + 1,
      actorType: entry[1], instanceId: record.id,
      ...(toolManifest !== undefined ? { toolManifest } : {}),
      ownerSemanticPostureDigest,
      ...(entry[1] === 'web' ? { backing: record.backing ?? 'tab' } : {}),
      ...(entry[1] === 'web' && record.ownedOrigin
        ? { originState: {
          mode: 'bound', ownedOrigin: record.ownedOrigin,
          ...(record.provisionalOrigin ? { provisional: true } : {}),
        } }
        : entry[1] === 'web' && record.backing !== 'api'
          ? { originState: { mode: 'roaming' } } : {}),
      ...(entry[1] === 'app' ? {
        actorSurface: 'code', appManifestDigest, appOwnerAuthorityDigest, appRole,
      } : {}),
    });
    if (entry[2]) {
      await entry[2].setDefaultForSession(created.sessionId, record.id);
      if (options.bindForward !== false) {
        await entry[2].setActorSession(record.id, created.sessionId);
      }
    }
    deps.auditLog.append({
      type: 'actor_minted', sessionId: created.sessionId,
      details: { instanceId: record.id, kind: entry[1] },
    }).catch(() => {});
    if (['webvm', 'notebook', 'app'].includes(entry[1])) {
      await live.prewalk?.armEngineActor(created.sessionId);
    }
    return created.sessionId;
  };
  /** @type {Map<string,Promise<string|null>>} */
  const appActorTails = new Map();
  const retireStale = async (/** @type {string|null|undefined} */ actorSessionId) => {
    if (!actorSessionId) return;
    live.shared.turnSlots.stop(actorSessionId);
    await live.shared.sessions.archive(actorSessionId).catch(() => {});
  };
  const ordinaryActorSessionMatches = async (
    /** @type {any} */ actor, /** @type {string} */ ownerSessionId,
    /** @type {string} */ actorType, /** @type {string} */ instanceId,
    /** @type {string|undefined} */ backing = undefined,
  ) => {
    if (!actor || actor.archivedAt || actor.kind !== 'actor'
        || actor.parentSessionId !== ownerSessionId || actor.actorType !== actorType
        || actor.instanceId !== instanceId
        || backing !== undefined && (actor.backing ?? 'tab') !== backing) return false;
    const owner = await live.shared.sessions.get(ownerSessionId).catch(() => null);
    if (!owner || owner.archivedAt) return false;
    return actor.ownerSemanticPostureDigest === (await deriveActorOwnerPosture(owner, {
      actorType, backing,
      ...(actor.actorSurface ? { actorSurface: actor.actorSurface } : {}),
    })).digest;
  };
  const retireOrdinaryActorForReplacement = async (
    /** @type {string|null|undefined} */ actorSessionId,
  ) => {
    if (!actorSessionId) return undefined;
    const tabId = webActorTabBindings.tabFor(actorSessionId);
    if (typeof tabId === 'number') webActorTabBindings.drop(tabId);
    await retireStale(actorSessionId);
    return tabId;
  };
  const resolveAppActorOwner = async (/** @type {string|null|undefined} */ senderSessionId,
    /** @type {any} */ record) => {
    const explicitOwner = senderSessionId || record?.ownerSessionId;
    if (typeof explicitOwner !== 'string' || !explicitOwner) {
      throw new Error('App has no explicit actor owner; reopen it from a chat');
    }
    const ownerSessionId = await rootSessionIdFor(explicitOwner);
    if (!ownerSessionId) throw new Error('App actor owner session is unavailable');
    return ownerSessionId;
  };
  const ensureAppActorBinding = async (/** @type {string} */ appId,
    /** @type {string|null|undefined} */ senderSessionId) => {
    await bindingReady;
    const ownerRecord = await engine.appRegistry.get(appId);
    if (!ownerRecord) return null;
    const ownerSessionId = await resolveAppActorOwner(senderSessionId, ownerRecord);
    const key = `${ownerSessionId}\0${appId}`;
    const previous = appActorTails.get(key) ?? Promise.resolve(null);
    const operation = previous.catch(() => null).then(async () => {
      const record = await engine.appRegistry.get(appId);
      if (!record) return null;
      const contract = parseAppManifest(
        await engine.appClient.readFile({ appId, path: 'peerd.json' }),
      );
      const manifestDigest = await sha256Hex(canonicalAppActorManifest(contract));
      const role = makeAppRole({ contract, record, manifestDigest });
      const owner = await live.shared.sessions.get(ownerSessionId);
      if (!owner || owner.archivedAt) throw new Error('App actor owner session is unavailable');
      const ownerAuthority = await deriveAppOwnerAuthority(owner, contract);
      const expected = {
        ownerChatId: ownerSessionId, appId, manifestDigest,
        ownerAuthorityDigest: ownerAuthority.digest,
        publisherSource: role.source, publisher: role.publisher,
      };
      let actorSessionId = appActorBindings.resolve(ownerSessionId, appId);
      let actor = actorSessionId
        ? await live.shared.sessions.get(actorSessionId).catch(() => null) : null;
      if (actorSessionId && !appActorSessionMatches(actor, expected)) {
        appActorBindings.drop(ownerSessionId, appId);
        await persistAppActors();
        await retireStale(actorSessionId);
        actorSessionId = null;
      }
      for (let attempt = 0; !actorSessionId && attempt < 8; attempt += 1) {
        const durable = await live.shared.sessions.findActorSession({
          parentSessionId: ownerSessionId, instanceId: appId, actorType: 'app',
        });
        if (!durable) break;
        actor = await live.shared.sessions.get(durable).catch(() => null);
        if (appActorSessionMatches(actor, expected)) {
          actorSessionId = durable;
          break;
        }
        await retireStale(durable);
      }
      if (!actorSessionId) {
        actorSessionId = await mintActor(
          ['app', 'app', engine.appRegistry, engine.appTabTracker], record, ownerSessionId, {
            contract, manifestDigest, ownerAuthority, bindForward: false,
          });
      }
      if (!appActorBindings.resolve(ownerSessionId, appId)) {
        if (!actorSessionId) throw new Error('app-actor-mint-failed');
        appActorBindings.bind(ownerSessionId, appId, actorSessionId);
        await persistAppActors();
      }
      return actorSessionId;
    });
    appActorTails.set(key, operation);
    return operation.finally(() => {
      if (appActorTails.get(key) === operation) appActorTails.delete(key);
    });
  };
  const retireAppActors = async (/** @type {string} */ appId) => {
    await bindingReady;
    const retirements = [];
    for (const [key, actorSessionId] of appActorBindings.entries()) {
      const gap = key.indexOf('\0');
      if (gap < 0 || key.slice(gap + 1) !== appId) continue;
      appActorBindings.drop(key.slice(0, gap), appId);
      retirements.push(retireStale(actorSessionId));
    }
    await persistAppActors();
    await Promise.all(retirements);
  };
  const validateGeneration = async (/** @type {any} */ actor) => {
    if (!actor?.sessionId || !actor?.parentSessionId || !actor?.instanceId) return false;
    await bindingReady;
    const record = await engine.appRegistry.get(actor.instanceId);
    const owner = await live.shared.sessions.get(actor.parentSessionId);
    if (!record || !owner || owner.archivedAt) return false;
    const contract = parseAppManifest(await engine.appClient.readFile({
      appId: actor.instanceId, path: 'peerd.json',
    }));
    const manifestDigest = await sha256Hex(canonicalAppActorManifest(contract));
    const role = makeAppRole({ contract, record, manifestDigest });
    const ownerAuthority = await deriveAppOwnerAuthority(owner, contract);
    return appActorBindings.resolve(actor.parentSessionId, actor.instanceId) === actor.sessionId
      && appActorSessionMatches(actor, {
        ownerChatId: actor.parentSessionId, appId: actor.instanceId, manifestDigest,
        ownerAuthorityDigest: ownerAuthority.digest,
        publisherSource: role.source, publisher: role.publisher,
      });
  };
  const validateBoundActorGeneration = async (/** @type {any} */ actor) => {
    if (actor?.actorType === 'dweb') return true;
    if (actor?.actorType === 'app') return validateGeneration(actor);
    if (typeof actor?.parentSessionId !== 'string'
        || typeof actor?.actorType !== 'string'
        || typeof actor?.instanceId !== 'string') return false;
    return ordinaryActorSessionMatches(
      actor, actor.parentSessionId, actor.actorType, actor.instanceId,
      actor.actorType === 'web' ? actor.backing ?? 'tab' : undefined,
    );
  };
  const resolveActor = async (/** @type {string} */ requested,
    /** @type {{senderSessionId?:string|null}} */ options = {}) => {
    await bindingReady;
    if (requested === 'dweb') {
      if (!deps.dwebEnabled || deps.settingsStore.get().dwebEnabled !== true
          || deps.settingsStore.get().dwebAgentEnabled !== true) return null;
      await dwebActorReady;
      let actorSessionId = dwebActorSessionId;
      if (actorSessionId && !await live.shared.sessions.get(actorSessionId)) {
        actorSessionId = null;
      }
      actorSessionId ??= await live.shared.sessions.findActorSession({
        instanceId: 'dweb', actorType: 'dweb',
      });
      if (!actorSessionId) {
        const active = await ensureActiveProvider();
        const created = await live.shared.sessions.create({
          kind: 'actor', provider: active.name, model: active.model,
          permissionMode: PERMISSION_MODES.ACT, confirmActions: false,
          depth: 0, actorType: 'dweb', instanceId: 'dweb',
        });
        actorSessionId = created.sessionId;
      }
      dwebActorSessionId = actorSessionId;
      await deps.sessionCache.sessionSet('dwebActorBinding', actorSessionId);
      return { instanceId: 'dweb', kind: 'dweb', actorSessionId };
    }
    const senderSessionId = options.senderSessionId
      ?? await deps.sessionCache.sessionGet('currentSessionId');
    if (!senderSessionId) return null;
    const ownerSessionId = await rootSessionIdFor(senderSessionId);
    if (!ownerSessionId) return null;
    if (requested === 'web') {
      let actorSessionId = webActorRegistry.resolve(ownerSessionId);
      let actor = actorSessionId
        ? await live.shared.sessions.get(actorSessionId).catch(() => null) : null;
      let retainedTabId;
      if (actorSessionId && !await ordinaryActorSessionMatches(
        actor, ownerSessionId, 'web', 'web', 'tab',
      )) {
        webActorRegistry.drop(ownerSessionId);
        retainedTabId = await retireOrdinaryActorForReplacement(actorSessionId);
        actorSessionId = null;
        actor = null;
        await Promise.all([persistWebActors(), persistWebBindings()]);
      }
      if (!actorSessionId) {
        actorSessionId = await mintActor(
          ['web', 'web', null, null], { id: 'web', backing: 'tab' }, ownerSessionId,
        );
        if (!actorSessionId) throw new Error('web-actor-mint-failed');
        webActorRegistry.bind(ownerSessionId, actorSessionId);
        if (typeof retainedTabId === 'number') {
          webActorTabBindings.bind(retainedTabId, actorSessionId);
        }
        await Promise.all([persistWebActors(), persistWebBindings()]);
      }
      const boundActorSessionId = /** @type {string} */ (actorSessionId);
      return { instanceId: 'web', kind: 'web', actorSessionId: boundActorSessionId,
        tabId: webActorTabBindings.tabFor(boundActorSessionId) };
    }
    if (/^\d+$/.test(requested)) {
      const tabId = Number(requested);
      const tab = await deps.browser.tabs.get(tabId).catch(() => null);
      if (!tab || !isAddressableBrowserTab(tab.url)) return null;
      let hostname = '';
      try { hostname = new URL(tab.url).hostname; } catch { return null; }
      if (matchesDenylist(hostname, deps.denylist.patterns())) return null;
      const authority = await numericTabAuthorityFor(tab.url);
      if (!authority.allowed) {
        deps.auditLog.append({
          type: 'actor_tab_authority_refused',
          details: {
            code: authority.code,
            ...(authority.origin ? { origin: authority.origin } : {}),
            ...(authority.reason ? { reason: authority.reason } : {}),
            performed: false,
          },
        }).catch(() => {});
        return { resolutionRefusal: numericTabAuthorityRefusal(authority) };
      }
      let actorSessionId = webActorTabBindings.resolve(tabId);
      if (actorSessionId) {
        const current = await live.shared.sessions.get(actorSessionId).catch(() => null);
        if (!await ordinaryActorSessionMatches(
          current, ownerSessionId, 'web', requested, 'tab',
        ) || current?.originState?.ownedOrigin !== authority.origin) {
          webActorTabBindings.drop(tabId);
          await persistWebBindings();
          if (current) await retireStale(actorSessionId);
          actorSessionId = null;
        }
      }
      if (!actorSessionId) {
        actorSessionId = await mintActor(
          ['web', 'web', null, null], {
            id: requested, backing: 'tab', ownedOrigin: authority.origin,
          }, ownerSessionId,
        );
        if (!actorSessionId) throw new Error('tab-actor-mint-failed');
        webActorTabBindings.bind(tabId, actorSessionId);
        await persistWebBindings();
      }
      return { instanceId: requested, kind: 'web', actorSessionId, tabId };
    }
    const siteOrigin = parseSiteHandle(requested);
    const apiOrigin = siteOrigin ?? normalizeApiOrigin(requested);
    if (apiOrigin && !isKnownIdpHost(apiOrigin)) {
      const bindings = siteOrigin ? siteActorBindings : apiActorBindings;
      const persist = siteOrigin ? persistSiteActors : persistApiActors;
      const expectedInstanceId = siteOrigin ? siteHandleFor(apiOrigin) : apiOrigin;
      const expectedBacking = siteOrigin ? 'tab' : 'api';
      let actorSessionId = bindings.resolve(ownerSessionId, apiOrigin);
      let actor = actorSessionId
        ? await live.shared.sessions.get(actorSessionId).catch(() => null) : null;
      let retainedTabId;
      if (actorSessionId && !await ordinaryActorSessionMatches(
        actor, ownerSessionId, 'web', expectedInstanceId, expectedBacking,
      )) {
        bindings.drop(ownerSessionId, apiOrigin);
        await persist();
        originStates.forget(actorSessionId);
        retainedTabId = await retireOrdinaryActorForReplacement(actorSessionId);
        await persistWebBindings();
        actorSessionId = null;
        actor = null;
      }
      if (!actorSessionId) {
        actorSessionId = await live.shared.sessions.findActorSession({
          parentSessionId: ownerSessionId,
          instanceId: expectedInstanceId,
          actorType: 'web',
          ...(siteOrigin ? {} : { backing: 'api' }),
        });
        if (actorSessionId) {
          actor = await live.shared.sessions.get(actorSessionId).catch(() => null);
          if (await ordinaryActorSessionMatches(
            actor, ownerSessionId, 'web', expectedInstanceId, expectedBacking,
          )) {
            bindings.bind(ownerSessionId, apiOrigin, actorSessionId);
            await persist();
          } else {
            await retireOrdinaryActorForReplacement(actorSessionId);
            actorSessionId = null;
          }
        }
      }
      if (!actorSessionId) {
        actorSessionId = await mintActor(
          ['web', 'web', null, null],
          siteOrigin
            ? {
              id: siteHandleFor(apiOrigin), backing: 'tab',
              ownedOrigin: apiOrigin, provisionalOrigin: true,
            }
            : { id: apiOrigin, backing: 'api' },
          ownerSessionId,
        );
        if (!actorSessionId) throw new Error('origin-actor-mint-failed');
        bindings.bind(ownerSessionId, apiOrigin, actorSessionId);
        if (typeof retainedTabId === 'number' && siteOrigin) {
          webActorTabBindings.bind(retainedTabId, actorSessionId);
          await persistWebBindings();
        }
        await persist();
      }
      let tabId = siteOrigin ? webActorTabBindings.tabFor(actorSessionId) : undefined;
      if (typeof tabId === 'number'
          && !await deps.browser.tabs.get(tabId).catch(() => null)) {
        webActorTabBindings.drop(tabId);
        await persistWebBindings();
        tabId = undefined;
      }
      return {
        instanceId: siteOrigin ? siteHandleFor(apiOrigin) : apiOrigin,
        kind: 'web', actorSessionId,
        ...(typeof tabId === 'number' ? { tabId } : {}),
      };
    }
    for (const entry of registryEntries()) {
      const record = await entry[2].get(requested);
      if (!record) continue;
      if (entry[1] === 'app') {
        const actorSessionId = await ensureAppActorBinding(requested, ownerSessionId);
        return actorSessionId ? { instanceId: requested, kind: 'app', actorSessionId } : null;
      }
      let actorSessionId = await entry[2].getActorSession(requested);
      if (actorSessionId) {
        const actor = await live.shared.sessions.get(actorSessionId).catch(() => null);
        if (!await ordinaryActorSessionMatches(
          actor, ownerSessionId, entry[1], requested,
        )) {
          await retireOrdinaryActorForReplacement(actorSessionId);
          actorSessionId = null;
        }
      }
      if (!actorSessionId) {
        actorSessionId = await mintActor(entry, record, ownerSessionId);
        await entry[2].setActorSession(requested, actorSessionId);
      }
      return { instanceId: requested, kind: entry[1], actorSessionId, name: record.name };
    }
    return null;
  };

  const forwardSpawnedEvent = (/** @type {any} */ event) => {
    const topology = projection.foldSpawned(event);
    if (topology) {
      post(topology);
      return;
    }
    const rootSessionId = projection.rootForSpawned(event.sessionId);
    const base = { rootSessionId, sessionId: event.sessionId };
    if (event.type === 'delta') {
      post({ type: 'turn/spawned-delta', ...base, messageId: event.messageId, text: event.text });
    } else if (event.type === 'tool-use') {
      post({
        type: 'turn/spawned-tool-use', ...base, messageId: event.messageId,
        toolUseId: event.toolUseId, name: event.name, input: event.input,
      });
    } else if (event.type === 'tool-result') {
      post({
        type: 'turn/spawned-tool-result', ...base,
        toolUseId: event.toolUseId, result: event.result,
      });
    } else if (event.type === 'stop') {
      post({
        type: 'turn/spawned-stop', ...base,
        messageId: event.messageId, stopReason: event.stopReason,
      });
    } else if (event.type === 'error') {
      post({
        type: 'turn/spawned-error', ...base,
        messageId: event.messageId, error: event.error,
      });
    } else if (event.type === 'usage') {
      post({ type: 'turn/spawned-cost', ...base, usage: event.usage });
    }
  };
  /** @type {Record<string,any>|null} */
  let actorOverviewRoutes = null;
  const actorCount = async () => {
    const routes = /** @type {any} */ (actorOverviewRoutes);
    return routes ? routes['actors/count']({}, null)
      : { activeActors: projection.activeActorCount() };
  };
  const actorOverview = async () => {
    const routes = /** @type {any} */ (actorOverviewRoutes);
    return routes ? routes['actors/overview']({}, null) : { roots: [] };
  };

  /** @type {any} */
  let actorClient = null;
  /** @type {any} */
  let directActorHost = null;
  let mailboxChain = Promise.resolve();
  const mailboxUpdate = (/** @type {(mailbox:Record<string,any>)=>Record<string,any>} */ update) => {
    const operation = mailboxChain.catch(() => undefined).then(async () => {
      const stored = await deps.sessionCache.sessionGet('actorMailbox');
      const mailbox = stored && typeof stored === 'object' && !Array.isArray(stored)
        ? stored : {};
      await deps.sessionCache.sessionSet('actorMailbox', update(mailbox));
    });
    mailboxChain = operation.catch((cause) => {
      console.warn('[actor] mailbox persist failed: request not run', cause);
    });
    return operation;
  };
  const actorMailbox = {
    append: (/** @type {{id:string}} */ entry) =>
      mailboxUpdate((mailbox) => ({ ...mailbox, [entry.id]: entry })),
    markStarted: (/** @type {string} */ id) => mailboxUpdate((mailbox) => {
      const entry = mailbox[id];
      if (!entry || typeof entry !== 'object'
          || entry.state !== undefined && entry.state !== 'queued') {
        throw new Error('actor mailbox entry is missing or not queued');
      }
      return { ...mailbox, [id]: { ...entry, state: 'started', startedAt: Date.now() } };
    }),
    remove: (/** @type {string} */ id) => mailboxUpdate((mailbox) => {
      const next = { ...mailbox };
      delete next[id];
      return next;
    }),
    load: async () => {
      const stored = await deps.sessionCache.sessionGet('actorMailbox');
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return [];
      return Object.entries(stored).map(([id, entry]) =>
        entry && typeof entry === 'object' ? { ...entry, id: entry.id ?? id } : { id });
    },
  };
  const siteClientInjected = new Set();
  const siteClientCustodyFor = async (/** @type {string} */ actorSessionId,
    /** @type {string} */ instanceId, /** @type {number|undefined} */ actorTabId) => {
    const record = await live.shared.sessions.get(actorSessionId).catch(() => null);
    if (!record) return null;
    if (record.backing === 'api') {
      const origin = normalizeApiOrigin(record.instanceId ?? instanceId);
      const authorize = makeFixedSiteClientOriginGuard(origin, { isKnownIdp: isKnownIdpHost });
      return origin && authorize(origin) ? { origin, authorize: async () => authorize(origin) } : null;
    }
    if (record.backing !== undefined && record.backing !== 'tab'
        || !hasDurableSiteClientState(record.originState)) return null;
    originStates.hydrate(actorSessionId, record.originState);
    const lock = live.originLockFor(actorSessionId);
    if (!lock) return null;
    const getLanding = async () => {
      const tabId = actorTabId ?? webActorTabBindings.tabFor(actorSessionId);
      if (typeof tabId !== 'number') return { status: 'missing' };
      const tab = await deps.browser.tabs.get(tabId).catch(() => null);
      return tab?.url ? { status: 'live', url: tab.url } : { status: 'missing' };
    };
    const authorize = lock.authorizeSiteClientOrigin(getLanding);
    let origin = record.originState?.mode === 'bound'
      ? normalizeApiOrigin(record.originState.ownedOrigin) : null;
    if (!origin && record.originState?.mode === 'roaming') {
      const landing = await getLanding();
      if (landing.status === 'live') origin = normalizeApiOrigin(landing.url);
    }
    return origin && await authorize(origin) === true ? { origin, authorize: () => authorize(origin) } : null;
  };
  const runActorTurn = async (/** @type {any} */ request) => {
    await live.actorIsolationReady;
    const {
      actorSessionId, message, instanceId, kind, actorTabId,
      oneShot, turnLease, inbound, correlationId, parentToolUseId,
      parentSessionId, rootSessionId, name, actorSurface: latchedActorSurface,
    } = request;
    if (!actorClient || !actorIsolationAvailable(live.actorIsolation)) {
      turnLease?.release?.();
      const refusal = actorIsolationRefusal(live.actorIsolation);
      return { result: refusal.error, stopped: true, isolationFailure: refusal };
    }
    let record = await live.shared.sessions.get(actorSessionId);
    if (!record) {
      turnLease?.release?.();
      return { result: 'the actor session no longer exists.', stopped: true };
    }
    // why: resolution and execution are separate awaits. A /tools or Plan/Act
    // change in that gap must retire the old model surface before its Worker is
    // allowed to issue another call; the next address resolution mints a fresh
    // generation with the current owner posture.
    if (!await validateBoundActorGeneration(record)) {
      turnLease?.release?.();
      await retireStale(actorSessionId);
      return {
        result: 'the actor owner policy changed; retry to start a fresh actor generation.',
        stopped: true, performed: false, outcomeKnown: true,
      };
    }
    const { controller, release } = turnLease ?? live.shared.turnSlots.claim(actorSessionId);
    landingStopReports.delete(actorSessionId);
    landingStopCards.delete(actorSessionId);
    landingTurnSequence += 1;
    landingTurnTokens.set(actorSessionId, landingTurnSequence);
    await originStates.serialize(actorSessionId, () => undefined);
    const withLandingStop = (/** @type {any} */ reply) => {
      const report = landingStopReports.get(actorSessionId);
      if (!report) return reply;
      const card = landingStopCards.get(actorSessionId);
      landingStopReports.delete(actorSessionId);
      landingStopCards.delete(actorSessionId);
      return { result: report, stopped: true, ...(card ? { landingStop: card } : {}) };
    };
    try {
      record = await live.prewalk.reconcileEngineActor(record);
      let deliveredMessage = message;
      if (kind === 'web' && !siteClientInjected.has(actorSessionId)) {
        try {
          const custody = await siteClientCustodyFor(actorSessionId, instanceId, actorTabId);
          if (custody) {
            const meta = await siteClientStore.getMeta(custody.origin).catch(() => null);
            if (meta && await custody.authorize() === true) {
              siteClientInjected.add(actorSessionId);
              deliveredMessage = `${buildMintInjection(meta)}\n\n---\n\n${message}`;
            }
          }
        } catch { /* dossier injection is optional and never widens custody */ }
      }
      let preflightReply;
      if (kind === 'web' && record.backing !== 'api') {
        originStates.hydrate(actorSessionId, record.originState);
        const lock = live.originLockFor(actorSessionId);
        try {
          const landing = await live.liveLandingFor(actorSessionId);
          const state = originStates.read(actorSessionId);
          const verdict = landing.status === 'live'
            ? await lock?.judgeLanding(landing.url)
            : state?.authGrant != null || state?.excursion != null
              ? await lock?.terminateUnreadableSignIn() : null;
          if (verdict?.action === 'wait') preflightReply = AUTH_WAITING_FOR_USER_MESSAGE;
          else if (verdict && verdict.action !== 'continue') {
            preflightReply = AUTH_BOUNDARY_STOPPED_MESSAGE;
          }
        } catch (cause) {
          if (/** @type {{name?:string}} */ (cause)?.name === 'AbortError') throw cause;
          preflightReply = AUTH_STATE_UNAVAILABLE_MESSAGE;
        }
      }
      const requestedContributorSurface = deps.settingsStore.get().webActorActionSurface === 'code'
        ? 'code' : 'tools';
      let toolSurface = null;
      let actorSurface = latchedActorSurface ?? record.actorSurface;
      if (!actorSurface && kind === 'web' && record.backing !== 'api') {
        toolSurface = await projectToolSurface({
          surface: 'actor', actorType: kind, backing: record.backing,
          requestedActorSurface: requestedContributorSurface,
          headlessAvailable: !deps.firefox,
          toolManifest: record.toolManifest, runtimeCapabilities,
          inbound: inbound === true,
        });
        actorSurface = toolSurface.actorSurface;
      }
      const contributorStartedAt = Date.now();
      const contributorDecision = kind === 'web' && record.backing === 'tab'
        ? Object.freeze({
          requested: requestedContributorSurface,
          resolved: actorSurface === 'code' ? 'code' : 'tools',
          fallback: requestedContributorSurface === (actorSurface === 'code' ? 'code' : 'tools')
            ? 'none' : toolSurface?.actorSurfaceFallback
              ?? (deps.firefox ? 'worker_unavailable' : 'capability_grant_incomplete'),
        }) : null;
      const contributorArm = contributorDecision && deps.contributor?.arm
        ? await deps.contributor.arm().catch(() => ({ enabled: false, generation: null }))
        : null;
      const finishContributor = async (/** @type {any} */ reply,
        /** @type {any} */ execution) => {
        const finalReply = withLandingStop(reply);
        if (!contributorDecision || contributorArm?.enabled !== true
            || typeof deps.contributor?.recordWebSettlement !== 'function') return finalReply;
        const projected = execution?.contributor;
        if (!projected || !Array.isArray(projected.actions)) return finalReply;
        try {
          const tally = normalizeTally(execution?.usage);
          const terminal = finalReply.aborted === true
            ? { outcome: 'cancelled', failure: 'none' }
            : finalReply.landingStop
              ? { outcome: 'error', failure: 'policy' }
              : finalReply.persistenceFailure
                ? { outcome: 'error', failure: 'internal' }
                : { outcome: projected.outcome, failure: projected.failure };
          await deps.contributor.recordWebSettlement({
            version: 1,
            consentGeneration: contributorArm.generation,
            operationKey: correlationId,
            feedbackContextKey: typeof parentSessionId === 'string'
                && typeof parentToolUseId === 'string'
              ? `${parentSessionId}:${parentToolUseId}` : null,
            decision: contributorDecision,
            browser: deps.firefox ? 'firefox' : 'chrome',
            extensionVersion: deps.browser.runtime.getManifest().version,
            channel: deps.channel,
            providerCode: projected.providerCode,
            modelFamilyCode: projected.modelFamilyCode,
            durationMs: Math.min(1_000_000_000, Date.now() - contributorStartedAt),
            tokens: Math.min(1_000_000_000, tally.inputTokens + tally.outputTokens
              + tally.cacheReadTokens + tally.cacheWriteTokens),
            outcome: terminal.outcome,
            failure: terminal.failure,
            actions: projected.actions,
          });
        } catch {
          // why: the failure may originate beside raw turn identifiers. The
          // contribution path logs only its closed category, never the cause.
          console.warn('[contributor] local settlement skipped');
        }
        return finalReply;
      };
      toolSurface ??= await projectToolSurface({
        surface: 'actor', actorType: kind,
        backing: record.backing,
        actorSurface,
        toolManifest: record.toolManifest,
        runtimeCapabilities,
        inbound: inbound === true,
      });
      const tools = toolSurface.tools;
      const programSurfaceName = actorSurface === 'code'
        ? tools.some((tool) => tool.name === 'page_code')
          ? 'page-program'
          : tools.some((tool) => tool.name === 'app_code') ? 'app-program' : null
        : null;
      const programSurface = programSurfaceName
        ? await projectToolSurface({ surface: programSurfaceName })
        : { tools: Object.freeze([]), operations: Object.freeze([]) };
      const systemPrompt = await deps.seams.renderSystemPrompt({
        actorType: kind, backing: record.backing, instanceId, actorSurface,
        schemaReply: deps.settingsStore.get().schemaValidatedReplies === true,
        temporalNowMs: Date.now(),
        customSystemPrompt: record.customSystemPrompt,
        appRole: record.appRole,
        effectiveTools: tools.map((tool) => tool.name),
        inbound: inbound === true,
      });
      const reasoningEnabled = deps.settingsStore.get().reasoningEnabled === true;
      const reasoningEffort = deps.settingsStore.get().reasoningEffort;
      const display = parentToolUseId ? {
        parentToolUseId, parentSessionId, rootSessionId,
        actorCorrelationId: correlationId, kind, instanceId, name, task: message,
      } : null;
      if (parentToolUseId) {
        const tabId = kind === 'web'
          ? actorTabId ?? webActorTabBindings.tabFor(actorSessionId)
          : registryEntries().find((entry) => entry[1] === kind)?.[3].getTabId(instanceId);
        if (typeof tabId === 'number') live.tabAffordances.setTabAnchor(tabId, parentToolUseId);
      }
      const fromIndex = (record.messages ?? []).length;
      if (display) {
        projection.startBound({
          ...display, sessionId: actorSessionId, fromIndex,
          visibleTools: tools.map((tool) => tool.name),
          messages: [], streaming: true, error: null, cost: null,
        });
        post({
          type: 'turn/actor-start', ...display, sessionId: actorSessionId, fromIndex,
          actorProjectionEpoch: projection.epoch(),
          actorProjectionRevision: projection.revision(),
          visibleTools: tools.map((tool) => tool.name),
          messages: [], streaming: true, error: null, cost: null,
        });
      }
      const onEvent = display ? (/** @type {any} */ event) => {
        if (event.type === 'state') {
          const messages = Array.isArray(event.session?.messages)
            ? event.session.messages.slice(fromIndex) : [];
          if (projection.patchBound(display, { messages })) {
            post({
              type: 'turn/actor-state', ...display,
              actorProjectionEpoch: projection.epoch(),
              actorProjectionRevision: projection.revision(),
              session: event.session, fromIndex,
              visibleTools: tools.map((tool) => tool.name),
            });
          }
        } else if (event.type === 'error'
            && projection.patchBound(display, { error: event.error, streaming: false })) {
          post({
            type: 'turn/actor-error', ...display,
            actorProjectionEpoch: projection.epoch(),
            actorProjectionRevision: projection.revision(), error: event.error,
          });
        }
      } : undefined;
      const userHookRecords = await deps.kv.get('hooks.user.v1')
        .then(projectSemanticHookManifest)
        .catch(() => HOOK_RECORDS_UNAVAILABLE);
      const tabOrigin = kind === 'web' && record.backing !== 'api' && actorTabId != null
        ? safeWebActorSummaryOrigin(
          (await deps.browser.tabs.get(actorTabId).catch(() => null))?.url,
          deps.denylist.patterns(),
        ) : undefined;
      const job = {
        actorSessionId, message: deliveredMessage, systemPrompt,
        provider: record.provider, model: record.model, depth: record.depth,
        ollamaHost: deps.settingsStore.get().ollamaHost,
        tools,
        allowedOperations: toolSurface.operations,
        programTools: programSurface.tools,
        programOperations: programSurface.operations,
        priorMessages: record.messages ?? [],
        ...(record.trimSummary && typeof record.trimSummary === 'object'
          ? { trimSummary: record.trimSummary } : {}),
        reasoningEnabled, reasoningEffort,
        contextWindowOverrides: deps.settingsStore.get().contextWindowOverrides,
        pricingOverrides: deps.settingsStore.get().pricingOverrides,
        runtimeCapabilities,
        oneShot: oneShot === true,
        actorType: kind, instanceId, backing: record.backing, inbound: inbound === true,
        semanticPolicy: {
          exposure: 'actor',
          permission: await resolvePermission(record),
          denylist: deps.denylist.patterns(),
          allowlist: Object.freeze([...HARDCODED_ALLOWLIST, ...userEndpoints]),
          userHookRecords,
          backing: record.backing,
          ...(typeof actorTabId === 'number'
            ? { activeTab: { id: actorTabId, origin: tabOrigin } }
            : {}),
        },
        ...(actorSurface ? { actorSurface } : {}),
        ...(kind === 'web' && record.backing === 'api' ? { origin: instanceId } : {}),
        ...(kind === 'web' && record.backing !== 'api' && actorTabId != null
          ? { tabOrigin }
          : {}),
        ...(preflightReply ? { preflightReply } : {}),
      };
      const result = await live.runActorIsolated(job, { signal: controller.signal, onEvent });
      if (!(result.ok || result.started)) {
        const error = result.error ?? 'the isolated actor worker did not start';
        if (display && projection.patchBound(display, { error, streaming: false })) {
          post({ type: 'turn/actor-error', ...display, error });
          post({
            type: 'turn/actor-done', ...display,
            sessionId: actorSessionId, ok: false, aborted: false,
          });
        }
        return withLandingStop({
          result: error,
          stopped: true, isolationFailure: result,
        });
      }
      const newMessages = Array.isArray(result.newMessages) ? result.newMessages : [];
      let persisted = true;
      for (const entry of newMessages) {
        await live.shared.sessions.appendMessage(actorSessionId, entry)
          .catch(() => { persisted = false; });
      }
      if (result.usage) {
        const price = result.price;
        if (!price || typeof price.cost !== 'number' || !Number.isFinite(price.cost)
            || price.cost < 0 || typeof price.estimated !== 'boolean') {
          throw new TypeError('actor usage price projection invalid');
        }
        await foldSessionCost(actorSessionId, result.usage, price?.cost ?? 0).catch(() => {});
        if (display && projection.patchBound(display, { cost: price })) {
          post({
            type: 'turn/actor-cost', ...display, cost: price, usage: result.usage,
          });
        }
      }
      const turnSnapshot = {
        messages: [...(record.messages ?? []), ...newMessages],
        usage: { ...normalizeTally(result.usage) },
      };
      if (!persisted) return await finishContributor({
        result: 'the actor ran, but its response could not be saved reliably; the outcome is unknown.',
        stopped: true, executionFailed: true, outcomeKnown: false,
        persistenceFailure: { performed: true, outcomeKnown: false, retryable: false },
        turnSnapshot,
      }, result);
      const reply = finalActorTurnReply(/** @type {any} */ ({ messages: newMessages }));
      const terminalError = [...newMessages].reverse()
        .find((entry) => entry?.role === 'assistant' && typeof entry?.error === 'string')?.error
        ?? (result.ok || result.aborted ? null
          : result.error ?? 'the isolated actor turn failed before it produced a reply');
      const outcomeKnown = terminalError == null || result.outcomeKnown === true;
      if (display) {
        const current = terminalError
          ? projection.patchBound(display, {
            error: terminalError, outcomeKnown, streaming: false,
          }) : projection.patchBound(display, {});
        if (current) {
          if (terminalError) post({
            type: 'turn/actor-error', ...display, error: terminalError, outcomeKnown,
          });
          post({
            type: 'turn/actor-done', ...display, sessionId: actorSessionId,
            ok: terminalError == null && !result.aborted, aborted: result.aborted === true,
          });
        }
      }
      if (terminalError) return await finishContributor({
        result: terminalError, stopped: true, executionFailed: true,
        outcomeKnown, executionFailure: result, turnSnapshot,
      }, result);
      if (result.aborted) return await finishContributor({
        ...reply, stopped: true, aborted: true, turnSnapshot,
      }, result);
      if (!result.ok) return await finishContributor({
        result: result.error ?? reply.result, stopped: true,
        executionFailed: true, outcomeKnown: result.outcomeKnown === true,
        turnSnapshot,
      }, result);
      return await finishContributor({ ...reply, turnSnapshot }, result);
    } finally {
      projection.finishBound(parentToolUseId ? {
        parentToolUseId, rootSessionId, actorCorrelationId: correlationId,
      } : null);
      release();
      const tabId = webActorTabBindings.tabFor(actorSessionId);
      if (typeof tabId === 'number') live.shared.pageActivity.idle(tabId).catch(() => {});
    }
  };

  const makeActorRuntime = async (/** @type {Record<string,any>} */ shared) => {
    const allToolDescriptors = await projectToolDescriptors({ surface: 'all' });
    const toolDescriptorsByName = new Map(allToolDescriptors.map((tool) => [tool.name, tool]));
    const baseActorIsolation = actorIsolationCapability({
      offscreenWorker: !deps.firefox,
      backgroundPageWorker: deps.firefox && typeof globalThis.Worker === 'function',
    });
    const isolationState = deps.browser.storage?.local
      ? makeActorIsolationStateStore({
        storage: deps.browser.storage.local, protocol: ACTOR_WORKER_PROTOCOL,
      }) : null;
    const loadingIsolation = actorIsolationAvailable(baseActorIsolation)
      ? {
        status: /** @type {const} */ ('temporarily_unavailable'),
        host: baseActorIsolation.host,
        reason: 'Actor isolation state is loading.', retryable: true,
      } : baseActorIsolation;
    /** @type {Map<string, Set<(...args:any[])=>void>>} */
    const tabListeners = new Map();
    const captureTabListener = (/** @type {string} */ key) => ({
      addListener: (/** @type {(...args:any[])=>void} */ listener) => {
        const listeners = tabListeners.get(key) ?? new Set();
        listeners.add(listener);
        tabListeners.set(key, listeners);
      },
    });
    const dispatchTabListeners = (/** @type {string} */ key, /** @type {any[]} */ args) => {
      for (const listener of tabListeners.get(key) ?? []) listener(...args);
    };
    const closePanel = async () => {
      if (deps.browser.sidebarAction?.close) {
        await deps.browser.sidebarAction.close();
        return { ok: true };
      }
      const sidePanel = deps.browser.sidePanel;
      if (!sidePanel?.setOptions) return { ok: false, error: 'no-sidepanel' };
      await sidePanel.setOptions({ enabled: false });
      setTimeout(() => {
        sidePanel.setOptions({ enabled: true, path: 'sidepanel/sidepanel.html' }).catch(() => {});
      }, 250);
      return { ok: true };
    };
    const tabAffordances = makeTabAffordances({
      browser: deps.browser, uiPorts: shared.uiPorts,
      denylistStore: deps.denylist, closeSidePanel: closePanel,
      isWatchOn: () => deps.settingsStore.get().watchAgentTab === true,
      getFrontDoorView: () => deps.settingsStore.get().frontDoorView === 'home' ? 'home' : 'panel',
      coldEvent: (key) => captureTabListener(key),
    });
    void tabAffordances.syncFrontDoorBehavior();
    live = {
      shared, baseActorIsolation, actorIsolation: loadingIsolation,
      tabAffordances, dispatchTabListeners,
    };
    actorOverviewRoutes = makeActorOverviewRoutes({
      vault: deps.vault, sessions: shared.sessions, turnSlots: shared.turnSlots,
      actorLiveProjection: projection, isActualHomeSender: () => true,
    });
    await Promise.all([
      bindingReady, refreshKeyedOrigins(), learnedOrigins.hydrate(), userEndpointsReady,
    ]);
    if (deps.firefox) void persistWebBindings();
    const directHandle = deps.firefoxActorLifetime?.createHandle?.({
      onLost: (/** @type {Error} */ error) => directActorHost?.failKeepAlive(error),
    });
    const directActorModule = deps.firefox
      ? await deps.loadDirectActorHost?.() : null;
    if (deps.firefox && typeof directActorModule?.makeDirectActorHost !== 'function') {
      throw new TypeError('kernel-firefox-actor-host-invalid');
    }
    directActorHost = deps.firefox
      ? directActorModule.makeDirectActorHost({
        workerUrl: deps.browser.runtime.getURL('offscreen/actor-worker.js'),
        startKeepAlive: () => directHandle?.start(),
        stopKeepAlive: () => directHandle?.stop(),
      }) : null;
    const channel = deps.firefox ? null : makeOffscreenActorChannelClient({
      ensureOffscreen: deps.featureHost.ensureOffscreen,
      findOffscreenClient: async () => {
        const candidates = typeof deps.listActorHostClients === 'function'
          ? await deps.listActorHostClients() : [];
        return /** @type {any} */ (selectExactActorHostClient(candidates, deps.offscreenUrl));
      },
    });
    const makeActorClient = deps.makeActorClient ?? makeOffscreenActorClient;
    actorClient = actorIsolationAvailable(baseActorIsolation) ? makeActorClient({
      ensureHost: async () => {
        if (directActorHost) return;
        await deps.featureHost.runtime.ready;
      },
      sendMessage: directActorHost?.sendMessage
        ?? ((/** @type {any} */ message) => deps.browser.runtime.sendMessage(message)),
      runOnChannel: channel ? (/** @type {any} */ job, /** @type {any} */ options) =>
        deps.featureHost.runtime.runWithLease(
          'controller', (/** @type {any} */ lease) => channel.run(job, { ...options, lease }),
          { reason: 'actor-demand' },
        ) : undefined,
      providerEgress: deps.providerEgress,
      sessions: shared.sessions, buildToolContext,
      ownedTabFor: (/** @type {string} */ sessionId) => webActorTabBindings.tabFor(sessionId),
      EXPOSURE_ACTOR: ACTOR_EXPOSURE,
      recordModelCall: contextSnapshots.record,
      broadcastOp: post,
      appendAudit: deps.auditLog.append,
      isRelaySender: directActorHost?.isRelaySender ?? deps.isOffscreenSender,
      spendRefusalFor: async (/** @type {string} */ actorSessionId) => {
        const spendLimit = deps.settingsStore.get().spendLimitUsd;
        const over = (/** @type {any} */ record) => record
          && limitExceeded(normalizeTally(record.cost).cost, spendLimit);
        const own = await shared.sessions.get(actorSessionId).catch(() => null);
        if (over(own)) {
          return `actor refused: this actor has reached the session spend limit ($${spendLimit})`;
        }
        const rootId = await rootSessionIdFor(actorSessionId);
        const root = rootId ? await shared.sessions.get(rootId).catch(() => null) : null;
        return over(root)
          ? `actor refused: the session spend limit ($${spendLimit}) is reached` : null;
      },
      authorityScheduler: deps.authorityScheduler,
    }) : null;
    directActorHost?.bindRelayRoutes(actorClient?.routes ?? {});
    live.actorIsolationReady = actorIsolationAvailable(baseActorIsolation) && isolationState
      ? isolationState.load(baseActorIsolation).then((stored) => {
        live.actorIsolation = stored ?? baseActorIsolation;
        return live.actorIsolation;
      }).catch((cause) => {
        live.actorIsolation = actorIsolationTemporarilyUnavailable(baseActorIsolation, cause);
        return live.actorIsolation;
      }) : Promise.resolve(baseActorIsolation);
    live.actorIsolationState = isolationState;
    live.runActorIsolated = async (/** @type {any} */ job, /** @type {any} */ options = {}) => {
      await live.actorIsolationReady;
      if (!actorClient || !actorIsolationAvailable(live.actorIsolation)) {
        return actorIsolationRefusal(live.actorIsolation, {
          targetRead: false, targetChanged: false,
        });
      }
      const attempt = await runActorWithStartupRetry({
        run: () => actorClient.run(job, options),
        isStartupFailure: isActorHostStartupFailure,
        signal: options.signal,
      });
      if (!attempt.exhausted) return attempt.result;
      live.actorIsolation = actorIsolationTemporarilyUnavailable(
        baseActorIsolation, attempt.result?.error ?? 'actor worker startup failed',
      );
      let persisted = true;
      try {
        await isolationState?.markUnavailable(
          baseActorIsolation,
          attempt.result?.error ?? 'actor worker startup failed',
          attempt.result?.code ?? 'unknown',
        );
      } catch { persisted = false; }
      deps.auditLog.append({
        type: 'actor_isolation_unavailable',
        details: {
          host: baseActorIsolation.host, code: attempt.result?.code ?? 'unknown',
          retryable: true, persisted,
        },
      }).catch(() => {});
      void deps.pushState().catch(() => {});
      return {
        ...actorIsolationRefusal(live.actorIsolation, {
          targetRead: false, targetChanged: false,
        }),
        cause: attempt.result?.error ?? null,
      };
    };
    const prewalk = makePrewalkController({
      sessions: shared.sessions,
      goalRunner: {
        isActive: (/** @type {string} */ sessionId) => goalRunner?.isActive(sessionId) ?? false,
        isPersisted: (/** @type {string} */ sessionId) =>
          goalRunner?.isPersisted(sessionId) ?? Promise.resolve(false),
      },
      settings: deps.settingsStore,
      resolveProvider: async (/** @type {string} */ sessionId) => {
        const selection = await deps.resolveProviderSelection(sessionId);
        if (selection?.ok !== true || typeof selection.selected !== 'string') return null;
        const [name, model, extra] = selection.selected.split('::');
        if (extra !== undefined || !name || !model) return null;
        return {
          name,
          defaultRunnerModel: typeof selection.selectedRunnerModel === 'string'
            ? selection.selectedRunnerModel : '',
        };
      },
      getTool: (/** @type {string} */ name) => toolDescriptorsByName.get(name),
      appendAudit: deps.auditLog.append, postChatNote: deps.postChatNote, now: Date.now,
    });
    live.prewalk = prewalk;
    const actorMessaging = makeActorMessaging({
      resolveActor: /** @type {any} */ (resolveActor), runActorTurn,
      reenter: (/** @type {any} */ request) => live.runAgentTurn(request),
      recordRecovery: async (/** @type {any} */ request) => {
        await shared.sessions.appendMessage(request.sessionId, {
          role: 'user', content: request.userText, synthetic: true,
          actorReply: request.actorReply,
          id: `actor-recovery:${request.sessionId}:${request.recoveryId}`,
          when: Date.now(),
        });
        await deps.pushState();
        return true;
      },
      deliveryCommitted: async (/** @type {{sessionId:string,deliveryId:string}} */ request) => {
        const session = await shared.sessions.get(request.sessionId);
        return (session?.messages ?? []).some((/** @type {any} */ message) =>
          actorDeliveryIdsFromMessage(message).includes(request.deliveryId));
      },
      isActorSessionCurrent: async (/** @type {string} */ actorSessionId) => {
        if (retiredActorSessions.has(actorSessionId)) return false;
        const actor = await shared.sessions.get(actorSessionId);
        return !!actor && actor.originState?.retired !== true;
      },
      turnSlots: shared.turnSlots,
      getActiveSessionId: () => deps.sessionCache.sessionGet('currentSessionId'),
      getAncestry: (/** @type {string} */ sessionId) => buildAncestry({
        sessionId, getRecord: (/** @type {string} */ id) => shared.sessions.get(id),
      }),
      schemaValidatedReplies: () => deps.settingsStore.get().schemaValidatedReplies === true,
      isVaultLocked: () => deps.vault.isLocked(),
      getActorIsolation: () => live.actorIsolation,
      wrapUntrusted, appendAudit: deps.auditLog.append, mailbox: actorMailbox,
    });
    const actorRecoveryGate = makeActorRecoveryGate({
      redrain: () => actorMessaging.redrain(),
      log: (cause) => console.error('[actor] mailbox recovery failed', cause),
    });
    void actorRecoveryGate.recover();
    const spawnToolDescriptors = await projectToolDescriptors({
      surface: 'main', toolManifest: null,
      dwebEnabled: false, dwebEngaged: false, goalActive: true,
      actorIsolation: live.actorIsolation, runtimeCapabilities,
    });
    const spawnActorCore = makeSpawnActor({
      sessions: shared.sessions, appendAudit: deps.auditLog.append,
      getToolDescriptors: () => [...spawnToolDescriptors],
      turnSlots: shared.turnSlots,
      runChildOffscreen: async (/** @type {any} */ job, /** @type {any} */ options) => {
        const childRecord = await shared.sessions.get(job.sessionId);
        const userHookRecords = await deps.kv.get('hooks.user.v1')
          .then(projectSemanticHookManifest)
          .catch(() => HOOK_RECORDS_UNAVAILABLE);
        const toolSurface = await projectToolSurface({
          surface: 'selection',
          toolNames: Array.isArray(job.tools)
            ? job.tools.map((/** @type {any} */ tool) => tool?.name) : [],
        });
        return live.runActorIsolated({
          actorSessionId: job.sessionId, message: job.task,
          systemPrompt: job.systemPrompt, provider: job.provider, model: job.model,
          ollamaHost: deps.settingsStore.get().ollamaHost,
          depth: job.depth, maxSteps: job.maxSteps,
          maxOutputTokens: job.maxOutputTokens, budgetMs: job.budgetMs,
          tools: job.tools ?? [], allowedOperations: toolSurface.operations,
          runtimeCapabilities,
          pricingOverrides: deps.settingsStore.get().pricingOverrides,
          semanticPolicy: {
            exposure: 'actor', permission: await resolvePermission(childRecord),
            denylist: deps.denylist.patterns(),
            allowlist: Object.freeze([...HARDCODED_ALLOWLIST, ...userEndpoints]),
            userHookRecords,
          },
        }, options);
      },
      renderSystemPromptForChild: (task, effectiveTools) => deps.seams.renderSystemPrompt({
        taskOverride: task, effectiveTools,
        temporalNowMs: Date.now(),
      }),
    });
    const spawnActor = async (/** @type {any} */ request) => {
      await live.actorIsolationReady;
      return actorIsolationAvailable(live.actorIsolation)
        ? spawnActorCore({ onEvent: forwardSpawnedEvent, ...request })
        : actorIsolationSpawnRefusal(live.actorIsolation, request?.parentDepth);
    };
    const pushAsyncTasks = (/** @type {string} */ parentSessionId) => {
      const tasks = live.asyncActors.actorTasks(parentSessionId);
      projection.setAsyncTasks(parentSessionId, tasks);
      post({ type: 'async-tasks/update', parentSessionId, tasks });
    };
    const notifyAsyncActors = (/** @type {number} */ count) => {
      try {
        deps.browser.notifications?.create?.({
          type: 'basic', iconUrl: deps.browser.runtime.getURL('icons/icon128.png'),
          title: count > 1 ? `${count} actors finished` : 'An actor finished',
          message: 'Open peerd to see the result.',
        });
      } catch { /* notification delivery is optional */ }
    };
    const asyncActors = makeAsyncActors({
      spawnActor,
      turnSlots: {
        runWhenIdle: (/** @type {string} */ sessionId, /** @type {any} */ operation) =>
          shared.turnSlots.runWhenIdle(sessionId, operation),
        runWhenIdleClaimed: (/** @type {string} */ sessionId,
          /** @type {any} */ operation) => shared.turnSlots.runWhenIdleClaimed(sessionId, operation),
        generation: (/** @type {string} */ sessionId) => shared.turnSlots.generation(sessionId),
        isBusy: (/** @type {string} */ sessionId) => shared.turnSlots.isBusy(sessionId),
        stop: (/** @type {string} */ sessionId) => shared.turnSlots.stop(sessionId),
      },
      stopSubtree: (/** @type {string} */ sessionId) => spawnActorCore.stopSubtree(sessionId),
      reenter: (/** @type {any} */ request) => live.runAgentTurn(request),
      getActiveSessionId: () => deps.sessionCache.sessionGet('currentSessionId'),
      isVaultLocked: () => deps.vault.isLocked(), wrapUntrusted,
      forwardEvent: forwardSpawnedEvent, notify: notifyAsyncActors,
      onTasksChanged: pushAsyncTasks,
    });
    live.asyncActors = asyncActors;
    const stopVaultSubscription = deps.vault.subscribe?.(() => {
      if (!deps.vault.isLocked()) asyncActors.onVaultUnlock();
    });
    const cheapCall = makeCheapCall({
      spawnActor, sessions: shared.sessions,
      getSpendLimitUsd: () => deps.settingsStore.get().spendLimitUsd,
      appendAudit: deps.auditLog.append,
    });
    const suggestions = createSuggestionStore({ kv: deps.kv });
    const autoMemory = makeAutoMemory({
      sessions: shared.sessions, memory: shared.memory, suggestions, cheapCall,
      getSettings: () => deps.settingsStore.get(),
      isBusy: (/** @type {string} */ sessionId) => shared.turnSlots.isBusy(sessionId),
      appendAudit: deps.auditLog.append,
      notify: (/** @type {{pending:number}} */ { pending }) =>
        post({ type: 'memory/suggestions-changed', pending }),
    });
    const trimEnricher = makeTrimEnricher({
      cheapCall, sessions: shared.sessions, appendAudit: deps.auditLog.append,
    });
    const scheduler = makeScheduler({
      kv: deps.kv, isLocked: () => deps.vault.isLocked(),
      isRunning: (/** @type {any} */ routine) => !!routine.lastSessionId
        && goalRunner?.isActive(routine.lastSessionId),
      setAlarm: (/** @type {number|null} */ when) => {
        if (when == null) deps.browser.alarms?.clear?.('peerd-schedule');
        else deps.browser.alarms?.create?.('peerd-schedule', { when });
      },
      onEvent: post,
      fireRoutine: async (/** @type {any} */ routine) => {
        await deps.ready;
        const active = await ensureActiveProvider();
        const created = await shared.sessions.create({
          provider: active.name, model: active.model,
          permissionMode: PERMISSION_MODES.ACT, confirmActions: false,
        });
        await shared.sessions.update(created.sessionId, { routineId: routine.id }).catch(() => {});
        deps.auditLog.append({
          type: 'routine_fired',
          details: {
            routineId: routine.id, mode: routine.mode, sessionId: created.sessionId,
          },
        }).catch(() => {});
        if (routine.mode === 'goal') {
          await prewalk.armForRun(created.sessionId);
          await goalRunner?.start({ sessionId: created.sessionId, goal: routine.prompt });
        } else {
          void live.runAgentTurn({
            sessionId: created.sessionId, userText: routine.prompt, synthetic: false,
          }).catch(() => {});
        }
        try {
          deps.browser.notifications?.create?.({
            type: 'basic', iconUrl: deps.browser.runtime.getURL('icons/icon128.png'),
            title: 'peerd routine running',
            message: 'A scheduled task started. Open peerd to see it.',
          });
        } catch { /* notification delivery is optional */ }
        return { sessionId: created.sessionId };
      },
    });
    const init = makeInitOrchestrator({
      tabs: deps.browser.tabs, scripting: deps.browser.scripting,
      listApps: () => engine.appRegistry.list(), memory: shared.memory,
      confirm: deps.confirmation.confirm, postChatNote: deps.postChatNote,
      getDenylist: () => deps.denylist.patterns(),
    });
    const adoptWebTab = async (/** @type {string} */ sessionId,
      /** @type {AbortSignal|undefined} */ signal = undefined) => {
      if (signal?.aborted) throw new Error('adopt_web_tab: aborted');
      const tab = await deps.browser.tabs.create({ active: false, url: 'about:blank' });
      if (typeof tab?.id !== 'number') throw new Error('web-actor-tab-open-failed');
      if (signal?.aborted) {
        await deps.browser.tabs.remove(tab.id).catch(() => {});
        throw new Error('adopt_web_tab: aborted');
      }
      webActorTabBindings.bind(tab.id, sessionId);
      await persistWebBindings();
      await deps.syncDenylistNetwork?.();
      if (signal?.aborted) {
        webActorTabBindings.drop(tab.id);
        await persistWebBindings();
        await deps.browser.tabs.remove(tab.id).catch(() => {});
        throw new Error('adopt_web_tab: aborted');
      }
      await live.tabAffordances.noteAgentTab(tab.id, { kind: 'web', opened: true });
      return { tabId: tab.id, windowId: tab.windowId };
    };
    const liveLandingFor = async (/** @type {string} */ sessionId) => {
      const tabId = webActorTabBindings.tabFor(sessionId);
      if (typeof tabId !== 'number') return { status: 'missing' };
      const tab = await deps.browser.tabs.get(tabId).catch(() => null);
      return tab?.url ? { status: 'live', url: tab.url } : { status: 'missing' };
    };
    const originLockFor = makeOriginLockResolver({
      originStates, landingTurnTokens, landingStopReports, landingStopCards,
      makeJudgeLanding, describeLandingStop, landingStopCard,
      retireStoppedRoamingWebActorDurably, webActorRegistry,
      retiredActorSessions, persistWebActors, turnSlots: shared.turnSlots,
      webActorTabBindings, persistWebBindings, pageActivity: shared.pageActivity,
      siteActorBindings, persistSiteActors, auditLog: deps.auditLog,
      originPhrase, isKnownIdp, isKnownIdpHost, sensitivitySignals,
      makeSignInOriginAuthorizer, makeSignInExcursionAuthorizer,
      makeSignInExcursionRevoker, makeCredentialScope,
      makeSiteClientOriginGuard, makeSiteClientOriginAuthorizer,
      liveSiteClientLandingFor: liveLandingFor,
    });
    Object.assign(live, {
      actorMessaging, spawnActor, scheduler, trimEnricher,
      autoMemory, init, adoptWebTab, liveLandingFor, originLockFor,
      actorRecoveryGate, actorLifecycle: spawnActorCore,
    });

    const observeAppRuntime = async (/** @type {{sessionId:string,appId:string,signal?:AbortSignal}} */ request) => {
      const startedAt = performance.now();
      const ctx = await buildToolContext({
        sessionId: request.sessionId, exposure: ACTOR_EXPOSURE, actorType: 'app',
        actorInstanceId: request.appId, actorSurface: 'code',
      });
      if (typeof ctx.appAgentCall !== 'function') return {
        ok: false, error: 'app_playtest_not_available', outcomeKnown: true,
        outcomeKind: 'pre-effect-failure',
      };
      const result = await ctx.appAgentCall('observe', {}, request.signal);
      deps.auditLog.append({
        type: result?.ok === false ? 'tool_failed' : 'tool_executed',
        sessionId: request.sessionId,
        details: {
          tool: 'app_observe', primitive: 'app', dispatch: 'read',
          durationMs: Math.round(performance.now() - startedAt),
          ...(result?.ok === false ? { error: result.error } : {}),
        },
      }).catch(() => {});
      return result;
    };
    const actAppRuntime = async (/** @type {{sessionId:string,appId:string,action:string,params:object,signal?:AbortSignal}} */ request) => {
      const startedAt = performance.now();
      const ctx = await buildToolContext({
        sessionId: request.sessionId, exposure: ACTOR_EXPOSURE, actorType: 'app',
        actorInstanceId: request.appId, actorSurface: 'code',
      });
      if (typeof ctx.appAgentCall !== 'function') return {
        ok: false, error: 'app_playtest_not_available', outcomeKnown: true,
        outcomeKind: 'pre-effect-failure',
      };
      const result = await ctx.appAgentCall(
        'act', { action: request.action, params: request.params }, request.signal,
      );
      deps.auditLog.append({
        type: result?.ok === false ? 'tool_failed' : 'tool_executed',
        sessionId: request.sessionId,
        details: {
          tool: 'app_act', primitive: 'app', dispatch: 'write',
          durationMs: Math.round(performance.now() - startedAt),
          ...(result?.ok === false ? { error: result.error } : {}),
        },
      }).catch(() => {});
      return result;
    };
    const actorsRoutes = makeActorsRoutes({
      sessions: shared.sessions, uiPorts: shared.uiPorts, buildToolContext,
      actorMessaging, scriptRuns,
      isOffscreenSender: deps.isOffscreenSender,
    });
    const appActorChat = makeAppActorChatHandler({
      isTrustedSender: deps.isTrustedSender, appTabTracker: engine.appTabTracker,
      ensureAppActorBinding, sessions: shared.sessions,
      messageActor: actorMessaging.messageActor,
    });
    const networkCustody = deps.networkCustody;
    const syncNetworkCustody = async () => {
      if (networkCustody?.sync) await networkCustody.sync();
      else if (typeof deps.syncDenylistNetwork === 'function') {
        await deps.syncDenylistNetwork();
      }
    };
    const networkCustodyState = () => networkCustody?.state?.()
      ?? networkCustody?.status?.()
      ?? { supported: false, lastError: 'network-custody-unavailable' };
    const refuseAppNetwork = (/** @type {string} */ appId, /** @type {number} */ tabId) => {
      engine.appTabTracker.onTabFailed(appId, new Error('App network isolation is unavailable.'));
      setTimeout(() => deps.browser.tabs.remove(tabId).catch(() => {}), 250);
      return {
        ok: false,
        error: 'Apps are unavailable because this browser cannot enforce their network isolation.',
      };
    };
    const attachAppTabActor = async (/** @type {any} */ message,
      /** @type {any} */ sender) => {
      const liveTabId = typeof message?.appId === 'string'
        ? typeof engine.appTabTracker.reconcileTabClaim === 'function'
          ? await engine.appTabTracker.reconcileTabClaim(message.appId, sender?.tab?.id)
          : engine.appTabTracker.getTabId(message.appId)
        : null;
      const claim = validateAppTabClaim({
        claimedAppId: message?.appId,
        urlAppId: engine.appTabTracker.parseIdFromUrl(sender?.tab?.url),
        senderTabId: sender?.tab?.id,
        liveTabId,
      });
      if (!claim.ok) return claim;
      const { appId, tabId } = claim;
      const record = await engine.appRegistry.get(appId);
      if (!record) return { ok: false, error: 'app-not-found' };
      const ownerClaim = resolveAppTabOwnerClaim({
        claimedOwner: message.ownerSessionId,
        urlOwner: engine.appTabTracker.parseOwnerFromUrl(sender?.tab?.url),
        recordOwner: record.ownerSessionId,
      });
      if (!ownerClaim.ok) return ownerClaim;
      const ownerSessionId = ownerClaim.ownerSessionId;
      if (message.type === 'app/actor-retry') engine.appTabTracker.markReloading(appId);
      engine.appTabTracker.onTabPending(appId, tabId, ownerSessionId);
      const admission = await networkCustody?.admitAppTab?.(tabId, sender.tab.url);
      const network = networkCustodyState();
      if (admission?.ok !== true || !network.supported || network.lastError
          || !network.tabs?.includes(tabId)) return refuseAppNetwork(appId, tabId);
      try {
        const actorSessionId = await ensureAppActorBinding(appId, ownerSessionId);
        if (!actorSessionId) throw new Error('manifest-defined App actor could not be attached');
        const actor = await shared.sessions.get(actorSessionId);
        if (!actor?.parentSessionId) throw new Error('manifest-defined App actor has no owner root');
        engine.appTabTracker.onTabReady(
          appId, tabId, ownerSessionId, actor.parentSessionId,
        );
        poisonedAppRuntimeTabs.delete(tabId);
        return { ok: true, actorSessionId };
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        engine.appTabTracker.onTabFailed(appId, error);
        await syncNetworkCustody();
        return {
          ok: false, error: error.message, actorRequired: true, retryable: true,
        };
      }
    };
    const trustedEngineMessage = (/** @type {any} */ sender) =>
      deps.isTrustedSender(sender) && typeof sender?.tab?.id === 'number';
    const engineRoutes = {
      'vm/tab-ready': async (/** @type {any} */ message, /** @type {any} */ sender) => {
        if (!trustedEngineMessage(sender) || typeof message?.vmId !== 'string'
            || engine.vmTabTracker.parseVmIdFromUrl(sender.tab.url) !== message.vmId
            || !await engine.vmRegistry.get(message.vmId)) return false;
        const liveTabId = engine.vmTabTracker.getTabId(message.vmId);
        if (liveTabId != null && liveTabId !== sender.tab.id) return false;
        engine.vmTabTracker.onTabReady(message.vmId, sender.tab.id);
        await syncNetworkCustody();
        return false;
      },
      'js/tab-ready': async (/** @type {any} */ message, /** @type {any} */ sender) => {
        if (!trustedEngineMessage(sender) || typeof message?.notebookId !== 'string'
            || engine.jsTabTracker.parseIdFromUrl(sender.tab.url) !== message.notebookId
            || !await engine.jsRegistry.get(message.notebookId)) return false;
        const liveTabId = engine.jsTabTracker.getTabId(message.notebookId);
        if (liveTabId != null && liveTabId !== sender.tab.id) return false;
        engine.jsTabTracker.onTabReady(message.notebookId, sender.tab.id);
        await syncNetworkCustody();
        return false;
      },
      'pod/tab-adopt': async (/** @type {any} */ message, /** @type {any} */ sender) => {
        if (!trustedEngineMessage(sender) || typeof message?.podId !== 'string'
            || engine.podTabTracker.parseIdFromUrl(sender.tab.url) !== message.podId) return false;
        if (!await engine.podRegistry.get(message.podId)) {
          return { ok: false, error: 'pod-not-found' };
        }
        const liveTabId = engine.podTabTracker.getTabId(message.podId);
        if (liveTabId != null && liveTabId !== sender.tab.id) {
          return { ok: false, error: 'pod-already-open' };
        }
        engine.podTabTracker.onTabPending(message.podId, sender.tab.id);
        await syncNetworkCustody();
        return { ok: true };
      },
      'app/tab-ready': (/** @type {any} */ message, /** @type {any} */ sender) =>
        trustedEngineMessage(sender) ? attachAppTabActor(message, sender) : false,
      'app/actor-retry': (/** @type {any} */ message, /** @type {any} */ sender) =>
        trustedEngineMessage(sender) ? attachAppTabActor(message, sender) : false,
    };
    const engineTrackersHydrated = Promise.resolve();
    const engineReady = Promise.all(engine.appCandidates.map((/** @type {any} */ candidate) =>
      attachAppTabActor({
        type: 'app/tab-ready', appId: candidate.appId,
        ownerSessionId: candidate.ownerSessionId,
      }, { tab: { id: candidate.tabId, url: candidate.url } })))
      .then(() => undefined);
    const conversationRegistry = createConversationRegistry();
    const dwebAgentOn = () => deps.dwebEnabled
      && deps.settingsStore.get().dwebEnabled === true
      && deps.settingsStore.get().dwebAgentEnabled === true;
    const meshHostRoom = (/** @type {Record<string,any>} */ payload,
      /** @type {()=>boolean} */ guard = () => true) =>
      engine.withDwebPublication(async (/** @type {()=>boolean} */ current) => {
        if (!current() || !dwebAgentOn() || guard() !== true) {
          return { ok: false, error: 'dweb-disabled-or-revoked' };
        }
        await deps.ensureDwebFeature();
        return deps.browser.runtime.sendMessage({
          type: 'dweb/base-host/room', roomId: 'peerd-agent', ...payload,
        });
      });
    const meshDispatch = makeMeshDispatch({
      sendDm: async (to, envelope) => {
        const replyConversationId = envelope?.kind === 'reply'
          && typeof envelope?.convId === 'string' ? envelope.convId : null;
        const result = await meshHostRoom(
          { op: 'dm', to, data: envelope },
          replyConversationId
            ? () => conversationRegistry.ownedBy(replyConversationId, to) : () => true,
        ).catch(() => null);
        return {
          ok: result?.ok === true, id: result?.id,
          error: result?.error,
        };
      },
      listPeers: async () => {
        await deps.ensureDwebFeature();
        const result = await deps.browser.runtime.sendMessage({
          type: 'dweb/base-host/peers',
        }).catch(() => null);
        return Array.isArray(result?.peers) ? result.peers.map((/** @type {any} */ peer) => ({
          did: peer.did, name: peer.name,
        })) : [];
      },
      fetchCard: async (did) => {
        const result = await meshHostRoom({ op: 'card-get', did }).catch(() => null);
        return result?.ok ? result.card ?? null : null;
      },
      publishCard: async (card) => {
        const result = await meshHostRoom({ op: 'card-set', card }).catch(() => null);
        return { ok: result?.ok === true, did: result?.did, error: result?.error };
      },
      conversations: conversationRegistry,
    });
    const confirmDwebReply = async (/** @type {string} */ conversationId,
      /** @type {string} */ did, /** @type {string} */ sessionId) => {
      if (conversationRegistry.hasReplyConsent(conversationId)) return true;
      const answer = await confirmAction({
        tool: 'a2a_reply', sessionId, origins: [did],
      }, /** @type {any} */ (undefined));
      const granted = answer === 'yes_once' || answer === 'yes_session';
      if (answer === 'yes_session') conversationRegistry.grantReplyConsent(conversationId);
      deps.auditLog.append({
        type: 'a2a_reply_consent',
        details: {
          did, convId: conversationId, approved: granted,
          standing: answer === 'yes_session',
        },
      }).catch(() => {});
      return granted;
    };
    dwebAgentOwner = createKernelDwebAgentOwner({
      active: dwebAgentOn, isLocked: deps.vault.isLocked,
      appendAudit: deps.auditLog.append, meshDispatch,
      conversations: conversationRegistry, approvedDids: a2aApprovedDids,
      persistApproved: () => deps.sessionCache.sessionSet(
        'a2aApprovedDids', [...a2aApprovedDids],
      ),
      isolationReady: () => live.actorIsolationReady,
      isolationAvailable: () => actorIsolationAvailable(live.actorIsolation),
      runWhenRecoveryReady: actorRecoveryGate.runWhenReady,
      resolveActor: () => resolveActor('dweb'),
      sessions: shared.sessions, runActorTurn, turnSlots: shared.turnSlots,
      currentSessionId: () => deps.sessionCache.sessionGet('currentSessionId'),
      runAgentTurn: (/** @type {any} */ request) => live.runAgentTurn(request),
      wrapUntrusted, finalAssistantText, confirmReply: confirmDwebReply,
      withPublication: engine.withDwebPublication,
      ensureFeature: deps.ensureDwebFeature,
      sendMessage: (/** @type {any} */ message) => deps.browser.runtime.sendMessage(message),
      isOffscreenSender: deps.isOffscreenSender,
    });
    const a2aCall = async (/** @type {any} */ message = {}, /** @type {any} */ sender) => {
      try {
        if (!deps.isOffscreenSender(sender)) return { ok: false, error: 'a2a: unauthorized relay' };
        if (!dwebAgentOn()) return { ok: false, error: 'a2a: the dweb agent is off' };
        await a2aApprovedReady;
        if (typeof message.runId !== 'string'
            || scriptRuns.ownerFor(message.runId) !== message.ownerSessionId
            || scriptRuns.allows(message.runId, 'a2a') !== true
            || scriptRuns.admitOp(message.runId, 'a2a') !== true) {
          return { ok: false, error: 'a2a: unknown, finished, foreign, or over-limit run' };
        }
        const signal = scriptRuns.signalFor(message.runId);
        if (signal?.aborted) return { ok: false, error: 'a2a: run aborted' };
        const owner = message.ownerSessionId
          ? await shared.sessions.get(message.ownerSessionId) : null;
        if (!owner || owner.kind !== 'actor' || owner.actorType !== 'dweb') {
          return { ok: false, error: 'a2a: not the dweb actor' };
        }
        const { op, args: rawArgs, signs } = meshCallToOp({
          method: message.method, args: message.args,
        });
        const args = /** @type {Record<string,any>} */ (rawArgs);
        if (signs) {
          const target = op === 'publishCard' ? 'self:publishCard'
            : op === 'say'
              ? conversationRegistry.didFor(args.convId ?? '') : args.did;
          if (!target) return { ok: false, error: `a2a: ${op} has no consent target` };
          if (!a2aApprovedDids.has(target)) {
            const answer = await confirmAction({
              tool: 'a2a_contact', sessionId: message.ownerSessionId, origins: [target],
            }, /** @type {any} */ (signal));
            const consent = a2aConsentOutcome(answer);
            if (consent.persist) {
              a2aApprovedDids.add(target);
              await deps.sessionCache.sessionSet('a2aApprovedDids', [...a2aApprovedDids]);
            }
            deps.auditLog.append({
              type: 'a2a_consent',
              details: { target, op, approved: consent.ok, standing: consent.persist },
            }).catch(() => {});
            if (!consent.ok) {
              return { ok: false, error: `a2a: the user declined ${op} to ${target}` };
            }
          }
        }
        if (signal?.aborted) return { ok: false, error: 'a2a: run aborted' };
        const result = await meshDispatch.dispatch(op, args, {
          signs, allowed: (did) => a2aApprovedDids.has(did),
          signal: signal ?? undefined,
        });
        return { ok: true, value: shapeMeshResult(message.method ?? '', result) };
      } catch (cause) {
        return { ok: false, error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause) };
      }
    };
    const reconcileTrackers = async () => {
      await engineTrackersHydrated;
      const tabs = await deps.browser.tabs.query({});
      const tabIds = new Set(tabs.flatMap((/** @type {any} */ tab) =>
        typeof tab.id === 'number' ? [tab.id] : []));
      let changed = false;
      for (const [tabId] of webActorTabBindings.entries()) {
        if (tabIds.has(tabId)) continue;
        webActorTabBindings.drop(tabId);
        changed = true;
      }
      if (changed) await persistWebBindings();
    };
    const eventOwners = {
      onCreated: (/** @type {any} */ tab) => {
        live.dispatchTabListeners('tabs.onCreated', [tab]);
      },
      onUpdated: (/** @type {number} */ tabId, /** @type {any} */ change,
        /** @type {any} */ tab) => {
        if (debuggerApiAvailable()) debuggerPool.onTabUpdated(tabId, change);
        if (change?.status === 'loading' || change?.url) domRefs.clear?.(tabId);
        if (siteCapture.has(tabId)
            && (change?.status === 'loading' || typeof change?.url === 'string')) {
          void siteCapture.cancel({ tabId, reason: 'page_changed' }).catch(() => {});
        }
        const sourceWrite = deps.firefox && typeof change?.url === 'string'
          && webActorTabBindings.has(tabId) ? persistWebBindings() : undefined;
        live.dispatchTabListeners('tabs.onUpdated', [tabId, change, tab]);
        return sourceWrite;
      },
      onRemoved: async (/** @type {number} */ tabId) => {
        poisonedAppRuntimeTabs.delete(tabId);
        if (debuggerApiAvailable()) debuggerPool.onTabRemoved(tabId);
        siteCapture.release(tabId);
        for (const [kind, , , tracker] of registryEntries()) {
          const instanceId = tracker.onTabRemoved(tabId);
          if (kind === 'vm' && instanceId) engine.vmClient.onTabClosed(instanceId);
        }
        if (webActorTabBindings.drop(tabId)) await persistWebBindings();
        domRefs.clear?.(tabId);
        await shared.pageActivity.release(tabId).catch(() => {});
        live.dispatchTabListeners('tabs.onRemoved', [tabId]);
      },
      onActivated: (/** @type {any} */ activeInfo) => {
        live.dispatchTabListeners('tabs.onActivated', [activeInfo]);
      },
      onNavigationTarget: (/** @type {any} */ details) => {
        if (typeof details?.sourceTabId !== 'number' || typeof details?.tabId !== 'number'
            || !webActorTabBindings.has(details.sourceTabId)) return;
        void live.tabAffordances.noteAgentTab(details.tabId, {
          kind: 'web', opened: true, protected: true,
        });
      },
      onBeforeRequest: () => ({}),
      reconcileTrackers,
      reconcile: async () => {
        await engineReady;
        await reconcileTrackers();
      },
    };
    const relayRoutes = {
      'actors/list': actorsRoutes['actors/list'],
      'actors/call': actorsRoutes['actors/call'],
      'site-fetch/call': async (/** @type {any} */ message = {}, /** @type {any} */ sender) => {
        if (!deps.isOffscreenSender(sender)) return { ok: false, error: 'site_fetch_unauthorized_relay' };
        if (deps.vault.isLocked()) return { ok: false, error: 'locked' };
        const { ownerSessionId, siteOrigin, pathOrUrl, method, headers, body, runId } = message;
        if (typeof ownerSessionId !== 'string' || !ownerSessionId) {
          return { ok: false, error: 'site_fetch_no_owner' };
        }
        if (typeof runId !== 'string' || scriptRuns.ownerFor(runId) !== ownerSessionId
            || scriptRuns.allows(runId, 'site') !== true
            || scriptRuns.admitOp(runId, 'site') !== true) {
          return { ok: false, error: 'site_fetch_unknown_finished_foreign_or_over_limit_run' };
        }
        const signal = scriptRuns.signalFor(runId);
        if (signal?.aborted) return { ok: false, error: 'site_fetch_aborted' };
        const owner = await shared.sessions.get(ownerSessionId).catch(() => null);
        if (!owner || owner.kind !== 'actor' || owner.actorType !== 'web') {
          return { ok: false, error: 'site_fetch_not_web_actor' };
        }
        const pin = normalizeApiOrigin(siteOrigin);
        if (!pin) return { ok: false, error: `site_fetch_bad_origin: ${siteOrigin}` };
        if (isKnownIdpHost(pin)) {
          return { ok: false, error: IDENTITY_PROVIDER_TRANSIT_ONLY_CODE };
        }
        const target = resolveSiteUrl(pathOrUrl, pin);
        if ('error' in target) return { ok: false, error: target.error };
        let host = '';
        try { host = new URL(target.url).hostname; } catch { /* resolveSiteUrl already validated */ }
        const denied = host ? matchesDenylist(host, deps.denylist.patterns()) : null;
        if (denied) return { ok: false, error: `denylisted: ${host} matches '${denied}'` };
        const backing = owner.backing === undefined ? 'tab' : owner.backing;
        const ownedApiOrigin = owner.backing === 'api'
          ? normalizeApiOrigin(owner.instanceId) : null;
        let originLock = null;
        if (backing === 'tab' && hasDurableSiteClientState(owner.originState)) {
          originStates.hydrate(ownerSessionId, owner.originState);
          originLock = live.originLockFor(ownerSessionId);
        }
        const authorizeTabOrigin = originLock?.authorizeSiteClientOrigin(
          () => live.liveLandingFor(ownerSessionId),
        );
        const reauthorize = () => authorizeSiteClientRelayOrigin({
          backing, instanceOrigin: ownedApiOrigin, durableState: owner.originState,
          targetOrigin: pin, authorizeTabOrigin, isKnownIdp: isKnownIdpHost,
        });
        if (!await reauthorize()) return { ok: false, error: 'site_fetch_cross_origin' };
        const httpMethod = String(method ?? 'GET').toUpperCase();
        const mutatesExternal = needsWebWriteConfirm(httpMethod);
        /** @type {Record<string,string>} */
        const safeHeaders = {};
        for (const [name, value] of Object.entries(headers ?? {})) {
          if (['cookie', 'authorization', 'proxy-authorization', 'dpop']
            .includes(name.toLowerCase())) continue;
          if (typeof value === 'string') safeHeaders[name] = value;
        }
        let requestBody = body;
        if (requestBody !== undefined && typeof requestBody !== 'string') {
          try { requestBody = JSON.stringify(requestBody); }
          catch { return { ok: false, error: 'site_fetch_bad_body', outcomeKnown: true }; }
          if (!safeHeaders['Content-Type'] && !safeHeaders['content-type']) {
            safeHeaders['Content-Type'] = 'application/json';
          }
        }
        const liveOwnerPermission = async () => {
          const currentOwner = await shared.sessions.get(ownerSessionId).catch(() => null);
          if (!currentOwner || currentOwner.kind !== 'actor'
              || currentOwner.actorType !== 'web') return null;
          return resolvePermission(currentOwner);
        };
        // why: confirmation is consent, not Plan/Act authorization. Stored
        // site-client code is allowed to run in Plan for reads, so the final
        // network edge must independently refuse every write method.
        if (mutatesExternal
            && (await liveOwnerPermission())?.mode !== PERMISSION_MODES.ACT) {
          return { ok: false, error: 'plan_mode_refused', outcomeKnown: true };
        }
        if (mutatesExternal) {
          const presentation = finalWebRequestConfirmation({
            url: target.url, method: httpMethod, headers: safeHeaders,
            ...(typeof requestBody === 'string' ? { body: requestBody } : {}),
            source: 'site client',
          });
          const answer = await confirmAction({
            tool: WEB_WRITE_CONFIRM_KEY, kind: 'web_write',
            origins: [...presentation.origins], summary: presentation.summary,
            sessionId: ownerSessionId,
          }, /** @type {any} */ (signal));
          if (answer !== 'yes_once' && answer !== 'yes_session') {
            return { ok: false, error: 'declined: user declined the site-client write.' };
          }
          if (signal?.aborted) return { ok: false, error: 'site_fetch_aborted' };
          if ((await liveOwnerPermission())?.mode !== PERMISSION_MODES.ACT) {
            return { ok: false, error: 'plan_mode_refused', outcomeKnown: true };
          }
        }
        let scopedFetch;
        if (owner.backing === 'api') {
          if (!ownedApiOrigin || pin !== ownedApiOrigin) {
            return { ok: false, error: 'site_fetch_cross_origin' };
          }
          scopedFetch = withDpopCredentials(webFetch, () => ownedApiOrigin, {
            getSecret: (/** @type {string} */ name) => deps.vault.getSecret(name),
            getDpopKey, audit: deps.auditLog.append,
          });
        } else {
          const ownedTabId = webActorTabBindings.tabFor(ownerSessionId);
          /** @type {string|undefined} */
          let tabOrigin;
          if (typeof ownedTabId === 'number') {
            const tab = await deps.browser.tabs.get(ownedTabId).catch(() => null);
            if (tab?.url) tabOrigin = originOf(tab.url);
          }
          scopedFetch = withSessionScopedCredentials(
            webFetch,
            originLock ? originLock.makeScope(() => tabOrigin) : () => tabOrigin,
          );
        }
        if (!await reauthorize()) return { ok: false, error: 'site_fetch_cross_origin' };
        if (signal?.aborted) return { ok: false, error: 'site_fetch_aborted' };
        if (mutatesExternal
            && (await liveOwnerPermission())?.mode !== PERMISSION_MODES.ACT) {
          return { ok: false, error: 'plan_mode_refused', outcomeKnown: true };
        }
        try {
          const response = await scopedFetch(target.url, {
            method: httpMethod, headers: safeHeaders,
            body: /** @type {string|undefined} */ (requestBody),
            ...(signal ? { signal } : {}),
          });
          const contentType = response.headers.get('content-type') ?? '';
          const text = (await response.text()).slice(0, 200_000);
          let json = null;
          if (/(json|graphql)/i.test(contentType)) {
            try { json = JSON.parse(text); } catch { json = null; }
          }
          return { ok: true, value: {
            status: response.status, finalUrl: response.url ?? target.url,
            contentType: contentType || null, body: text, json,
          } };
        } catch (cause) {
          const error = /** @type {{reason?:string,message?:string}} */ (cause);
          if (error.reason === 'redirect_blocked') {
            return {
              ok: false,
              error: `redirected: ${target.url} issued a redirect (not followed). Use the final URL.`,
              outcomeKnown: true,
              ...(mutatesExternal ? {
                performed: true, outcomeKind: 'effect-completed', retryable: false,
              } : { outcomeKind: 'pre-effect-failure' }),
            };
          }
          if (error.reason === 'private_network') {
            return {
              ok: false,
              error: `blocked: ${target.url} is a private/loopback host (SSRF defense).`,
              outcomeKnown: true, outcomeKind: 'pre-effect-failure',
            };
          }
          return mutatesExternal ? {
            ok: false, error: error.message ?? 'site_fetch_failed',
            outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
          } : {
            ok: false, error: error.message ?? 'site_fetch_failed',
            outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: true,
          };
        }
      },
      'a2a/call': a2aCall,
    };
    const relays = {
      scriptRuns, validateGeneration, retireStale,
      observeAppRuntime, actAppRuntime, appActorChat, engineTrackersHydrated, engineReady,
      relayRoutes, engineRoutes, eventOwners,
      dwebInbound: dwebAgentOwner.onMessage,
      syncDwebAgentRoom: dwebAgentOwner.syncRoom,
      onDwebStopped: dwebAgentOwner.roomStopped,
      onSettingsChanged: async (/** @type {any} */ patch) => {
        if (patch?.watchAgentTab === true) await live.tabAffordances.focusAgentTab();
        if (Object.hasOwn(patch ?? {}, 'frontDoorView')) {
          await live.tabAffordances.syncFrontDoorBehavior();
        }
      },
      resolveAppOwnerRoot: (/** @type {string} */ ownerSessionId) =>
        rootSessionIdFor(ownerSessionId),
      onAppDeleted: retireAppActors,
      onAppManifestMutation: retireAppActors,
      archiveOrphanedActor: retireStale,
      loadUserEndpoints,
      onEngineAdopt: (/** @type {string} */ kind, /** @type {string} */ id,
        /** @type {number} */ tabId) => engineLiveness.adopt(kind, id, tabId),
      onEngineDrop: (/** @type {string} */ kind, /** @type {string} */ id) =>
        engineLiveness.drop(kind, id),
      noteAgentTab: (/** @type {number} */ tabId, /** @type {any} */ tab) =>
        live.tabAffordances.noteAgentTab(tabId, tab),
      bindGoalRunner: (/** @type {any} */ runner) => { goalRunner = runner; },
      beforeGoalStart: (/** @type {{sessionId:string}} */ request) =>
        prewalk.armForRun(request?.sessionId),
      hasUnresolvedSideEffects: async (/** @type {string} */ sessionId) => {
        await lifecycleArmed;
        if (await lifecycleBoot.operationLog.unknownIntentOverflowed?.()) return true;
        for (const record of await lifecycleBoot.operationLog.listOutcomeUnknown()) {
          if (await rootSessionIdFor(record.sessionId) === sessionId) return true;
        }
        return false;
      },
      onGoalRunEnd: (/** @type {string} */ sessionId, /** @type {any} */ info) => {
        prewalk.restoreForRun(sessionId).catch(() => {});
        void deps.sessionCache.sessionGet('currentSessionId').then((/** @type {any} */ current) => {
          if (current !== sessionId) return;
          if (info?.phase === 'capped') {
            deps.postChatNote(`Goal run stopped after reaching the ${GOAL_MAX_ITERATIONS}-turn limit.`);
          } else if (info?.phase === 'halted') {
            deps.postChatNote(info?.reason
              ? `Goal run stopped (${info.reason}).` : 'Goal run stopped.');
          }
        }).catch(() => {});
      },
      broadcastAgentTab: () => live.tabAffordances.broadcastAgentTab(),
      onUiConnect: async (/** @type {any} */ port) => {
        for (const event of goalRunner?.activeStates?.() ?? []) port.postMessage(event);
        const sessionId = await deps.sessionCache.sessionGet('currentSessionId');
        const snapshot = projection.snapshot(sessionId);
        for (const actor of Object.values(snapshot.actors)) {
          port.postMessage({
            type: 'turn/actor-start', ...actor,
            actorProjectionEpoch: snapshot.actorProjectionEpoch,
            actorProjectionRevision: snapshot.actorProjectionRevision,
          });
        }
        for (const actor of Object.values(snapshot.spawned.sessions)) {
          port.postMessage({
            type: 'turn/spawned-start', ...actor,
          });
          port.postMessage({
            type: 'turn/spawned-state', rootSessionId: actor.rootSessionId,
            session: actor,
          });
        }
        for (const [parentSessionId, tasks] of Object.entries(snapshot.asyncTasks)) {
          port.postMessage({ type: 'async-tasks/update', parentSessionId, tasks });
        }
      },
      showWebTabHint: (/** @type {number} */ tabId) =>
        live.tabAffordances.showWebTabHint(tabId),
      isDrivenSource: (/** @type {number} */ tabId) =>
        webActorTabBindings.resolve(tabId) != null,
      webActorSessionForTab: (/** @type {number} */ tabId) =>
        webActorTabBindings.resolve(tabId),
      isWebActorTab: (/** @type {number} */ tabId) => webActorTabBindings.has(tabId),
      externalDrivenTabIds: () => {
        const ids = new Set(webActorTabBindings.entries().map(([tabId]) => tabId));
        for (const [, , , tracker] of registryEntries()) {
          for (const instanceId of tracker.listLive()) {
            const tabId = tracker.getTabId(instanceId);
            if (typeof tabId === 'number') ids.add(tabId);
          }
        }
        return [...ids];
      },
      appTabIds: () => engine.appTabTracker.listLive()
        .map((/** @type {string} */ appId) => engine.appTabTracker.getTabId(appId))
        .filter((/** @type {number|null} */ tabId) => typeof tabId === 'number'),
      resumeSchedules: async () => {
        await actorRecoveryGate.runWhenReady('schedules', async () => {
          await Promise.resolve(goalRunner?.resume?.()).catch(() => {});
          await scheduler.load();
          await scheduler.tick();
          await dwebAgentOwner?.syncRoom();
        });
      },
      debugOriginLock: async (/** @type {any} */ message = {}) => {
        await deps.keyedOriginAuthority?.hydrate();
        const origin = normalizeApiOrigin(message.origin);
        const chatId = await deps.sessionCache.sessionGet('currentSessionId');
        const actorSessionId = chatId ? webActorRegistry.resolve(chatId) : null;
        if (deps.settingsStore.get().devMode === true && origin
            && ['password-field', 'confirmed-write'].includes(message.seedReason)) {
          learnedOrigins.note(origin, message.seedReason);
          await learnedOrigins.settled();
        }
        const siteActorSessionId = origin && chatId
          ? siteActorBindings.resolve(chatId, origin) : null;
        return {
          ok: true,
          learned: origin ? [...learnedOrigins.snapshot().keys()]
            .some((host) => learnedOriginCovers(host, origin)) : false,
          keyed: origin
            ? deps.keyedOriginAuthority?.has(origin) ?? keyedOrigins.has(origin) : false,
          ownedTabId: actorSessionId ? webActorTabBindings.tabFor(actorSessionId) ?? null : null,
          originState: actorSessionId ? originStates.read(actorSessionId) ?? null : null,
          siteActorState: siteActorSessionId
            ? originStates.read(siteActorSessionId) ?? null : null,
          siteActorTabId: siteActorSessionId
            ? webActorTabBindings.tabFor(siteActorSessionId) ?? null : null,
        };
      },
    };
    return Object.freeze({
      actorCount, actorOverview, relays,
      onSessionMessageAppended: async (/** @type {string} */ _sessionId,
        /** @type {any} */ message) => {
        await Promise.all(actorDeliveryIdsFromMessage(message).map((id) => actorMailbox.remove(id)));
      },
      close: async () => {
        stopVaultSubscription?.();
        await directHandle?.stop?.();
      },
    });
  };

  let debuggerNudgeShown = false;
  const maybeNudgeDebuggerGrant = (/** @type {any} */ result) => {
    const unavailable = typeof result?.error === 'string'
      && (result.error.startsWith('debugger_unavailable')
        || result.error.startsWith('debugger_not_available'));
    if (!debuggerApiAvailable() || advancedAutomationOn() || debuggerNudgeShown
        || result?.ok !== false || !unavailable || !uiConnected()) return;
    try {
      live.shared.uiPorts.broadcast({
        type: 'turn/system-note',
        text: 'That step needs advanced automation. It is off in Settings → Advanced.',
        action: { kind: 'grant-debugger', label: 'Turn on advanced automation' },
      });
      debuggerNudgeShown = true;
    } catch { /* the next unavailable result can retry after a surface reconnects */ }
  };
  const checkpointMgr = {
    capture: async (/** @type {{scope:string,label?:string|null}} */ { scope, label }) => {
      if (typeof scope !== 'string' || !scope.startsWith('app:')) return null;
      const appId = scope.slice(4);
      const result = await engine.appQuiescence.run(appId, () => engine.repositories.coordinate(
        { kind: 'app', id: appId },
        async () => {
          const status = await engine.repositories.statusApp(appId);
          const paths = status.changed.slice(0, 3)
            .map((/** @type {{path:string}} */ change) => change.path);
          const automatic = paths.length
            ? `agent turn: update ${paths.join(', ')}${status.changed.length > paths.length ? ', …' : ''}`
            : 'agent turn';
          return engine.repositories.commitApp(appId, { message: label || automatic });
        },
      ));
      return result?.oid ? { id: result.oid, scope } : null;
    },
    diffSince: async (/** @type {{scope?:string|null,ref?:string|null}} */ { scope, ref }) => {
      if (typeof scope !== 'string' || !scope.startsWith('app:')) return { files: [] };
      const appId = scope.slice(4);
      const status = await engine.repositories.statusApp(appId);
      const from = ref || status.oid;
      if (!from) return { files: [] };
      const result = await engine.repositories.diffApp(appId, { from });
      return { files: result.files, ref: from };
    },
  };

  const makeDriver = (/** @type {Record<string,any>} */ assembly) => {
    const driver = makeTurnAuthorityDriver(assembly);
    live.runAgentTurn = driver.runAgentTurn;
    live.maybeAutoResume = driver.maybeAutoResume;
    return driver;
  };
  const makeDriverDeps = (/** @type {Record<string,any>} */ shared) => ({
    vault: deps.vault, VaultLockedError, sessionCache: deps.sessionCache,
    ensureActiveProvider, resolvePermission, sessions: shared.sessions,
    turnSlots: shared.turnSlots,
    memory: shared.memory, browser: deps.browser,
    skillRegistry, buildToolContext,
    // why: the turn authority needs the build-pinned exact-operation subset
    // beside descriptors. The descriptors-only helper remains for local
    // catalog consumers that have no authority role.
    projectToolDescriptors: projectToolSurface,
    settingsStore: deps.settingsStore,
    DWEB_ENABLED: deps.dwebEnabled,
    dwebEngagedSessions,
    markDwebEngaged: (/** @type {string} */ sessionId) => {
      if (sessionId) dwebEngagedSessions.add(sessionId);
    },
    maybeNudgeDebuggerGrant,
    uiConnected, uiPorts: shared.uiPorts, auditLog: deps.auditLog,
    postChatNote: deps.postChatNote,
    trimEnricher: live.trimEnricher,
    getDenylist: () => deps.denylist.patterns(),
    drainRecoveryNotices: (/** @type {string} */ sessionId) =>
      lifecycleBoot.drainNoticesFor(sessionId),
    getActorIsolation: () => live.actorIsolation,
    waitForActorIsolation: () => live.actorIsolationReady,
    getRuntimeCapabilities: () => runtimeCapabilities,
    // why: user-hook source is semantic configuration. Send a bounded snapshot
    // to the sealed realm instead of compiling executable hook functions in SW.
    getUserHookRecords: () => deps.kv.get('hooks.user.v1'),
    completeGoalRun: (/** @type {string} */ sessionId, /** @type {string} */ summary) =>
      goalRunner?.complete(sessionId, summary) ?? false,
    reconcilePrewalk: live.prewalk.reconcile,
    maybePrewalkSwap: live.prewalk.maybeSwap,
    reconcileEngineActor: live.prewalk.reconcileEngineActor,
  });
  const makeRouteDeps = (/** @type {Record<string,any>} */ shared) => ({
    turn: {
      vault: deps.vault, auditLog: deps.auditLog, sessions: shared.sessions,
      sessionCache: deps.sessionCache, turnSlots: shared.turnSlots,
      makeAgentSendCustody, pushState: deps.pushState, buildToolContext,
      applyComposer, commandSources, prepareUserAttachmentsWithDocs,
      convertDocAttachment: docOffscreenClient
        ? async (/** @type {any} */ attachment) => {
          if (!attachment?.data) throw new Error('the file was empty');
          const { doc } = await docOffscreenClient.extract({
            bytesB64: attachment.data, name: attachment.name,
            contentType: attachment.mediaType,
          });
          if (!doc) throw new Error('the file did not contain a supported structured document');
          return formatDocBody({
            doc, maxChars: DOC_TEXT_MAX_CHARS, source: attachment.name,
          });
        } : null,
      runInit: () => live.init.runInit(), handleSystemCommand, handleToolsCommand,
      postChatNote: deps.postChatNote, spawnActor: live.spawnActor,
      browser: deps.browser, ensureSession: ensureCurrentSession,
      actorRecoveryReady: () => live.actorRecoveryGate.ready(),
      actorMessaging: live.actorMessaging,
      actorLifecycle: live.actorLifecycle, settingsStore: deps.settingsStore,
      contextSnapshots, assembleDebugBundle, childSessionIdsOf,
      CHANNEL: deps.channel,
    },
    session: {
      vault: deps.vault, auditLog: deps.auditLog, pushState: deps.pushState,
      sessions: shared.sessions, sessionCache: deps.sessionCache,
      autoMemory: live.autoMemory,
      resolvePermission, normalizeMode, normalizeConfirmActions,
      SessionNotFoundError, maybeAutoResumeAfterRecovery: (/** @type {string} */ sessionId) =>
        live.actorRecoveryGate.runWhenReady(
          `auto-resume:${sessionId}`,
          () => live.maybeAutoResume(sessionId),
        ),
      turnSlots: shared.turnSlots, actorMessaging: live.actorMessaging,
      nukeSessionWorkspace: (/** @type {string} */ sessionId) =>
        engine.opfsHelpers(['peerd-workspace', sessionId]).nuke(),
      purgeLifecycleSession: (/** @type {string} */ sessionId) =>
        lifecycleBoot.purgeSession(sessionId),
    },
    isolation: {
      retryActorIsolation: async () => {
        await live.actorIsolationReady;
        if (!actorIsolationAvailable(live.baseActorIsolation) || !actorClient) {
          return actorIsolationRefusal(live.baseActorIsolation);
        }
        const result = await actorClient.run({
          actorSessionId: '__actor_isolation_probe__', message: '', systemPrompt: '',
          provider: '', model: '', probeOnly: true,
        });
        if (!result?.ok) {
          live.actorIsolation = actorIsolationTemporarilyUnavailable(
            live.baseActorIsolation, result?.error ?? 'actor worker startup failed',
          );
          let persisted = true;
          try {
            await live.actorIsolationState?.markUnavailable(
              live.baseActorIsolation,
              result?.error ?? 'actor worker startup failed',
              result?.code ?? 'unknown',
            );
          } catch { persisted = false; }
          deps.auditLog.append({
            type: 'actor_isolation_retry_failed',
            details: {
              host: live.baseActorIsolation.host, code: result?.code ?? 'unknown',
              performed: false, persisted,
            },
          }).catch(() => {});
          await deps.pushState();
          return { ...actorIsolationRefusal(live.actorIsolation), cause: result?.error ?? null };
        }
        try {
          await live.actorIsolationState?.clear(live.baseActorIsolation);
        } catch (cause) {
          live.actorIsolation = actorIsolationTemporarilyUnavailable(
            live.baseActorIsolation, cause,
          );
          deps.auditLog.append({
            type: 'actor_isolation_retry_failed',
            details: {
              host: live.baseActorIsolation.host,
              code: 'actor_isolation_state_clear_failed', performed: false, persisted: true,
            },
          }).catch(() => {});
          await deps.pushState();
          return { ...actorIsolationRefusal(live.actorIsolation), cause: live.actorIsolation.reason };
        }
        live.actorIsolation = live.baseActorIsolation;
        deps.auditLog.append({
          type: 'actor_isolation_restored',
          details: {
            host: live.actorIsolation.host, realmVerified: true, extensionApisPresent: false,
          },
        }).catch(() => {});
        await deps.pushState();
        return { ok: true, capability: { ...live.actorIsolation } };
      },
    },
  });

  return Object.freeze({
    buildToolContext, makeActorRuntime, makeDriverDeps, makeRouteDeps, makeDriver,
    makeGoals: makeGoalRunner, goalMaxIterations: GOAL_MAX_ITERATIONS,
  });
};
