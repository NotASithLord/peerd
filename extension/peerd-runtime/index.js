// @ts-check
// peerd-runtime — public surface.
//
// V1 — agent loop (no tools) + sessions. Profiles land V1.2. Tool
// registry/dispatcher land V1 step 7. See ARCHITECTURE.md §2.4
// and TODO.md.
//
// Runtime takes every Layer 1 capability via dependency injection
// (callModel from provider, vault/safeFetch/appendAudit from egress,
// vmRun from engine). It never imports concrete adapters — see
// ARCHITECTURE.md §2.4 dependencies.

// --- agent loop ---------------------------------------------------------
export { runUserTurn } from './loop/agent-loop.js';
// auto-resume: detect a turn the SW reclaimed mid-flight (the read side);
// the SW drives a synthetic continuation when it says yes.
export { detectInterruptedTurn, RESUME_NUDGE } from './loop/resume-detect.js';
// Per-session turn slots — steer-live aborts stay inside one chat;
// streams in other conversations survive navigation + new sends.
export { makeTurnSlots } from './loop/turn-slots.js';
// The agent turn driver — runAgentTurn + maybeAutoResume with injected IO.
export { makeTurnAuthorityDriver } from './loop/turn-authority-driver.js';
// Goal mode (the mode-row Goal toggle): auto-continuing agent turns until the
// agent calls complete_goal (or the cap / Stop). loop/goal-runner.js.
export { makeGoalRunner, GOAL_MAX_ITERATIONS, goalContinuationPrompt } from './loop/goal-runner.js';
// Background scheduling: standing Routines that fire unattended on a cadence and
// catch up as soon as peerd is back on. loop/scheduler.js (runner) + schedule.js
// (pure math).
export { makeScheduler, SCHEDULE_ROUTINES_KEY, SCHEDULE_ALARM_NAME } from './loop/scheduler.js';
// The goal run's plan-of-record (session.todos) — pure list ops + the
// prompt-facing renderer the SW binds into the goal continuation.
export { initTodos, checkTodo, addTodo, nextPending, todoProgress, formatTodoBlock, MAX_TODO_ITEMS } from './todo/core.js';
// Prewalk (loop/prewalk.js): frontier model plans a goal run, a cheap
// executor inherits the live context at the first landed action. Pure
// policy — the SW owns the session writes and the run lifecycle.
export {
  resolvePrewalkExecutor, armPrewalk, shouldPrewalkSwap, markPrewalkSwapped, PREWALK_NUDGE,
} from './loop/prewalk.js';
// The prewalk lifecycle controller — the testable imperative shell the SW
// binds real IO into (arm / reconcile / maybeSwap / restore).
export { makePrewalkController } from './loop/prewalk-controller.js';
// Long-session context compression: the rolling trim-summary core +
// the post-turn enrichment shell the SW binds behind the loop's
// enrichTrimSummary seam.
export { planTrim, trimHistory } from './loop/trim.js';
export {
  emptySummaryState, normalizeSummaryState, foldDropped, mergeEnrichment,
  renderSummaryText, digestMessages, buildSummarizationTask,
  parseSummarizationResult,
  SUMMARY_MAX_ITEMS, SUMMARY_ITEM_MAX_CHARS, SUMMARY_MAX_CHARS,
} from './loop/rolling-summary.js';
export { makeTrimEnricher, ENRICHMENT_MAX_OUTPUT_TOKENS } from './loop/summary-enrichment.js';
// Pure scheduling for multi-tool turns: consecutive READ-class calls run
// concurrently, everything else stays serial. The loop consumes it; it's
// exported for tests and for the SW's lineage/debug surfaces.
export { partitionToolBatch } from './loop/tool-batch.js';
export { renderSystemPrompt, _setTemplateForTests } from './loop/system-prompt.js';
// File attachments — pure classify/validate/strip core. The SW validates
// agent/send payloads through it (fail closed); the side panel uses the
// same caps/classifier for instant pre-send feedback; the loop strips.
export {
  classifyAttachment, validateAttachment, validateAttachments,
  prepareUserAttachments, prepareUserAttachmentsWithDocs, convertDocAttachments,
  stripAttachment, stripAttachments,
  AttachmentConversionError, DOC_MEDIA_TYPES, DOC_EXTENSIONS, DOC_TEXT_MAX_CHARS,
  attachmentBytes, formatBytes,
  ATTACHMENT_CAPS, MAX_ATTACHMENTS_PER_MESSAGE, IMAGE_MEDIA_TYPES, PDF_MEDIA_TYPE,
  UnsupportedAttachmentError, AttachmentTooLargeError, TooManyAttachmentsError,
} from './loop/attachments.js';

