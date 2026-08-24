// @ts-check

import {
  ACTORS_RUN_MAX_OPS,
  ACTORS_ASK_DEFAULT_TIMEOUT_MS,
  ACTORS_TRACE_ERROR_MAX_CHARS,
  ACTORS_TRACE_TARGET_MAX_CHARS,
  actorsCallToOp,
  askOutcome,
  actorAllowedToolsFor,
  actorDescriptors,
  actorIsolationAvailable,
  actorIsolationCapability,
  actorIsolationRefusal,
  applyComposer,
  assembleDebugBundle,
  buildAncestry,
  buildTemporalBlock,
  BUILTIN_TOOLS,
  childSessionIdsOf,
  CLOCK_TOOLS,
  confirmActionsFromRecord,
  createCommandStore,
  createRunCacheStore,
  createSkillRegistry,
  createSkillStore,
  decideAction,
  detectInterruptedTurn,
  dispatchToolCall,
  DWEB_INBOUND_TOOL_NAMES,
  EXPOSURE_ACTOR,
  EXPOSURE_REVIEW,
  filterByDwebActive,
  filterByDwebEnabled,
  filterByGoalActive,
  filterByRuntimeCapabilities,
  filterDescriptorsByManifest,
  foldProviderEvents,
  finalActorTurnReply,
  getTool,
  listTools,
  loadSkillTool,
  localStoreSource,
  mainAgentDescriptors,
  makeActorMessaging,
  makeInitOrchestrator,
  makeSpawnActor,
  makeRequestReview,
  makeScheduler,
  makeCheapCall,
  makeAutoMemory,
  createSuggestionStore,
  makeTrimEnricher,
  makeToolsCommand,
  makeTurnCostTracker,
  manifestLabel,
  mergeSources,
  normalizeConfirmActions,
  normalizeTally,
  normalizeMode,
  limitExceeded,
  makeDispatchTracker,
  makeFailClosedTracker,
  makeLifecycleBoot,
  retryClassForTool,
  classifyFailure,
  PERMISSION_MODES,
  pinActorCall,
  prepareUserAttachmentsWithDocs,
  providerQuotaError,
  registerTool,
  resolveManifestAllow,
  shapeActorsResult,
  restrictCtxCapabilities,
  skillRegistrySource,
  SessionNotFoundError,
  resolveRuntimeCapabilities,
  resolveWebActorSurface,
  makeWebActorTabBindings,
  makeWebActorRegistry,
  makeApiActorBindings,
  normalizeApiOrigin,
  safeWebActorSummaryOrigin,
  siteHandleFor,
  parseSiteHandle,
  fenceWebActorSummary,
  fenceApiActorSummary,
  makeOriginStateStore,
  makeJudgeLanding,
  makeCredentialScope,
  makeSignInOriginAuthorizer,
  makeSignInExcursionAuthorizer,
  makeSignInExcursionRevoker,
  makeSiteClientOriginGuard,
  makeSiteClientOriginAuthorizer,
  makeFixedSiteClientOriginGuard,
  hasDurableSiteClientState,
  isKnownIdp,
  isKnownIdpHost,
  isUgcHost,
  describeLandingStop,
  landingStopCard,
  originPhrase,
  retireStoppedRoamingWebActorDurably,
  createSiteClientStore,
  createToolboxStore,
  makeToolboxParseCheck,
  createRefRegistry,
  WEB_TOOLS,
  validateProviderCallArgs,
  wrapUntrusted,
} from '/peerd-runtime/background.js';
import {
  callModel,
  contextWindowFor,
  hasPricing,
  listProviders,
  planFailoverChain,
  shouldFailover,
} from '/peerd-provider/background.js';
import {
  HARDCODED_ALLOWLIST,
  makeAgentSendCustody,
  makeSafeFetch,
  makeWebFetch,
  matchesDenylist,
  VaultLockedError,
  withSessionScopedCredentials,
} from '/peerd-egress/background.js';
import { createActorLiveProjection } from './actor-live-projection.js';
import { makeDirectActorHost } from './direct-actor-host.js';
import { makeOffscreenActorChannelClient, selectExactActorHostClient } from './offscreen-actor-channel-client.js';
import { makeOffscreenActorClient } from './offscreen-actor-client.js';
import { makeOffscreenDocClient } from './offscreen-doc-client.js';
import { makeOffscreenJsClient } from './offscreen-js-client.js';
import { makeOffscreenPdfClient } from './offscreen-pdf-client.js';
import { makeOffscreenWebClient } from './offscreen-web-client.js';
import { createScriptRunRegistry } from './script-runs.js';
import { makeAppActorChatHandler } from './app-actor-chat.js';
import { createContextSnapshots } from './context-snapshots.js';
import { makeScriptModelCallRoute } from './script-model-call.js';
import { makePageCallHandler } from '/peerd-runtime/background.js';
import { makeActorsRoutes } from './routes/actors.js';
import { makeOriginLockResolver } from './origin-lock-controller.js';
import { CHANNEL_DEFAULTS } from '/shared/channel-config.js';

