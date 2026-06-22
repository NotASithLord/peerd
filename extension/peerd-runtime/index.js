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
// The agent turn driver — runAgentTurn + maybeAutoResume, extracted from the
// SW with all IO injected (background/service-worker.js wires it).
export { makeTurnDriver } from './loop/turn-driver.js';
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
  prepareUserAttachments, stripAttachment, stripAttachments,
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

// --- subagents (orchestration over sessions; see docs/SUBAGENTS.md) ------
export {
  makeSpawnSubagent, narrowTools, finalAssistantText,
  DEFAULT_MAX_DEPTH, DEFAULT_MAX_STEPS, DEFAULT_MAX_OUTPUT_TOKENS,
} from './subagent/spawn.js';
// DESIGN-11: async (non-blocking) subagents — spawn returns a handle, the
// result re-enters the parent as a synthetic wake turn. Testable orchestrator.
export { makeAsyncSubagents } from './subagent/async-subagents.js';
// Cheap one-shot clean-context calls (auto-memory + trim enrichment):
// a tools:[] spawn with the spend-limit preflight and the cost fold
// into the parent session's tally built in.
export {
  makeCheapCall, CHEAP_CALL_MAX_STEPS, CHEAP_CALL_MAX_OUTPUT_TOKENS,
} from './subagent/cheap-call.js';

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
// --- review (clean-context read-only reviewer; see docs/REVIEW.md) ------
export {
  makeRequestReview,
  parseReviewSummary, worstSeverity, SEVERITIES,
  readOnlyToolNames, isReadOnlyTool, intersectReadOnly,
  renderDiffForReview, synthesizeDiff, fromCheckpointDiff,
  buildReviewTask,
} from './review/index.js';

// --- tools --------------------------------------------------------------
export { registerTool, getTool, listTools, clearTools } from './tools/registry.js';
export { dispatchToolCall } from './tools/dispatcher.js';
export { GATES } from './tools/gates.js';
export { BUILTIN_TOOLS } from './tools/defs/index.js';
export {
  mainAgentDescriptors, isHiddenFromMain, MAIN_AGENT_HIDDEN_TOOLS,
  filterByInstanceState, isInstanceGatedOut, instanceGateKind, INSTANCE_GATED_TOOLS,
  filterByDwebEnabled, isDwebTool,
  filterByDwebActive, isDwebSecondaryTool, DWEB_SECONDARY_TOOLS,
} from './tools/exposure.js';
// Per-session tool exposure manifests (ROADMAP) — presets-as-data + the
// pure resolve/filter helpers, plus the /tools command's functional core.
export {
  TOOL_MANIFEST_PRESETS, normalizeToolManifest, resolveManifestAllow,
  manifestLabel, filterDescriptorsByManifest,
} from './tools/manifests.js';
export { makeToolsCommand, describePresets } from './tools/manifest-command.js';
export { wrapUntrusted } from './tools/prompt-wrap.js';

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
// Foundational: features 03 (plan/act), 05 (Ralph), and others register
// hooks here; the dispatcher runs them around execute(). The egress
// allowlist ships as a DEFAULT pre-tool-use hook (see DESIGN §10).
export {
  registerHook, listHooks, exportHooks,
  loadUserHooks, saveUserHook, removeHook, clearUserHooks,
  HOOKS_STORAGE_KEY,
  runPreToolUse, runPostToolUse, selectHooks, hookMatches,
  compileUserHook, parseHookMarkdown,
  DEFAULT_HOOKS, egressAllowlistHook,
} from './tools/hooks/index.js';

// --- transfer (settings export/import; dual-distribution §10) -----------
// Explicit migration between installs and across channels. Pure shaping
// + passphrase crypto; the SW injects all IO (vault, memory, hooks, kv).
export {
  EXPORT_VERSION, EXPORT_FORMAT,
  buildExport, inspectImport, applyImport,
  encryptWithPassphrase, decryptWithPassphrase,
  ExportPassphraseError,
} from './transfer/transfer.js';

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
// --- ralph (persistent fresh-context loop; see DESIGN.md §Ralph) ---------
export {
  createRalphLoop, decideNext, initLoopState, MAX_ITERATIONS, LOOP_STATE_KEY,
  createPlanStore, parsePlan, serializePlan, pickNextTask, completeTask,
  failTask, isPlanExhausted, planSummary, EMPTY_PLAN, PLAN_KEY,
  createGateRunner, lintGate, testGate, buildGate,
  consoleCleanGate, domContainsGate,
  makeRalphDriver,
} from './ralph/index.js';

// --- clock (temporal grounding) -----------------------------------------
export {
  buildTemporalBlock,
  CLOCK_TOOLS,
} from './clock/index.js';

// --- web (fetch vs tab policy + wrappers) -------------------------------
export {
  WEB_TOOLS,
  callApiTool, readArticleTool, webSearchTool, submitFormTool, captureTool,
  shouldEscalate, looksLikeSpaShell, matchesAntiBotTemplate, satisfiesExpects,
} from './tools/web/index.js';

// --- voice (local transcription) ----------------------------------------
export {
  createVoiceManager,
  createModelStore,
  createBestTranscriber, detectVoiceCapability,
  MicButton,
  normalizeVariant, normalizeEngine, VOICE_ENGINES,
} from './voice/index.js';

// --- pdf (read_pdf tool: pdf.js text layer + opt-in OCR) ----------------
export {
  chooseEngine, looksScanned, requireEngine, DEFAULT_ENGINE, PDF_ENGINES,
  formatPdfBody, assemblePages, DEFAULT_MAX_CHARS,
  createOcrStore, hasValidOcrSris, OCR_ASSETS, OCR_TOTAL_BYTES,
  PdfFetchError, PdfParseError, OcrUnavailableError,
} from './pdf/index.js';

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
  pullInHintInjected,
} from './dom/index.js';

// --- errors -------------------------------------------------------------
export {
  SessionNotFoundError,
  RuntimeContextIncompleteError,
} from './errors.js';