// --- sessions -----------------------------------------------------------
export { createSessionStore } from './sessions/store.js';

// --- profiles (default-profile shape; ROADMAP "Profiles" deprioritized) --
// One 'default' record carrying peerName (the AI peer's display name —
// chat-transcript label only) + the first-run onboarding latch. The
// store API is already multi-profile shaped; nothing is namespaced yet.
export {
  createProfileStore,
  DEFAULT_PROFILE_ID, DEFAULT_PEER_NAME, PEER_NAME_MAX,
  normalizePeerName, defaultProfileRecord,
} from './profiles/index.js';

// --- contacts: the per-peer overlay (user name/notes/tags) keyed by did,
// plus the read-time "known peers + activity" aggregation. The store is core
// (a did is just an identity string); activity is derived from the App catalog
// + the audit log, so it stays correct whether or not the mesh is up.
export { createContactsStore, InvalidDidError } from './contacts/store.js';
export { mergeContacts } from './contacts/aggregate.js';
export {
  isPeerDid, peerDidFromUri, normalizeContactName,
  MAX_CONTACT_NAME, MAX_CONTACT_NOTES, MAX_CONTACT_TAGS,
} from './contacts/contact.js';

// --- cost/usage telemetry (feature 06) ----------------------------------
// Pure accumulation over token usage. The SW folds provider `usage` events
// into per-turn + per-session tallies, prices them via peerd-provider's
// local pricing table, and enforces an optional hard spend limit.
export {
  normalizeTally, addUsage, limitExceeded,
} from './cost/accumulator.js';

// The per-turn imperative shell over the accumulator: fold usage events,
// persist the session total, push the live meter, fire the hard-limit
// halt once. All IO injected; the SW's streaming switch stays two lines.
export { makeTurnCostTracker } from './cost/turn-tracker.js';