const REASONING_BUDGET_TOKENS = 2048;
const REASONING_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
let toolsRegistered = false;

const registerTools = () => {
  if (toolsRegistered) return;
  for (const tool of [...BUILTIN_TOOLS, ...CLOCK_TOOLS, ...WEB_TOOLS, loadSkillTool]) {
    registerTool(/** @type {any} */ (tool));
  }
  toolsRegistered = true;
};

const originOf = (/** @type {string} */ value) => {
  try { return new URL(value).origin; }
  catch { return ''; }
};

/** @param {Record<string,any>} deps */
export const createKernelTurnLiveFactories = (deps) => {
  if (!deps?.engine || !deps.browser || !deps.vault || !deps.settingsStore
      || !deps.seams || !deps.confirmation || !deps.denylist) {
    throw new TypeError('kernel-turn-live-config-invalid');
  }
  registerTools();
  const engine = deps.engine;
  const scriptRuns = createScriptRunRegistry({ actorOpLimit: ACTORS_RUN_MAX_OPS });
  const projection = createActorLiveProjection();
  const contextSnapshots = createContextSnapshots();
  const skillRegistry = createSkillRegistry({
    store: createSkillStore({ canWrite: () => deps.canWrite('skills') }),
    audit: deps.auditLog.append,
  });
  const commandStore = createCommandStore({ kv: deps.kv });
  const commandSources = mergeSources([
    localStoreSource(commandStore), skillRegistrySource(skillRegistry),
  ]);
  const safeFetch = makeSafeFetch({
    getAllowlist: () => [...HARDCODED_ALLOWLIST],
    audit: deps.auditLog.append,
  });
  const webFetch = makeWebFetch({
    getDenylist: () => deps.denylist.patterns(),
    matchDenylist: matchesDenylist,
    audit: deps.auditLog.append,
  });
  const runtimeCapabilities = resolveRuntimeCapabilities({
    offscreenDocument: !deps.firefox,
    dwebPackaged: deps.dwebEnabled,
  });
  const dwebEngagedSessions = new Set();
  const userEndpoints = new Set();
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
  const originStates = makeOriginStateStore({
    save: async (sessionId, state) => {
      if (live) await live.shared.sessions.update(sessionId, { originState: state });
    },
  });
  const siteClientStore = createSiteClientStore();
  const toolboxStore = createToolboxStore();
  const toolboxParseCheck = makeToolboxParseCheck({
    buildModule: deps.buildToolboxModule ?? (async () => ({ code: '' })),
    readSibling: async (name) => await toolboxStore.getBody(name) ?? '',
    remoteModulesEnabled: deps.remoteModuleImportsEnabled === true,
  });
  const domRefs = createRefRegistry();
  const webCache = createRunCacheStore();
  const persistEntries = (/** @type {string} */ key, /** @type {any} */ store) => () =>
    deps.sessionCache.sessionSet(key, store.entries()).catch(() => {});
  const persistWebBindings = persistEntries('webActorTabBindings', webActorTabBindings);
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
    const names = await deps.vault.listSecretNames?.().catch(() => []) ?? [];
    for (const name of names) {
      if (!String(name).startsWith('origin:')) continue;
      const origin = normalizeApiOrigin(String(name).slice(7));
      if (origin) keyedOrigins.add(origin);
    }
  };
  const sensitivitySignals = () => ({
    isKnownIdp: isKnownIdpHost,
    isUgcZone: isUgcHost,
    hasVaultSecret: (/** @type {string} */ origin) => keyedOrigins.has(origin),
    getLearned: () => new Set(),
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
    const providers = listProviders();
    const entry = providers.find((provider) => provider.name === settings.providerName)
      ?? providers.find((provider) => provider.keyless)
      ?? providers[0];
    if (!entry) throw new Error('no-provider');
    return { name: entry.name, model: settings.providerModel || entry.defaultModel };
  };
  const ensureActiveProvider = async () => {
    const configured = resolveActiveProvider();
    const provider = listProviders().find((entry) => entry.name === configured.name);
    if (provider?.keyless) return configured;
    if (provider?.vaultSecretName && await deps.vault.getSecret(provider.vaultSecretName).catch(() => null)) {
      return configured;
    }
    for (const candidate of listProviders()) {
      if (candidate.keyless) return { name: candidate.name, model: candidate.defaultModel };
      if (candidate.vaultSecretName
          && await deps.vault.getSecret(candidate.vaultSecretName).catch(() => null)) {
        return { name: candidate.name, model: candidate.defaultModel };
      }
    }
    return configured;
  };
  const resolvePermission = async (/** @type {any} */ session) => ({
    mode: normalizeMode(session?.permissionMode
      ?? await deps.sessionCache.sessionGet('currentPermissionMode')
      ?? PERMISSION_MODES.ACT),
    confirmActions: normalizeConfirmActions(confirmActionsFromRecord(session)
      ?? confirmActionsFromRecord({
        confirmActions: await deps.sessionCache.sessionGet('currentConfirmActions'),
      }) ?? false),
  });
  const providerSecret = (/** @type {string} */ name) =>
    listProviders().find((provider) => provider.name === name)?.vaultSecretName ?? 'anthropic';
  const foldSessionCost = async (/** @type {string} */ sessionId,
    /** @type {any} */ usage, /** @type {number} */ amount) => {
    const session = await live.shared.sessions.get(sessionId);
    const prior = session?.cost ?? {};
    await live.shared.sessions.update(sessionId, {
      cost: {
        inputTokens: (prior.inputTokens ?? 0) + (usage.inputTokens ?? 0),
        outputTokens: (prior.outputTokens ?? 0) + (usage.outputTokens ?? 0),
        cacheReadTokens: (prior.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
        cacheWriteTokens: (prior.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        cost: (prior.cost ?? 0) + amount,
      },
    });
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
  const pdfOffscreenClient = deps.firefox ? null : makeOffscreenPdfClient({
    ensureOffscreen: deps.featureHost.ensureOffscreen,
    sendMessage: (message) => hostMessage(message, 'pdf-extract-demand'),
  });
  const docOffscreenClient = deps.firefox ? null : makeOffscreenDocClient({
    ensureOffscreen: deps.featureHost.ensureOffscreen,
    sendMessage: (message) => hostMessage(message, 'document-extract-demand'),
  });
  const webOffscreenClient = deps.firefox ? null : makeOffscreenWebClient({
    ensureOffscreen: deps.featureHost.ensureOffscreen,
    sendMessage: (message) => hostMessage(message, 'web-extract-demand'),
  });
  const runCache = createRunCacheStore();

  const buildToolContext = async (/** @type {any} */ options = {}) => {
    const shared = live.shared;
    const denylistReady = await deps.denylist.ready();
    if (!denylistReady?.ok) throw new Error('sensitive-origin policy unavailable');
    await lifecycleArmed;
    await deps.syncDenylistNetwork();
    const sessionId = options.sessionId
      ?? await deps.sessionCache.sessionGet('currentSessionId');
    const session = sessionId ? await shared.sessions.get(sessionId) : null;
    const permission = await resolvePermission(session);
    const toolAllow = resolveManifestAllow(session?.toolManifest);
    /** @type {any} */
    let activeTab;
    if (options.activeTabId != null) {
      const tab = await deps.browser.tabs.get(options.activeTabId).catch(() => null);
      if (tab) activeTab = {
        id: tab.id, windowId: tab.windowId, url: tab.url ?? '', origin: originOf(tab.url ?? ''),
      };
    } else if (options.exposure !== EXPOSURE_ACTOR) {
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
    const actorSurface = actorType === 'app'
      ? (requestedActorSurface === 'code' ? 'code' : 'tools')
      : actorType === 'web' && actorBacking !== 'api'
        ? resolveWebActorSurface({
          requested: requestedActorSurface,
          allowedTools: toolAllow,
          headlessAvailable: !deps.firefox,
        }) : undefined;
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
      toolAllow,
      toolManifestLabel: toolAllow ? manifestLabel(session?.toolManifest) : null,
      session: {
        sessionId: sessionId ?? null, depth: session?.depth ?? 0,
        kind: session?.kind ?? 'chat',
        messageCount: session?.messages?.length ?? 0,
        trimCovered: session?.trimSummary?.covered ?? 0,
      },
      permission,
      activeTab,
      onToolActivity: shared.pageActivity,
      spawnActor: (/** @type {any} */ request) => live.spawnActor(request),
      messageActor: (/** @type {any} */ request) => live.actorMessaging.messageActor(request),
      scriptRuns,
      requestReview: (/** @type {any} */ request) => live.requestReview(request),
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
      pdfOffscreenClient,
      docOffscreenClient,
      webOffscreenClient,
      runCache,
      tabs: deps.browser.tabs,
      scripting: deps.browser.scripting,
      debuggerPool: deps.advancedAutomationOn?.() ? deps.debuggerPool : undefined,
      cdpUnavailableReason: deps.advancedAutomationOn?.()
        ? null : deps.browser.debugger ? 'setting_off' : 'browser_unsupported',
      domRefs,
      ensureBrowserNetworkGuard: deps.ensureBrowserNetworkGuard,
      updateBrowserNetworkGuardOrigin: deps.updateBrowserNetworkGuardOrigin,
      acquireBrowserNetworkGuardLease: deps.acquireBrowserNetworkGuardLease,
      releaseBrowserNetworkGuardLease: deps.releaseBrowserNetworkGuardLease,
      consumeBrowserChildPolicyNotice: deps.consumeBrowserChildPolicyNotice,
      waitForBrowserChildPolicyNotice: deps.waitForBrowserChildPolicyNotice,
      hasPendingBrowserChildPolicy: deps.hasPendingBrowserChildPolicy,
      noteTab: deps.noteAgentTab,
      hintPullIn: deps.scheduleWebTabHint,
      ...(actorType === 'web' && actorBacking !== 'api'
        ? { adoptWebTab: () => live.adoptWebTab(sessionId) } : {}),
      noteLearnedOrigin: deps.noteLearnedOrigin ?? (() => {}),
      listApiIntegrations: () => live.listApiIntegrations(sessionId),
      safeFetch,
      webFetch,
      webCache,
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
      toolbox: toolboxStore,
      toolboxParseCheck,
      denylist: Object.freeze([...deps.denylist.patterns()]),
      allowlist: Object.freeze([...HARDCODED_ALLOWLIST, ...userEndpoints]),
      provider: {
        name: providerName,
        model: session?.model ?? resolveActiveProvider().model,
        hasKey: !!(await deps.vault.getSecret(providerSecret(providerName)).catch(() => null)),
      },
      vault: { isLocked: deps.vault.isLocked() },
      now: Date.now,
    };
    if (options.exposure !== EXPOSURE_ACTOR) return ctx;
    const restricted = /** @type {any} */ (restrictCtxCapabilities(
      ctx,
      new Set(actorAllowedToolsFor(actorType, actorBacking, actorSurface)),
    ));
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
      restricted.siteCapture = deps.siteCapture;
    }
    return restricted;
  };

  return Object.freeze({ buildToolContext });
};
