// @ts-check
// Background-only public surface.
//
// The universal index also serves pages and components, so importing it from
// an MV3 worker links UI-only dependencies such as Mithril and CodeMirror
// before any background listener can register. Keep this barrel exact to
// the service worker's needs; the link-integrity meta test prevents drift.

export { createSessionStore } from './sessions/store.js';
export { learnedOriginCovers } from './actor/origin-sensitivity.js';
export { AUTH_BOUNDARY_STOPPED_MESSAGE, AUTH_STATE_UNAVAILABLE_MESSAGE, AUTH_WAITING_FOR_USER_MESSAGE } from './actor/auth-wait.js';
export { detectInterruptedTurn, RESUME_NUDGE } from './loop/resume-detect.js';
export { prepareUserAttachmentsWithDocs, DOC_TEXT_MAX_CHARS } from './loop/attachments.js';
export { formatDocBody } from './doc/format.js';
export { makeSpawnActor, restrictCtxCapabilities, finalActorTurnReply, finalAssistantText } from './actor/spawn.js';
export {
  activityOverlayInjected, clearActivityOverlayInjected,
} from './dom/activity-overlay-injected.js';
export { createRefRegistry } from './dom/ref-registry.js';
export { pullInHintInjected } from './dom/pull-in-hint-injected.js';
export { installFetchTapInjected, drainFetchTapInjected } from './dom/fetch-tap-injected.js';
export { isDenylistedTab, liveDocumentLocationInjected } from './browser-authority/dom-helpers.js';
export { SessionNotFoundError } from './errors.js';
export {
  registerTool,
  getTool,
  listTools,
} from './tools/registry.js';
export {
  registerMetadataInventory,
  getToolDescriptor,
  listToolDescriptors,
} from './tools/metadata-registry.js';
export { mainAgentDescriptors, filterByDwebEnabled, filterByDwebActive, filterByGoalActive, actorAllowedToolsFor, EXPOSURE_ACTOR, pinActorCall, actorDescriptors } from './tools/exposure.js';
export { resolveManifestAllow, manifestLabel, filterDescriptorsByManifest } from './tools/manifests.js';
export { resolveRuntimeCapabilities, filterByRuntimeCapabilities, requireRuntimeCapability } from './runtime-capabilities.js';
export { makeGoalRunner, GOAL_MAX_ITERATIONS } from './loop/goal-runner.js';
export { makeScheduler, SCHEDULE_ALARM_NAME } from './loop/scheduler.js';
export { formatTodoBlock } from './todo/core.js';
export { makePrewalkController } from './loop/prewalk-controller.js';
export { makeToolsCommand } from './tools/manifest-command.js';
export {
  executePreparedToolCall, prepareToolCall, settleToolCall,
} from './tool-authority.js';
export { BUILTIN_TOOLS } from './tools/defs/index.js';
export { makeLifecycleBoot } from './lifecycle/boot.js';
export { makeDispatchTracker, makeFailClosedTracker } from './lifecycle/dispatch-tracking.js';
export { makeWriteGuard } from './lifecycle/write-guard.js';
export { makeEngineLiveness } from './lifecycle/engine-liveness.js';
export { retryClassForTool } from './lifecycle/tool-retry-class.js';
export { projectToolAuthority } from './tools/metadata/descriptor.js';
export { applyStoreBootPosture, VERSION_STAMP_KEY } from './lifecycle/store-registry.js';
export { migrationBlockedReport } from './lifecycle/recovery-report.js';
export { classifyFailure } from './observability/failure-classify.js';
export { registerHook, listHooks, loadUserHooks, saveUserHook, removeHook, exportHooks } from './tools/hooks/registry.js';
export { parseHookMarkdown } from './tools/hooks/compile.js';
export { DEFAULT_HOOKS } from './tools/hooks/defaults/index.js';
export { buildTemporalBlock } from './clock/context.js';
export { WEB_TOOLS } from './tools/web/index.js';
export { createCommandStore } from './composer/command-store.js';
export { localStoreSource, skillRegistrySource, mergeSources } from './composer/command-sources.js';
export { applyComposer } from './composer/apply.js';
export { createMemoryStore } from './memory/store.js';
export { makeInitOrchestrator } from './memory/init-orchestrator.js';
export { USER_DOC_SCOPE, seedUserDocBody } from './memory/user-doc.js';
export { createSuggestionStore } from './memory/suggestions.js';
export { makeAutoMemory } from './memory/auto-memory-orchestrator.js';
export { appendNoteToUserDoc } from './memory/auto-memory.js';
export { makeCheapCall } from './actor/cheap-call.js';
export { makeTrimEnricher } from './loop/summary-enrichment.js';
export { makeTurnSlots } from './loop/turn-slots.js';
export { makeTurnAuthorityDriver } from './loop/turn-authority-driver.js';
export { createProfileStore } from './profiles/store.js';
export { createContactsStore } from './contacts/store.js';
export { PERMISSION_MODES, ACTION_CLASSES, classifyAction, decideAction, normalizeMode, normalizeConfirmActions, confirmActionsFromRecord } from './permissions/policy.js';
export { normalizeTally, addUsage, limitExceeded } from './cost/accumulator.js';
export { makeTurnCostTracker } from './cost/turn-tracker.js';
export { buildExport, inspectImport, applyImport, ExportPassphraseError, EXPORT_PASSPHRASE_MIN_LENGTH, isCustodySecretName } from './transfer/transfer.js';
export { createSiteClientStore } from './site-clients/store.js';
export { resolveSiteUrl, buildMintInjection } from './site-clients/core.js';
export { digestCapture, shapeSketch } from './site-clients/digest.js';
export { createResultStore } from './tools/result-store.js';
export { SPILL_CACHE_MAX_ENTRIES } from './tools/web/spill.js';
export { SkillParseError } from './skills/parse.js';
export { createSkillStore } from './skills/store.js';
export { createSkillRegistry, SkillExistsError } from './skills/registry.js';
export { installFromLocal, installFromGit, installFromManifest, SkillInstallError } from './skills/install.js';
export { loadSkillTool } from './skills/load-skill-tool.js';
export { normalizeVariant, normalizeEngine } from './voice/settings.js';
export { wrapUntrusted } from './tools/prompt-wrap.js';
export { makeAsyncActors } from './actor/async-actors.js';
export { makeActorMessaging } from './actor/actor-messaging.js';
export { buildAncestry } from './actor/delegation-lineage.js';
export { actorIsolationCapability, actorIsolationAvailable, actorIsolationTemporarilyUnavailable, actorIsolationRefusal, actorIsolationSpawnRefusal, filterByActorIsolation, actorIsolationPromptBlock } from './actor/isolation.js';
export { actorsCallToOp, shapeActorsResult, askOutcome, ACTORS_ASK_DEFAULT_TIMEOUT_MS, ACTORS_RUN_MAX_OPS, ACTORS_TRACE_TARGET_MAX_CHARS, ACTORS_TRACE_ERROR_MAX_CHARS } from './actor/actors-api.js';
export { canonicalCodeTraceLabel, DWEB_INBOUND_TOOL_NAMES, resolveWebActorSurface, resolveWebActorSurfaceDecision } from './actor/capability-manifest.js';
export { browserNetworkGuardUnavailableResult, classifyBrowserAutomationTarget, isAddressableBrowserTab } from './tools/browser-automation-policy.js';
export { validateProviderCallArgs, providerQuotaError, foldProviderEvents } from './actor/provider-call-api.js';
export { makeMeshDispatch } from './actor/a2a-dispatch.js';
export { meshCallToOp, shapeMeshResult } from './actor/a2a-api.js';
export { createConversationRegistry } from './actor/conversation-registry.js';
export { makeWebActorTabBindings, makeWebActorRegistry, retireStoppedRoamingWebActorDurably, safeWebActorSummaryOrigin, fenceWebActorSummary, makeApiActorBindings, normalizeApiOrigin, fenceApiActorSummary, siteHandleFor, parseSiteHandle } from './actor/web-actor.js';
export { makeOriginStateStore } from './actor/origin-state-store.js';
export { makeLearnedOrigins } from './actor/learned-origins.js';
export { makeJudgeLanding, makeCredentialScope, makeSignInOriginAuthorizer, makeSignInExcursionAuthorizer, makeSignInExcursionRevoker, makeSiteClientOriginGuard, makeSiteClientOriginAuthorizer, makeFixedSiteClientOriginGuard, authorizeSiteClientRelayOrigin, hasDurableSiteClientState } from './actor/origin-lock.js';
export { decideNumericTabAuthority, numericTabAuthorityRefusal, IDENTITY_PROVIDER_TRANSIT_ONLY_CODE } from './actor/numeric-tab-authority.js';
export { isKnownIdp, isKnownIdpHost, knownIdpDomains } from './actor/idp-registry.js';
export { describeLandingStop, landingStopCard, originPhrase } from './actor/origin-lock-report.js';
export { isUgcHost } from './actor/ugc-registry.js';
export { groupResourceLossNotices } from './lifecycle/resource-recovery.js';
export { assembleDebugBundle, childSessionIdsOf } from './observability/debug-bundle.js';
export {
  shapeSessionsSurface, applySessionsSurface, shapeMemorySurface,
  shapeSettingsSurface, captureAppsSurface, applyAppsSurface,
  SurfaceApplyPartialError,
} from './transfer/self-sync-surfaces.js';