// --- spawned (orchestration over sessions; see docs/ACTORS.md) ------
export {
  makeSpawnActor, narrowTools, finalAssistantText, finalActorTurnReply,
  restrictCtxCapabilities, CAPABILITY_CONSUMERS,
  DEFAULT_MAX_DEPTH, DEFAULT_MAX_STEPS, DEFAULT_MAX_OUTPUT_TOKENS,
} from './actor/spawn.js';
// DESIGN-11: async (non-blocking) spawned — spawn returns a handle, the
// result re-enters the parent as a synthetic wake turn. Testable orchestrator.
export { makeAsyncActors } from './actor/async-actors.js';
// DESIGN-17: the message_actor orchestrator (the mailbox to a tab-hosted
// instance's actor — the async-actors shape, specialized).
export { makeActorMessaging } from './actor/actor-messaging.js';
export {
  actorIsolationCapability, actorIsolationAvailable,
  actorIsolationTemporarilyUnavailable, actorIsolationRefusal, actorIsolationSpawnRefusal,
  filterByActorIsolation, actorIsolationPromptBlock,
  ACTOR_ISOLATION_HOST_OFFSCREEN, ACTOR_ISOLATION_HOST_BACKGROUND,
  ACTOR_ISOLATION_UNAVAILABLE_TOOLS, ACTOR_ISOLATION_TEMPORARY_USER_FAILURE,
  ACTOR_ISOLATION_UNSUPPORTED_USER_FAILURE,
} from './actor/isolation.js';
// A2A — the agent-to-agent code surface: the pure translation + the mesh
// dispatch/correlation the a2a/call route runs.
export { meshCallToOp, shapeMeshResult } from './actor/a2a-api.js';
export {
  CODE_CLIENT_MANIFESTS, CODE_RUN_MAX_TRACE_OPS, ACTOR_CAPABILITY_MANIFESTS,
  DWEB_INBOUND_TOOL_NAMES, WEB_ACTOR_DOM_TOOL_NAMES, WEB_ACTOR_CODE_CLIENT_TOOL_NAMES,
  codeClientMethods, codeClientAllows, codeClientMethod, codeClientReference, buildCodeClientSource,
  renderCodeOpTrace, canonicalCodeTraceLabel,
  actorCapabilityManifest, resolveWebActorSurface, resolveWebActorSurfaceDecision,
} from './actor/capability-manifest.js';
export {
  actorsCallToOp, shapeActorsResult, renderTraceLines, traceErrorDetails,
  askOutcome, ACTORS_ASK_DEFAULT_TIMEOUT_MS, ACTORS_BRIDGE_GUARD_MS,
  ACTORS_RUN_MAX_OPS, ACTORS_ADDRESS_MAX_CHARS, ACTORS_GOAL_MAX_CHARS,
  ACTORS_TRACE_TARGET_MAX_CHARS, ACTORS_TRACE_ERROR_MAX_CHARS,
  ACTORS_API_METHODS, ACTORS_API_ACCEPTED_METHODS,
} from './actor/actors-api.js';
export { makeMeshDispatch } from './actor/a2a-dispatch.js';
// Design 5 — peerd.provider.call: the pure core (text-only arg validation,
// per-run quota arithmetic, event fold) the SW script/model-call relay runs.
// Only the three functions the relay consumes surface here (the a2a-api.js
// precedent); the error classes + constants stay module-internal.
export {
  validateProviderCallArgs, providerQuotaError, foldProviderEvents,
} from './actor/provider-call-api.js';
// Standing peer conversations — the pure thread registry (convId → turns),
// capped + TTL-evicted; the SW singleton drives inbound routing + reply consent.
export {
  createConversationRegistry,
  MAX_CONVERSATIONS, MAX_TURNS_PER_CONVERSATION, CONVERSATION_TTL_MS,
} from './actor/conversation-registry.js';
// PR #134: the trusted-lineage shell walk behind the actor sender gate. Pure
// (getRecord injected) so the fail-closed trust rules are unit-tested, not just
// exercised through the SW's inlined walk. The SW passes getRecord = sessions.get.
export { buildAncestry } from './actor/delegation-lineage.js';
// DESIGN-17: the WEB actor — the disposable page-driving agent (an
// `actorType:'web'` actor that owns one tab). Pure core: the tab→session
// bindings, the action-log rolling-summary prompt, the self-fence.
// DESIGN-18: the API actor is the same origin actor with NO tab; its
// origin-keyed bindings, normalizer, and "what I learned" summary live here too.
export {
  makeWebActorTabBindings, makeWebActorRegistry, retireStoppedRoamingWebActor,
  retireStoppedRoamingWebActorDurably,
  WEB_ACTOR_SUMMARY_PROMPT,
  safeWebActorSummaryOrigin, fenceWebActorSummary,
  makeApiActorBindings, normalizeApiOrigin, API_ACTOR_SUMMARY_PROMPT, fenceApiActorSummary,
  // issue 251: the SITE actor's handle — a web actor BOUND to one origin, with a
  // tab. Distinct from the bare-origin API handle on purpose: that one is
  // tab-free and can never log in.
  SITE_ACTOR_PREFIX, siteHandleFor, parseSiteHandle,
} from './actor/web-actor.js';
// issue 251: authority segmented by origin. A web actor is ROAMING (browses
// freely, holds nothing) or BOUND (owns one credentialed origin, like the API
// actor above). Two pure cores: which origins the user has an identity on, and
// what happens when a tab LANDS somewhere. Exported here because the enforcement
// points that will consume them live outside this module (background/).
export {
  classifyOriginSensitivity,
  learnedOriginCovers,
  sameOrigin,
  LEARNED_REASONS,
} from './actor/origin-sensitivity.js';
export {
  decideNumericTabAuthority, numericTabAuthorityRefusal,
  NUMERIC_TAB_SENSITIVE_CODE, NUMERIC_TAB_POLICY_UNAVAILABLE_CODE,
  IDENTITY_PROVIDER_TRANSIT_ONLY_CODE,
} from './actor/numeric-tab-authority.js';
export {
  RUNTIME_CAPABILITY_VERSION, resolveRuntimeCapabilities, runtimeCapabilityAvailable,
  runtimeCapabilityForTool, filterByRuntimeCapabilities, runtimeCapabilityRefusal,
  runtimeCapabilityPromptBlock, RuntimeCapabilityUnavailableError, requireRuntimeCapability,
} from './runtime-capabilities.js';
export { decideLanding, mayHoldCredentials, EXCURSION_BUDGET, EXCURSION_MS, MAX_EXCURSIONS } from './actor/landing-rule.js';
export {
  makeJudgeLanding, makeCredentialScope, makeSiteClientOriginGuard,
  makeSiteClientOriginAuthorizer, makeFixedSiteClientOriginGuard, makeSignInOriginAuthorizer,
  makeSignInExcursionAuthorizer, makeSignInExcursionRevoker,
  authorizeSiteClientRelayOrigin, mayAddressSiteClientOrigin,
  mayUseSiteClientOrigin, hasDurableSiteClientState,
} from './actor/origin-lock.js';
export {
  AUTH_WAITING_FOR_USER_CODE, AUTH_WAITING_FOR_USER_MESSAGE,
  AUTH_BOUNDARY_STOPPED_MESSAGE, AUTH_STATE_UNAVAILABLE_MESSAGE,
} from './actor/auth-wait.js';
// …and the three pieces the SW needs to make the lock live: where the state
// lives (cached + serialized + persisted), which origins are dedicated identity
// providers (the one narrow exemption), and what the orchestrator is told when
// an actor is stopped — text authored HERE, never by the actor or the page.
export { makeOriginStateStore } from './actor/origin-state-store.js';
export { makeLearnedOrigins, MAX_LEARNED } from './actor/learned-origins.js';
// #242's UGC registry, asked at ORIGIN level — the seed the origin lock wants.
// A UGC host is by construction a site people have accounts on; that is what
// made its content attacker-authorable in the first place.
export { isUgcHost } from './actor/ugc-registry.js';
export { isKnownIdp, isKnownIdpHost, knownIdpSeeds, knownIdpDomains } from './actor/idp-registry.js';
export { describeLandingStop, landingStopCard, originPhrase } from './actor/origin-lock-report.js';
// DESIGN-19: site clients — per-origin derived API clients. The pure core
// (validation, confirm-gated proposal, staleness header, fenced dossier, URL pin),
// the two-tier store, and the capture digester. See site-clients/index.js.
export {
  normalizeSiteOrigin, validateDossier, buildClientWriteProposal,
  stalenessHeader, fenceDossier, buildMintInjection, resolveSiteUrl, stampRecord,
  createSiteClientStore, digestCapture, redactHeaders, shapeSketch,
} from './site-clients/index.js';
// PR #119: the host-side handler for the web actor's code-REPL arm — turns a
// page.<method> RPC (made inside the sealed worker) into the SAME gated tool
// dispatch the tool-call web actor uses, pinned to the actor's owned tab.
// Cheap one-shot clean-context calls (auto-memory + trim enrichment):
// a tools:[] spawn with the spend-limit preflight and the cost fold
// into the parent session's tally built in.
export {
  makeCheapCall, CHEAP_CALL_MAX_STEPS, CHEAP_CALL_MAX_OUTPUT_TOKENS,
} from './actor/cheap-call.js';

// --- edit (SEARCH/REPLACE diff editing + checkpoint/undo) ---------------
export {
  parseEditBlocks, applyBlocks, applyEdit,
} from './edit/search-replace.js';
export {
  EditParseError, SearchNotFoundError, SearchAmbiguousError,
} from './edit/errors.js';
export {
  createSnapshotStore, createBrowserSnapshotStore, browserSnapshotIO,
} from './edit/snapshot-store.js';
export { createCheckpointManager } from './edit/checkpoint.js';
export {
  defaultWritePermissions, resolveCanWrite,
} from './edit/permissions-adapter.js';
// --- tools --------------------------------------------------------------
export {
  registerTool,
  getTool,
  listTools,
  clearTools,
} from './tools/registry.js';
export {
  registerMetadataInventory,
  getToolDescriptor,
  listToolDescriptors,
} from './tools/metadata-registry.js';
export { dispatchToolCall } from './tools/local-tool-dispatcher.js';
export { GATES } from './tools/gates.js';
export { BUILTIN_TOOLS } from './tools/defs/index.js';
export {
  mainAgentDescriptors, isHiddenFromMain, MAIN_AGENT_HIDDEN_TOOLS,
  filterByDwebEnabled, isDwebTool,
  filterByDwebActive, isDwebSecondaryTool, DWEB_SECONDARY_TOOLS,
  filterByGoalActive, isGoalOnlyTool, GOAL_ONLY_TOOLS,
  // DESIGN-17: the actor capability tier vocabulary.
  EXPOSURE_ACTOR, ACTOR_ONLY_TOOLS, isActorOnlyTool,
  actorAllowedTools, isAllowedForActorType, actorDescriptors, filterActorSurface,
  // DESIGN-18: backing-aware allow-set (an API actor has no DOM tools).
  actorAllowedToolsFor, isAllowedForActor,
  // Heap-split phase 2: the per-instance pin used by the privileged actor tool
  // relay (one implementation on a security seam).
  pinActorCall,
} from './tools/exposure.js';
// Per-session tool exposure manifests (ROADMAP) — presets-as-data + the
// pure resolve/filter helpers, plus the /tools command's functional core.
export {
  TOOL_MANIFEST_PRESETS, normalizeToolManifest, resolveManifestAllow,
  manifestLabel, filterDescriptorsByManifest,
} from './tools/manifests.js';
export { makeToolsCommand, describePresets } from './tools/manifest-command.js';
export { wrapUntrusted } from './tools/prompt-wrap.js';
// The script value-spill store (run cache) — the SW instantiates it and
// injects it into tool contexts (read_result pages it back).
export { createResultStore } from './tools/result-store.js';
// The shared spill-cache entry cap — the SW's web extract cache uses the same
// number as the run cache, imported from ONE home so the twins never drift.
export { SPILL_CACHE_MAX_ENTRIES } from './tools/web/spill.js';
// The one per-file OPFS write ceiling — js_write_file enforces it tool-side;
// the workspace relay (offscreen/job-runner.js) imports it from HERE so
// worker-side writes share the same number without a deep import.
export { MAX_FILE_CONTENT_CHARS } from './tools/defs/js-write-file.js';

// --- composer (slash commands + @-references + palette) -----------------
export {
  parseComposer, parseCommandName, parseCommandArgs, parseRefs, activeTrigger,
  score, filterCandidates,
  createCommandStore, isValidCommandName, COMMAND_KEY_PREFIX,
  localStoreSource, skillRegistrySource, mergeSources,
  decideTabGate, buildTabPayload, buildFilePayload,
  resolveTabRef, resolveFileRef, resolveAllRefs,
  applyComposer,
} from './composer/index.js';
// --- memory (V1.5 — file-based AGENTS.md, hierarchical scope) ------------
// Public store + pure core + /init drafter. Foundational for skills (07)
// and auto-memory (09): both wire onto createMemoryStore + the loader.
// memory/index.js sub-barrel was removed; source the public surface
// directly from the concrete files (intra-module deep imports are fine).
export { createMemoryStore } from './memory/store.js';
export {
  scopeId, normalizeWorkspace, normalizeSubpath, subpathInScope,
  countLines, normalizeBody, buildWriteProposal, lineDelta,
  assembleAlwaysLoaded, orderAlwaysLoaded, scopeHeader,
  initializerScope, seedInitializerBody, appendProgress,
  ALWAYS_LOADED_LINE_BUDGET, MAX_DOC_CHARS, INITIALIZER_SUBPATH,
} from './memory/memory.js';
export { draftAgentsMd, deriveChecklist, resolveWorkspaceKey } from './memory/initializer.js';
export { makeInitOrchestrator } from './memory/init-orchestrator.js';
export { USER_DOC_SCOPE, seedUserDocBody } from './memory/user-doc.js';
// Auto-memory: wrap-up extraction → pending suggestions → user
// approval into the user doc. See memory/auto-memory.js.
export {
  shouldExtract, substantiveStats, transcriptDigest,
  buildExtractionTask, parseExtractionNotes, dedupeAgainstDoc,
  appendNoteToUserDoc,
  AUTO_MEMORY_MIN_USER_TURNS, AUTO_MEMORY_MIN_NEW_USER_TURNS,
  AUTO_MEMORY_MIN_CHARS, MAX_NOTES_PER_EXTRACTION, NOTE_MAX_CHARS,
  MAX_PENDING_SUGGESTIONS,
} from './memory/auto-memory.js';
export { createSuggestionStore, SUGGESTIONS_KEY } from './memory/suggestions.js';
export { makeAutoMemory, EXTRACTION_MAX_OUTPUT_TOKENS } from './memory/auto-memory-orchestrator.js';

// --- hooks (pre/post-tool-use lifecycle) --------------------------------
// Foundational: features like plan/act and others register hooks here; the
// dispatcher runs them around execute(). The egress
// allowlist ships as a DEFAULT pre-tool-use hook (see DESIGN §10).
export {
  registerHook, listHooks, exportHooks,
  loadUserHooks, saveUserHook, removeHook, clearUserHooks,
  HOOKS_STORAGE_KEY,
  runPreToolUse, runPostToolUse, selectHooks, hookMatches,
  compileUserHook, parseHookMarkdown,
  DEFAULT_HOOKS, egressAllowlistHook, egressTripwireHook,
} from './tools/hooks/index.js';

// --- transfer (settings export/import; dual-distribution §10) -----------
// Explicit migration between installs and across channels. Pure shaping
// + passphrase crypto; the SW injects all IO (vault, memory, hooks, kv).
export {
  EXPORT_VERSION, EXPORT_FORMAT, EXPORT_PASSPHRASE_MIN_LENGTH,
  buildExport, inspectImport, applyImport,
  encryptWithPassphrase, decryptWithPassphrase,
  ExportPassphraseError, isCustodySecretName,
} from './transfer/transfer.js';

// The same-user device sync surfaces: the LOGICAL projection of each store
// that may cross to a proven self device, and its idempotent applier. The
// bytes move through the dweb module; deciding what a surface means is
// runtime work, so it lives here.
export {
  portableSession,
  shapeSessionsSurface, applySessionsSurface,
  shapeSettingsSurface, shapeProviderEndpointsSurface, shapeMemorySurface,
  shapeHooksSurface, shapeSkillsSurface, shapeSecretsSurface,
  shapeAppsSurface, captureAppsSurface, applyAppsSurface, SurfaceApplyPartialError,
  shapeWorkspacesSurface, applyWorkspacesSurface,
  encodeSurface, decodeSurface,
} from './transfer/self-sync-surfaces.js';

// The "Use my existing Peerd" flow, as a pure reducer + its copy table.
export {
  STEP_COPY, initialEnrollmentState, enrollmentStep, describeSurfaces, diagnostics,
} from './transfer/enrollment-flow.js';

// --- permissions (Plan/Act mode + confirm-actions toggle; Feature 03) ---
// The foundational write-authorization policy. Other features route every
// write through decideAction. Pure function — see permissions/policy.js.
export {
  PERMISSION_MODES, DEFAULT_PERMISSION_MODE,
  DEFAULT_CONFIRM_ACTIONS,
  ACTION_CLASSES, classifyAction, decideAction,
  normalizeMode, normalizeConfirmActions, confirmActionsFromRecord,
} from './permissions/index.js';
// --- skills (progressive-disclosure SKILL.md) ---------------------------
export {
  parseSkillMd, normalizeName, SkillParseError,
  createSkillStore,
  createSkillRegistry, SkillExistsError, SkillNotFoundError,
  installFromLocal, installFromGit, installFromManifest, resolveGitRawUrl, SkillInstallError,
  loadSkillTool,
} from './skills/index.js';

// --- clock (temporal grounding) -----------------------------------------
export {
  buildTemporalBlock,
} from './clock/index.js';

// --- web (capture wrapper) ----------------------------------------------
export {
  WEB_TOOLS,
} from './tools/web/index.js';
export { captureTool } from './tools/web/screenshot.js';

// --- voice (lightweight control/UI surface) -----------------------------
// The offscreen-only transcriber factory imports Moonshine and must never be
// reachable from this universal barrel: the MV3 worker evaluates it cold.
export { createVoiceManager } from './voice/manager.js';
export { createModelStore } from './voice/model-store.js';
export { detectVoiceCapability } from './voice/engine-picker.js';
export { MicButton } from './voice/mic-button.js';
export { normalizeVariant, normalizeEngine, VOICE_ENGINES } from './voice/settings.js';

// --- PDF engine (used internally by read_doc: pdf.js + opt-in OCR) ------
export {
  chooseEngine, looksScanned, requireEngine, DEFAULT_ENGINE, PDF_ENGINES,
  formatPdfBody, assemblePages, DEFAULT_MAX_CHARS,
  createOcrStore, hasValidOcrSris, OCR_ASSETS, OCR_TOTAL_BYTES,
  PdfFetchError, PdfParseError, OcrUnavailableError,
} from './pdf/index.js';

// --- doc (read_doc tool: office/publishing formats -> Markdown) ---------
export {
  convertToDocument, formatDocBody, toMarkdown, sniffDocFormat,
  isConvertible, isLegacyBinary, CONVERTIBLE,
  DocFetchError, DocParseError, UnsupportedDocFormatError,
  LegacyDocFormatError, ZipError,
} from './doc/index.js';

// --- dom navigation (a11y tree + element refs; diffable snapshots) ------
export {
  serializeAxTree,
  createRefRegistry,
  diffSnapshots,
  // Firefox-parity capture: CDP when the pool is wired, else the
  // chrome.scripting DOM-walk pseudo-snapshot. Same contract either way.
  captureSnapshot,
  describeSource,
  domWalkInjected,
  activityOverlayInjected,
  clearActivityOverlayInjected,
  ACTIVITY_OVERLAY_ID,
  pullInHintInjected,
  // DESIGN-19 Tap B — the MAIN-world fetch/XHR tap for site-client capture.
  installFetchTapInjected,
  drainFetchTapInjected,
} from './dom/index.js';
// Browser target classification and the location-only document probe are also
// used by the background-owned activity overlay before it injects UI.
export {
  browserNetworkGuardUnavailableResult,
  browserNetworkGuardPostNavigationResult,
  classifyBrowserAutomationTarget,
  isAddressableBrowserTab,
} from './tools/browser-automation-policy.js';
export { isDenylistedTab, liveDocumentLocationInjected } from './browser-authority/dom-helpers.js';

// --- lifecycle (the interruption/recovery contract's functional core) ---
// Canonical operation states + the retry-class recovery decision, SW/actor
// generations (authority never survives restart by assumption), single-use
// confirmation binding, the startup reconciler, versioned-store migration
// guard, the durable operation log, and the paired user/agent recovery
// reports. The vault session-mirror side of the contract already lives in
// peerd-egress/vault; this is the operation/authority side.
export {
  OPERATION_STATES, TERMINAL_STATES, isTerminal, isOperationState,
  canTransition, assertTransition, canRecoverySettle, IllegalTransitionError,
  COMPLETION_EVIDENCE, FAILURE_EVIDENCE,
  provesCompletion, provesFailure, resolveUnknownOutcome,
  UnknownOutcomeUnresolvedError,
} from './lifecycle/operation-state.js';
export {
  RETRY_CLASSES, isRetryClass, normalizeRetryClass, decideRecovery,
} from './lifecycle/retry-class.js';
export {
  mintGeneration, authorityValid, sweepStaleAuthority, acceptActorMessage,
} from './lifecycle/generation.js';
export {
  bindConfirmation, confirmationSatisfies, consumeConfirmation,
  normalizeConfirmationTarget, CONFIRMATION_TTL_MS,
} from './lifecycle/confirmation.js';
export {
  reconcileAtStartup, buildTurnRecoveryRecord,
} from './lifecycle/reconcile.js';
export {
  classifyStoreVersion, guardStore, runMigration,
} from './lifecycle/store-version.js';
export {
  LIFECYCLE_EVENTS, lifecycleAuditEntry, sanitizeDetail,
} from './lifecycle/audit-events.js';
export {
  createOperationLog,
  OperationNotFoundError, OperationExistsError, RetryRefusedError,
  OPERATION_LOG_KEY, OPERATION_LOG_MAX_TERMINAL, OPERATION_LOG_MAX_UNKNOWN,
} from './lifecycle/operation-log.js';
export {
  RECOVERY_CATEGORIES, categorizeRecovery, describeRecovery,
  securityDegradationReport, migrationBlockedReport,
} from './lifecycle/recovery-report.js';
// §16.1: every tool resolves to a retry class — explicit field, name
// override table, then the sideEffect/primitive taxonomy, failing closed
// to E. The inventory test asserts totality over the live tool set.
export { retryClassForTool, RETRY_CLASS_OVERRIDES } from './lifecycle/tool-retry-class.js';
// §9: passive, bounded reports for engine resources the live boot sweep lost.
export { groupResourceLossNotices } from './lifecycle/resource-recovery.js';
// §11.1/§12: independent per-store schema versions + durability tiers.
export {
  DURABILITY_TIERS, STORE_REGISTRY, VERSION_STAMP_KEY,
  storeEntry, portableStores, omittedDeviceBoundStores,
  checkStores, stampStores, applyStoreBootPosture,
} from './lifecycle/store-registry.js';
// §11.5 enforced: the SW wraps its kv/idb adapters through the guard once
// and a read-only verdict refuses writes at the shared chokepoint.
export { makeWriteGuard, StoreReadOnlyError } from './lifecycle/write-guard.js';
// §9: the durable engine-liveness ledger the tab trackers feed and the
// boot sweep reaps orphans from.
export { makeEngineLiveness, ENGINE_LIVENESS_KEY } from './lifecycle/engine-liveness.js';
// The wiring shells: dispatch tracking (the dispatcher consumes it via
// ctx.lifecycle) and the SW boot sequence (generation + reconcile +
// notices).
export { makeDispatchTracker, makeFailClosedTracker } from './lifecycle/dispatch-tracking.js';
// Typed failure outcomes — throw sites stamp outcomeKind so recovery is a
// table lookup, not a regex (adoption is incremental; see the module).
export {
  FAILURE_OUTCOMES, isFailureOutcomeKind, outcomeKindOf,
  TransportLostError, ExecutionHostLostError, PreEffectFailureError,
} from './lifecycle/failure-taxonomy.js';
export {
  makeLifecycleBoot, GENERATION_KEY, PENDING_NOTICES_KEY,
} from './lifecycle/boot.js';

// --- errors -------------------------------------------------------------
export {
  ActorCredentialBoundaryError,
  ACTOR_CREDENTIAL_BOUNDARY_FAILURE, ACTOR_CREDENTIAL_BOUNDARY_USER_FAILURE,
  SessionNotFoundError,
  RuntimeContextIncompleteError,
} from './errors.js';

// --- observability (the debug surface: bundle export, failure classes,
// OTel mapping — all pure; the SW route and the side panel consume them) --
export { classifyFailure, FAILURE_KINDS } from './observability/failure-classify.js';
export {
  assembleDebugBundle, childSessionIdsOf, collectFailures,
  DEBUG_BUNDLE_FORMAT, DEBUG_BUNDLE_VERSION,
  BUNDLE_MAX_AUDIT_ENTRIES, BUNDLE_MAX_CHILD_SESSIONS,
} from './observability/debug-bundle.js';
export { bundleToOtlp, traceIdFromUuid, spanIdFrom } from './observability/otel-export.js';
