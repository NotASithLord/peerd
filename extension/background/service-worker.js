// @ts-check
// Service worker — wiring + dependency-injection assembly (architecture.md §6).
//
// The SW imports each peerd-* module's public surface, creates concrete
// instances (vault, audit log, session store), assembles the per-call
// dependency context (buildToolContext, buildStateSnapshot), drives the agent
// turn, and routes messages. It owns no business logic of its own — that lives
// in the peerd-* modules and in the route handlers under background/routes/.
//
// Message routes: the dispatcher handlers live in background/routes/*.js —
// import-free, deps-injected factories (makeVaultRoutes, makeProviderRoutes, …)
// spread into makeDispatcher with a shared `routeDeps` object. They are
// Bun-unit-tested in tests/background/ and statically wiring-checked in
// tests/meta/sw-routes-wiring.test.ts. A route stays INLINE here only when it
// closes over reassigned module state (settings, activeSession, denylist*,
// defaultProfile, localModel*) that a captured reference couldn't track — those
// are the handful left in the dispatcher below. Keep that rule: a new route
// that needs only stable collaborators belongs in a routes/ module, not here.
// New non-route logic that grows past a few lines of glue belongs in a module
// (a peerd-* barrel, or a background/*.js helper like settings-patch.js), not
// inlined into a handler.
//
// SW lifetime: this module is re-executed on every cold start. Module
// scope is the "per-SW-lifetime singleton" surface. The offscreen doc
// holds a keepalive port so the SW survives the 30s idle timer during
// active sessions. State that must survive SW termination lives in
// chrome.storage.session (`peerd-egress` sessionCache namespace) or
// chrome.storage.local (`egress.kv`).

import browser from '/vendor/browser-polyfill.js';
import { makeDispatcher, isTrustedSender } from '/shared/messaging.js';
import { isOffscreenSender } from '/shared/sender-trust.js';
import { CHANNEL_DEFAULTS, CHANNEL, DWEB_ENABLED } from '/shared/channel-config.js';
import { REMOTE_SKILL_INSTALL } from '/shared/flags.js';

import {
  // vault
  createVault,
  purgeVaultBlob,
  deriveArgon2id,
  DEFAULT_AUTO_LOCK_MS,
  VaultAlreadyInitializedError,
  VaultLockedError,
  VaultNotInitializedError,
  WrongPassphraseError,
  PrfNotEnrolledError,
  PrfUnlockFailedError,
  RecoveryPassphraseNotSetError,
  // fetch / egress
  makeSafeFetch,
  makeWebFetch,
  withSessionScopedCredentials,
  // DESIGN-18 P1 + Tier 1 / INV-15: the API actor's credentialed boundary fetch
  // (session scope + the keyless origin:<origin> injection), upgraded to
  // proof-of-possession. withDpopCredentials is a strict SUPERSET of
  // withApiCredentials — a bearer/raw secret behaves identically — and a
  // dpop-scheme secret additionally rides a fresh RFC 9449 proof signed by a
  // NON-EXTRACTABLE key that never leaves the SW and that nothing, including this
  // file, can export. Plus the Settings → API integrations routes.
  withDpopCredentials,
  getOrCreateDpopKey,
  makeDpopKeyStore,
  // The credential LIFECYCLE seams the Settings routes close over: mint-at-provision
  // (so the thumbprint exists to register), read-only surfacing, and retirement.
  ensureDpopJkt,
  loadDpopJkt,
  makeOriginCredentialRoutes,
  // DESIGN-18 P2: map a vault secret name → its origin (actor_list integration discovery).
  originFromSecretName,
  HARDCODED_ALLOWLIST,
  matchesDenylist,
  // audit
  createAuditLog,
  // confirmation protocol (SW ↔ side panel round-trip)
  makeConfirmCoordinator,
  // storage namespaces
  kv,
  idb,
  idbKV,
  sessionCache,
} from '/peerd-egress/index.js';

import { base64ToBytes, bytesToBase64 } from '/shared/util.js';
import { applyFetchExtract } from '/shared/fetch-extract.js';

import {
  listProviders,
  // web actor model resolution: pin → local → provider default → inherit.
  // Pure; the SW resolves it when minting a web actor session.
  resolveRunnerModel,
  // local WebGPU runner: the offscreen-engine bridge + the resident model id.
  setLocalGenerate, LOCAL_MODEL_ID,
  // live model inventory (Ollama /api/tags) for the model picker.
  listProviderModels,
  // OpenRouter live catalog + curated "popular" seed for the Settings model
  // curation picker (and the key-verify probe).
  listOpenRouterModels,
  OPENROUTER_POPULAR,
  // live per-model context window (Anthropic Models API) for the trim trigger.
  providerModelContextWindow,
  ProviderHttpError,
  ProviderKeyMissingError,
  // hard account limit (out of credit / over a spend or usage cap) — surfaced
  // explicitly instead of three silent retries then a generic "rate limited".
  ProviderUsageLimitError,
  UnknownProviderError,
  anthropicAdapter,
  callModel,
  // provider failover (switch-and-continue): classify a failure as one a
  // different provider could get past, and order the candidate chain.
  shouldFailover,
  planFailoverChain,
  // cost telemetry (feature 06): local pricing table + cost math. hasPricing
  // also gates the sub-call model arg (design 5): an unpriceable id would
  // spend invisibly past the spend limit, so the route refuses it up front.
  costOf, hasPricing,
  // long-session compression: resolve the active model's context window so
  // the trim trigger scales to it (dynamic, not a fixed token count).
  // contextWindowFor returns the resolved number, or null when unknown —
  // exactly the "known-gating" the trim path wants (null is falsy → no
  // token trigger).
  contextWindowFor,
} from '/peerd-provider/index.js';

import {
  createSessionStore,
  renderSystemPrompt,
  runUserTurn,
  // auto-resume: detect a turn the SW reclaimed mid-flight + the synthetic
  // nudge that drives the continuation (maybeAutoResume, below).
  detectInterruptedTurn,
  RESUME_NUDGE,
  // file attachments — agent/send validates + shapes through the pure
  // core (fail closed) before the turn starts. Office/e-book files get one
  // extra, IMPURE step first (convertDocAttachments) — the converter is
  // injected, so the pure core never imports a parser.
  prepareUserAttachmentsWithDocs,
  formatDocBody,
  DOC_TEXT_MAX_CHARS,
  makeSpawnActor,
  makeRequestReview,
  createRefRegistry,
  SessionNotFoundError,
  registerTool,
  getTool,
  listTools,
  mainAgentDescriptors,
  // per-session tool exposure manifests (descriptor filter + gate input
  // + the /tools command core)
  resolveManifestAllow,
  manifestLabel,
  filterDescriptorsByManifest,
  filterByDwebEnabled,
  filterByDwebActive,
  filterByGoalActive,
  makeGoalRunner,
  GOAL_MAX_ITERATIONS,
  makeScheduler,
  SCHEDULE_ALARM_NAME,
  formatTodoBlock,
  // prewalk — the lifecycle controller (testable shell); the SW binds real IO
  makePrewalkController,
  makeToolsCommand,
  dispatchToolCall,
  BUILTIN_TOOLS,
  // lifecycle — the recovery contract's shells: SW-generation boot +
  // startup reconcile, the dispatch tracker every tool ctx carries, the
  // per-tool retry classifier, and the per-store schema stamps.
  makeLifecycleBoot,
  makeDispatchTracker,
  retryClassForTool,
  checkStores,
  stampStores,
  VERSION_STAMP_KEY,
  classifyFailure,
  // hooks (pre/post-tool-use lifecycle)
  registerHook,
  listHooks,
  loadUserHooks,
  saveUserHook,
  removeHook,
  exportHooks,
  parseHookMarkdown,
  DEFAULT_HOOKS,
  // clock
  buildTemporalBlock,
  CLOCK_TOOLS,
  // web
  WEB_TOOLS,
  // composer — slash commands + @-references + palette
  createCommandStore,
  localStoreSource,
  skillRegistrySource,
  mergeSources,
  applyComposer,
  // memory (V1.5) — store + the /init orchestrator (scan/draft/confirm)
  createMemoryStore,
  makeInitOrchestrator,
  // user doc (the durable "doc on the user", memory scope 'user') —
  // onboarding seeds it; '' means "nothing to write".
  USER_DOC_SCOPE,
  seedUserDocBody,
  // auto-memory — wrap-up extraction into pending suggestions, approved
  // from Context → Memory into the user doc.
  createSuggestionStore,
  makeAutoMemory,
  appendNoteToUserDoc,
  // cheap one-shot clean-context calls (auto-memory + trim enrichment)
  makeCheapCall,
  // long-session compression: post-turn trim-summary enrichment shell
  makeTrimEnricher,
  // per-session turn slots — steer-live stays inside one chat; streams
  // in other conversations survive navigation and new sends.
  makeTurnSlots,
  // the agent turn driver (runAgentTurn + maybeAutoResume), extracted to
  // peerd-runtime/loop/turn-driver.js — wired with injected deps below.
  makeTurnDriver,
  // profiles — the default-profile shape (peerName + onboarding latch)
  createProfileStore,
  // contacts — per-peer overlay (name/notes/tags) + known-peer aggregation
  createContactsStore,
  mergeContacts,
  // permissions (Plan/Act mode + confirm-actions toggle — Feature 03)
  PERMISSION_MODES,
  ACTION_CLASSES,
  classifyAction,
  decideAction,
  normalizeMode,
  normalizeConfirmActions,
  confirmActionsFromRecord,
  // edit (SEARCH/REPLACE diff editing + review-diff snapshots, feature 02)
  createBrowserSnapshotStore,
  createCheckpointManager,
  // cost telemetry (feature 06): normalize for the state push + the
  // per-turn tracker (fold/persist/push/halt with all IO injected).
  // addUsage/limitExceeded also serve the script/model-call route's cost
  // fold + spend-limit preflight (design 5).
  normalizeTally, makeTurnCostTracker, addUsage, limitExceeded,
  // transfer (settings export/import — dual-distribution §10)
  buildExport,
  inspectImport,
  applyImport,
  ExportPassphraseError,
  // design js-superpower/06 — the toolbox: durable agent-authored modules
  // (peerd:toolbox/<name>; store + the write-time import-resolution check).
  createToolboxStore,
  makeToolboxParseCheck,
  // DESIGN-19 site clients — per-origin derived API clients (store + pure helpers)
  createSiteClientStore,
  // script's value-spill store (run cache) — read_run_cache pages it back —
  // and the shared spill-cache entry cap both spill stores use.
  createRunCacheStore,
  SPILL_CACHE_MAX_ENTRIES,
  resolveSiteUrl,
  buildMintInjection,
  digestCapture,
  // DESIGN-19 Tap B — the MAIN-world fetch/XHR tap (chrome.scripting), for capture
  // on every channel (store-Chrome + Firefox, no new permission).
  installFetchTapInjected,
  drainFetchTapInjected,
  // skills (progressive-disclosure SKILL.md)
  createSkillStore,
  createSkillRegistry,
  loadSkillTool,
  installFromLocal,
  installFromGit,
  installFromManifest,
  SkillExistsError,
  SkillInstallError,
  SkillParseError,
  // voice: the settings normalizers — the SW validates voiceVariant +
  // voiceEngine on settings/update (coerce unknowns).
  normalizeVariant, normalizeEngine,
  // DESIGN-11: wrap an async-actor's model-authored result (possibly
  // page-derived) as UNTRUSTED before it re-enters the parent's context.
  wrapUntrusted,
  // DESIGN-11: the async-actor orchestrator (testable; the SW injects its IO).
  makeAsyncActors,
  // DESIGN-17: the message_actor orchestrator + the actor capability-tier
  // helpers the actor tool context is built from (keyless strip + kind scope).
  makeActorMessaging, restrictCtxCapabilities, actorAllowedToolsFor, EXPOSURE_ACTOR, EXPOSURE_REVIEW, pinActorCall, actorDescriptors, buildAncestry,
  actorsCallToOp, shapeActorsResult, askOutcome, ACTORS_ASK_DEFAULT_TIMEOUT_MS,
  // Design 5 — the pure core the script/model-call route runs: text-only arg
  // validation, per-run quota arithmetic, and the provider-event fold.
  validateProviderCallArgs, providerQuotaError, foldProviderEvents,
  // A2A — the mesh dispatch + translation the a2a/call route runs.
  makeMeshDispatch, meshCallToOp, shapeMeshResult,
  // Standing peer conversations — the pure thread registry (convId → turns).
  createConversationRegistry,
  // DESIGN-17: web-actor core — tab→session bindings, the chat→web-actor
  // registry (the 0-or-1-tab actor), + the self-fenced summary.
  makeWebActorTabBindings, makeWebActorRegistry, fenceWebActorSummary,
  // PR #119: the code-REPL arm's host-side page-call handler + the pure
  // adopt-first-tab-on-goto decision.
  makePageCallHandler, resolvePageTab,
  // DESIGN-18: API-actor core — the origin-keyed bindings, the origin normalizer
  // (addressing + same-origin-lock anchor), and the "what I learned" self-fence.
  makeApiActorBindings, normalizeApiOrigin, fenceApiActorSummary,
  siteHandleFor, parseSiteHandle,
  // issue 251: the origin lock. The pure rule + classifier live in
  // peerd-runtime; these are the four pieces the SW binds together to make it
  // live — the state store, the judge, the synchronous credential-scope
  // narrowing, and the report a stop turns into.
  makeOriginStateStore, makeLearnedOrigins, makeJudgeLanding, makeCredentialScope,
  isKnownIdp, knownIdpDomains, describeLandingStop, originPhrase, isUgcHost,
  finalAssistantText,
  // The debug surface: the bundle assembler + the delegation-tree walk the
  // session/debugBundle route runs (pure; the SW supplies the reads).
  assembleDebugBundle, childSessionIdsOf,
} from '/peerd-runtime/index.js';

import { flattenCategorisedDenylist, normalizeDenylistPattern, denylistSessionRuleUpdate } from '/peerd-egress/index.js';

import { createVmClient } from './vm-client.js';
import { createVmTabTracker } from './vm-tab-tracker.js';
import { createJsClient } from './notebook-client.js';
import { createJsTabTracker } from './notebook-tab-tracker.js';
import { makeOffscreenJsClient } from './offscreen-js-client.js';
import { createScriptRunRegistry } from './script-runs.js';
import { createContextSnapshots } from './context-snapshots.js';
import { confirmGrantKey } from './confirm-grant-key.js';
import { makeOffscreenActorClient } from './offscreen-actor-client.js';
import { makeOffscreenPdfClient } from './offscreen-pdf-client.js';
import { makeOffscreenDocClient } from './offscreen-doc-client.js';
import { makeOffscreenWebClient } from './offscreen-web-client.js';
import { makeUiPorts } from './ui-ports.js';
import { createAppClient, APP_TAB_GROUP_TITLE } from './app-client.js';
import { createPageActivityReporter } from './page-activity.js';
import { createAppTabTracker } from './app-tab-tracker.js';
import {
  createVmRegistry,
  createNotebookRegistry,
  createAppRegistry,
  // artifact export/import (.peerd envelopes — DESIGN-10)
  opfsHelpers,
  // design 06: the resolver transform, injected into the toolbox write-time
  // parse check (functional core — the check itself lives in peerd-runtime).
  buildModule,
  NOTEBOOK_OPFS_ROOT,
  IMAGE_PIN_STORAGE_KEY,
  buildAppExport,
  buildNotebookExport,
  buildVmRecipeExport,
  openEnvelope,
  inspectEnvelope,
  exportFilename,
  ArtifactTooLargeError,
  EnvelopeFormatError,
  EnvelopeIntegrityError,
  // WebVM HTTP bridge + git-credential routes: IO-injected factories whose
  // pure cores (cache policy, host-bound git-auth, validation) live in vm-net.
  makeVmHttpFetch,
  makeGitCredentialRoutes,
  WEB_WRITE_CONFIRM_KEY,
  // DESIGN-19: the shared non-GET web-write predicate (site-fetch/call gates a
  // non-GET through the same web:write confirm as fetch_url / call_api).
  needsWebWriteConfirm,
} from '/peerd-engine/index.js';
import { createDebuggerPool } from './debugger-pool.js';
import { normalizeSettingsPatch } from './settings-patch.js';
import { makeSettingsStore } from './settings-store.js';
import { makeDenylistStore } from './denylist-store.js';
import { makeDenylistNetGuard } from './denylist-net-guard.js';
import { makeSessionState } from './session-state.js';
import { makeLocalModelState } from './local-model-state.js';
import { makeProfileState } from './profile-state.js';
import { makeModelCatalog } from './model-catalog.js';
import { makeTabAffordances } from './tab-affordances.js';
import { makeMintOnce } from './mint-once.js';
import { makeDwebInboundRateCap } from './dweb-inbound-rate-cap.js';
import { downgradesActorConfirm, a2aConsentOutcome } from './a2a-consent.js';
import { makeVaultRoutes } from './routes/vault.js';
import { makeProviderRoutes } from './routes/providers.js';
import { makeHooksRoutes } from './routes/hooks.js';
import { makeSkillsRoutes } from './routes/skills.js';
import { makeMemoryRoutes } from './routes/memory.js';
import { makeContactsRoutes } from './routes/contacts.js';
import { makeSessionRoutes } from './routes/sessions.js';
import { makeEngineRoutes } from './routes/engine.js';
import { makeSystemRoutes } from './routes/system.js';
import { makeDenylistRoutes } from './routes/denylist.js';
import { makeLearnedOriginRoutes } from './routes/learned-origins.js';
import { makeSettingsRoutes } from './routes/settings.js';
import { makeSessionMutationRoutes } from './routes/session-mutations.js';
import { makeLocalModelRoutes } from './routes/local-model.js';
import { makeDwebRoutes } from './routes/dweb.js';
import { makeToolboxRoutes } from './routes/toolbox.js';

// ---------------------------------------------------------------------------
// 1. Layer 1 instances
// ---------------------------------------------------------------------------

// Vault wiring.
//
//   autoLockMs        idle auto-lock interval. Default ON (45min) so the
//                     unwrapped DK doesn't sit live for the whole browser
//                     session; the user can change it (incl. to "never")
//                     via the vaultAutoLockMs setting, applied in
//                     loadSettings() once storage has loaded. Re-unlock is
//                     cheap, especially with Touch ID / Windows Hello (PRF).
//   sessionCache      lets the vault persist the unwrapped DK in
//                     chrome.storage.session so SW restarts (the 30s
//                     idle timer, etc.) don't force a re-unlock. The
//                     persisted bytes never land on disk — session
//                     storage is RAM-only and cleared on browser close,
//                     so unlock prompts still happen exactly once per
//                     browser session, just not once per SW lifetime.
//   idb               the vault blob's home (IDB `vault` store). The
//                     vault migrates a legacy chrome.storage.local blob
//                     over on first access — loss-proof: verified
//                     read-back before the original is deleted.
//   argon2            the memory-hard passphrase KDF (vendored WASM
//                     behind peerd-egress/vault/argon2.js). New
//                     passphrase wraps use the vault.v2 Argon2id format;
//                     legacy PBKDF2 wraps migrate lazily on the next
//                     successful unlock. PRF (passkey) unlocks never
//                     touch this.
const vault = createVault({
  kv, idb, sessionCache, argon2: deriveArgon2id, autoLockMs: DEFAULT_AUTO_LOCK_MS,
});
// maxEntries: capped retention — oldest entries pruned, amortized on
// append — so a long-lived install's audit log doesn't grow unbounded.
const auditLog = createAuditLog({ idb, maxEntries: CHANNEL_DEFAULTS.auditLogMaxEntries });

// ---- Lifecycle boot (the recovery contract's imperative shell) -------------
// Every SW start mints a new generation, settles the previous generation's
// orphaned operation records (interrupted vs outcome_unknown by retry
// class), stamps the per-store schema versions, and arms the dispatch
// tracker that buildToolContext hands to every dispatch. Posture: fail-OPEN
// on tracking (a broken boot must never brick the tool surface — dispatches
// just run untracked, as they did before this landed), fail-CLOSED on
// replay (once armed, the tracker refuses automatic re-dispatch of an
// unproven side effect).
const lifecycleBoot = makeLifecycleBoot({
  storage: kv,
  appendAudit: (/** @type {any} */ entry) =>
    auditLog.append({ type: entry.event, details: entry }),
  // postChatNote is declared far below — the standard late-dep deferral.
  notify: (/** @type {string} */ _sessionId, /** @type {string} */ text) =>
    postChatNote(`Recovered from a browser interruption: ${text}`),
  nonce: () => crypto.randomUUID(),
});
/** @type {ReturnType<typeof makeDispatchTracker> | null} */
let lifecycleTracker = null;
// Fire-and-forget by design: nothing awaits the boot — a dispatch that
// races it simply runs untracked (the pre-lifecycle behavior), and the
// chain's own catch keeps a failed boot from surfacing as an unhandled
// rejection.
lifecycleBoot.init()
  .then(async ({ generation }) => {
    lifecycleTracker = makeDispatchTracker({
      operationLog: lifecycleBoot.operationLog,
      generationId: () => generation.id,
      retryClassFor: retryClassForTool,
      classifyFailure: /** @type {any} */ (classifyFailure),
    });
    // §11.1 — independent per-store schema stamps. A newer stamp than this
    // build supports leaves that store read-only (refuse-newer); the check
    // result is audited so a blocked profile is diagnosable, and stamping
    // only proceeds when every store is writable.
    const readStamps = async () => (await kv.get(VERSION_STAMP_KEY)) ?? undefined;
    const storesCheck = await checkStores({ read: readStamps });
    if (storesCheck.ok) {
      await stampStores({
        read: readStamps,
        write: (/** @type {any} */ map) => kv.set(VERSION_STAMP_KEY, map),
      });
    } else {
      for (const s of storesCheck.stores.filter((/** @type {any} */ x) => x.mode === 'read-only')) {
        console.error('[sw] store schema blocked:', s.store, s.reason);
        auditLog.append({
          type: 'lifecycle.migration.failed',
          details: { store: s.store, reason: s.reason, diagnosticId: s.diagnosticId },
        }).catch(() => {});
      }
    }
    return generation;
  })
  .catch((/** @type {unknown} */ e) => {
    console.error('[sw] lifecycle boot failed; dispatches run untracked', e);
    return null;
  });

// INV-15 — the proof-of-possession key seam. Backed by the `dpop_keys` IDB store
// (one non-extractable keypair per owned https origin, minted lazily on the first
// credentialed request to that origin). why it lives HERE and is only ever closed
// over by a boundary wrapper: like getSecret, it must never appear on an actor's
// ctx. Unlike getSecret it is not even a secret to leak — the handle it returns
// cannot be exported by anyone, including this file.
const dpopKeyStore = makeDpopKeyStore({ get: idb.get, put: idb.put, del: idb.del });
// A MINT is audited: a new key means a new `jkt`, so every token bound to the old
// one stops working — the one silent re-key that would otherwise look like an
// unexplained wall of 401s.
const dpopKeyDeps = { ...dpopKeyStore, audit: (/** @type {any} */ e) => { auditLog.append(e).catch(() => {}); } };
/** @param {string} origin @returns {Promise<{ privateKey: CryptoKey, publicJwk: any } | null>} */
const getDpopKeyForOrigin = (origin) => getOrCreateDpopKey(origin, dpopKeyDeps);

/** User-added provider endpoints; safeFetch reads via callback. */
let userEndpoints = new Set();

const loadUserEndpoints = async () => {
  const stored = await kv.get('provider_endpoints.v1');
  if (stored?.endpoints) {
    userEndpoints = new Set(stored.endpoints.map((/** @type {any} */ e) => e.url));
  }
};

/**
 * Per-profile settings. V1 surface is intentionally narrow — we only
 * persist things the user explicitly toggles.
 *
 * Defaults come from CHANNEL_DEFAULTS (shared/channel-config.js), GENERATED
 * per distribution channel from packaging/default-settings.mjs — that schema
 * file carries the per-key rationale and the store/preview divergences.
 * The store package's copy has no dweb keys at all.
 *
 * Migration semantics (Option A, PACKAGING.md): presence of a stored
 * value always wins over CHANNEL_DEFAULTS, even if it equals an old
 * default; absence means "use the channel default". Upgrades therefore
 * never silently change behavior a user may be relying on.
 */
const DEFAULT_SETTINGS = CHANNEL_DEFAULTS;

// The dweb module's persistent-identity vault secret. Held here (NOT
// imported from the module — a ServiceWorker cannot `import()` it, and must
// not reference its path) so the SW can own the vault get/set for the
// room-hosting page. Store-safe: not the dweb module path. Mirrors
// identity/keypair.js SECRET_NAME by convention.
const DWEB_IDENTITY_SECRET = 'distributed/identity/v1';
// Extended-thinking budget (tokens) when reasoningEnabled. Modest by
// design — enough for a real plan, not a dissertation. The adapter
// lifts max_tokens above this so the visible answer still has room.
const REASONING_BUDGET_TOKENS = 2048;
// Valid Anthropic `output_config.effort` levels (settingsStore.get().reasoningEffort).
// Defaults to 'medium' via CHANNEL_DEFAULTS — owner call (2026-06-12): in a
// browser harness, long invisible deliberation reads as a hang, so the
// default trades reasoning depth for earlier visible action; the chat
// mode-row dial raises it per task. NOTE this deliberately under-runs the
// platform default (high).
const REASONING_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// Settings live in a store (background/settings-store.js): the merged view via
// settingsStore.get(), the user-set keys via settingsStore.stored(). Routes call
// the store directly (settings/* in routes/settings.js, transfer/import via
// system.js); Option A migration semantics live in the store.
const settingsStore = makeSettingsStore({ kv, key: 'settings.v1', defaults: DEFAULT_SETTINGS });

const loadSettings = async () => {
  await settingsStore.load();
  // Apply the persisted idle auto-lock policy to the vault now that storage
  // has loaded (the vault was constructed with the default before this).
  // Fallback guards against a channel-config missing the key — absence must
  // mean "default lock", never "never lock".
  vault.setAutoLockMs(settingsStore.get().vaultAutoLockMs ?? DEFAULT_AUTO_LOCK_MS);
};

/**
 * Resolve the provider NEW chats should use, from settings. Falls back
 * to Anthropic if the configured provider name isn't registered. The
 * model is the user's override or the adapter's default. Returns a flat
 * descriptor { name, label, model, vaultSecretName } — enough for
 * session creation, the key-presence check, and the settings UI.
 */
const resolveActiveProvider = () => {
  const list = listProviders();
  const fallback = list.find((p) => p.name === 'anthropic') ?? list[0];
  const chosen = list.find((p) => p.name === settingsStore.get().providerName) ?? fallback;
  return {
    name: chosen.name,
    label: chosen.label,
    model: settingsStore.get().providerModel || chosen.defaultModel,
    // why: the web actor's fast default for this provider (Haiku on
    // Anthropic). Surfaced so the settings UI can show it as the "blank =
    // this" placeholder and mintWebSession can resolve the web actor model.
    defaultRunnerModel: chosen.defaultRunnerModel,
    vaultSecretName: chosen.vaultSecretName,
    keyless: !!chosen.keyless,
  };
};

/**
 * Async sibling of resolveActiveProvider used at lazy session-create. When the
 * user has NOT explicitly chosen a provider (providerName is empty, or names an
 * unregistered adapter), pick the first USABLE provider — a keyed one with a
 * stored key, or a keyless one that is actually reachable/ready — and PERSIST it
 * as the active provider, instead of falling back to a keyless-Anthropic guess.
 * So a fresh chat binds to a provider that actually works (Ollama-only, or the
 * just-keyed OpenRouter) and matches what the model picker already shows.
 * No-op (returns the explicit choice) when providerName names a registered
 * provider — an explicit selection is never silently overridden, and the common
 * case skips the vault/daemon probes entirely.
 */
const ensureActiveProvider = async () => {
  const list = listProviders();
  const name = settingsStore.get().providerName;
  if (name && list.some((p) => p.name === name)) return resolveActiveProvider();
  for (const p of list) {
    let usable = false;
    if (p.keyless) {
      // Keyless usability is REAL readiness, not mere presence: a live daemon
      // (Ollama) must answer; the on-device model must be downloaded.
      if (p.liveModels) usable = !!(await liveProviderModels(p.name));
      else if (p.name === 'local-webgpu') usable = localModelState.available();
      else usable = true;
    } else {
      try { usable = !!(await vault.getSecret(/** @type {string} */ (p.vaultSecretName))); }
      catch { usable = false; }
    }
    if (usable) {
      // Clear providerModel so the picked provider's own default model applies.
      try { await settingsStore.update({ providerName: p.name, providerModel: '' }); }
      catch { /* a settings write failure must not block chat creation */ }
      return resolveActiveProvider();
    }
  }
  // Nothing usable — keep the existing fallback so the turn fails with a clear
  // provider error (the UI gates sending before reaching here on a fresh chat).
  return resolveActiveProvider();
};

/**
 * Build the ordered failover candidate chain for a turn: the active
 * {provider, model} first, then each configured fallback PROVIDER (resolved
 * to its default model). Returns just [start] when failover is off or no
 * fallbacks are configured — so the wrapper is a transparent pass-through by
 * default. Validation: unknown provider names are dropped here, so the chain
 * only ever names registered adapters.
 *
 * @param {{ provider: string, model: string }} start
 * @returns {{ provider: string, model: string }[]}
 */
const resolveFailoverChain = (start) => {
  const s = settingsStore.get();
  if (!s.providerFailoverEnabled) return [start];
  const names = Array.isArray(s.providerFallbacks) ? s.providerFallbacks : [];
  if (names.length === 0) return [start];
  const list = listProviders();
  const fallbacks = [];
  for (const name of names) {
    const p = list.find((x) => x.name === name);
    if (p) fallbacks.push({ provider: p.name, model: p.defaultModel });
  }
  return planFailoverChain(start, fallbacks);
};

/** vaultSecretName for a given provider name (defaults to Anthropic's). */
const secretNameForProvider = (/** @type {string} */ name) => {
  const p = listProviders().find((x) => x.name === name);
  return p?.vaultSecretName ?? anthropicAdapter.vaultSecretName;
};

// Mask an API key for display: enough to recognise it (prefix + last 3) +
// its length (so a whitespace-padded or truncated key is obvious), never
// the secret itself.
const maskKey = (/** @type {string} */ k) => {
  const s = String(k ?? '');
  if (s.length <= 11) return `${s.length} chars`;
  return `${s.slice(0, 7)}…${s.slice(-3)} · ${s.length} chars`;
};

// The per-chat model picker's catalog assembly lives in background/model-catalog.js
// (curated catalog, live Ollama inventory, OpenRouter curated mapping, live
// context window, buildModelOptions). The factory is invoked further down, after
// its collaborators (safeFetch, getSecret, sessions) are created.

// The user-configured Ollama host (issue #104). Its exact origin joins the
// allowlist so safeFetch permits a remote daemon — the loopback default is
// already hardcoded, so this only ever adds a custom host. why origin-only +
// try/catch: settings-patch already stores it as a validated origin, but the
// allowlist is the security boundary, so read it defensively and contribute
// nothing on a bad/missing value. (The SSRF/private-network guard is on the
// open-web path, not this credentialed provider path — so a LAN host is fine
// here, and exact-origin matching keeps it to the one host the user set.)
const ollamaAllowedOrigin = () => {
  try { return new URL(settingsStore.get().ollamaHost || '').origin; }
  catch { return null; }
};

export const safeFetch = makeSafeFetch({
  getAllowlist: () => {
    const ollama = ollamaAllowedOrigin();
    return ollama
      ? [...HARDCODED_ALLOWLIST, ...userEndpoints, ollama]
      : [...HARDCODED_ALLOWLIST, ...userEndpoints];
  },
  audit: /** @type {any} */ (auditLog.append),
});

// why: separate egress wrapper for web tools (fetch_url) and
// the web actor. Provider allowlist would be too narrow — those tools
// reach arbitrary HTTPS hosts. The denylist still applies as defense
// in depth alongside the dispatcher's origin gate.
export const webFetch = makeWebFetch({
  getDenylist: () => denylistStore.patterns(),
  matchDenylist: (host, patterns) => matchesDenylist(host, patterns),
  audit: /** @type {any} */ (auditLog.append),
});

// Bind vault.getSecret to a stable function reference so DI consumers
// (provider adapters via runUserTurn) get a clean lambda.
const getSecret = (/** @type {string} */ name) => vault.getSecret(name);

// ---------------------------------------------------------------------------
// WebVM HTTP bridge fetch — the one egress path the VM (and the Notebook
// code-mode bridge) reach, with two additions over a bare webFetch:
//   1. an IDB response cache (vm_http_cache) for safe idempotent GETs, so a
//      dev re-cloning/re-installing the same bytes hits warm storage instead
//      of re-streaming. Pure policy lives in vm-net/http-cache.js; this is the
//      IDB-backed shell around it.
//   2. host-side git auth injection: when the caller sets gitAuth, a token
//      from the vault (secret `git:<host>`) is added as the right header for
//      the forge — the token never enters the VM (or even this page from the
//      VM), only the SW↔vault boundary.
// Returns the SW message shape: { ok, status, statusText, headers, bodyB64 } |
// { ok:false, error }.
// ---------------------------------------------------------------------------
const VM_HTTP_CACHE_STORE = 'vm_http_cache';

// fetch_url's spill-and-page store (idb v11). Keys are time-prefixed so IDB's
// sorted key order IS chronological order — eviction is then delUpTo on the
// cutoff key (the vm_http_cache posture: fetched public bytes, best-effort,
// safe to clear). Bounded so unbounded page-spills can't grow the profile.
const WEB_EXTRACT_CACHE_STORE = 'web_extract_cache';
const WEB_EXTRACT_CACHE_MAX_ENTRIES = SPILL_CACHE_MAX_ENTRIES;
let webCacheSeq = 0;
const webCache = {
  /** Mint a new time-ordered cache key. */
  key: () => `wc-${Date.now().toString(36)}-${(webCacheSeq += 1).toString(36)}`,
  /** @param {{ key: string, url?: string, format?: string, text: string, storedAt?: number, ownerSessionId?: string | null }} record */
  put: async (record) => {
    await idb.put(WEB_EXTRACT_CACHE_STORE, { storedAt: Date.now(), ...record });
    // Best-effort eviction: keys sort chronologically (time-prefixed), so
    // dropping everything up to the (count-MAX)th key keeps the newest MAX.
    try {
      const keys = /** @type {string[]} */ (await idb.getAllKeys(WEB_EXTRACT_CACHE_STORE));
      if (keys.length > WEB_EXTRACT_CACHE_MAX_ENTRIES) {
        await idb.delUpTo(WEB_EXTRACT_CACHE_STORE, keys[keys.length - WEB_EXTRACT_CACHE_MAX_ENTRIES - 1]);
      }
    } catch { /* eviction is hygiene, never a failure */ }
  },
  /** @param {string} key */
  get: (key) => idb.get(WEB_EXTRACT_CACHE_STORE, key),
};

// The bridge fetch is now an IO-injected factory (vm-net/vm-http-fetch.js) so
// its security-critical logic — the anti-exfil write gate, host-bound git-auth
// injection, and the revalidating IDB cache — is bun-testable. The SW supplies
// the IO: webFetch (denylist+SSRF+redirect-gated), the vault secret lookup, the
// IDB cache store, the confirm coordinator, the current session id, base64, and
// audit. Behavior is byte-for-byte what was inline here.
const vmHttpFetch = makeVmHttpFetch({
  webFetch,
  getSecret,
  cacheGet: (key) => idb.get(VM_HTTP_CACHE_STORE, key),
  cachePut: (record) => idb.put(VM_HTTP_CACHE_STORE, record),
  // Deferred: confirmAction is declared further down; the wrapper closes over
  // it so resolution happens at fetch time (not module-eval), avoiding the TDZ.
  confirm: (prompt) => confirmAction(prompt),
  getCurrentSessionId: () => /** @type {Promise<any>} */ (sessionCache.sessionGet('currentSessionId')),
  bytesToBase64,
  audit: (e) => { auditLog.append(e).catch(() => {}); },
});

// Git-credential provisioning routes (Settings → Git credentials). Host/token
// validation + canonicalization + the vault-locked → 'locked' mapping live in
// the factory (vm-net/git-credential-routes.js) so they're bun-testable; the SW
// injects the vault, audit, and the VaultLockedError predicate. Spread into the
// message-handler map below.
const gitCredentialRoutes = makeGitCredentialRoutes({
  vault,
  isLockedError: (e) => e instanceof VaultLockedError,
  audit: (e) => { auditLog.append(e).catch(() => {}); },
});

// DESIGN-18 P1 — Settings → API integrations: list/set/delete origin:<origin> API keys,
// the same vault + write-only-from-the-UI shape as git credentials. The value is
// decrypted just-in-time at the egress boundary (withApiCredentials), never shown.
const originCredentialRoutes = makeOriginCredentialRoutes({
  vault,
  isLockedError: (e) => e instanceof VaultLockedError,
  // The DPoP half of the credential's lifecycle. Provisioning mints the keypair so
  // the user has a thumbprint to register with the authorization server BEFORE the
  // token is issued; listing reads it without minting; revoking retires it, so the
  // stable per-origin fingerprint doesn't outlive the credential the user removed.
  ensureDpopKey: (origin) => ensureDpopJkt(origin, dpopKeyDeps),
  readDpopJkt: (origin) => loadDpopJkt(origin, dpopKeyStore),
  deleteDpopKey: (origin) => dpopKeyStore.remove(origin),
  audit: (e) => {
    auditLog.append(e).catch(() => {});
    // issue 251: storing a key for an origin is the strongest "I have an account
    // here" signal there is, and on this branch it is the ONLY seed the origin
    // lock has. Learn it the moment it happens.
    //
    // why here and not by re-listing the vault: the lock's sensitivity check is
    // synchronous, so it reads a cached Set that was filled at boot and on
    // unlock. Adversarial review found the gap that leaves — add a credential
    // mid-session and the origin stays classified ORDINARY for the whole service
    // worker lifetime, which is exactly when a user is most likely to have just
    // set one up and immediately try to use it. Keying off the audit event the
    // route already emits means a future change to that route cannot silently
    // skip this. (Removal deliberately does NOT un-learn — see keyedOrigins.)
    if (e?.type === 'origin_credential_added' && typeof e?.details?.origin === 'string') {
      keyedOrigins.add(e.details.origin);
    }
  },
});

// ---------------------------------------------------------------------------
// 2. Layer 2 — runtime owns sessions + agent loop
// ---------------------------------------------------------------------------

const sessions = createSessionStore({ idb });

// Memory store (V1.5). Binds the egress `idb` adapter to the
// 'agents_memory' object store. The loader assembles the always-loaded
// <memory> block per turn; the remember tool + /init route writes through
// its confirmation-gated writeWithConfirm. Foundational for skills (07)
// and auto-memory (09).
const memory = createMemoryStore({ idb });

// DESIGN-19 site clients — per-origin derived API clients (dossier + module),
// its OWN IDB DB (a distinct trust class from skills — a client is never
// loadable as a skill). Injected as ctx.siteClients for the web actor's
// site_client_* tools and read at mint for fenced dossier injection.
const siteClientStore = createSiteClientStore();

// The script value-spill store (run cache) — its OWN best-effort IDB DB, the
// web-extract-cache posture one tier down: an oversized script [VALUE] spills
// here and read_run_cache pages it back, ownership-stamped per session and
// fenced per the run's own fence state.
const runCache = createRunCacheStore();

// Session teardown for the durable script WORKSPACE (['peerd-workspace', sid]
// — the `script` tool's workspace:true root). Wired into session/archive,
// the terminal session-lifecycle event. OPFS is reachable from the SW
// (peerd-engine/opfs.js header); nuke() already swallows a missing subtree.
const nukeSessionWorkspace = (/** @type {string} */ sid) => opfsHelpers(['peerd-workspace', sid]).nuke();

// design js-superpower/06 — the TOOLBOX: durable agent-authored ES modules
// (peerd:toolbox/<name>), its OWN IDB DB. A distinct trust class from skills
// AND site clients (a toolbox module is never loadable as a skill and never
// runnable against an origin pin); keeping the DBs separate makes that
// boundary structural. Injected as ctx.toolbox for the toolbox_* tools; the
// resolution hosts read bodies via the toolbox/read route.
const toolboxStore = createToolboxStore();
// The write-time import-resolution check: the resolver transform run against a
// candidate body, siblings read from the store. It validates import resolution,
// NOT JS syntax. makeBlobUrl inside is a stub — the SW has no
// URL.createObjectURL, and the check never imports the result.
const toolboxParseCheck = makeToolboxParseCheck({
  buildModule,
  readSibling: async (/** @type {string} */ name) => {
    const body = await toolboxStore.getBody(name);
    if (body == null) throw new Error(`unknown toolbox module '${name}' — write it first (toolbox_write)`);
    return body;
  },
});

// Profiles (ROADMAP "Profiles", deprioritized to the default-profile
// shape). Exactly ONE record exists — 'default' — carrying peerName
// (the AI peer's display name; reflects only in chat-transcript row
// labels) and the onboardingComplete latch that gates the first-run
// "Hello, I'm peerd" screen. Everything else stays global; the store
// API is already multi-profile shaped so later profiles are additive.
const profiles = createProfileStore({ idb });
// Contacts: the per-peer overlay store (name/notes/tags keyed by did). Core +
// always wired — a did is just an identity string. The "known peers + activity"
// view is computed at read time from this overlay + the App catalog + the audit
// log (mergeContacts), so it needs no network and works on every channel.
const contacts = createContactsStore({ idb });
// Default-profile cache behind a store (background/profile-state.js) so
// pushState doesn't re-read IDB on every push and onboarding/complete can reach
// it via deps. profileState.get() ensures+caches; completeOnboarding refreshes.
const profileState = makeProfileState({ profiles });

// The per-chat model picker's catalog assembly (background/model-catalog.js).
// localModelAvailable is a thunk because localModelState is created later.
const { liveProviderModels, liveContextWindow, buildModelOptions } = makeModelCatalog({
  listProviders, listProviderModels, providerModelContextWindow,
  localModelId: LOCAL_MODEL_ID, localModelAvailable: () => localModelState.available(),
  settingsStore, vault, sessions, resolveActiveProvider, getSecret, safeFetch,
});

// ---------------------------------------------------------------------------
// Tool layer
// ---------------------------------------------------------------------------
//
// Register the V1 built-in introspection tools (peerd-runtime/tools/defs/).
// The agent loop gets a list of available tools to pass to the provider.

for (const t of BUILTIN_TOOLS) registerTool(/** @type {any} */ (t));
for (const t of CLOCK_TOOLS) registerTool(t);
for (const t of WEB_TOOLS) registerTool(t);

// ---------------------------------------------------------------------------
// Hook layer — pre/post-tool-use lifecycle (feature 10).
// ---------------------------------------------------------------------------
//
// Default (code) hooks register synchronously at boot; they're trusted
// and always-on (the egress-allowlist hook is the always-on floor).
// User (config) hooks load async from chrome.storage.local — fire and
// forget; the dispatcher reads the live registry per call, so they take
// effect as soon as the load resolves. A load failure leaves only the
// defaults installed, which is the safe degraded state.
for (const h of DEFAULT_HOOKS) registerHook(h);
loadUserHooks({ kv })
  .then(({ loaded, skipped }) => {
    if (loaded || skipped) console.info(`[sw] hooks: ${loaded} user hook(s) loaded, ${skipped} skipped`);
  })
  .catch((e) => console.warn('[sw] hooks: user-hook load failed', e));
// Skills — progressive-disclosure SKILL.md (feature 07).
//
// The registry is IDB-backed (skills must survive a 30s SW death) via the
// thin createSkillStore adapter. INTEGRATOR NOTE: to repoint at feature
// 01's workspace store, swap createSkillStore() here for feature 01's
// store under the `skills/` namespace — the registry only consumes the
// store interface (put/listMeta/getBody/remove), never IDB.
//
// load_skill is registered like any built-in. The registry is attached to
// the ToolContext (ctx.skills) in buildToolContext so the tool can read a
// body on invocation. Descriptions are injected into the system prompt
// per turn (skillsBlock below) — bodies never are.
const skillStore = createSkillStore();
const skillRegistry = createSkillRegistry({ store: skillStore, audit: auditLog.append });
registerTool(loadSkillTool);


// Denylist patterns — loaded once at boot from the seed JSON shipped
// with the extension. The origin gate (peerd-runtime/tools/gates.js)
// reads from this; inspect kind:'denylist' (the tool) reads from it too.
// Denylist state lives in a store (background/denylist-store.js): seed + user
// overlay + the effective list, behind methods so consumers read the LIVE value
// (.patterns()) instead of a reassigned singleton. The seed FETCH stays here
// (IO + an egress flatten helper); the store owns the overlay + recompute.
const denylistStore = makeDenylistStore({
  kv, key: 'denylist.user.v1', normalizePattern: /** @type {any} */ (normalizeDenylistPattern),
});

// why (SECURITY): the seed loads ASYNC. Until it resolves, the effective list is
// [] — and the origin gate would allow a denylisted site (the cold-start race).
// buildToolContext awaits denylistReady before constructing any tool context, so
// NO tool can dispatch against an unloaded denylist. The promise RESOLVES (never
// rejects) when the load finishes or fails — it can't hang a turn, and
// fails-closed to [] (the seed is a bundled extension asset, so a real failure
// is near-impossible).
/**
 * The seed's OWN category map ({ banks_us: [...], health_us: [...], … }), kept
 * for the settings list to group by.
 *
 * why keep it: the seed ships curated and categorised, but the store only ever
 * needed a flat match list, so the taxonomy was thrown away one line after it
 * was read — leaving the UI to render 164 undifferentiated chips. Grouping is a
 * read-only presentation concern, so this stays out of the matcher entirely:
 * `patterns()` is still the flat list every gate consults.
 * @type {Record<string, string[]>}
 */
let seedCategories = {};
/** Live read for the settings list — the map is replaced when the seed loads. */
const getSeedCategories = () => seedCategories;
const loadDenylist = async () => {
  /** @type {any[]} */ let seed = [];
  try {
    const res = await fetch('/peerd-egress/denylist/default.json');
    if (!res.ok) console.error('[sw] denylist seed fetch failed:', res.status);
    else {
      const json = await res.json();
      seedCategories = (json && typeof json === 'object' && json.categories) ? json.categories : {};
      seed = flattenCategorisedDenylist(json);
    }
  } catch (e) {
    console.error('[sw] denylist load threw', e);
  }
  await denylistStore.load(seed);
  console.log('[sw] denylist loaded —', denylistStore.patterns().length, 'patterns');
  // The backstop's rule set is derived from the list, so it has to be rebuilt
  // the moment the list exists (a live SW restart can find tabs already driven).
  denylistNetGuard.sync();
};
/** @type {Promise<void>} */
const denylistReady = loadDenylist();

// ── the denylist's NETWORK-level backstop ──────────────────────────────────
//
// The gates above are decision-time: they judge a URL the agent hands us. They
// cannot see what a page does on its OWN initiative — a driven tab that
// `location =`s onto a bank reaches the bank's DOM through a tool call that
// never named the bank, so no gate ever got a URL to refuse. Same gap in an App
// sandbox, whose agent-authored code reaches the network without passing
// webFetch at all. declarativeNetRequest closes it below the page: one
// session-scoped rule, blocking denylisted domains in the tabs peerd is
// CURRENTLY DRIVING and nowhere else. See background/denylist-net-guard.js and
// peerd-egress/denylist/dnr-rules.js.
//
// Deliberately a BACKSTOP, not a replacement: the JS gates still produce the
// refusal the model reads and the audit entry the user sees. Where DNR is
// unavailable (Firefox's partial implementation) the guard is a no-op and
// behavior is exactly what it was before.
const drivenTabIds = () => {
  /** @type {Set<number>} */
  const ids = new Set();
  // Tabs a web actor owns — the ones it navigates and reads the DOM of.
  for (const [tabId] of webActorTabBindings.entries()) ids.add(tabId);
  // Engine tabs. The WebVM's network already proxies through webFetch and the
  // Notebook worker is sealed, so App tabs are the ones with a real un-gated
  // network edge — but scoping all three keeps the rule uniform and costs a
  // rule condition entry, not a check per request.
  for (const tracker of [vmTabTracker, jsTabTracker, appTabTracker]) {
    for (const instanceId of tracker.listLive()) {
      const tabId = tracker.getTabId(instanceId);
      if (typeof tabId === 'number') ids.add(tabId);
    }
  }
  return [...ids];
};
// The IdP registry as bare domains for the allow rule — derived NEXT TO the
// registry (knownIdpDomains) so a registry edit moves the excursion rule and
// this carve-out together. Computed once; the registry is a frozen constant.
const idpExemptDomains = knownIdpDomains();

const denylistNetGuard = makeDenylistNetGuard({
  dnr: /** @type {any} */ (globalThis).chrome?.declarativeNetRequest,
  // The IdP carve-out. The origin lock lets a bound actor's tab leave its owned
  // origin exactly once, for a sign-in, and several identity providers are also
  // denylist entries — an overlap both halves intend (the denylist stops the
  // AGENT driving a login box; the excursion keeps the tab usable so the PERSON
  // can finish signing in and the actor can resume). A blanket network block
  // would break that, so the rule pair exempts exactly the IdP registry — which
  // stays the single authority on what counts as one. No authority is granted:
  // isDenylistedTab still refuses every DOM tool on such a tab.
  buildUpdate: (/** @type {any} */ input) => denylistSessionRuleUpdate({ ...input, exemptDomains: idpExemptDomains }),
  getPatterns: () => denylistStore.patterns(),
  getTabIds: drivenTabIds,
  audit: (/** @type {any} */ entry) => { auditLog.append(entry).catch(() => {}); },
});

// ---------------------------------------------------------------------------
// issue 251 — the origin lock, made live.
// ---------------------------------------------------------------------------
//
// Everything that DECIDES lives in peerd-runtime (the rule, the classifier, the
// IdP seeds, the report). What is here is the part only the SW can do: say WHICH
// actors are locked, keep their state, and turn a stop into something the
// orchestrator can act on.
//
// WHICH ACTORS ARE LOCKED, decided once, here, rather than re-litigated per
// call: a TAB-BACKED WEB ACTOR, and nothing else.
//
//   * the orchestrator          — drives the user's own foreground tab on the
//                                 user's own instruction. Locking it would mean
//                                 peerd refusing to look at the page you are on.
//   * the three engine kinds    — act on an instance, never a tab. No landing.
//   * the dweb actor            — no tab either.
//   * an API actor (backing:'api') — already bound to ONE fixed origin by
//                                 `withApiCredentials`, which is the same
//                                 property this lock exists to create. Adding a
//                                 second mechanism would be duplication, not
//                                 defence.
//
// A context with no state is UNLOCKED, and that is the pre-#251 behaviour rather
// than a refusal — see the fail-open note in origin-lock.js for why failing
// closed there would break the product rather than harden it.

/**
 * The vault's `origin:<origin>` secrets, cached as a Set for the SYNCHRONOUS
 * sensitivity check. `classifyOriginSensitivity` needs `hasVaultSecret(origin)`
 * to answer without awaiting — it runs inside a credential-scope getter — but
 * `vault.listSecretNames()` is async AND throws when locked.
 *
 * why a cache rather than resolving per context build: an origin the user stored
 * a key for is sensitive whether or not the vault happens to be unlocked right
 * now, and a locked vault must not silently DOWNGRADE an origin to ordinary.
 * Once seen, an origin stays in the set for this SW lifetime; the refresh only
 * ever adds. (An origin whose key the user deletes therefore stays classified
 * sensitive until the SW restarts — the safe direction, and the reason this
 * doesn't clear.)
 * @type {Set<string>}
 */
const keyedOrigins = new Set();
const refreshKeyedOrigins = async () => {
  try {
    const names = await vault.listSecretNames();
    for (const name of names) {
      const origin = originFromSecretName(name);
      if (origin) keyedOrigins.add(origin);
    }
  } catch { /* locked — keep what we have; never shrink */ }
};
refreshKeyedOrigins();
vault.subscribe(() => { if (!vault.isLocked()) refreshKeyedOrigins(); });

/**
 * Per-actor origin state, cached in the heap and persisted on the actor's own
 * session record.
 *
 * why the session record and not chrome.storage.session: `ownedOrigin` and the
 * excursion counters are the actor's authority, and they must survive a service
 * worker eviction mid-task. The record is already this actor's durable identity
 * (it is where `instanceId`, `backing` and its memory live), so the state rides
 * the thing whose lifetime it shares. The store elides no-op writes, so the
 * common "still where you were" verdict costs no IDB traffic.
 */
const originStates = makeOriginStateStore({
  save: async (sessionId, state) => { await sessions.update(sessionId, { originState: state }); },
  onError: (message, error) => console.warn('[origin-lock]', message, error),
});

/**
 * The origins peerd has LEARNED the user has an account on — grown from
 * ordinary use, because the two curated seeds will never be a complete list of
 * where someone is signed in.
 *
 * Durable in kv: this is the part of the classifier that gets better the longer
 * peerd is used, and throwing it away on every service-worker eviction would
 * mean it never got better at all.
 */
const learnedOrigins = makeLearnedOrigins({
  load: async () => /** @type {any} */ (await kv.get('learnedOrigins.v1')),
  save: async (all) => { await kv.set('learnedOrigins.v1', all); },
  // Audit the FIRST time an origin is learned. why: this list silently changes
  // what peerd will and won't let a helper do, so a user asking "why did it
  // refuse to open that site" deserves a record naming the signal and the moment.
  onLearn: (origin, reason) => {
    auditLog.append({ type: 'origin_learned_sensitive', details: { origin, reason } }).catch(() => {});
  },
  // The inverse, from Settings. Recorded per-origin even for a bulk clear: the
  // learn entries name origins, so the un-learn entries must too or the log
  // cannot be read as a history of one site's protection.
  onForget: (origins) => {
    for (const origin of origins) {
      auditLog.append({ type: 'origin_unlearned_sensitive', details: { origin } }).catch(() => {});
    }
  },
  onError: (message, error) => console.warn('[learned-origins]', message, error),
});
learnedOrigins.hydrate();

/**
 * Record a learned signal. Canonicalizes here — ONE place — because the
 * classifier looks the origin up through the same normalizer, and a mismatch
 * would be a silent miss rather than an error.
 * @param {string | null | undefined} rawOrigin
 * @param {'password-field' | 'confirmed-write'} reason
 */
const noteLearnedOrigin = (rawOrigin, reason) => {
  const origin = normalizeApiOrigin(rawOrigin);
  if (origin) learnedOrigins.note(origin, reason);
};

/** The sensitivity signals, in the shape the classifier takes. */
const sensitivitySignals = () => ({
  // SEED 1 — #242's curated UGC registry, asked at ORIGIN level (isUgcHost, not
  // classifyUrl). #242 is path-scoped because it gates one WRITE on a page
  // strangers authored; the lock asks whether the user has an IDENTITY here,
  // and a session does not stop at a path boundary.
  isUgcZone: isUgcHost,
  // SEED 2 — the user stored a credential for it. Definitionally credentialed:
  // they authored the fact.
  hasVaultSecret: (/** @type {string} */ origin) => keyedOrigins.has(origin),
  getLearned: () => learnedOrigins.snapshot(),
});

/**
 * A stop, en route to the orchestrator.
 *
 * The lock ending an actor is only half a defence: an actor that stops with no
 * explanation looks to the orchestrator exactly like one that failed, and the
 * likely next move is to try again. So the stop is RECORDED here and read back
 * by the message_actor reply path, which returns it in place of the generic
 * "stopped before it produced a reply".
 *
 * The recorded text comes from `describeLandingStop` — ours, origins only, no
 * path, no query, nothing the actor or the page wrote. See that file for why
 * that constraint is the load-bearing one.
 * @type {Map<string, string>}
 */
const landingStopReports = new Map();

/**
 * A monotonic token per actor TURN, and the reason it has to exist.
 *
 * Aborting an offscreen actor run unwinds the worker but does NOT cancel the
 * SW-side tool dispatch it was waiting on — the 'actor/tool-dispatch' route
 * threads no abort signal for a bound actor. `navigate` can therefore still be
 * inside its 30-second load wait when the turn that issued it has already ended,
 * and its judge deliberately runs AFTER that wait. Adversarial review traced
 * what followed: the orphaned judge fires, writes a report keyed by bare
 * actorSessionId, and calls turnSlots.stop on that session — which by then is
 * the NEXT turn, about something else entirely. That turn is aborted and its
 * reply replaced with a report about a navigation it never made.
 *
 * The token makes a stop attributable. A judge built for turn N can only stop
 * turn N and only file a report for turn N; once N is over it is inert.
 * @type {Map<string, number>}
 */
const landingTurnTokens = new Map();
let landingTurnSeq = 0;
/** Open a fresh turn token for an actor. Called where the turn is claimed. */
const beginLandingTurn = (/** @type {string} */ actorSessionId) => {
  landingTurnSeq += 1;
  landingTurnTokens.set(actorSessionId, landingTurnSeq);
  return landingTurnSeq;
};

/** Build the two lock closures for one actor session. Null for an unlocked kind. */
const originLockFor = (/** @type {string | null | undefined} */ actorSessionId) => {
  if (!actorSessionId) return null;
  const getState = () => originStates.read(actorSessionId);
  // The turn this lock belongs to, captured at CONTEXT-BUILD time — the moment
  // the dispatch it will judge was authorized.
  const myTurn = landingTurnTokens.get(actorSessionId) ?? null;
  const isCurrentTurn = () => myTurn === null || landingTurnTokens.get(actorSessionId) === myTurn;
  return {
    getState,
    judgeLanding: makeJudgeLanding({
      getState,
      saveState: (patch) => originStates.write(actorSessionId, patch),
      onStop: (event) => {
        // A judge that outlived its turn may not stop anything and may not file
        // anything. It still records the landing in the audit trail below — the
        // observation was real even when the turn it belonged to is gone.
        const current = isCurrentTurn();
        if (current) landingStopReports.set(actorSessionId, describeLandingStop(/** @type {any} */ (event)));
        // RELEASE THE TAB. Without this the stop is self-sealing and the actor is
        // dead for good, which adversarial review demonstrated end to end:
        //
        //   navigate is the actor's ONLY way to change its tab's URL, and it
        //   calls resolveTargetTab FIRST — which judges the tab's CURRENT url.
        //   After a stop the tab is parked on the refused origin, so every later
        //   navigate is refused on the landing it is trying to leave. The next
        //   request in the chat — about anything at all — gets the same handoff
        //   report, forever. For a per-tab actor it outlives the chat entirely.
        //
        // Dropping the binding puts the actor back in the genuine 0-tab state,
        // where navigate's adopt path opens a fresh tab. That is a RECOVERY, not
        // a loosening: the new tab starts blank and its first landing is judged
        // like any other, so a bound actor still cannot leave its origin and a
        // roaming one still cannot enter a credentialed site. The refused tab
        // itself is left open and untouched — the user may well want to look at
        // it, and closing a tab out from under someone to enforce a policy they
        // did not see would be its own kind of wrong.
        if (current) {
          const parkedTab = webActorTabBindings.tabFor(actorSessionId);
          if (typeof parkedTab === 'number' && webActorTabBindings.drop(parkedTab)) persistWebBindings();
          // The stop hands this tab back to the user (they may want to look at
          // it), so peerd's group + pill come off with the binding. Without this
          // a refused tab stays in peerd's group forever, still looking driven.
          if (typeof parkedTab === 'number') pageActivity.release(parkedTab).catch(() => {});
          // A SITE actor whose very first landing was refused is a dead handle:
          // its owned origin is one the site does not actually serve, and the
          // binding is durable, so retrying the same handle resumed the same
          // doomed session and opened another orphaned tab. Dropping the binding
          // makes a retry MINT afresh — which, with the www-fold allowance, is
          // usually all that was needed. Only on the FIRST landing: after that
          // the origin is settled and an actor that wandered off it should stay
          // stopped rather than quietly re-home itself somewhere new.
          const st = originStates.read(actorSessionId);
          if (st?.provisional) {
            // The store's key is `${chatId} ${origin}` (one space; neither half
            // can contain one), so splitting on the FIRST space recovers the pair.
            let dropped = false;
            for (const [key, sid] of siteActorBindings.entries()) {
              if (sid !== actorSessionId) continue;
              const gap = key.indexOf(' ');
              if (gap < 0) continue;
              siteActorBindings.drop(key.slice(0, gap), key.slice(gap + 1));
              dropped = true;
            }
            if (dropped) persistSiteActors();
            originStates.forget(actorSessionId);
          }
        }
        auditLog.append({
          type: 'actor_origin_stop',
          sessionId: actorSessionId,
          // The audit trail keeps the FULL landing url (unlike the report): it is
          // local, append-only, and read by a human investigating — exactly the
          // place the detail belongs, and the one place it can't be read by a model.
          details: {
            action: event.action,
            from: event.from,
            // NARROWED to an origin, exactly like the report — NOT the full
            // landing URL, which an earlier version wrote here reasoning that
            // the audit is "local, append-only, and read by a human ... the one
            // place it can't be read by a model". That was wrong: `inspect`
            // exposes audit_log to the MAIN agent and returns entries verbatim
            // (only actor ERROR bodies are redacted). A hostile page that
            // redirects a bound actor to an attacker-chosen URL therefore got
            // ~2MB of attacker text into the orchestrator's context the moment
            // it inspected its own audit trail — the exact channel
            // origin-lock-report.js exists to close, reopened one door over.
            to: originPhrase(event.to),
            handoffTo: event.handoffTo ?? null,
            // Marks a landing observed after its turn ended — kept because a
            // stale judge firing is itself worth being able to see.
            ...(current ? {} : { staleTurn: true }),
          },
        }).catch(() => {});
        // End the actor's whole TURN, not just this tool call: a refusal alone
        // leaves the loop free to try the next tool against the same tab. Only
        // ever OUR turn — see landingTurnTokens for the turn this would
        // otherwise have aborted by accident.
        if (current) {
          try { turnSlots.stop(actorSessionId); } catch (e) { console.warn('[origin-lock] stop failed', e); }
        }
      },
      isIdp: isKnownIdp,
      ...sensitivitySignals(),
    }),
    makeScope: (/** @type {() => string | undefined} */ getOrigin) =>
      makeCredentialScope({ getState, getOrigin, ...sensitivitySignals() }),
  };
};

/**
 * Resolve the Plan/Act permission { mode, confirmActions } for a session
 * (Feature 03; tiers collapsed to one boolean 2026-06-12). Resolution
 * order, most-specific first:
 *
 *   1. The session record's own permissionMode / confirmActions (set the
 *      moment the user touches the mode selector; survives SW restart via
 *      IDB).
 *   2. sessionCache (chrome.storage.session) — covers the window after a
 *      mode change but before a session exists, and SW respawns.
 *   3. Hard defaults — Act + confirmations OFF, the DELIBERATE product
 *      default (peerd acts on the browser without nagging; see the
 *      why-comment in the body). The dispatcher-level fallback stays the
 *      cautious one by design: policy.js DEFAULT_PERMISSION_MODE /
 *      DEFAULT_CONFIRM_ACTIONS are Plan + confirm ON, and the
 *      normalizers clamp any garbage record to that read-only side.
 *
 * Pure-ish: only reads, no writes. normalizeMode/normalizeConfirmActions
 * clamp any garbage to safe defaults so a bad record can't widen
 * authority.
 *
 * @param {{ permissionMode?: unknown, confirmActions?: unknown } | null} activeSession
 * @returns {Promise<{ mode: string, confirmActions: boolean }>}
 */
const resolvePermission = async (activeSession) => {
  // Goal mode runs UNATTENDED: while a goal run is active for this session, the
  // effective permission is Act + confirm-off — COMPUTED here, never written to
  // the record. Because every consumer (the turn's tool context, the dispatch
  // gates, the state-snapshot the Plan/Act pill reads) resolves through this one
  // function, the autonomy applies everywhere AND reverts the instant the run
  // ends or pauses (isActive flips false) — nothing to restore, nothing to
  // strand if the SW dies mid-run. why not store it: a stored flip needs a
  // restore, and a restore that depends on an in-memory run surviving an
  // auto-lock/eviction is exactly the bug class this avoids.
  const goalSid = /** @type {any} */ (activeSession)?.sessionId;
  if (goalSid && goalRunner?.isActive(goalSid)) {
    return { mode: PERMISSION_MODES.ACT, confirmActions: false };
  }
  // Product default for a fresh install: ACT with confirmations OFF —
  // peerd acts on the browser without nagging. (A corrupted record still
  // fails safe via the normalizers.) The "Confirm before actions" Settings
  // toggle persists confirmActions per chat.
  const rawMode = activeSession?.permissionMode
    ?? (await sessionCache.sessionGet('currentPermissionMode'))
    ?? PERMISSION_MODES.ACT;
  const cachedConfirm = confirmActionsFromRecord({
    confirmActions: await sessionCache.sessionGet('currentConfirmActions'),
  });
  const rawConfirm = confirmActionsFromRecord(activeSession)
    ?? cachedConfirm
    ?? false;
  return { mode: normalizeMode(rawMode), confirmActions: normalizeConfirmActions(rawConfirm) };
};

// Per-session promise chains serializing todo read-modify-writes (the
// ctx.todoStore below). Keyed by sessionId; an entry is just the tail of the
// chain, so the map stays tiny and dies with the SW (the persisted list is
// the durable state).
/** @type {Map<string, Promise<unknown>>} */
const todoChains = new Map();

/**
 * Build a ToolContext for the current call. The agent loop (commit 2)
 * will pass this into the dispatcher per tool call; the side-panel
 * verify-without-LLM affordance uses it directly. We snapshot the
 * provider + vault state so tools see a consistent view during a
 * single dispatch.
 */
// The in-page activity indicator, one per service worker. Holds the set of tabs
// it has marked so release() only ever undoes its own grouping — a tab the user
// grouped themselves is none of its business. Best-effort throughout; on Firefox
// browser.tabGroups is undefined and the group half quietly no-ops.
const pageActivity = createPageActivityReporter({
  tabs: browser.tabs,
  tabGroups: /** @type {any} */ (browser).tabGroups,
  scripting: browser.scripting,
});

const buildToolContext = async (/** @type {any} */ { sessionId: overrideSessionId, activeTabId, exposure, synthetic, trusted, actorInstanceId, actorType, actorBacking, actorSurface } = {}) => {
  // SECURITY: never build a tool context against an unloaded denylist. The seed
  // loads async; this await closes the cold-start race so the origin gate always
  // sees the real denylist before any tool can dispatch. Resolves (never
  // rejects) — it cannot hang the turn. Every dispatch path (main turn, direct
  // dispatch, spawned actors) routes through here, so all are covered.
  await denylistReady;
  // Same shape, one layer down: never dispatch a tool while the DNR backstop
  // trails the driven-tab set. Most binding paths kick the sync without awaiting
  // it (bind() is a sync callback), so an actor's FIRST tool call could
  // otherwise race the rule landing — adoptWebTab awaits, but the site-actor
  // path (addressing an existing tab) did not. Awaiting here closes every such
  // race structurally. Cheap: a no-change sync short-circuits on the
  // fingerprint, and the promise never rejects.
  await denylistNetGuard.sync();
  // why: the override lets the actor orchestrator build a context
  // bound to a CHILD session id instead of the chat's current one. With
  // no override this is identical to the original behaviour (the active
  // chat session). When overridden, depth comes from the target session
  // record, not the chat's.
  const sessionId = overrideSessionId ?? await sessionCache.sessionGet('currentSessionId');
  const activeSession = sessionId ? await sessions.get(sessionId) : null;
  // Plan/Act permission axis (Feature 03). Per-session, persisted in the
  // session record; sessionCache is the MV3-survival fallback for the
  // pre-session-create window. See resolvePermission for the resolution
  // order.
  const permission = await resolvePermission(/** @type {any} */ (activeSession));
  // Per-session tool manifest → the exposure gate's dispatch-time check.
  // Resolved from the session RECORD (main chat, or a child that inherited
  // the manifest at spawn), so every dispatch path that builds a context
  // here — main turn, direct dispatch, spawned actors — enforces it.
  // null = no manifest = everything stays exposed.
  const toolAllow = resolveManifestAllow(activeSession?.toolManifest);
  // why: key presence is per-PROVIDER. A session created on OpenRouter
  // checks the OpenRouter key, not Anthropic's. Falls back to the active
  // provider setting for sessions that predate the provider field.
  const ctxProviderName = activeSession?.provider ?? resolveActiveProvider().name;
  let hasKey = false;
  try { hasKey = !!(await vault.getSecret(secretNameForProvider(ctxProviderName))); }
  catch { hasKey = false; }
  // Resolve the active tab once per ctx build. Tools use this as the
  // default target; the origin gate uses ctx.activeTab.origin against
  // the denylist before any DOM tool runs.
  // DESIGN-17: an ACTOR has NO user-foreground-tab context — its tools act on
  // its instance (origins:()=>[]), never the user's page. Skip the query so the
  // actor ctx never carries the user's foreground origin (a latent leak the
  // moment an actor ever gains a tab-targeting tool), matching the turn
  // driver's memory/active-tab skip.
  /** @type {{ id?: number, windowId?: number, url: string, origin: string } | undefined} */
  let activeTab;
  try {
    if (exposure === EXPOSURE_ACTOR) {
      // A WEB actor OWNS exactly one tab: its DOM tools must target THAT tab,
      // and the origin/denylist gate must see THAT tab's origin. Resolve activeTab
      // from the owned tab id (threaded as activeTabId) ONLY — and FAIL CLOSED: if
      // the owned tab can't be resolved (closed/unknown), leave activeTab undefined
      // rather than ever querying the foreground (a web actor must NEVER act on
      // the user's current page). The three ENGINE kinds (webvm/notebook/app) act
      // on their instance, not a tab, so they stay activeTab-undefined as before.
      if (actorType === 'web' && activeTabId != null) {
        const t = await browser.tabs.get(activeTabId).catch(() => null);
        if (t) {
          activeTab = {
            id: t.id,
            windowId: t.windowId,
            url: t.url ?? '',
            origin: originOfTabUrl(/** @type {string} */ (t.url)),
          };
        }
      }
    } else {
    // why: a web actor is PINNED to one specific tab, passed as activeTabId.
    // Resolve activeTab to THAT tab so its DOM tools target it — and, critically,
    // so ctx.activeTab.origin is the actor's tab for the origin/denylist gate.
    // With no activeTabId this is the original behaviour: the chat's current
    // active tab.
    let t;
    if (activeTabId != null) {
      t = await browser.tabs.get(activeTabId).catch(() => null);
    } else {
      [t] = await browser.tabs.query({ active: true, currentWindow: true });
    }
    if (t) {
      activeTab = {
        id: t.id,
        windowId: t.windowId,
        url: t.url ?? '',
        origin: originOfTabUrl(/** @type {string} */ (t.url)),
      };
    }
    }
  } catch (e) {
    console.warn('[sw] active tab query failed', e);
  }
  // PR #119: resolve the tab web actor's ACTION surface ONCE. An explicit arg
  // wins (the page/call route forces 'tools' for its inner mapped dispatch);
  // otherwise it's the live setting. Used BOTH to stamp ctx.actorSurface (gate +
  // descriptors) AND the capability strip below — the turn driver doesn't pass
  // actorSurface, so the strip can't read the raw param; it must use THIS.
  const effectiveActorSurface = (actorType === 'web' && actorBacking !== 'api')
    ? (actorSurface ?? (settingsStore.get().webActorActionSurface === 'code' ? 'code' : 'tools'))
    : undefined;
  const ctx = {
    // why: the exposure gate (gates.js) reads this. 'main' is set ONLY on
    // the main agent turn; it makes the main-hidden DOM/page tools refuse
    // at dispatch, so a prompt-injected model can't reach them by name.
    // Actors leave it unset. DESIGN-17: an actor turn sets 'actor' — the
    // kind-scoped, instance-pinned tier (the web actor holds the DOM tools;
    // the capability strip below makes its ctx keyless).
    exposure: exposure ?? null,
    synthetic: synthetic === true,
    // The recovery contract's dispatch tracker (lifecycle/dispatch-tracking.js).
    // Read at ctx-build time: before the async boot resolves this is null and
    // the dispatch runs untracked (pre-lifecycle behavior); once armed, every
    // path through this builder — main turn, actor relay, page-call — records
    // side-effecting calls durably and refuses unproven replays.
    lifecycle: lifecycleTracker,
    // DESIGN-17: the message_actor sender gate's untrusted-ORIGIN signal. A
    // synthetic turn (goal continuation / async wake / actor reply-wake) is
    // "inbound" — refused — UNLESS it is an explicit first-party continuation
    // that set trusted:true (goal turns + actor reply-wakes do). FAIL-CLOSED:
    // any NEW re-entry source (peer messages) is inbound by default and must
    // never set trusted; the gate's `=== active` check is the second wall.
    // Direct/composer builds: synthetic false → inbound false.
    // Scheduled routines (loop/scheduler.js): a firing's FIRST turn is
    // synthetic:false (inbound:false, a real turn like a typed message); a
    // 'goal'-mode firing's CONTINUATIONS run trusted like any goal run. Their
    // first-party standing is earned at ARM time — schedule_create force-confirms,
    // so a routine can't be planted (or self-replicate) without the user
    // approving its exact prompt — not asserted here per-firing.
    inbound: synthetic === true && trusted !== true,
    // DESIGN-17: an actor's bound instance + kind (the gate's per-instance pin
    // + positive kind-scope read these; absent on non-actor ctx).
    ...(actorInstanceId ? { actorInstanceId } : {}),
    ...(actorType ? { actorType } : {}),
    // DESIGN-18: a web actor's backing (the gate reads it to refuse DOM tools for an
    // API actor, which has no tab). Absent = tab backing (the DESIGN-17 default).
    ...(actorBacking ? { backing: actorBacking } : {}),
    // PR #119: a TAB web actor's ACTION surface — 'tools' (discrete DOM tools) or
    // 'code' (page_code REPL). An explicit arg wins (the page/call route forces
    // 'tools' for its inner mapped-tool dispatch); otherwise it's the live setting.
    // The gate reads ctx.actorSurface to pick the allow-set; absent = 'tools'.
    ...(effectiveActorSurface ? { actorSurface: effectiveActorSurface } : {}),
    // #241: the PROMPT half of the deterministic schema boundary. The turn driver
    // reads it off this ctx to decide which rule (3) the actor's system prompt
    // carries (loop/system-prompt.js SCHEMA_REPLY_RULE). It comes from the SAME
    // setting that arms the validator in actorMessaging below, read LIVE on both
    // sides — that is what keeps the two halves one switch. Stamped for every ctx
    // (not just actors) because it costs nothing and the turn driver only forwards
    // it on an actor turn; narrowing to the kinds that validate lives in
    // actorBlock, next to the rule it selects.
    schemaReply: settingsStore.get().schemaValidatedReplies === true,
    // DESIGN-17: the WEB actor SELF-FENCES its own rolling summary. Its whole
    // accumulation is untrusted-provenance (every byte derives from page content),
    // so when the agent loop folds the trim-summary back into history it wraps it
    // with this — even a laundered injection that survives compression re-enters as
    // DATA, not a command. (Survives restrictCtxCapabilities below: this is not a
    // CAPABILITY_CONSUMERS key, so the keyless narrowing leaves it in place.)
    ...(actorType === 'web'
      ? {
        // DESIGN-18: an API actor self-fences its learned memory tagged with its FIXED
        // owned origin (actorInstanceId); a tab actor tags its current tab url.
        fenceActorSummary: actorBacking === 'api'
          ? (/** @type {string} */ text) => fenceApiActorSummary(text, { origin: actorInstanceId })
          : (/** @type {string} */ text) => fenceWebActorSummary(text, { tabUrl: activeTab?.url }),
      }
      : {}),
    // why: the exposure gate's SECOND check — the session's resolved tool
    // manifest (Set | null) plus the label its refusal reason names, so
    // the lineage tells the user WHICH manifest excluded the tool.
    toolAllow,
    toolManifestLabel: toolAllow ? manifestLabel(activeSession?.toolManifest) : null,
    session: {
      sessionId: sessionId ?? null,
      // why: the actor_create tool reads ctx.session.depth to compute
      // the child's depth (parent + 1) and enforce maxDepth. Defaults to
      // 0 for legacy sessions written before the field existed.
      depth: activeSession?.depth ?? 0,
      // why: message_actor reads ctx.session.kind to pick its reply mode
      // (PR #134): a 'spawned' sender is an EPHEMERAL call-site with no
      // later turn to wake, so its actor reply is awaited into the tool
      // result instead of delivered as a re-entry wake.
      kind: activeSession?.kind ?? 'chat',
      // why: load_skill's trim-aware once-per-session dedup (schema-diet 6b).
      // messageCount is where this call's result will sit; trimCovered is the
      // count of leading messages the rolling summary has folded out of the
      // SENT slice. A re-load re-injects the full body only once trimCovered
      // has passed the prior load's position — so a skill still in context is
      // deduped, one that scrolled out is re-paged. Read-only, both default 0.
      messageCount: Array.isArray(activeSession?.messages) ? activeSession.messages.length : 0,
      trimCovered: activeSession?.trimSummary?.covered ?? 0,
    },
    // Plan/Act permission policy input. The persona gate reads
    // permission.mode to enforce Plan's read-only block; the dispatcher
    // reads permission.confirmActions to decide whether each non-read
    // action confirms. { mode: 'plan'|'act', confirmActions: boolean }.
    permission,
    activeTab,
    // The in-page activity indicator (background/page-activity.js). The
    // dispatcher calls begin/end around every `primitive:'tab'` call, so the
    // tab peerd is driving marks itself in the tab strip and says what it is
    // doing. Threaded here rather than imported by the dispatcher so the IO
    // stays injected and every non-SW dispatch path (tests, the offscreen
    // worker's own ctx) simply has no indicator.
    onToolActivity: pageActivity,
    // why: the bound actor orchestrator. The actor_create tool calls
    // ctx.spawnActor(...) to decompose a task into a child session
    // that runs the same loop. Wired below; see makeSpawnActor.
    spawnActor,
    // DESIGN-17: the message_actor orchestrator (wired below). An actor's own
    // ctx strips this back out (it's not in its toolset, so the keyless narrowing
    // removes it).
    messageActor: (/** @type {any} */ req) => actorMessaging.messageActor(req),
    // why: the script tool's actors surface. The tool registers its run here
    // (with the dispatch abort signal) BEFORE launching the worker; the
    // actors/call route derives every pending ask's awaitSignal from it, and
    // the tool aborts + releases on the way out — one Stop unwinds the fan.
    scriptRuns,
    // why: DESIGN-11 async spawned actors. spawnActorAsync fires the child
    // fire-and-forget and returns a handle; its result re-enters the parent
    // as a later synthetic turn. actorTasks/actorCancel back the
    // actor_tasks (peek) and actor_cancel tools, scoped to THIS session.
    spawnActorAsync,
    actorTasks: () => actorTasksSnapshot(sessionId),
    actorCancel: (/** @type {string} */ taskId) => actorCancel(sessionId, taskId),
    // why: the request_review tool calls ctx.requestReview(...) to spawn a
    // clean-context READ-ONLY reviewer over a diff and get a structured
    // summary back. Bound below; see makeRequestReview. Feature 08.
    requestReview,
    // why: the complete_goal tool calls ctx.completeGoalRun(summary) to end the
    // autonomous goal run for THIS session (loop/goal-runner.js). Resolves at
    // call time (goalRunner is built after this fn is defined). Returns false
    // outside an active run, which the tool surfaces as a harmless no-op.
    completeGoalRun: sessionId
      ? (/** @type {string} */ summary) => goalRunner?.complete(/** @type {string} */ (sessionId), summary) ?? false
      : undefined,
    // why: the schedule_* tools call these to register / list / remove background
    // Routines (loop/scheduler.js). Resolved lazily — `scheduler` is built after
    // this fn (same late-dep dance as goalRunner). Routines are GLOBAL (not
    // per-session), so these are present regardless of sessionId.
    scheduleAdd: (/** @type {any} */ req) => scheduler?.add(req) ?? { ok: false, error: 'schedule_unavailable' },
    scheduleList: () => scheduler?.list() ?? [],
    scheduleRemove: (/** @type {string} */ id) => scheduler?.remove(id) ?? false,
    // why: the todo_* tools mutate the session's plan-of-record through this
    // serialized read-modify-write (todoChains, module scope) — two todo ops
    // in one concurrent tool wave would otherwise race the record and lose an
    // update. apply(fn): fn is PURE (todo/core.js); a result with ok+todos is
    // persisted, anything else is returned untouched. Goal-run-scoped like
    // completeGoalRun: absent outside a live run, so the tools no-op cleanly.
    todoStore: sessionId && goalRunner?.isActive(/** @type {string} */ (sessionId))
      ? {
          apply: (/** @type {(todos: any) => any} */ fn) => {
            const sid = /** @type {string} */ (sessionId);
            const next = (todoChains.get(sid) ?? Promise.resolve()).then(async () => {
              const rec = await sessions.get(sid);
              const out = fn(rec?.todos);
              if (out?.ok && Array.isArray(out.todos)) {
                await sessions.update(sid, { todos: out.todos });
              }
              return out;
            });
            // why swallow for the CHAIN only: a failed apply must not wedge
            // every later todo op; the caller still sees its own rejection.
            todoChains.set(sid, next.catch(() => {}));
            return next;
          },
        }
      : undefined,
    dom: undefined,
    // why: vm is a SW-side client that proxies vm/run + vm/write-file
    // messages via chrome.tabs.sendMessage to the discrete VM tab.
    // The tool reaches the chat's "current VM" by passing ctx.session.
    // sessionId; vmClient resolves it via the registry (auto-creating
    // a fresh VM on first call for new chats).
    vm: vmClient,
    // why: agent tools for VM lifecycle. vmRegistry exposes the
    // catalog (list / get / create / delete / attach to session).
    // vmTabTracker tells which VMs are currently live (have a tab open).
    vmRegistry,
    vmTabTracker,
    // why: Notebook kind — lighter peer of VMs. jsClient.eval runs
    // code in the Notebook worker; the registry + tracker are the same
    // shape as the VM versions so tools can reason uniformly.
    jsClient,
    jsRegistry,
    jsTabTracker,
    // script — a HEADLESS sibling: the same sealed worker, hosted in the
    // offscreen doc (no tab). Defined after ensureOffscreen below.
    jsOffscreenClient,
    // read_pdf — PDF text extraction in the offscreen doc (pdf.js needs a
    // Worker the SW can't host). Defined after ensureOffscreen below.
    pdfOffscreenClient,
    // read_doc — office/publishing formats (Word/Excel/PowerPoint/ODF/RTF/EPUB/
    // CSV) converted to Markdown in the offscreen doc. Defined after
    // ensureOffscreen below. NOT in spawn.js CAPABILITY_CONSUMERS (like
    // pdfOffscreenClient), so it survives the web actor's capability strip.
    docOffscreenClient,
    // fetch_url's clean-content extraction — HTML -> markdown in the offscreen
    // doc (Readability needs a DOM Document the SW can't build). Defined after
    // ensureOffscreen below. NOT in spawn.js CAPABILITY_CONSUMERS (like
    // pdfOffscreenClient), so it survives the web actor's capability strip.
    webOffscreenClient,
    // why: App kind — DOM-bearing artifact the agent built for the
    // user. appClient combines registry (metadata) + body store (IDB).
    appClient,
    appRegistry,
    appTabTracker,
    // why: the dweb network surface for the dweb_share/discover/install tools —
    // the SAME ops the home UI uses, reaching the offscreen base host. Injected
    // ONLY when the dweb is on (DWEB_ENABLED + the setting), so on the store build
    // (and dweb-off) ctx.dweb is null and the tools (already hidden by exposure)
    // also no-op. share reads the app's OPFS bundle like export does.
    dweb: (DWEB_ENABLED && settingsStore.get().dwebEnabled) ? {
      share: async (/** @type {string} */ appId) => {
        const record = await appRegistry.get(appId);
        if (!record) return { ok: false, error: 'app-not-found' };
        const opfs = opfsHelpers(['peerd-apps', appId]);
        /** @type {Record<string, any>} */ const files = {};
        for (const f of await opfs.list()) { const path = f.path.replace(/^\/+/, ''); files[path] = await opfs.read(path); }
        await ensureOffscreen();
        const r = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'dweb/base-host/share-app', name: record.name, entry: record.entryFile, files }));
        // Mark shared so deleting this app later un-shares it (stops serving the
        // bytes) — same bookkeeping as the Library's Share button.
        if (r?.ok) { try { await appRegistry.update(appId, { shared: true }); } catch (e) { console.debug('[dweb.share] mark shared failed', e); } }
        return r;
      },
      discover: async () => { await ensureOffscreen(); return browser.runtime.sendMessage({ type: 'dweb/base-host/heard' }); },
      install: async (/** @type {any} */ { uri, name } = {}) => { await ensureOffscreen(); return browser.runtime.sendMessage({ type: 'dweb/base-host/install-app', uri, name }); },
      peers: async () => { await ensureOffscreen(); return browser.runtime.sendMessage({ type: 'dweb/base-host/peers' }); },
      block: async (/** @type {any} */ { did, block = true, reason } = {}) => { await ensureOffscreen(); if (block && typeof did === 'string') { a2aRevoke(did); conversationRegistry.closeDid(did); } return browser.runtime.sendMessage({ type: block ? 'dweb/base-host/ban' : 'dweb/base-host/unblock', did, reason }); },
      setDiscovery: async (/** @type {any} */ { enabled } = {}) => { await ensureOffscreen(); return browser.runtime.sendMessage({ type: 'dweb/base-host/set-discovery', enabled }); },
    } : null,
    // why: debuggerPool exposes the CDP channel for snapshot / page_exec /
    // page_keys / read_state and the ref path of click / type. Lazy-attaches
    // per tab on first use; the "DevTools is debugging" banner shows while
    // attached, no cost when idle. Injected ONLY while the
    // advancedAutomationEnabled SETTING is on (the permission itself is
    // required at install — Chrome forbids optional `debugger`) — otherwise
    // undefined, so each tool's existing guard returns a clean unavailable
    // error (or, for click/type, falls back to the chrome.scripting
    // selector path).
    debuggerPool: advancedAutomationOn() ? debuggerPool : undefined,
    // why: when the pool is absent, the CDP-ONLY tools (page_exec,
    // page_keys — the ones with no scripting fallback) want to tell the
    // model WHY. Two shapes:
    //   'setting_off'        — Chrome with the `debugger` permission
    //     installed but the advancedAutomationEnabled SETTING off: the
    //     capability exists, the nudge offers to turn it back on.
    //   'browser_unsupported' — the chrome.debugger API isn't present at
    //     all. Covers BOTH Firefox (no such WebExtension API) AND the store
    //     Chrome package, which ships without the `debugger` permission until
    //     it's re-added post-approval. Neither has a switch to flip, so the
    //     message is channel-agnostic and the nudge stays silent (it already
    //     bails on !debuggerApiAvailable()). We deliberately do NOT split
    //     Firefox vs store-Chrome here: that would require leaking the build
    //     channel to the agent (CLAUDE.md forbids it) for no actionable gain.
    cdpUnavailableReason: advancedAutomationOn()
      ? null
      : (debuggerApiAvailable() ? 'setting_off' : 'browser_unsupported'),
    // why: DOM-nav ref registry (Phase 1). snapshot stores @e<n> refs here;
    // click({ref}) resolves them to a backendDOMNodeId for CDP dispatch —
    // or, for DOM-walk pseudo-snapshot refs, to a page-side walkId.
    domRefs,
    tabs: browser.tabs,
    // open_tab opens in the background and announces a "go there" card instead of
    // stealing focus; this is the late-bound announce (defined below).
    // noteTab updates the "current agent tab" card to whatever tab a tool just
    // touched (open_tab, and DOM tools via resolveTargetTab) — a web tab, so it
    // carries just a label (the page). Late-bound.
    noteTab: (/** @type {number} */ tabId, /** @type {string} */ label, /** @type {any} */ opts = {}) => noteAgentTab(tabId, { ...(label ? { label } : {}), opened: opts.opened !== false }),
    // open_tab calls this for a web tab it opened: schedule the informational
    // "pull peerd in" reminder to inject once the page is visible (SW-side; no
    // page→SW route). Engine tabs don't use it — they carry the real button.
    hintPullIn: (/** @type {number} */ tabId, /** @type {string} */ url) => scheduleWebTabHint(tabId, url),
    // DESIGN-17: the web ACTOR's render-decision hook. A web actor with NO tab
    // (the 0-tab fetch state) calls this from navigate to lazily OPEN + ADOPT its one
    // tab, bound to THIS actor's session. Injected ONLY for the web kind; the
    // capability strip drops it from any actor whose toolset lacks navigate, and
    // it's absent on the main/actor ctx (actorType unset). adoptWebTab
    // is defined later in the file — referenced lazily here (called at turn time),
    // the same late-bound pattern as noteAgentTab.
    // DESIGN-18: an API actor (backing:'api') never renders — no tab, ever — so it
    // does NOT get the render hook (only a tab-backed web actor lazily adopts a tab).
    ...(actorType === 'web' && actorBacking !== 'api' ? { adoptWebTab: () => adoptWebTab(sessionId) } : {}),
    scripting: browser.scripting,
    // issue 251: the snapshot tool calls this when the page it just walked had a
    // password field. Injected rather than imported so the tool stays free of
    // storage, and present on every context — the orchestrator's own snapshots
    // teach the classifier exactly as well as an actor's, and there is no reason
    // to learn less from the one the user drove themselves.
    noteLearnedOrigin,
    // DESIGN-18 P2: actor_list reads this for its integration rows — the chat's API integrations
    // (formed ∪ keyed). Referenced lazily (defined later, called at turn time, like
    // adoptWebTab). Only the orchestrator calls it (the gate refuses it for actors).
    listApiIntegrations: () => listApiIntegrations(sessionId),
    // why: web tools (fetch_url) reach arbitrary
    // HTTPS hosts. They use webFetch (denylist + audit) NOT safeFetch
    // (provider-allowlist, locked down). safeFetch is still in ctx for
    // any future tool that legitimately needs to hit a provider.
    safeFetch,
    webFetch,
    // fetch_url's spill-and-page store: oversized fetched text spills here and
    // read_web_cache pages it back. Stripped to exactly those two tools by
    // spawn.js CAPABILITY_CONSUMERS.webCache.
    webCache,
    // script's value-spill store: an oversized [VALUE] spills here and
    // read_run_cache pages it back. Stripped to exactly those two tools by
    // spawn.js CAPABILITY_CONSUMERS.runCache.
    runCache,
    // why: web tools open background tabs unconditionally (never-steal-
    // focus policy, 2026-06-12); settings ride along for other consumers.
    settings: { ...settingsStore.get() },
    getSecret: (/** @type {string} */ name) => vault.getSecret(name),
    audit: (/** @type {any} */ entry) => auditLog.append(entry),
    // Real confirmation round-trip (SW ↔ side panel). The dispatcher
    // calls this when the Plan/Act decideAction policy says the action
    // needs approval (confirmActions ON confirms every non-read action;
    // OFF confirms nothing).
    confirm: confirmAction,
    // why: the memory store (V1.5). The remember/read_memory tools reach
    // file-based memory through ctx.memory; remember routes its write
    // through memory.writeWithConfirm → ctx.confirm (the same SW ↔ side
    // panel round-trip), so an agent memory write always asks the user.
    memory,
    kv,
    idb,
    // why: load_skill reads a skill's full SKILL.md body on invocation
    // (the expensive half of progressive disclosure). The registry caches
    // descriptions in memory; getBody hits IDB only when the model
    // actually loads a skill.
    skills: skillRegistry,
    // DESIGN-19: the site-client store (run/read/write reach it). Stripped from any
    // actor whose toolset lacks the site_client_* tools (CAPABILITY_CONSUMERS.siteClients);
    // present on the web actor. Harmless on the main ctx (the tools are hidden + gated).
    siteClients: siteClientStore,
    // design 06: the toolbox store + write-time parse check (toolbox_write/
    // list/delete). Stripped from any actor/child whose grants lack the tools
    // (CAPABILITY_CONSUMERS.toolbox / .toolboxParseCheck).
    toolbox: toolboxStore,
    toolboxParseCheck,
    // DESIGN-19: the capture closure for site_capture (Tap A CDP / Tap B scripting),
    // injected ONLY for a tab-backed web actor below (like adoptWebTab). Absent → the
    // tool returns site_capture_unavailable.
    // why a frozen COPY, not the live array: a tool context handed the live
    // list lets a stray tool/hook mutate the denylist for the whole SW lifetime;
    // a frozen snapshot makes the seed + user overlay read-only per context.
    // Gates/inspect only ever read it.
    denylist: Object.freeze([...denylistStore.patterns()]),
    // why: the egress-allowlist DEFAULT hook reads ctx.allowlist to veto
    // a network tool whose declared origin isn't a sanctioned provider
    // endpoint — the same list safeFetch enforces (hardcoded + user
    // endpoints). Snapshot per ctx build, like denylist.
    allowlist: Object.freeze([...HARDCODED_ALLOWLIST, ...userEndpoints]),
    // why: hooks may call ctx.now() for provenance timestamps; reuse the
    // SW clock. Optional — hooks fall back to Date.now() if absent
    // (e.g. in tests).
    now: Date.now,
    provider: {
      name: ctxProviderName,
      model: activeSession?.model ?? resolveActiveProvider().model,
      hasKey,
    },
    vault: { isLocked: vault.isLocked() },
  };
  // DESIGN-17: an ACTOR gets a KEYLESS, kind-narrowed tool context — a keyless,
  // narrow trust model. restrictCtxCapabilities strips every capability closure
  // (getSecret, safeFetch, webFetch, spawnActor, memory, messageActor, …)
  // that none of the actor's OWN kind tools need, so a confused/injected tool
  // has no path to secrets/egress/spawn. The loop still gets the provider key
  // via the turn driver's injected getSecret (off this ctx), exactly like a
  // actor. Non-actor ctx is unchanged.
  if (exposure === EXPOSURE_ACTOR) {
    // DESIGN-18: an API actor's allow-set is fetch_url-only (backing-aware), so the
    // strip drops the closures keyed in CAPABILITY_CONSUMERS that fetch_url doesn't use
    // (getSecret/safeFetch/adoptWebTab/engine/spawn/…). NB scripting + debuggerPool are
    // NOT in CAPABILITY_CONSUMERS (shared with the web actor's DOM tools), so they survive
    // here — the no-DOM guarantee for an API actor rests on the GATE refusing every DOM
    // tool (isAllowedForActor → fetch_url only), not on this strip.
    // PR #119: pass actorSurface — a CODE-surface web actor's allow-set is
    // { page_code }, so WITHOUT the surface the strip computed the TOOLS
    // allow-set (no page_code) and dropped jsOffscreenClient (page_code's
    // execution client) — page_code then returned 'page_code_unavailable' on
    // every call, silently breaking the whole code arm. The gate + descriptors
    // were already surface-aware; this strip is the one place that wasn't.
    const resCtx = restrictCtxCapabilities(ctx, new Set(actorAllowedToolsFor(actorType, actorBacking, effectiveActorSurface)));
    // The web actor's egress is SESSION-SCOPED at the boundary: its webFetch carries
    // the user's session ONLY for a request same-origin to the ORIGIN it owns (where it's
    // already in that session — no escalation, and it never holds a credential: the
    // browser attaches the origin's cookies, keyless intact). Every cross-origin request
    // stays sessionless, so an injected actor can't point a credentialed fetch at a
    // DIFFERENT logged-in site. The owned origin differs by backing:
    //   - tab   → the tab's LIVE origin (mutable; navigate re-pins resCtx.activeTab
    //             mid-turn, and the wrapper reads that SAME object live).
    //   - api   → the FIXED bound origin (actorInstanceId) — no tab, never changes.
    if (actorType === 'web' && actorBacking === 'api') {
      const ownedOrigin = typeof actorInstanceId === 'string' ? actorInstanceId : undefined;
      // DESIGN-18 P1: session-scope cookies AND inject the vault origin:<origin> key
      // same-origin (keyless: getSecret is the SW's, closed over here, never on resCtx).
      resCtx.webFetch = withDpopCredentials(webFetch, () => ownedOrigin, {
        getSecret: (/** @type {string} */ name) => vault.getSecret(name),
        getDpopKey: getDpopKeyForOrigin,
        audit: (/** @type {any} */ e) => auditLog.append(e),
      });
      // No repinActiveTab / adoptWebTab: an API actor has no tab to adopt or re-pin.
    } else if (actorType === 'web') {
      // issue 251 — THE LOCK GOES LIVE HERE, for exactly this kind: a tab-backed
      // web actor. Hydrating BEFORE the ctx is handed out is deliberate: the
      // store's sync read returns null until then, and null means "unlocked", so
      // a lazy hydrate would make the lock's absence the silent default on
      // exactly the first tool call of a turn — the call most likely to be the
      // one that matters.
      // Seeded from the RECORD we already read above — not from a second load
      // inside the store. Adversarial review found why that matters: a load that
      // threw fell back to `roaming`, so a transient storage error quietly
      // DEMOTED a bound actor, which for the credential scope is a widening.
      originStates.hydrate(sessionId, /** @type {any} */ (activeSession?.originState));
      const lock = originLockFor(sessionId);
      resCtx.judgeLanding = lock?.judgeLanding;
      // The session-credential scope, NARROWED by the same policy. `ctx.activeTab.origin`
      // IS the scope — read live on every request — so a page that redirects itself onto
      // a credentialed origin moves the scope with no tool call in between to judge. The
      // getter answers synchronously and can only ever withhold, so the ordinary
      // same-origin case is byte-for-byte what it was before #251.
      resCtx.webFetch = withSessionScopedCredentials(
        webFetch,
        lock
          ? lock.makeScope(() => /** @type {{ origin?: string } | undefined} */ (resCtx.activeTab)?.origin)
          : () => /** @type {{ origin?: string } | undefined} */ (resCtx.activeTab)?.origin,
      );
      // navigate adopts the actor's tab MID-TURN (0->1). It re-pins through this setter
      // — which closes over the SHARED resCtx — NOT a direct activeTab= on the per-call
      // {...ctx} copy the dispatcher hands each tool (that write would die with the copy),
      // so the rest of the turn's DOM tools + the session-scoped webFetch above see the
      // adopted tab. (The >=1-tab case mutates activeTab in place, which the shallow copy
      // already shares; only the 0->1 reassignment needs the setter.)
      resCtx.repinActiveTab = (/** @type {any} */ tab) => { resCtx.activeTab = tab; };
      // DESIGN-19: site_capture — inject the capture manager ONLY for a tab-backed
      // web actor (an API actor has no tab to observe). It survives the strip because
      // site_capture is in this actor's allow-set (CAPABILITY_CONSUMERS.siteCapture).
      resCtx.siteCapture = siteCaptureManager;
    }
    return resCtx;
  }
  return ctx;
};

// Local helper to avoid importing the same logic the dom-helpers file
// uses; this is the SW-side mirror of originOfUrl.
const originOfTabUrl = (/** @type {string} */ url) => {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.protocol === 'chrome:' || u.protocol === 'about:' || u.protocol === 'devtools:') {
      return `${u.protocol}//${u.host || u.pathname.split('/')[0] || ''}`;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------
// Actor orchestrator — one orchestrator, two surfaces.
// ---------------------------------------------------------------------------
//
// makeSpawnActor (peerd-runtime/actor) stays pure with everything
// injected; the SW binds the real loop/model/dispatcher/store/prompt/
// audit. Both the actor_create tool (via ctx.spawnActor) and the
// actor/spawn route (Notebook peerd.runtime.runAgent) call the same bound fn,
// so they share audit, gates, trust inheritance, and caps. The bound fn
// also defaults a live-event forwarder that streams the child's turn to
// the side panel's nested transcript, keyed by the child session id.

const forwardActorEvent = (/** @type {any} */ ev) => {
  if (!uiConnected()) return;
  const post = (/** @type {any} */ msg) => {
    try { uiPorts.broadcast(msg); }
    catch (e) { console.warn('[sw] actor forward failed', e); }
  };
  // why: distinct turn/spawned-* types (not the parent's turn/*) so the
  // side panel routes them into the per-child nested store instead of
  // clobbering the active chat's transcript.
  switch (ev.type) {
    case 'actor-start':
      post({ type: 'turn/spawned-start', parentToolUseId: ev.parentToolUseId, parentSessionId: ev.parentSessionId, sessionId: ev.sessionId, depth: ev.depth, task: ev.task });
      break;
    case 'actor-stop':
      post({ type: 'turn/spawned-done', parentToolUseId: ev.parentToolUseId, sessionId: ev.sessionId, depth: ev.depth });
      break;
    case 'state':
      post({ type: 'turn/spawned-state', session: ev.session });
      break;
    case 'delta':
      post({ type: 'turn/spawned-delta', sessionId: ev.sessionId, messageId: ev.messageId, text: ev.text });
      break;
    case 'tool-use':
      post({ type: 'turn/spawned-tool-use', sessionId: ev.sessionId, messageId: ev.messageId, toolUseId: ev.toolUseId, name: ev.name, input: ev.input });
      break;
    case 'tool-result':
      post({ type: 'turn/spawned-tool-result', sessionId: ev.sessionId, toolUseId: ev.toolUseId, result: ev.result });
      break;
    case 'stop':
      post({ type: 'turn/spawned-stop', sessionId: ev.sessionId, messageId: ev.messageId, stopReason: ev.stopReason });
      break;
    case 'error':
      post({ type: 'turn/spawned-error', sessionId: ev.sessionId, messageId: ev.messageId, error: ev.error });
      break;
    case 'usage':
      // why: actor/actor spend is SEPARATE from the main turn tally (the
      // main usage handler only folds its own session). Forward it so the eval
      // harness — and any future offload-cost meter — can attribute the
      // delegated work honestly instead of it looking free.
      post({ type: 'turn/spawned-cost', sessionId: ev.sessionId, usage: ev.usage });
      break;
    default:
      break;
  }
};

const spawnActorCore = makeSpawnActor({
  sessions,
  runUserTurn,
  callModel: /** @type {any} */ (callModel),
  // why the closure: contextSnapshots is declared further down the module —
  // defer the reference to call time (the postChatNote late-dep pattern).
  recordModelCall: (/** @type {Record<string, any>} */ call) => contextSnapshots.record(call),
  getSecret,
  safeFetch,
  appendAudit: /** @type {any} */ (auditLog.append),
  buildToolContext,
  dispatchToolCall: /** @type {any} */ (dispatchToolCall),
  // why: resolve background-tabs from CURRENT settings at call time, not
  // boot — settings load async and can change over the SW's life. This
  // design 01: a spawned child renders its prompt FRESH per spawn (no cross-turn
  // cache to bust), so it embeds its own temporal grounding — without this an
  // ephemeral child gets zero time bytes (the main path's <context> message is
  // built only in turn-driver and never reaches a child). Caller-supplied
  // temporalBlock still wins.
  renderSystemPrompt: (/** @type {any} */ opts) => renderSystemPrompt({
    temporalBlock: buildTemporalBlock({ lastTurnAt: null, nowMs: Date.now() }),
    ...opts,
  }),
  getToolDescriptors: () => listTools().map((t) => ({ name: t.name, description: t.description, schema: t.schema })),
  // PR #134 phase 1: children run UNDER turn slots so Stop / cancel / the
  // wall-clock timeout can abort them. Lazy arrows — turnSlots is defined
  // later in this module (after the agent loop); only called at spawn time.
  turnSlots: {
    claim: (/** @type {string} */ sessionId) => turnSlots.claim(sessionId),
    stop: (/** @type {string} */ sessionId) => turnSlots.stop(sessionId),
  },
  // Heap split: run a child's loop in a dedicated offscreen Worker instead of the
  // in-SW loop — the SAME substrate a bound actor uses (an actor is an ephemeral
  // actor: tool-less = pure reasoning, tool-bearing = a narrowed-general toolset), so
  // it flows through the ONE actorClient. A LAZY arrow — actorClient is a const
  // assigned LATER in module init (after ensureOffscreen); reading it at wiring time
  // would see the TDZ, so we only DEREFERENCE at call time. null on Firefox / when
  // offscreen is unavailable → the unavailable sentinel so spawn.js falls back to the
  // in-SW loop. The key never enters the worker; the model call and every tool call
  // relay back to SW-gated routes. Adapt the child job shape (sessionId/task/tools) to
  // the actor run shape (actorSessionId/message/tools); the 'actor/tool-dispatch' route
  // rebuilds the child's restricted ctx from the persisted grantedTools (never the
  // worker's args). Tools default to [] (a pure-reasoning child that never dispatches).
  runChildOffscreen: (/** @type {any} */ job, /** @type {any} */ opts) => actorClient
    ? actorClient.run({
      actorSessionId: job.sessionId, message: job.task, systemPrompt: job.systemPrompt,
      provider: job.provider, model: job.model, depth: job.depth,
      maxSteps: job.maxSteps, maxOutputTokens: job.maxOutputTokens, budgetMs: job.budgetMs,
      tools: job.tools ?? [],
    }, opts)
    : Promise.resolve({ ok: false, error: 'child offscreen unavailable' }),
  // design 01: embed temporal grounding — the offscreen child prompt renders
  // fresh per spawn (no cache), and the main path's <context> message never
  // reaches a child, so without this an ephemeral child has zero time bytes.
  renderSystemPromptForChild: (/** @type {string} */ task) => renderSystemPrompt({
    taskOverride: task,
    temporalBlock: buildTemporalBlock({ lastTurnAt: null, nowMs: Date.now() }),
  }),
});

// SW-bound spawn. Defaults the live forwarder so neither surface has to
// wire streaming; an explicit onEvent in `req` still wins.
const spawnActor = (/** @type {any} */ req) => spawnActorCore({ onEvent: forwardActorEvent, ...req });
// PR #134 phase 5: the live-children registry riding on the spawn orchestrator —
// agent/stop and actor_cancel walk it to end whole delegation subtrees.
const actorLifecycle = {
  stopSubtree: (/** @type {string} */ sessionId) => spawnActorCore.stopSubtree(sessionId),
  liveChildrenOf: (/** @type {string} */ sessionId) => spawnActorCore.liveChildrenOf(sessionId),
};

// ---------------------------------------------------------------------------
// Async spawned actors (DESIGN-11) — orchestration in peerd-runtime/actor.
// ---------------------------------------------------------------------------
//
// The spawn -> settle -> drain -> re-enter logic lives in a TESTABLE module
// (makeAsyncActors, peerd-runtime/actor/async-actors.js); the SW only
// injects its IO. actor_create's async path returns a handle immediately and
// the child's result re-enters the parent as a synthetic wake turn via
// turnSlots.runWhenIdle (never aborts a live turn — DECISIONS #20). A per-chat
// LIFETIME cap stops a re-spawn runaway (the live force-quit bug; reproduced in
// tests/peerd-runtime/actor/async-actors.test.js).

// Generic, content-free desktop notification (DECISIONS #20): title only —
// NEVER the result text or any watched content.
const notifyAsyncActor = (/** @type {number} */ count) => {
  try {
    browser.notifications?.create?.({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon128.png'),
      title: count > 1 ? `${count} actors finished` : 'An actor finished',
      message: 'Open peerd to see the result.',
    });
  } catch (e) { console.warn('[sw] async-actor notify failed', e); }
};

// Push the live async-task snapshot to the side panel (DESIGN-11 status bar).
// why a snapshot push (not per-event): the orchestrator owns the task list;
// the panel just mirrors it, keyed by parent session so it renders only the
// active chat's in-flight tasks. References asyncActorsOrchestrator (defined
// just below) lazily — only ever called at a status transition, long after boot.
const pushAsyncTasks = (/** @type {string} */ parentSessionId) => {
  if (!uiConnected()) return;
  try {
    uiPorts.broadcast({
      type: 'async-tasks/update',
      parentSessionId,
      tasks: asyncActorsOrchestrator.actorTasks(parentSessionId),
    });
  } catch (e) { console.warn('[sw] async-tasks push failed', e); }
};

const asyncActorsOrchestrator = makeAsyncActors({
  spawnActor: (req) => spawnActor(req),
  // why lazy (arrows): turnSlots + runAgentTurn are defined LATER in this module
  // (after the agent loop). The orchestrator only calls these at wake time (long
  // after boot), so deferring the references avoids a TDZ at module load.
  turnSlots: {
    runWhenIdle: (sessionId, fn) => turnSlots.runWhenIdle(sessionId, fn),
    isBusy: (sessionId) => turnSlots.isBusy(sessionId),
    // PR #134: actor_cancel aborts the child's live slot (children run
    // under slots now), instead of only dropping the result.
    stop: (sessionId) => turnSlots.stop(sessionId),
  },
  // PR #134: a cancel ends the child's own descendants too.
  stopSubtree: (sessionId) => spawnActorCore.stopSubtree(sessionId),
  // async-actor wakes are NOT trusted to delegate (a parent reacting to a
  // actor result stays attended-gated for message_actor, like today) —
  // so this reenter deliberately does not forward trusted.
  reenter: ({ userText, sessionId, synthetic }) => runAgentTurn({ userText, sessionId, synthetic }),
  getActiveSessionId: () => /** @type {Promise<any>} */ (sessionCache.sessionGet('currentSessionId')),
  isVaultLocked: () => vault.isLocked(),
  wrapUntrusted,
  forwardEvent: forwardActorEvent,
  notify: notifyAsyncActor,
  // Mirror the live task list to the side-panel status bar on every status
  // transition (spawn / settle / cancel / deliver) so the bar never goes stale.
  onTasksChanged: (parentSessionId) => pushAsyncTasks(parentSessionId),
  // Only the runaway guard (REFUSED) logs now — a rare, worth-seeing event.
  log: (msg, data) => console.warn('[async-actor]', msg, data),
});
const { spawnActorAsync } = asyncActorsOrchestrator;
// ctx aliases — the actor_tasks / actor_cancel tools call these scoped to
// their own session.
const actorTasksSnapshot = (/** @type {string} */ parentSessionId) => asyncActorsOrchestrator.actorTasks(parentSessionId);
const actorCancel = (/** @type {string} */ parentSessionId, /** @type {string} */ taskId) => asyncActorsOrchestrator.actorCancel(parentSessionId, taskId);

// On vault unlock, re-drain any async children that finished while locked.
vault.subscribe(() => { if (!vault.isLocked()) asyncActorsOrchestrator.onVaultUnlock(); });

// ---------------------------------------------------------------------------
// Clean-context review orchestrator (feature 08).
// ---------------------------------------------------------------------------
//
// makeRequestReview reuses the SAME bound spawnActor above — the reviewer
// is a spawned child with a clean session and a READ-ONLY tool subset. We
// inject the full descriptor set WITH sideEffect (the read-only filter's
// input), the audit log, the feature-02 checkpoint adapter (the `since`
// path diffs the current App workspace against a checkpoint), and the
// feature-03 permissions adapter (policy-side read classification,
// intersected with the local filter). Explicit diff / before+after
// snapshots still take priority over the checkpoint path.
const requestReview = makeRequestReview({
  spawnActor,
  // why: read-only filtering needs the sideEffect field; the actor's
  // getToolDescriptors omits it, so review gets its own descriptor fn.
  getToolDescriptors: () => listTools().map((t) => ({ name: t.name, sideEffect: t.sideEffect })),
  appendAudit: /** @type {any} */ (auditLog.append),
  // Feature 02 adapter: review/run's `since` path diffs the current
  // session's App workspace against a checkpoint (explicit ref, else the
  // scope's latest). checkpointMgr is declared later in this module —
  // safe: the closure only dereferences it at call time, long after boot.
  checkpoints: {
    diffSince: async (ref) => {
      const sessionId = await sessionCache.sessionGet('currentSessionId');
      const scope = await currentAppScope(/** @type {any} */ (sessionId));
      if (!scope && !ref) return { files: [] };
      return checkpointMgr.diffSince({ scope, ref: ref ?? null });
    },
  },
  // Feature 03 adapter: the policy's OWN read classification (classifyAction
  // knows shell tools + workspace primitives, not just the sideEffect tag),
  // intersected by the orchestrator with the local sideEffect filter so
  // neither layer can widen the other.
  permissions: {
    readOnlyTools: () => listTools()
      .filter((t) => classifyAction(t) === ACTION_CLASSES.READ)
      .map((t) => t.name),
  },
});

// ---------------------------------------------------------------------------
// Auto-memory + trim-summary enrichment (cheap clean-context calls)
// ---------------------------------------------------------------------------
//
// Both features share ONE call shape: a tools:[] actor spawn (clean
// context, output cap) with the spend-limit preflight and the cost fold
// into the parent session's tally built into makeCheapCall — so the
// cost tracker and the user's spendLimitUsd see this background work.

const cheapCall = makeCheapCall({
  spawnActor,
  sessions,
  // why read settings at call time: pricing overrides can change over
  // the SW's life; snapshotting at boot would price stale.
  costOf: (model, usage) => costOf(/** @type {any} */ (model), usage, settingsStore.get().pricingOverrides),
  getSpendLimitUsd: () => settingsStore.get().spendLimitUsd,
  appendAudit: /** @type {any} */ (auditLog.append),
});

// Pending auto-memory suggestions — kv-backed holding pen between
// extraction and the user's approve/dismiss in Context → Memory.
const memorySuggestions = createSuggestionStore({ kv });

const autoMemory = makeAutoMemory({
  sessions,
  memory,
  suggestions: memorySuggestions,
  cheapCall,
  getSettings: () => settingsStore.get(),
  // why: never extract from a session whose turn is still streaming —
  // it isn't "wrapped up", and its cost tally is being written live by
  // the turn's cost tracker (the fold would race).
  isBusy: (sid) => turnSlots.isBusy(sid),
  appendAudit: /** @type {any} */ (auditLog.append),
  notify: ({ pending }) => {
    if (!uiConnected()) return;
    try { uiPorts.broadcast({ type: 'memory/suggestions-changed', pending }); }
    catch { /* panel gone */ }
  },
});

// Trim-summary enrichment: the loop queues (fire-and-forget) when a
// trim drops new messages; runAgentTurn's finally drains AFTER the
// turn so the loop can never block on — or race — the model call.
const trimEnricher = makeTrimEnricher({
  cheapCall,
  sessions,
  appendAudit: /** @type {any} */ (auditLog.append),
});

// ---------------------------------------------------------------------------
// 3. Offscreen lifecycle — keepalive + future engine host
// ---------------------------------------------------------------------------

const OFFSCREEN_URL = 'offscreen/offscreen.html';

// Module-singleton VM registry + tab tracker + client. Each WebVM is
// a discrete tab; the registry persists metadata, the tracker maps
// vmId → live tabId (in memory, rebuilt at SW startup), and the
// client wraps chrome.tabs.sendMessage with vmId resolution.
/** Delete an IDB database (a VM's disk overlay). Resolves on success;
 *  rejects if the delete is blocked (e.g. another tab still holds it
 *  open — caller should close VM tabs first). */
const deleteIDBDatabase = (/** @type {string} */ name) => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') return resolve(false);
  const req = indexedDB.deleteDatabase(name);
  req.onsuccess = () => resolve(true);
  req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
  req.onblocked = () => reject(new Error(`deleteDatabase blocked: ${name} (close VM tab first)`));
});

// DESIGN-17: archive an actor session orphaned by its instance's deletion.
// Fired by registry.remove() (so it covers BOTH the *_delete tools and the
// Library UI route uniformly). Archiving only sets archivedAt — safe even on a
// actor's own self-delete turn. Fire-and-forget; the binding died with the record.
const archiveOrphanedActor = (/** @type {string} */ actorSessionId) => {
  const doArchive = () => {
    Promise.resolve(sessions.archive(actorSessionId)).catch(() => {});
    auditLog.append({ type: 'actor_archived', sessionId: actorSessionId, details: { reason: 'instance_deleted' } }).catch(() => {});
  };
  // why: an actor can delete its OWN instance mid-turn (vm_delete/app_delete are
  // in its toolset). archive() is a read-modify-write of the actor's session
  // record, so doing it WHILE that turn is still appending messages could clobber
  // the final message and hand the sender a stale reply. Defer to when the slot is
  // idle (the turn settled) — runs immediately when nothing is in flight.
  if (turnSlots.isBusy(actorSessionId)) turnSlots.runWhenIdle(actorSessionId, doArchive);
  else doArchive();
};

const vmRegistry = createVmRegistry({ storage: idbKV('vms'), onActorArchive: archiveOrphanedActor });
// Per-kind tracker note: on every background ensureTab the card updates to the
// touched tab, labelled "<Kind> · <instance name>" (looked up from the registry
// by the instance id) so it reads like a real tab. noteAgentTab is late-bound.
const trackerNote = (/** @type {any} */ registry, /** @type {string} */ kind) => (/** @type {number} */ tabId, /** @type {string} */ _kindLabel, /** @type {any} */ id) => {
  Promise.resolve(registry.get(id))
    .then((r) => noteAgentTab(tabId, { kind, name: r?.name ?? null }))
    .catch(() => noteAgentTab(tabId, { kind }));
};
const vmTabTracker = createVmTabTracker({ announce: trackerNote(vmRegistry, 'WebVM') });
const vmClient = createVmClient({ registry: vmRegistry, tracker: vmTabTracker });

// Notebook registry + tracker + client. Same lifecycle pattern as
// VMs: persistent metadata, in-memory tabId map, lazy-tab spawning
// via chrome.tabs.sendMessage to the Notebook's host page. (The IDB
// store name 'notebooks' is the persistence key — see notebook-registry.)
const jsRegistry = createNotebookRegistry({ storage: idbKV('notebooks'), onActorArchive: archiveOrphanedActor });
const jsTabTracker = createJsTabTracker({ announce: trackerNote(jsRegistry, 'Notebook') });
const jsClient = createJsClient({ registry: jsRegistry, tracker: jsTabTracker });

// App registry + tracker + client. Apps' files live in OPFS at
// peerd-apps/<appId>/; the registry tracks metadata only.
const appRegistry = createAppRegistry({ storage: idbKV('apps'), onActorArchive: archiveOrphanedActor });
const appTabTracker = createAppTabTracker({ announce: trackerNote(appRegistry, 'App') });
const appClient = createAppClient({ registry: appRegistry, tracker: appTabTracker });

// Sessions that have ENGAGED the dweb — a dweb tool was called this turn-or-
// earlier. Monotonic per session, SW-lifetime (a cold start resets it; the next
// dweb call re-engages). Gates the dweb SECONDARY tools (exposure.js
// filterByDwebActive): the controls + bridge guide appear the step after the
// first dweb call, so an untouched session never pays for them.
const dwebEngagedSessions = new Set();
const markDwebEngaged = (/** @type {string} */ sid) => { if (sid) dwebEngagedSessions.add(sid); };

// Composer commands store + sources. The `.peerd/commands/` workspace
// lives in KV; enabled skills surface as /<skill-name> commands via the
// registry's listCommands(). Earlier source wins on a name collision, so
// a user's local command always shadows a same-named skill command.
const commandStore = createCommandStore({ kv });
const commandSources = mergeSources([
  localStoreSource(commandStore),
  skillRegistrySource(skillRegistry),
]);
// --- Feature 02: checkpoint manager over content-addressed snapshots ----
//
// The "workspace" we snapshot is an App's OPFS subtree, read directly in
// the SW via appClient.opfsForApp (no tab needed — browser-native, cheap
// per turn). Scopes are `app:<appId>`. A workspaceFor(scope) returns a
// read/write/delete adapter the manager uses for capture + restore.
//
// Notebook scratch is also OPFS but only reachable through its tab's
// worker; snapshotting it would require spawning a tab per turn, so it's
// a documented V1.x gap (DEV-NOTES.md). The manager already accepts any
// scope, so adding a `notebook:<id>` adapter later is purely additive.
const SNAPSHOT_SCOPE_APP = (/** @type {string} */ appId) => `app:${appId}`;
const appWorkspaceAdapter = (/** @type {string} */ appId) => {
  const opfs = appClient.opfsForApp(appId);
  return {
    readAll: async () => {
      const files = await opfs.list();
      /** @type {Record<string,string>} */
      const out = {};
      for (const f of files) {
        const path = f.path.replace(/^\/+/, '');
        try { out[path] = await opfs.read(path); }
        catch { /* skip unreadable (binary/locked) entries */ }
      }
      return out;
    },
    writeFile: (/** @type {string} */ path, /** @type {any} */ content) => opfs.write(path, content),
    deleteFile: (/** @type {string} */ path) => opfs.delete(path).catch(() => {}),
  };
};
const workspaceForScope = (/** @type {string} */ scope) => {
  if (typeof scope === 'string' && scope.startsWith('app:')) {
    return appWorkspaceAdapter(scope.slice('app:'.length));
  }
  return null; // unknown scope kind (notebook snapshots: V1.x)
};
const checkpointMgr = createCheckpointManager({
  store: createBrowserSnapshotStore(),
  workspaceFor: workspaceForScope,
});

/**
 * Resolve the App scope to snapshot for a session, or null if the session
 * has no current App. Used by the post-turn auto-snapshot and the
 * the snapshot/diff consumers so they all agree on "the workspace".
 *
 * @param {string|null} sessionId
 * @returns {Promise<string|null>}
 */
const currentAppScope = async (sessionId) => {
  if (!sessionId) return null;
  try {
    const appId = await appRegistry.getDefaultForSession(sessionId);
    return appId ? SNAPSHOT_SCOPE_APP(appId) : null;
  } catch { return null; }
};

// Debugger pool: SW-singleton manager for chrome.debugger attach +
// CDP Runtime.evaluate. Construction is cheap (it no longer touches the
// chrome.debugger namespace, which may not exist yet — see debugger-pool.js);
// attach is lazy on the first CDP call per tab. Lives at module scope so a
// single per-SW attach amortizes across many evals (no banner flicker).
const debuggerPool = createDebuggerPool();

// --- Advanced automation (the `debugger` permission) ------------------------
// `debugger` is a CHANNEL-GATED required permission, NOT optional: Chrome
// forbids it under optional_permissions ("Permission 'debugger' cannot be
// listed as optional. This permission will be omitted."), so where CDP ships
// it is required at install. It ships in the preview/dev channels (CDP is the
// DEFAULT automation path there) and is STRIPPED from the initial store Chrome
// package and from every Firefox package (packaging/gen-manifest.ts — the store strip
// is held until a post-approval re-add; docs/store/OPEN-DECISIONS.md §1). So
// "is CDP available" has TWO independent inputs, both package-time:
//   1. the namespace exists — globalThis.chrome.debugger present, i.e. the
//      manifest shipped the permission (preview/dev Chrome only);
//   2. the `advancedAutomationEnabled` SETTING — the user-facing off switch
//      (default ON in preview/dev, OFF in store; packaging/default-settings.mjs).
// When CDP is unavailable for either reason the pool is simply never wired
// into a tool context, so the CDP-backed tools degrade cleanly: snapshot
// falls back to the chrome.scripting DOM-walk pseudo-snapshot, click/type
// fall back to their scripting selector path, read_state to its world:'MAIN'
// selector fallback, and page_exec/page_keys return `debugger_unavailable`.
// The agent keeps a working browser surface (read_page + selector click/type
// + DOM-walk snapshot + navigate). This is the DEFAULT path on store-Chrome
// and Firefox — not a degraded edge case.
//
// CAPABILITY GAP without CDP (store-Chrome + Firefox, by design): page_exec
// on Trusted-Types pages and page_keys' trusted (isTrusted) input have no
// scripting equivalent — genuine platform limits, correctly NOT faked. Fine
// on ordinary sites, degraded on hardened/bot-protected ones. Everything
// non-DOM is identical across channels.
const debuggerApiAvailable = () => !!globalThis.chrome?.debugger;
const advancedAutomationOn = () =>
  debuggerApiAvailable() && settingsStore.get().advancedAutomationEnabled !== false;

// First time a tool needs the debugger while the setting is off, nudge the
// side panel with a one-click enable. One-shot per SW lifetime so we don't
// nag — but the latch is consumed only on SUCCESSFUL delivery, so a tool
// failing while the panel is closed leaves the offer armed for a later turn.
let debuggerNudgeShown = false;
// Prefix match, not exact: the DOM tools (snapshot/click/type/
// read_state) return a self-describing `debugger_unavailable: <hint>` string.
const isDebuggerUnavailableError = (/** @type {any} */ err) =>
  typeof err === 'string'
  && (err.startsWith('debugger_unavailable') || err.startsWith('debugger_not_available'));
const maybeNudgeDebuggerGrant = (/** @type {any} */ result) => {
  // No nudge where the API itself doesn't exist (Firefox) — the offer
  // would flip a setting that can't do anything there.
  if (!debuggerApiAvailable()) return;
  if (advancedAutomationOn() || debuggerNudgeShown) return;
  if (!result || result.ok !== false || !isDebuggerUnavailableError(result.error)) return;
  if (!uiConnected()) return; // bail BEFORE latching so the offer stays armed
  try {
    uiPorts.broadcast({
      type: 'turn/system-note',
      text: 'That step needs advanced automation (the Chrome debugger) to act on '
        + 'apps that block injected scripts, like Gmail or Notion. It’s turned '
        + 'off in Settings → Advanced.',
      action: { kind: 'grant-debugger', label: 'Turn on advanced automation' },
    });
    debuggerNudgeShown = true; // latch only after the nudge actually went out
  } catch { /* panel went away between the check and the post — leave armed */ }
};
// DOM-nav ref registry (Phase 1): persists @e<n> → backendDOMNodeId across
// turns (a snapshot in turn N must resolve in turn N+1's click). Singleton,
// not per-ctx. Cleared per tab on close (below) + replaced on re-snapshot.
const domRefs = createRefRegistry();

const ensureOffscreen = async () => {
  // why: Firefox has no chrome.offscreen — its MV3 background is an event
  // page, which doesn't need the keepalive trick (different lifetime
  // model). Degrade quietly instead of throwing on every vault unlock:
  // the offscreen-hosted voice transcriber is simply absent there (the
  // mic UI's capability detection already reports voice unsupported).
  if (typeof (/** @type {any} */ (browser)).offscreen?.createDocument !== 'function') {
    console.info('[sw] offscreen API unavailable (Firefox event page) — skipping keepalive/voice host');
    return;
  }
  try {
    const contexts = await browser.runtime.getContexts({
      contextTypes: /** @type {any} */ (['OFFSCREEN_DOCUMENT']),
    });
    if (contexts.length > 0) {
      console.log('[sw] offscreen already exists');
      return;
    }
    console.log('[sw] creating offscreen document', OFFSCREEN_URL);
    await (/** @type {any} */ (browser)).offscreen.createDocument({
      url: OFFSCREEN_URL,
      // why: WORKERS keeps the doc alive for the SW-keepalive port and
      // (future) CheerpX. USER_MEDIA permits the offscreen doc to call
      // getUserMedia for the Moonshine voice transcriber. Declared
      // up-front so a later voice-enable doesn't require recreating
      // the doc; the actual mic permission still prompts the user at
      // first getUserMedia call.
      reasons: ['WORKERS', 'USER_MEDIA'],
      justification: 'SW keepalive, WebVM host, and local voice transcription (Moonshine).',
    });
    console.log('[sw] offscreen document created');
    // why: small grace period so the offscreen import chain has
    // actually wired up its message listeners. Without this, a
    // voice/* message posted immediately after createDocument can land
    // before the offscreen doc finishes evaluating its modules.
    await new Promise((r) => setTimeout(r, 50));
  } catch (e) {
    // Race: concurrent caller already created it. Chrome wording:
    // "Only a single offscreen document may be created"
    // We deliberately match narrowly so unrelated failures still
    // throw and get logged (the broader /offscreen/i filter was
    // swallowing legit errors like missing-permissions).
    if (/single offscreen document|already exists/i.test((/** @type {{ message?: string }} */ (e))?.message ?? '')) {
      console.log('[sw] offscreen create lost the race; another caller won');
      return;
    }
    console.error('[sw] ensureOffscreen failed', e);
    throw e;
  }
};

// why gate on offscreen availability: Firefox has no chrome.offscreen, so the
// offscreen-hosted job/pdf workers can never run there. Injecting null (not a
// live client) makes the tools' own `if (!client) return *_unavailable` guard
// trip — so script/read_pdf report a clean "not supported in this build" signal
// the agent can act on, instead of dispatching a job message no context answers
// and surfacing an opaque "headless job failed".
const offscreenAvailable = typeof (/** @type {any} */ (browser)).offscreen?.createDocument === 'function';

// The headless-JS client (the script tool). execHeadless ensures the offscreen
// doc, then dispatches a 'job/run' message to job-runner.js hosted there.
// Defined after ensureOffscreen; buildToolContext reads it lazily at dispatch.
const jsOffscreenClient = offscreenAvailable ? makeOffscreenJsClient({
  ensureOffscreen,
  sendMessage: (m) => browser.runtime.sendMessage(m),
}) : null;

// Live actors-enabled script runs (background/script-runs.js): Stop → abort
// pending asks + terminate the worker. Declared here (before buildToolContext
// consumers run) and read by the actors/call route below.
const scriptRuns = createScriptRunRegistry();

// The context inspector's capture ring — "what did the model see" per
// session, SW-memory only. Fed from the two seams that together cover
// every model call (the turn driver's failover wrapper, the actor relay
// route below); read by the debug-bundle route and the inspector view.
const contextSnapshots = createContextSnapshots();

/**
 * Walk parentSessionId up from any actor / spawned session to the CHAT at the base
 * of its lineage — the session that carries the user-visible cost tally the spend
 * limit is measured against. Returns the record, or null when the chain is broken
 * (a reaped parent) or the id is already a chat.
 *
 * why bounded + cycle-guarded rather than a plain while: this walks persisted
 * records, and a corrupt or hand-edited chain must degrade to "no root" instead of
 * spinning the service worker.
 * @param {string} sessionId
 * @returns {Promise<any | null>}
 */
const rootChatSessionFor = async (sessionId) => {
  const seen = new Set();
  let id = sessionId;
  for (let hop = 0; hop < 16; hop++) {
    if (!id || seen.has(id)) return null;
    seen.add(id);
    const rec = await sessions.get(id).catch(() => null);
    if (!rec) return null;
    if (rec.kind !== 'actor' && rec.kind !== 'spawned') return rec;
    // A reaped or never-set parent ends the walk (the `!id` guard above) rather
    // than climbing into undefined — an orphaned actor simply has no root.
    id = rec.parentSessionId ?? '';
  }
  return null;
};

// The heap split: the ONE offscreen agent-loop client. It runs every non-
// orchestrator loop — an ephemeral reasoning actor (spawn.js, tools:[]) OR a
// bound actor (VM/Notebook/App/web) — in its own dedicated Worker heap. Its
// 'actor/tool-dispatch' route builds the actor's instance-pinned, gated ctx SW-side
// and dispatches there — the worker holds no
// key, no engine clients, no chrome.*. Null when offscreen is unavailable.
const actorClient = offscreenAvailable ? makeOffscreenActorClient({
  ensureOffscreen,
  sendMessage: (m) => browser.runtime.sendMessage(m),
  callModel: /** @type {any} */ (callModel),
  getSecret,
  safeFetch,
  sessions,
  buildToolContext,
  dispatchToolCall: /** @type {any} */ (dispatchToolCall),
  pinActorCall,
  // Phase 4: rebuild an actor's narrowed-general tool ctx SW-side from its persisted
  // grantedTools (capability-by-need strip), the analog of the actor's kind-scoped strip.
  restrictCtxCapabilities,
  // Phase 3: a tab-backed web actor's currently-owned tab, read per dispatch (lazy —
  // webActorTabBindings is defined later, called at turn time). tabFor returns the
  // adopted tab or undefined (0-tab state); buildToolContext fails closed on a stale id.
  ownedTabFor: (/** @type {string} */ sid) => webActorTabBindings.tabFor(sid),
  EXPOSURE_ACTOR,
  // #160: lets the tool-dispatch route re-stamp a review child's exemption
  // marker from its persisted record (see offscreen-actor-client.js).
  EXPOSURE_REVIEW,
  recordModelCall: contextSnapshots.record,
  // Announce each settled ACTOR tool dispatch on the UI ports (lazy: uiPorts is
  // defined below, read at call time — same pattern as ownedTabFor). why: the
  // offscreen actor heap has no turn/tool-use broadcast (that's turn-driver's,
  // in-SW only), so without this the eval harness's OM2W recorder — and any
  // activity view — is blind to what an actor actually did.
  broadcastOp: (/** @type {any} */ msg) => uiPorts.broadcast(msg),
  // The relay boundary. `runtime.sendMessage` cannot address one extension
  // context, so the actor/run job (grant token included) is broadcast to every
  // listener — the side panel and the engine tab pages among them. Pinning the
  // three relay routes to the offscreen document is therefore what actually
  // keeps another first-party page from dispatching as an actor; the token
  // carries run identity and liveness on top of it.
  isOffscreenSender: (/** @type {any} */ sender) => isOffscreenSender(sender, {
    runtimeId: browser.runtime?.id,
    extensionOrigin: browser.runtime?.getURL?.('') ?? '',
    offscreenUrl: browser.runtime?.getURL?.(OFFSCREEN_URL) ?? '',
  }),
  // Spend-limit preflight for the actor lane. Two tallies, because they fail in
  // different directions and each alone leaves a hole:
  //
  //   the ACTOR's own record — the one runActorTurnOffscreen folds this lane's
  //     cost into. This is the check that actually bounds actor spend, and it is
  //     the only one that works for the dweb daemon actor, a global singleton with
  //     no parent chat to walk to. Same shape as cheap-call.js: preflight and fold
  //     name the same record, so the number being tested is the number being
  //     incremented.
  //   the ROOT CHAT — so a conversation that has already blown the cap cannot keep
  //     spending by delegating.
  //
  // Refusing is all this does; it never bills. NOT closed by this: a fan-out across
  // MANY actors, each individually under the cap. That needs one budget spanning the
  // lineage — see HARDENING-ROADMAP.md P0-3, still open.
  spendRefusalFor: async (/** @type {string} */ actorSessionId) => {
    const spendLimit = settingsStore.get().spendLimitUsd;
    const over = (/** @type {any} */ rec) => !!rec && limitExceeded(normalizeTally(rec.cost).cost, spendLimit);
    const own = await sessions.get(actorSessionId).catch(() => null);
    if (over(own)) return `actor refused: this actor has reached the session spend limit ($${spendLimit})`;
    const root = await rootChatSessionFor(actorSessionId);
    if (over(root)) return `actor refused: the session spend limit ($${spendLimit}) is reached`;
    return null;
  },
}) : null;

// The PDF-extraction client (the read_pdf tool). ensureOffscreen, then a
// 'pdf/extract' message to offscreen/pdf-extract.js (pdf.js in a Worker).
const pdfOffscreenClient = offscreenAvailable ? makeOffscreenPdfClient({
  ensureOffscreen,
  sendMessage: (m) => browser.runtime.sendMessage(m),
}) : null;

// The office-document conversion client (the read_doc tool). ensureOffscreen,
// then a 'doc/extract' message to offscreen/doc-extract.js. The conversion
// itself is pure (peerd-runtime/doc) — it runs offscreen so the multi-megabyte
// byte buffer, and the untrusted document behind it, stay out of the SW.
const docOffscreenClient = offscreenAvailable ? makeOffscreenDocClient({
  ensureOffscreen,
  sendMessage: (m) => browser.runtime.sendMessage(m),
}) : null;

// Convert an ATTACHED office/e-book file to Markdown. Same offscreen reader as
// read_doc, handed the bytes directly — so an attached .docx and a linked one
// go through exactly one implementation. Returns the formatted body (header,
// conversion notes, truncation announcement) that gets inlined into the turn.
// null where offscreen is unavailable (Firefox): convertDocAttachments turns a
// missing converter into a clear refusal.
const convertDocAttachment = offscreenAvailable
  ? async (/** @type {{ name: string, mediaType: string, data?: string }} */ att) => {
    if (!att?.data) throw new Error('the file was empty');
    if (!docOffscreenClient) throw new Error('document conversion is not available in this browser build');
    const { doc } = await docOffscreenClient.extract(
      { bytesB64: att.data, name: att.name, contentType: att.mediaType }, {},
    );
    return formatDocBody({ doc, maxChars: DOC_TEXT_MAX_CHARS, source: att.name });
  }
  : null;

// The HTML -> markdown extraction client (fetch_url's clean-content path).
// Readability/Turndown need a DOM Document only the offscreen doc can build
// ('web/extract' in offscreen/web-extract.js). null where offscreen is
// unavailable (Firefox) - fetch_url then degrades to today's raw-text
// behavior (the read_pdf precedent for capability-absent contexts).
const webOffscreenClient = offscreenAvailable ? makeOffscreenWebClient({
  ensureOffscreen,
  sendMessage: (m) => browser.runtime.sendMessage(m),
}) : null;

// The sw/web-fetch route's extract post-step (see shared/fetch-extract.js) —
// composed HERE so the route reuses the SAME offscreen extraction client
// fetch_url rides. Firefox (no offscreen doc): no extractor → the helper
// passes the body through, extracted:false.
const applyWebExtract = (/** @type {any} */ resp, /** @type {unknown} */ extract, /** @type {string} */ url) =>
  applyFetchExtract(resp, {
    extract, url,
    extractMarkdown: webOffscreenClient
      ? (source) => webOffscreenClient.extractMarkdown(source)
      : null,
  });

// ── Local WebGPU runner bridge (FEATURE-LOCAL-WEBGPU B / M1) ────────────────
// The local-webgpu adapter generates by calling generateLocalForAdapter, which
// drives the offscreen engine (offscreen/local-model.js) and streams its tokens
// back. local-model/{status,init} flip localModelAvailable, which feeds
// resolveRunnerModel step 2 (local-when-available) — so once the model is
// resident it becomes the web actor default with no pin.
// Local-model residency + progress live in a store (background/local-model-state.js)
// so the local-model/* routes reach them via deps. available() feeds
// resolveRunnerModel; progress() is polled by Settings.
const localModelState = makeLocalModelState();
const localRunnerState = () => ({ available: localModelState.available(), model: LOCAL_MODEL_ID });

// genId → { tokens, waiters, done, error }: the async queue that turns the
// offscreen's local-model/delta pushes into the adapter's async-generator.
let localGenSeq = 0;
const localGens = new Map();
const wakeLocalGen = (/** @type {any} */ s) => { const w = s.waiters.shift(); if (w) w(); };

browser.runtime.onMessage.addListener((/** @type {any} */ msg) => {
  if (msg?.type === 'local-model/delta') { const s = localGens.get(msg.genId); if (s) { s.tokens.push(msg.token); wakeLocalGen(s); } return undefined; }
  if (msg?.type === 'local-model/done') { const s = localGens.get(msg.genId); if (s) { s.done = true; s.error = msg.error ?? null; wakeLocalGen(s); } return undefined; }
  if (msg?.type === 'local-model/progress') { localModelState.setProgress(msg.progress); uiPorts.broadcast({ type: 'local-model/progress', progress: msg.progress }); return undefined; }
  return undefined;
});

// The async-generator the local-webgpu adapter consumes. Sends a SERIALIZABLE
// generate command to the offscreen (no AbortSignal — not serializable; v1 runs
// to max_new_tokens), yields tokens as they stream, throws on a reported error.
const generateLocalForAdapter = (/** @type {any} */ opts) => {
  const genId = `lg${++localGenSeq}`;
  /** @type {{ tokens: any[], waiters: any[], done: boolean, error: any }} */ const state = { tokens: [], waiters: [], done: false, error: null };
  localGens.set(genId, state);
  ensureOffscreen()
    .then(() => browser.runtime.sendMessage({ type: 'local-model/host/generate', genId, messages: opts.messages, system: opts.system, tools: opts.tools, maxTokens: 512 }))
    .catch((e) => { state.done = true; state.error = (/** @type {{ message?: string }} */ (e))?.message ?? String(e); wakeLocalGen(state); });
  return (async function* () {
    try {
      for (;;) {
        if (state.tokens.length) { yield state.tokens.shift(); continue; }
        if (state.done) { if (state.error) throw new Error(state.error); return; }
        await new Promise((resolve) => { state.waiters.push(/** @type {any} */ (resolve)); });
      }
    } finally { localGens.delete(genId); }
  })();
};
setLocalGenerate(/** @type {any} */ (generateLocalForAdapter));

// ---------------------------------------------------------------------------
// 4. Side-panel port — state push + user actions
// ---------------------------------------------------------------------------

// Live UI surfaces — the side panel AND the full-page home are EQUAL live
// projections of the SW session (DESIGN-12). The SW streams session state to,
// and routes confirm prompts through, ALL of them via this registry (was the
// singleton sidePanelPort). uiConnected() = is any surface open right now.
const uiPorts = makeUiPorts();
const uiConnected = () => uiPorts.size > 0;
// Tell every surface whether a SIDE PANEL is currently open. The home SPA uses
// this to hand chat off (DESIGN-12: chat is single-homed — when the panel is
// open it owns Chat + Chats, and home shows only the tool sections). Broadcast
// on every UI-port connect/disconnect so both sides stay in sync.
const broadcastSurfaces = () => {
  const sidePanelOpen = uiPorts.hasNamed('sidepanel');
  try { uiPorts.broadcast({ type: 'surfaces', sidePanelOpen }); }
  catch { /* ports closing — their onDisconnect cleans up */ }
  // Also nudge the PORTLESS engine tabs (vm/notebook/app): their "pull in peerd"
  // toggle listens for surfaces/changed so its label tracks the panel even when
  // it's opened/closed from elsewhere. Best-effort — rejects when nothing's
  // listening, which is fine.
  try { browser.runtime.sendMessage({ type: 'surfaces/changed', sidePanelOpen }).catch(() => {}); }
  catch { /* no receiver */ }
};

// Close the side panel / sidebar. Chrome has no sidePanel.close(), so disabling
// the panel dismisses it; we re-arm it (enabled:true) a beat later so it can be
// reopened. Firefox has a real sidebarAction.close(). Closing needs NO user
// gesture (unlike open), so this is plain async. Shared by the 'sidepanel/close'
// route (home's "bring chat home") and the Alt+Shift+P toggle. The panel's port
// disconnect then broadcasts surfaces → home renders the chat inline again.
const closeSidePanel = async () => {
  try {
    if (browser.sidebarAction?.close) {            // Firefox
      await browser.sidebarAction.close();
      return { ok: true };
    }
    if ((/** @type {any} */ (browser)).sidePanel?.setOptions) {           // Chrome
      await (/** @type {any} */ (browser)).sidePanel.setOptions({ enabled: false });
      setTimeout(() => {
        (/** @type {any} */ (browser)).sidePanel.setOptions({ enabled: true, path: 'sidepanel/sidepanel.html' })
          .catch((/** @type {any} */ e) => console.debug('[sidepanel/close] re-arm failed', e));
      }, 250);
      return { ok: true };
    }
    return { ok: false, error: 'no-sidepanel' };
  } catch (e) {
    return { ok: false, error: (/** @type {{ message?: string }} */ (e))?.message ?? String(e) };
  }
};

// How peerd shows up in the tab strip (background/tab-affordances.js): the
// agent-tab card, the "pull peerd in" web-tab hint, and the toolbar-icon /
// Alt+Shift+P front door. It owns all the tab-strip state + listeners; the SW
// calls noteAgentTab/scheduleWebTabHint/broadcastAgentTab/showWebTabHint from
// its tool-context + port wiring, and setTabAnchor from the actor-turn start.
const {
  noteAgentTab, broadcastAgentTab, scheduleWebTabHint, showWebTabHint, setTabAnchor, isHomeOpen, focusAgentTab, syncFrontDoorBehavior,
} = makeTabAffordances({
  browser, uiPorts, denylistStore, closeSidePanel,
  isWatchOn: () => settingsStore.get().watchAgentTab === true,
  // Sync read (no await) — the front-door decision must run inside the
  // click gesture or sidePanel.open() drops its activation.
  getFrontDoorView: () => (settingsStore.get().frontDoorView === 'home' ? 'home' : 'panel'),
});

// Confirmation coordinator. The dispatcher's async confirmation step
// calls ctx.confirm(prompt); this pushes a 'confirm/request' to the side
// panel and resolves when the panel posts back 'confirm/answer'.
// Exercised whenever the Plan/Act decideAction policy marks an action as
// needing confirmation.
const confirmCoordinator = makeConfirmCoordinator({
  notifySidePanel: (prompt) => {
    if (!uiConnected()) return;
    try { uiPorts.broadcast({ type: 'confirm/request', prompt }); }
    catch (e) { console.warn('[sw] confirm/request post failed', e); }
  },
  // Hang protection: no side-panel port → the agent can't ask, so auto-deny
  // immediately rather than awaiting forever.
  isChannelOpen: () => uiConnected(),
  // Dismiss the modal on EVERY open surface when a prompt settles for ANY
  // reason — answer, 120s timeout, or session reset (DESIGN-12). Without this a
  // timed-out/reset prompt lingers, and a later click "approves" an action that
  // was already auto-denied.
  onSettled: (id) => { try { uiPorts.broadcast({ type: 'confirm/resolved', id }); } catch { /* port closing */ } },
  // Raise an action badge while a confirm is pending so a waiting agent is
  // visible even if the panel is hidden; cleared at zero.
  onPendingChange: (count) => {
    try {
      browser.action?.setBadgeText?.({ text: count > 0 ? String(count) : '' });
      if (count > 0) browser.action?.setBadgeBackgroundColor?.({ color: '#F59E0B' });
    } catch { /* action API unavailable in some contexts */ }
  },
});

// "Yes for this session" grants, in memory, keyed by sessionId → set of
// tool names the user blanket-approved for that chat. Cleared when the
// SW dies (which also clears the vault DK), which is the right blast
// radius for a convenience grant. A persistent tool_grants store is a
// documented follow-up.
/** @type {Map<string, Set<string>>} */
const sessionConfirmGrants = new Map();

// Shared confirm key for non-GET web egress (fetch_url + the WebVM HTTP bridge),
// so "approve all writes this session" and the confirmWebWrites setting apply
// uniformly across both paths. Imported from vm-net so the bridge fetch and
// this confirm filter can't drift on the literal.

/**
 * ctx.confirm implementation. Checks the session-grant cache first so a
 * prior "yes for session" doesn't re-prompt, then falls back to the
 * round-trip. Records new session grants.
 *
 * @param {{ tool: string, sessionId?: string|null, origins?: string[] }} prompt
 * @returns {Promise<'yes_once'|'yes_session'|'no'>}
 */
const confirmAction = async (prompt) => {
  const sid = prompt.sessionId ?? null;
  // issue 251 — the second LEARNED signal: the user AFFIRMED acting as themselves
  // on this origin, so remember that the origin is one they have an identity on.
  //
  // Fired ONLY on a real answer from the user, and the earlier draft that fired
  // it on the other two approving exits was wrong on its own terms. Those exits
  // are the `confirmWebWrites`-off auto-approve and the session-grant cache, and
  // neither is a decision about THIS origin:
  //
  //   * auto-approve is page-driven. An injected actor could POST to any origin
  //     it liked and thereby mark it sensitive — page-controlled security state,
  //     and the failure is real if unglamorous: sites the user never chose become
  //     unreachable to roaming helpers, which reads as peerd randomly breaking.
  //   * the grant cache is a REPLAY of an approval already learned from.
  //
  // The signal's whole justification is "they affirmed it", so it fires exactly
  // where that is true. Origins the auto-approve path would have taught are still
  // caught by the password-field signal on the first page walk.
  //
  // Only on approval — a DECLINED write says the opposite, and recording it
  // would make refusing to act on a site the thing that marks it as yours.
  const learnUserApprovedWrite = (/** @type {string} */ ans) => {
    if (prompt.tool !== WEB_WRITE_CONFIRM_KEY) return;
    if (ans !== 'yes_once' && ans !== 'yes_session') return;
    for (const origin of prompt.origins ?? []) noteLearnedOrigin(origin, 'confirmed-write');
  };
  // Web-write gate (shared key for fetch_url + the WebVM bridge): when the user
  // has turned confirmWebWrites OFF, non-GET egress is auto-approved — their
  // explicit, risk-acknowledged choice. The session-grant cache still applies
  // when it's on.
  if (prompt.tool === WEB_WRITE_CONFIRM_KEY && settingsStore.get().confirmWebWrites === false) {
    return 'yes_once';
  }
  // R5 (origin-bound grants): "approve for this session" means this tool ON
  // this origin — the dispatcher computes prompt.origins (the pinned tab's
  // origin for DOM tools, the target host for web writes), and the grant key
  // folds it in. Approving `click` on site A no longer covers site B. Tools
  // with no origin surface keep the bare tool key (confirm-grant-key.js).
  const grantKey = confirmGrantKey(prompt);
  // DESIGN-17: an ACTOR never accumulates a STANDING grant — its confirms are
  // strictly PER-TURN (an actor can be steered by untrusted instance output
  // across turns, so a once-granted "yes for session" must not silence the next
  // one). Bypass the grant cache for an actor session AND downgrade a
  // yes_session answer to a one-shot.
  let ephemeral = false;
  if (sid) {
    try { ephemeral = (await sessions.get(sid))?.kind === 'actor'; } catch { ephemeral = false; }
  }
  if (!ephemeral && sid && sessionConfirmGrants.get(sid)?.has(grantKey)) {
    return 'yes_session';
  }
  // ...and TELL THE PANEL, so it can stop offering a button that grants
  // nothing. why this became load-bearing with #242: before the UGC override, a
  // default-config user (confirmActions OFF) never saw an actor confirm at all,
  // so the dead "Allow for session" was unreachable. Now it is the second thing
  // they see on a GitHub issue, twice per comment — a control that looks like
  // the way to stop the prompting and silently isn't. The downgrade itself is
  // correct and stays; what was wrong was offering the choice.
  const answer = await confirmCoordinator.confirm(/** @type {any} */ (
    downgradesActorConfirm(prompt.tool, ephemeral, 'yes_session') ? { ...prompt, ephemeral: true } : prompt
  ));
  if (answer === 'yes_session' && sid && !ephemeral) {
    if (!sessionConfirmGrants.has(sid)) sessionConfirmGrants.set(sid, new Set());
    (/** @type {Set<string>} */ (sessionConfirmGrants.get(sid))).add(grantKey);
  }
  // Ephemeral: an actor's yes_session approves THIS call only (no standing grant),
  // EXCEPT a2a_contact — the sanctioned exception (an explicit first-contact
  // allowlist decision, the peer did shown to the user), whose raw answer survives
  // so a2aResolveConsent can honor "Allow for session" vs "Allow once". Decision is
  // the pure downgradesActorConfirm (background/a2a-consent.js), unit-tested.
  learnUserApprovedWrite(answer);
  return downgradesActorConfirm(prompt.tool, ephemeral, answer) ? 'yes_once' : answer;
};

// Per-SW "current active session" cache (background/session-state.js), behind a
// store so the session-mutating routes reach it via deps. Only a cache —
// pushState rebuilds the snapshot from the session store.
const sessionState = makeSessionState();

/**
 * Build the full UI state snapshot — the ONE shape both state consumers
 * render from: the side panel (pushed over its port on every mutation,
 * see pushState below) and the options page (pulled via the one-shot
 * 'state/get' route + refetch-on-focus; it holds no port on purpose —
 * the uiPorts registry is load-bearing for confirm routing and the
 * voice/vm/goal forwarders).
 *
 * why a closure, not an extracted module: this is snapshot ASSEMBLY whose
 * one load-bearing invariant — no key material in the snapshot — is already
 * pinned END-TO-END against the real SW by the in-browser
 * extension/tests/unit/background/state-get.test.js (it walks the live
 * snapshot for secret-named string values). That's STRONGER than a faked
 * bun unit would be, since a fake vault can drift from what the real one
 * emits. Extracting to an injected-deps module (it closes over ~10 SW
 * singletons) would trade real deps-wiring for redundant, weaker coverage —
 * net-negative. Contrast the turn driver (turn-driver.js): dense
 * orchestration with NO unit coverage, so THERE extraction unlocked real
 * tests. The yardstick is new testability, not runtime or line count.
 *
 * Invariant (pinned by extension/tests/unit/background/state-get.test.js):
 * the snapshot never carries key material — providers.hasKey is a boolean
 * derived from the vault, never the secret itself.
 */
const buildStateSnapshot = async () => {
  const sessionId = await sessionCache.sessionGet('currentSessionId');
  // prfEnrolled is cheap to read (one kv.get) and the side panel uses it
  // (permission resolved per-path below — needs the session record.)
  // both pre-unlock (to show the Touch ID button) and post-unlock (to
  // show the enroll/disable toggle in settings). Surfaced on every push.
  const prf = await vault.prfStatus();
  // why: the gate/settings need to know whether a recovery passphrase
  // exists — the unlock screen only offers the passphrase path when it
  // can succeed, and settings shows "Set" vs "Change". Cheap kv.get.
  const hasRecovery = await vault.hasRecoveryPassphrase();
  // Vault-locked path: emit a minimal state without touching IDB
  // (session reads would surface as null anyway).
  if (vault.isLocked()) {
    const permission = await resolvePermission(null);
    return {
      vault: {
        initialized: await vault.isInitialized(),
        locked: true,
        unlockedAt: 0,
        prfEnrolled: prf.enrolled,
        hasRecovery,
      },
      session: { sessionId: null, messages: [], permission, customSystemPrompt: null, toolManifest: null },
      providers: { current: resolveActiveProvider().name, hasKey: false, model: resolveActiveProvider().model, defaultRunnerModel: resolveActiveProvider().defaultRunnerModel },
      settings: { ...settingsStore.get() },
      pendingConfirm: null,
      streaming: false,
    };
  }
  // Unlocked path.
  const session = sessionId ? (await sessions.get(/** @type {any} */ (sessionId))) ?? null : null;
  const permission = await resolvePermission(session);
  // Default profile — the side panel gates first-run onboarding on
  // onboardingComplete and labels assistant transcript rows with
  // peerName. Only surfaced when unlocked: the locked push deliberately
  // omits it so the panel's "assume complete" default holds at the gate
  // and onboarding can never flash before a real unlock.
  const profile = await profileState.get();
  // why: providers block drives the Settings UI (provider selector + key
  // field), so it reflects the SELECTED provider (settings), and hasKey
  // is checked against THAT provider's vault secret. Keyless providers
  // (Ollama) are always "ready" — there is no key to have.
  const activeProv = resolveActiveProvider();
  let hasKey = activeProv.keyless;
  if (!hasKey) {
    try { hasKey = !!(await vault.getSecret(/** @type {string} */ (activeProv.vaultSecretName))); }
    catch { hasKey = false; }
  }
  return {
    vault: {
      initialized: await vault.isInitialized(),
      locked: false,
      unlockedAt: vault.unlockedAt(),
      prfEnrolled: prf.enrolled,
      hasRecovery,
    },
    session: {
      sessionId: session?.sessionId ?? null,
      messages: session?.messages ?? [],
      permission,
      // The provider this chat is BOUND to (sessions snapshot it on
      // first send). The panel gates provider-specific affordances on
      // it — e.g. the reasoning-effort dial only renders where effort
      // is actually honored (Anthropic adapter; OpenRouter ignores
      // the reasoning object entirely today, see TODO.md).
      provider: session?.provider ?? null,
      // Cost/usage tally for the meter (feature 06). Normalized so the
      // UI always gets a full shape, even for pre-feature sessions.
      cost: normalizeTally(session?.cost),
      // Per-session /system instructions — the chat header chip renders
      // from this so the augmentation's presence is always visible.
      customSystemPrompt: session?.customSystemPrompt ?? null,
      // Per-session /tools manifest — same visibility contract: a
      // narrowed toolset silently changes what the model can do, so its
      // presence must be visible where the chat happens (mode-row chip).
      toolManifest: session?.toolManifest ?? null,
    },
    providers: {
      current: activeProv.name,
      hasKey,
      model: activeProv.model,
      // why: the web actor's fast default for this provider — the Settings
      // "Web actor model" field shows it as the blank placeholder so "blank"
      // honestly reads as e.g. claude-haiku-4-5, not "inherit".
      defaultRunnerModel: activeProv.defaultRunnerModel,
    },
    profile: {
      id: profile.id,
      peerName: profile.peerName,
      onboardingComplete: !!profile.onboardingComplete,
    },
    settings: { ...settingsStore.get() },
    pendingConfirm: null,
    // Per-session truth: is THIS chat's turn in flight? Lets the panel
    // re-arm its spinner/Stop affordances when the user switches back
    // to a conversation that kept streaming in the background.
    streaming: sessionId ? turnSlots.isBusy(/** @type {any} */ (sessionId)) : false,
  };
};

const pushState = async () => {
  if (!uiConnected()) return;
  uiPorts.broadcast({ type: 'state', state: await buildStateSnapshot() });
};

// Keepalive ports we hold references to so they're not GC'd. Recent
// Chrome versions retain SW ports via their internal table, but holding
// our own reference is belt-and-suspenders against version-to-version
// drift.
/** @type {Set<chrome.runtime.Port>} */
const keepalivePorts = new Set();

// Side-panel forwarder. The offscreen doc broadcasts voice/* (chunk,
// auto-stop, error, permission-result) and the VM tabs broadcast
// vm/stdout-chunk + vm/stderr-chunk via runtime.sendMessage; the SW
// forwards them all to the active side-panel port so the side panel
// only has to subscribe to one surface. (Voice chunks stream the live
// transcript; VM chunks render per-tool-use stdout/stderr inline next
// to the vm_boot card.) Returns false so the unified makeDispatcher
// continues to other listeners that might care.
const FORWARD_TYPES = new Set([
  'voice/chunk', 'voice/auto-stop', 'voice/error', 'voice/permission-result',
  'vm/stdout-chunk', 'vm/stderr-chunk',
]);
browser.runtime.onMessage.addListener((/** @type {any} */ msg, /** @type {any} */ sender) => {
  if (!FORWARD_TYPES.has(msg?.type)) return false;
  if (!isTrustedSender(sender)) return false;
  if (uiConnected()) {
    try { uiPorts.broadcast(msg); }
    catch (e) { console.warn('[sw] side-panel forward failed', e); }
  }
  return false;
});

// Tab tracker wiring. Each kind's tab broadcasts <kind>/tab-ready
// on load; we resolve the pending readyPromise so any in-flight
// ensureTab call returns. Closed tabs drop from the map via
// chrome.tabs.onRemoved.
browser.runtime.onMessage.addListener((/** @type {any} */ msg, /** @type {any} */ sender) => {
  if (!isTrustedSender(sender)) return false;
  // Each tab-ready is a new tabId entering the driven set, so each one resyncs
  // the denylist network backstop (idempotent; a no-op when nothing moved).
  if (msg?.type === 'vm/tab-ready') {
    if (typeof msg.vmId !== 'string' || sender?.tab?.id == null) return false;
    vmTabTracker.onTabReady(msg.vmId, sender.tab.id);
    denylistNetGuard.sync();
    return false;
  }
  if (msg?.type === 'js/tab-ready') {
    if (typeof msg.notebookId !== 'string' || sender?.tab?.id == null) return false;
    jsTabTracker.onTabReady(msg.notebookId, sender.tab.id);
    denylistNetGuard.sync();
    return false;
  }
  if (msg?.type === 'app/tab-ready') {
    if (typeof msg.appId !== 'string' || sender?.tab?.id == null) return false;
    appTabTracker.onTabReady(msg.appId, sender.tab.id);
    denylistNetGuard.sync();
    return false;
  }
  return false;
});

browser.tabs.onRemoved.addListener((tabId) => {
  // why the vmClient hop: a VM tab closing mid-command would otherwise
  // leave its pending RPCs stalling out the 90s message timeout. The
  // tracker maps tabId→vmId; the client owns the per-VM command lane
  // and rejects everything in it with VMTabClosedError right away.
  const closedVmId = vmTabTracker.onTabRemoved(tabId);
  if (closedVmId) vmClient.onTabClosed(closedVmId);
  jsTabTracker.onTabRemoved(tabId);
  appTabTracker.onTabRemoved(tabId);
  // DESIGN-17 note: only the VM client owns a per-instance COMMAND QUEUE to
  // interrupt on tab-close (above). The Notebook/App clients have no such lane —
  // their ops are request/response with a per-call timeout — so there is nothing
  // to "generalize" for js/app at P0 beyond the tracker mapping drop already
  // done here. An actor bound to a tabless instance simply re-spawns the tab on
  // its next op (the clients ensureTab internally); the binding persists.
  // Drop any DOM-nav refs for the closed tab.
  domRefs.clear(tabId);
  // ...and drop it out of the network backstop's tab scope. Tab ids are REUSED
  // within a browser session, so a stale entry would silently apply the block
  // to whatever unrelated tab inherits the id.
  denylistNetGuard.sync();
});

// Invalidate a tab's DOM-nav refs when it starts navigating — the
// backendDOMNodeIds belong to the old document. why: tabs.onUpdated
// (status 'loading') instead of a new webNavigation permission — full
// navigations are covered, and an SPA route change that slips through
// still fails safe (DOM.resolveNode can't find the node → tool errors →
// the model re-snapshots).
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') domRefs.clear(tabId);
});

browser.runtime.onConnect.addListener((port) => {
  // Reject ports from anything that isn't one of our own contexts. The
  // 'sidepanel' port receives pushState (vault status, session, settings),
  // so an untrusted connector must never get it. Same boundary as the
  // message dispatcher.
  if (!isTrustedSender(port.sender)) { try { port.disconnect(); } catch { /* already gone */ } return; }
  if (port.name === 'sidepanel' || port.name === 'home' || port.name === 'eval') {
    // The side panel and the full-page home are equal live surfaces (DESIGN-12);
    // the 'eval' surface (the Lab section + the standalone eval page) also needs
    // the turn/* stream. Register every one and stream session state to all.
    // ONLY 'sidepanel' counts as "the side panel is open" (broadcastSurfaces →
    // hasNamed('sidepanel')) — so an 'eval' port from the home page must NOT use
    // the 'sidepanel' name, or the home wrongly thinks the panel popped out.
    uiPorts.add(port);
    pushState();
    // Let every surface (incl. this fresh one) know whether a side panel is open,
    // and replay the current-agent-tab card (it's not in the state snapshot).
    broadcastSurfaces();
    broadcastAgentTab();
    // Replay a live pending confirm to THIS fresh surface so a late-joiner can
    // answer it — the state snapshot deliberately doesn't carry confirm state.
    const pendingPrompt = confirmCoordinator.getPending();
    if (pendingPrompt) {
      try { port.postMessage({ type: 'confirm/request', prompt: pendingPrompt }); }
      catch { /* port closing */ }
    }
    // Same idea for a LIVE goal run: its goal/state events only reached ports
    // connected when they fired, and the snapshot carries no goal-run field. So
    // replay each active run to this fresh surface — otherwise a reopened panel
    // (or one that reconnected after an SW respawn) shows no Goal bar / Stop for a
    // run still driving autonomously, leaving the user without the visible stop.
    for (const ev of (goalRunner?.activeStates?.() ?? [])) {
      try { port.postMessage(ev); } catch { /* port closing */ }
    }
    port.onDisconnect.addListener(() => {
      uiPorts.remove(port);
      broadcastSurfaces();
      // Sidebar just closed → if the user is sitting on a peerd-opened web tab,
      // surface the reminder (and start its 15s timer) right then.
      if (port.name === 'sidepanel' && !uiPorts.hasNamed('sidepanel')) {
        browser.tabs.query({ active: true, currentWindow: true })
          .then((tabs) => { const t = tabs[0]; if (t?.id != null) showWebTabHint(t.id); })
          .catch(() => {});
      }
    });
    return;
  }
  if (port.name === 'sw-keepalive') {
    console.log('[sw] keepalive port connected at', new Date().toISOString());
    keepalivePorts.add(/** @type {any} */ (port));

    // Heartbeat handler. Logging this proves the SW is awake AND that
    // bidirectional traffic is flowing. If we see heartbeats stop
    // arriving without a corresponding disconnect, the SW is being
    // killed silently and we should switch to chrome.alarms.
    port.onMessage.addListener((/** @type {any} */ msg) => {
      if (msg?.type === 'heartbeat') {
        console.log('[sw] heartbeat at', new Date().toISOString());
        try { port.postMessage({ type: 'heartbeat-ack', at: Date.now() }); }
        catch (e) { console.warn('[sw] heartbeat ack post failed', e); }
        return;
      }
    });

    port.onDisconnect.addListener(() => {
      const err = browser.runtime.lastError;
      console.log('[sw] keepalive port disconnected at',
        new Date().toISOString(),
        err ? `— lastError: ${err.message}` : '');
      keepalivePorts.delete(/** @type {any} */ (port));
    });
    return;
  }
});

vault.subscribe(() => { pushState(); });

// ---------------------------------------------------------------------------
// 5. Agent turn driver
// ---------------------------------------------------------------------------

// In-flight turns, one slot PER SESSION (peerd-runtime/loop/turn-slots).
// Steer-live (send mid-stream aborts + re-prompts) and agent/stop are
// scoped to a single chat; a turn streaming in another conversation
// keeps running when the user navigates away or chats elsewhere. The
// slots also back auto-memory's isBusy gate and pushState's streaming
// flag. (Replaced the global single-slot AbortController, 2026-06-12 —
// it killed chat A's stream the moment the user sent in chat B.)
// onAbort: when a session's turn is aborted (steer-live or Stop), decline any
// confirm it's parked on — otherwise the parked turn would run the cancelled
// side-effect after its 120s confirm timeout and double-write the session.
const turnSlots = makeTurnSlots({ onAbort: (sid) => confirmCoordinator.declineSession(sid) });

// The agent turn driver (runAgentTurn + maybeAutoResume) lives in
// peerd-runtime/loop/turn-driver.js now — ~530 lines of turn orchestration
// moved out of this file (SW thinning). All IO/state is injected here: this is
// the imperative-shell seam. turnSlots (above) is shared with the orchestrators
// and pushState, so it stays SW-scoped and is injected like everything else.
// The error CLASSES are imported inside the driver (instanceof narrowing), not
// passed here.
// Goal mode (the mode-row Goal toggle): keeps re-entering the agent turn until
// the agent calls complete_goal. Forward-declared so makeTurnDriver can read
// goalActiveFor (which tool list to show) at CALL time — the runner itself is
// built just below, once runAgentTurn exists (the same late-dep dance the
// orchestrator wiring uses). filterByGoalActive is a pure descriptor filter.
/** @type {ReturnType<typeof makeGoalRunner> | null} */
let goalRunner = null;
// Background scheduling (loop/scheduler.js): forward-declared like goalRunner so
// buildToolContext's schedule_* hooks resolve it lazily; built just below once
// runAgentTurn / startGoalRun exist.
/** @type {ReturnType<typeof makeScheduler> | null} */
let scheduler = null;

// Prewalk (loop/prewalk-controller.js) — the lifecycle side effects, bound to
// the SW's live IO. The controller owns the arm/reconcile/swap/restore logic
// (Bun-tested); the SW just injects sessions/goalRunner/settings/etc. No
// parallel in-memory Set: the swap gate keys on goalRunner.isActive and the
// stale check on the durable goal-runs mirror (goalRunner.isPersisted), so
// there's no bookkeeping that can desync from the run lifecycle. goalRunner is
// forward-declared (built below), so read it live via a getter closure.
const prewalk = makePrewalkController({
  sessions,
  goalRunner: {
    isActive: (/** @type {string} */ sid) => goalRunner?.isActive(sid) ?? false,
    isPersisted: (/** @type {string} */ sid) => goalRunner?.isPersisted(sid) ?? Promise.resolve(false),
  },
  settings: settingsStore,
  listProviders,
  getTool,
  appendAudit: auditLog.append,
  postChatNote: (/** @type {string} */ text) => postChatNote(text),
  now: Date.now,
});

const { runAgentTurn, maybeAutoResume } = makeTurnDriver({
  vault, VaultLockedError, sessionCache, ensureActiveProvider, resolvePermission,
  sessions, sessionState, turnSlots, buildTemporalBlock, memory, browser, originOfTabUrl,
  skillRegistry, renderSystemPrompt, resolveManifestAllow, buildToolContext,
  filterByDwebActive, filterByDwebEnabled,
  filterDescriptorsByManifest, mainAgentDescriptors, listTools, settingsStore, DWEB_ENABLED,
  filterByGoalActive, goalActiveFor: (/** @type {string} */ sid) => goalRunner?.isActive(sid) ?? false,
  dwebEngagedSessions, markDwebEngaged, dispatchToolCall, maybeNudgeDebuggerGrant, getTool,
  decideAction, listProviders, costOf, makeTurnCostTracker, uiConnected, uiPorts, auditLog,
  resolveFailoverChain, shouldFailover, callModel, runUserTurn, getSecret,
  safeFetch, REASONING_BUDGET_TOKENS, REASONING_EFFORT_LEVELS, DEFAULT_SETTINGS, trimEnricher,
  contextWindowFor, liveContextWindow, currentAppScope, checkpointMgr, detectInterruptedTurn,
  // Lifecycle recovery notices → the next turn's <context> message (read-once).
  drainRecoveryNotices: (/** @type {string} */ sid) => lifecycleBoot.drainNoticesFor(sid),
  recordModelCall: contextSnapshots.record,
  // prewalk: the turn-boundary reconcile (swap/restore) + the per-tool-call gate,
  // plus the engine-actor reconcile (VM/Notebook/App swap after their first turn).
  reconcilePrewalk: prewalk.reconcile, maybePrewalkSwap: prewalk.maybeSwap,
  reconcileEngineActor: prewalk.reconcileEngineActor,
  // postChatNote is declared just below this call — defer the reference so it
  // resolves at call-time (the same late-declared-dep pattern the orchestrator
  // wiring above uses, see the note at the postChatNote site).
  postChatNote: (/** @type {any} */ text, /** @type {any} */ action) => postChatNote(text, action),
});

// Build the goal runner now that runAgentTurn exists. Each goal turn is a
// normal runAgentTurn on the MAIN session (turn 1 = the goal, later turns =
// hidden synthetic continuations), so the work streams into the chat like any
// session. The complete_goal tool ends it; goal/state events drive the panel's
// Goal bar (iteration + Stop).
goalRunner = makeGoalRunner({
  runTurn: (/** @type {any} */ args) => runAgentTurn(args),
  onEvent: (/** @type {any} */ ev) => { if (uiConnected()) { try { uiPorts.broadcast(ev); } catch { /* port closed */ } } },
  // Terminal note when a run ends WITHOUT a complete_goal result already in the
  // transcript (cap / halt). 'done' needs none — complete_goal's tool result is
  // the visible record. (Permission needs no restore: resolvePermission computes
  // the autonomy from the live run, so it reverts on its own when the run ends.)
  onRunEnd: (/** @type {any} */ sid, /** @type {any} */ info) => {
    // Prewalk: put the chat back on the planner model whatever way the run
    // ended. Fire-and-forget — restore is a no-op while a run isActive (so a
    // superseding run's arm can't be clobbered), and the reconcile path
    // self-heals if this write is ever lost. Runs for EVERY ending run (incl. a
    // background routine's), so it is NOT under the foreground guard below.
    prewalk.restoreForRun(sid).catch(() => {});
    // why the foreground guard: postChatNote broadcasts a session-agnostic
    // system-note and the reducer appends it to whatever chat is OPEN. A
    // background scheduled routine's goal run ends in its OWN (never-foreground)
    // session, so without this its "capped/halted" note would pop into an
    // unrelated chat the user is reading. Only surface it when the ending run IS
    // the foreground chat; a background routine's outcome rides its own session
    // + the routine notification instead.
    Promise.resolve(sessionCache.sessionGet('currentSessionId')).then((cur) => {
      if (cur !== sid) return;
      if (info?.phase === 'capped') postChatNote(`Goal run stopped — hit the ${GOAL_MAX_ITERATIONS}-turn limit without finishing.`);
      else if (info?.phase === 'halted') postChatNote(info?.reason ? `Goal run stopped (${info.reason}).` : 'Goal run stopped.');
    }).catch(() => {});
  },
  // why kv: a goal run must survive an SW restart and keep going while the user
  // is in another chat — the runner mirrors active runs to storage.local and
  // resume() (on vault unlock) re-drives them. Without it the run is in-memory
  // only and an MV3 recycle would silently drop it.
  kv,
  // The live plan-of-record for each continuation prompt — re-read per turn
  // so check-offs show; '' when no list yet (todo/core.js formatTodoBlock).
  getTodoBlock: async (/** @type {string} */ sid) =>
    formatTodoBlock(/** @type {any} */ (await sessions.get(sid))?.todos),
});

// ---------------------------------------------------------------------------
// 5b1. Background scheduling — standing Routines (loop/scheduler.js)
// ---------------------------------------------------------------------------
// A Routine fires an agent run unattended on a cadence, and catches up as soon
// as peerd is back on (see the three tick() wakes below: chrome.alarms, cold
// boot, vault unlock). The runner is the time-triggered sibling of goalRunner —
// same durable-mirror-in-storage.local contract — with the IO injected here.

// Arm (or clear) the single wake alarm for the soonest routine. chrome.alarms
// persists across SW eviction AND browser restart, and a `when` in the past
// fires ~immediately on the next browser start — that's the "run as soon as the
// browser is back on" mechanism for the SW-asleep / browser-off cases.
const setScheduleAlarm = (/** @type {number | null} */ whenMs) => {
  try {
    if (whenMs == null) { browser.alarms?.clear?.(SCHEDULE_ALARM_NAME); return; }
    // chrome.alarms floors very-near/near-past `when` to ~1 min out; that's fine
    // — a due routine still fires promptly, and the boot/unlock ticks cover the
    // immediate case without waiting for the alarm.
    browser.alarms?.create?.(SCHEDULE_ALARM_NAME, { when: whenMs });
  } catch (e) { console.error('[sw] schedule alarm set failed', e); }
};

// Content-free desktop notification when a routine starts (DECISIONS #20 posture:
// title only, never the task text or any result). The run itself streams into
// its own session; this just tells a user with the panel closed that it fired.
const notifyRoutineFired = () => {
  try {
    browser.notifications?.create?.({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon128.png'),
      title: 'peerd routine running',
      message: 'A scheduled task started. Open peerd to see it.',
    });
  } catch (e) { console.warn('[sw] routine notify failed', e); }
};

// Fire ONE routine: mint a fresh, dedicated session (tagged with the routine id
// for provenance — NOT the foreground currentSessionId, so it never disturbs the
// user's active chat), then drive it. 'goal' mode reuses the goal runner (an
// autonomous multi-step run until complete_goal); 'turn' mode is a single agent
// turn. trusted:true — a routine is USER-authored first-party work, same posture
// as goal mode; untrusted CONTENT it later pulls is still fenced behind actors.
const fireRoutine = async (/** @type {any} */ routine) => {
  // why settingsStore.load() first: a cold-unlock catch-up can reach here before
  // loadSettings() (un-awaited at boot) has hydrated, so ensureActiveProvider
  // would pick the channel-default provider instead of the user's. load() is
  // idempotent — same guard the maybeAutoResume path uses.
  await settingsStore.load().catch(() => {});
  const ap = await ensureActiveProvider();
  // why explicit ACT + confirm-off (NOT resolvePermission(null)): a routine runs
  // UNATTENDED with the panel closed. Inheriting the foreground chat's mode would
  // make the run's autonomy depend on whatever chat happened to be open at the
  // firing instant — a Plan-mode foreground would silently restrict it, and a
  // confirm-on foreground would DEADLOCK the background turn on a prompt no one
  // can answer. An unattended run must be self-determined: Act, no confirms.
  const created = await sessions.create({
    provider: ap.name,
    model: ap.model,
    permissionMode: PERMISSION_MODES.ACT,
    confirmActions: false,
  });
  await sessions.update(created.sessionId, { routineId: routine.id }).catch(() => {});
  auditLog.append({ type: 'routine_fired', details: { routineId: routine.id, mode: routine.mode, sessionId: created.sessionId } }).catch(() => {});
  if (routine.mode === 'turn') {
    // synthetic:false makes this a REAL first turn (inbound:false) exactly like a
    // user's typed message — no `trusted` needed (it's redundant when synthetic is
    // false). The routine's first-party standing comes from the confirm-to-arm gate
    // in schedule_create, not from a trusted flag here.
    runAgentTurn({ sessionId: created.sessionId, userText: routine.prompt, synthetic: false })
      .catch((/** @type {unknown} */ e) => console.error('[sw] routine turn threw', e));
  } else {
    await startGoalRun({ sessionId: created.sessionId, goal: routine.prompt });
  }
  notifyRoutineFired();
  return { sessionId: created.sessionId };
};

scheduler = makeScheduler({
  fireRoutine,
  kv,
  isLocked: () => vault.isLocked(),
  // Skip a firing whose PREVIOUS run is still going (a goal loop slower than the
  // routine's cadence) so it can't pile up concurrent runs — the runner advances
  // it a slot instead. A 'turn'-mode routine has no goal run, so it never blocks
  // here; a 'goal'-mode routine's last session is live iff goalRunner says so.
  isRunning: (/** @type {any} */ routine) =>
    !!routine.lastSessionId && (goalRunner?.isActive(routine.lastSessionId) ?? false),
  setAlarm: setScheduleAlarm,
  onEvent: (/** @type {any} */ ev) => { if (uiConnected()) { try { uiPorts.broadcast(ev); } catch { /* port closed */ } } },
});

// The chrome.alarms wake: fires even with the panel closed and the SW asleep.
// resumeSchedules (defined below; referenced at fire time, post-boot) sequences
// goalRunner.resume() → load → tick so the isRunning() guard sees paused goal
// runs — an alarm can respawn a dead SW, racing goal-run resume.
browser.alarms?.onAlarm?.addListener((/** @type {any} */ alarm) => {
  if (alarm?.name !== SCHEDULE_ALARM_NAME) return;
  resumeSchedules().catch((/** @type {unknown} */ e) => console.error('[sw] schedule tick (alarm) failed', e));
});

// Browser-start wake: rehydrate + catch up any routines that came due while the
// browser was off. Redundant with the top-level boot catch-up (which runs on
// every SW spawn), but onStartup is the guaranteed cold-browser-start signal;
// resumeSchedules is idempotent + serialized, so both firing is harmless.
browser.runtime?.onStartup?.addListener(() => {
  resumeSchedules().catch((/** @type {unknown} */ e) => console.error('[sw] schedule onStartup catch-up failed', e));
});

// ---------------------------------------------------------------------------
// 5b2. DESIGN-17 — actor tab agents: the message_actor orchestrator
// ---------------------------------------------------------------------------
// An actor is a per-instance agent that OWNS one tab-hosted instance and
// exclusively holds its tools. The orchestrator (the async-actors shape,
// specialized) is the mailbox to it; the SW supplies the IO — resolve + lazy-
// mint the actor across the three registries, drive ONE actor turn (the
// SAME runAgentTurn wrapper, kind-aware), and re-enter the sender with the reply.

// Route an instance id to its registry + engine kind by id-prefix (the registry
// idPrefix: 'vm' / 'notebook' / 'app').
const ACTOR_REGISTRY_BY_PREFIX = {
  vm: { reg: vmRegistry, kind: 'webvm' },
  notebook: { reg: jsRegistry, kind: 'notebook' },
  app: { reg: appRegistry, kind: 'app' },
};

// Dedupe concurrent first-mints: two message_actor calls to the SAME not-yet-
// minted instance (e.g. the model emits two tool_use blocks targeting one new
// instance in a single turn) would both see no forward pointer and both mint —
// one wins setActorSession, the other orphans a session. A per-id in-flight
// promise collapses them to ONE mint; the entry clears when it settles. why a
// shared map: engine ids carry a prefix and web keys are `web:<tabId>`, so they
// never collide. @type {Map<string, Promise<string>>} */
// Single-flight dedup for lazy actor minting (background/mint-once.js): two
// message_actor calls racing to the same instance collapse onto ONE mint.
const { mintOnce } = makeMintOnce();

// Start the actor process on demand: lazily mint an actor session for an
// instance (on the first message_actor). Inherits the spawning chat's RESOLVED
// Plan/Act posture — resolved + stored EXPLICITLY so it can't silently widen to the
// global default (the actor guardrail-3 precedent). Binds BOTH directions:
// actorSessionId on the registry record (the REGISTERED NAME — the stable
// instance id → live session pointer resolveActor reads, like a Registry entry),
// and the actor session as the instance's session-default so id-less tools
// (vm_write_file / vm_import / edit_file) resolve the bound instance. Lost session?
// re-minted on the next message — let-it-crash / supervisor restart (resolveActor).
const mintActor = async (/** @type {{ reg: any, kind: string }} */ entry, /** @type {any} */ record) => {
  const activeId = await sessionCache.sessionGet('currentSessionId');
  const ownerChat = activeId ? await sessions.get(/** @type {string} */ (activeId)) : null;
  const perm = await resolvePermission(/** @type {any} */ (ownerChat));
  const created = await sessions.create({
    kind: 'actor',
    ...(activeId ? { parentSessionId: /** @type {string} */ (activeId) } : {}),
    instanceId: record.id,
    actorType: /** @type {any} */ (entry.kind),
    ...(ownerChat?.provider ? { provider: ownerChat.provider } : {}),
    ...(ownerChat?.model ? { model: ownerChat.model } : {}),
    permissionMode: perm.mode,
    confirmActions: perm.confirmActions,
    // The actor inherits the owner chat's tool MANIFEST as an authority bound
    // (the actor precedent, spawn.js): a /tools-narrowed chat can't widen its
    // reach by delegating to an actor. A browse-only chat's actor is held to
    // browse-only's read DOM tools — the gate refuses click/type for it. null /
    // absent = no manifest = the actor keeps its full kind toolset.
    ...(ownerChat?.toolManifest !== undefined ? { toolManifest: ownerChat.toolManifest } : {}),
  });
  // Order matters for crash-safety: bind the session-default FIRST, then the
  // forward pointer LAST. resolveActor re-mints whenever the forward pointer
  // is absent, so an SW death between these two persists leaves an un-pointed
  // (re-mintable) instance rather than a pointed-but-unresolvable one — a present
  // actorSessionId now IMPLIES its session-default was written.
  await entry.reg.setDefaultForSession(created.sessionId, record.id);
  await entry.reg.setActorSession(record.id, created.sessionId);
  auditLog.append({ type: 'actor_minted', sessionId: created.sessionId, details: { instanceId: record.id, kind: entry.kind } }).catch(() => {});
  // Engine-actor prewalk: an engine actor is minted on the frontier (owner
  // chat) model; when enginePrewalkEnabled, arm it so it keeps that model for
  // its first turn and swaps to the cheap executor thereafter. Quiet no-op when
  // the setting is off or no distinct executor resolves. Awaited so the state
  // is on the record before the actor's first turn renders.
  await prewalk.armEngineActor(created.sessionId);
  return created.sessionId;
};

// DESIGN-17 — WEB actors (a fourth `kind:'web'` actor that owns one TAB).
// Unlike the three engine kinds, a web actor has no registry record: the TAB
// is the durable handle and the binding is tab→session, held here and mirrored to
// session storage (ephemeral by design — on a cold miss we re-mint against the
// live tab, whose DOM re-derives state). The address the orchestrator uses is the
// tabId AS A STRING (the actor's instanceId).
// A registry's chrome.storage.session persistence: the persist thunk + the
// best-effort boot rehydrate, shared by the three actor registries below (a
// missing/garbage stored value just starts empty). Ephemeral by design — every
// one of these is a routing cache whose durable truth lives on the session record.
const persistRegistry = (/** @type {string} */ key, /** @type {{ entries: () => any }} */ registry) =>
  () => { sessionCache.sessionSet(key, registry.entries()).catch(() => {}); };
// Returns the load promise (never rejects) so a caller whose state DEPENDS on
// the rehydrated entries — the net guard's driven-tab set — can chain onto it
// instead of guessing at the timing.
const hydrateRegistry = (/** @type {string} */ key, /** @type {{ load: (e: any) => void }} */ registry) =>
  Promise.resolve(sessionCache.sessionGet(key))
    .then((e) => { if (Array.isArray(e)) registry.load(/** @type {any} */ (e)); })
    .catch(() => {});

const webActorTabBindings = makeWebActorTabBindings();
const WEB_BINDINGS_KEY = 'webActorTabBindings';
const persistWebBindingsOnly = persistRegistry(WEB_BINDINGS_KEY, webActorTabBindings);
// why compose the net-guard sync in HERE rather than at each call site: every
// mutation of the tab bindings — bind, drop, re-bind, the onRemoved prune —
// already funnels through persistWebBindings, so this is the one place that
// sees the driven-tab set change. A sync is idempotent and skips when nothing
// moved, so the extra call on a no-op mutation costs nothing.
const persistWebBindings = () => { persistWebBindingsOnly(); denylistNetGuard.sync(); };
// Rehydration restores bindings without going through persistWebBindings (an
// SW restart finds tabs still being driven), so the guard is told once the load
// lands — not before, or it would re-derive the same empty set it started with.
hydrateRegistry(WEB_BINDINGS_KEY, webActorTabBindings)
  .then(() => denylistNetGuard.sync());

// The chat→web-actor registry — the 0-or-1-tab web actor (addressed by `to:'web'`,
// the SINGLE entry point for web work). Separate from webActorTabBindings because
// the actor exists BEFORE it owns a tab; its tab (when it renders) is read back
// from webActorTabBindings.tabFor (one source of truth). Persisted/rehydrated like
// the tab bindings — ephemeral is fine (re-mint on loss).
const webActorRegistry = makeWebActorRegistry();
const WEB_ACTOR_KEY = 'webActorRegistry';
const persistWebActors = persistRegistry(WEB_ACTOR_KEY, webActorRegistry);
hydrateRegistry(WEB_ACTOR_KEY, webActorRegistry);

// PR #119 — the code-REPL arm's SW route. A page.<method> call the code-surface
// web actor makes inside its sealed worker rides here (offscreen job-runner →
// 'page/call'). SECURITY, the whole point of doing this SW-side:
//   • The OWNER is the sessionId the offscreen relay attached from the trusted
//     job params — never anything the worker put in its own message.
//   • That session must be a tab-backed WEB actor; anything else (a bare js_run
//     job, an engine actor, a stale id) is refused — the page capability is not
//     a general worker power.
//   • The tab is resolved AUTHORITATIVELY from webActorTabBindings.tabFor(owner):
//     the owner can't name a tab, so it can only ever act on the ONE tab it owns
//     (fail closed if it owns none).
// Then makePageCallHandler translates → builds a normal tab web-actor ctx (NO
// code surface, so the mapped navigate/click/type are allowed) → dispatches
// through the FULL gate stack (denylist / confirm / audit), so this route adds
// zero authority over the tool-call actor.
const pageCallHandler = makePageCallHandler({
  dispatchToolCall: /** @type {any} */ (dispatchToolCall),
  buildActorContext: ({ sessionId, tabId }) => buildToolContext({
    sessionId, activeTabId: tabId,
    exposure: EXPOSURE_ACTOR, actorType: 'web', actorInstanceId: String(tabId), actorBacking: 'tab',
    // FORCE the tools surface for the INNER mapped-tool dispatch: the actor's own
    // surface is 'code' (that's how it got here), but navigate/click/type must be
    // ALLOWED for the page.* translation — else the setting would refuse them.
    actorSurface: 'tools',
  }),
});
const pageCallRoute = {
  /** @param {{ method?: string, args?: object, ownerSessionId?: string }} msg */
  'page/call': async ({ method, ownerSessionId, args } = {}) => {
    if (vault.isLocked()) return { ok: false, error: 'locked' };
    if (typeof ownerSessionId !== 'string' || !ownerSessionId) return { ok: false, error: 'page_call_no_owner' };
    // The owner MUST be a live tab-backed web actor — the page surface is not a
    // general worker capability. (findActorSession/get by id; reject otherwise.)
    const owner = await sessions.get(ownerSessionId).catch(() => null);
    if (!owner || owner.kind !== 'actor' || owner.actorType !== 'web' || owner.backing === 'api') {
      return { ok: false, error: 'page_call_not_web_actor' };
    }
    // Authoritative tab: the ONE this actor owns (never a worker-supplied id).
    // A fresh code actor owns none — and unlike the tool-call actor it has no
    // direct `navigate` to lazily open one, so page.goto() IS its adopt path:
    // open + bind its first tab here (the SAME adoptWebTab navigate uses), then
    // dispatch pinned to it. Every other page.* with no tab is refused with an
    // actionable "open a page first" message. See resolvePageTab.
    const decision = resolvePageTab(webActorTabBindings.tabFor(ownerSessionId), /** @type {string} */ (method));
    if (decision.action === 'refuse') return { ok: false, error: decision.error };
    let tabId;
    if (decision.action === 'adopt') {
      const adopted = await adoptWebTab(ownerSessionId).catch(() => null);
      if (typeof adopted?.tabId !== 'number') return { ok: false, error: 'page_call_tab_open_failed' };
      tabId = adopted.tabId;
    } else {
      tabId = decision.tabId;
    }
    const outcome = await pageCallHandler({ method: /** @type {string} */ (method), args, sessionId: ownerSessionId, tabId });
    // Announce the settled op on the UI ports — pure observability, ZERO added
    // authority (the gated dispatch already ran; consumers see method/ok only).
    // why: a page_code call is ONE tool_use whose real page actions happen in
    // here — invisible to the turn/tool-use stream. The eval harness's OM2W
    // recorder (and any UI activity view) needs each op as a discrete
    // after-action event, or a code-surface trajectory records as
    // [navigate, answer] and a judge can't see the work.
    uiPorts.broadcast({
      type: 'page/op', sessionId: ownerSessionId, tabId,
      method: /** @type {string} */ (method), args: args ?? {}, ok: outcome?.ok === true,
      ...(outcome?.ok === false ? { error: String(outcome.error ?? '').slice(0, 200) } : {}),
    });
    return outcome;
  },
};

// ── DESIGN-19 — the site-fetch/call route (a site-client run's ONLY egress) ──
// A site.fetch(pathOrUrl) call inside a sealed site-client worker relays here
// (offscreen job-runner → 'site-fetch/call'). SECURITY, the whole point of doing
// this SW-side (the a2a/page-call posture):
//   • OWNER + PINNED ORIGIN ride from the trusted job params, never the worker.
//   • The owner must be a WEB actor (tab or API) — not a general worker power.
//   • resolveSiteUrl pins every request to the origin (cross-origin REFUSED) —
//     the worker cannot point the fetch at another host.
//   • Denylist-checked; a non-GET crosses the shared web:write confirm.
//   • The fetch runs through the actor's SESSION-SCOPED webFetch (cookies ride
//     same-origin, keyless — identical authority to fetch_url), so this relay adds
//     nothing the live actor doesn't already have for its own origin.
const siteFetchCallRoute = {
  /** @param {{ ownerSessionId?: string, siteOrigin?: string, pathOrUrl?: string, method?: string, headers?: Record<string,string>, body?: unknown }} msg */
  'site-fetch/call': async ({ ownerSessionId, siteOrigin, pathOrUrl, method, headers, body } = {}) => {
    if (vault.isLocked()) return { ok: false, error: 'locked' };
    if (typeof ownerSessionId !== 'string' || !ownerSessionId) return { ok: false, error: 'site_fetch_no_owner' };
    const owner = await sessions.get(ownerSessionId).catch(() => null);
    if (!owner || owner.kind !== 'actor' || owner.actorType !== 'web') {
      return { ok: false, error: 'site_fetch_not_web_actor' };
    }
    const pin = normalizeApiOrigin(siteOrigin);
    if (!pin) return { ok: false, error: `site_fetch_bad_origin: ${siteOrigin}` };
    const resolved = resolveSiteUrl(pathOrUrl, pin);
    if ('error' in resolved) return { ok: false, error: resolved.error };
    const url = resolved.url;
    // Denylist floor (the origin gate's SW-side twin): a site client can't reach a
    // denylisted host even if one was somehow stored.
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    if (host) {
      const hit = matchesDenylist(host, denylistStore.patterns());
      if (hit) return { ok: false, error: `denylisted: ${host} matches '${hit}'` };
    }
    const httpMethod = String(method ?? 'GET').toUpperCase();
    // Anti-exfil: a non-GET can transmit in-context data. Confirm by default via
    // the SHARED web:write key (one approval governs fetch_url + call_api + this).
    if (needsWebWriteConfirm(httpMethod)) {
      const ans = await confirmAction(/** @type {any} */ ({
        tool: 'web:write', kind: 'web_write', origins: [pin],
        summary: `Allow a ${httpMethod} request to ${host} from a site client? This can send data out of the browser.`,
        sessionId: ownerSessionId,
      }));
      if (ans !== 'yes_once' && ans !== 'yes_session') return { ok: false, error: 'declined: user declined the site-client write.' };
    }
    // The actor's SESSION-SCOPED / origin-pinned webFetch — same wrappers
    // buildToolContext hands the web/API actor. Cookies ride only same-origin to
    // the owned origin; the worker never holds a credential.
    let scopedFetch;
    if (owner.backing === 'api') {
      // An API actor OWNS ONE origin (its instanceId), and fetch_url pins its
      // credentials to that FIXED origin (see the actorBacking==='api' branch in
      // buildToolContext). This relay must pin the SAME way — `pin` here is
      // MODEL-supplied (site_client_run's `origin` arg), so without this check a
      // hijacked API actor bound to origin A could name origin B and spend B's
      // stored vault key + B's cookies: the cross-origin credential escalation the
      // "an API actor owns one origin" containment (DESIGN-18) exists to prevent.
      // Refuse when the named origin is not the actor's owned origin. why this is
      // the API sibling of the tab branch below: #251 scoped the tab path to the
      // tab's LIVE origin via the lock and origin-lock.js flagged site_client_* as
      // uncovered — that fix landed for tab actors; this closes it for API actors.
      const owned = typeof owner.instanceId === 'string' ? normalizeApiOrigin(owner.instanceId) : null;
      if (!owned || pin !== owned) return { ok: false, error: 'site_fetch_cross_origin' };
      scopedFetch = withDpopCredentials(webFetch, () => owned, {
        getSecret: (/** @type {string} */ name) => vault.getSecret(name),
        getDpopKey: getDpopKeyForOrigin,
        audit: (/** @type {any} */ e) => auditLog.append(e),
      });
    } else {
      // A tab actor: scope to the owned tab's LIVE origin (matches the pin when the
      // actor is on that site; a mismatch is naturally sessionless at the boundary).
      const ownedTabId = webActorTabBindings.tabFor(ownerSessionId);
      // FAIL CLOSED when there is no readable tab. This used to default to `pin`
      // — i.e. to `siteOrigin`, which the MODEL supplies — so a web actor with no
      // tab (the 0-tab fetch state, or a tab that just closed) got a CREDENTIALED
      // fetch to any origin it cared to name. Adversarial review found it; it is
      // the precise escalation the session scope exists to prevent, arriving
      // through the scope's own default. Undefined means sessionless, which is
      // what "we do not know where this actor is" should always have meant.
      let tabOrigin = /** @type {string | undefined} */ (undefined);
      if (typeof ownedTabId === 'number') {
        const t = await browser.tabs.get(ownedTabId).catch(() => null);
        if (t?.url) tabOrigin = originOfTabUrl(/** @type {string} */ (t.url));
      }
      // issue 251 — and narrowed by the origin lock, the SAME policy
      // buildToolContext applies to this actor's own webFetch. Without this the
      // route was a way around the lock rather than a peer of it: origin-lock.js
      // named site_client_* as uncovered, and a relay that quietly kept the
      // wider scope would have made that note the only thing standing between a
      // hijacked actor and the user's session.
      originStates.hydrate(ownerSessionId, /** @type {any} */ (owner.originState));
      const lock = originLockFor(ownerSessionId);
      scopedFetch = withSessionScopedCredentials(
        webFetch,
        lock ? lock.makeScope(() => tabOrigin) : () => tabOrigin,
      );
    }
    // Strip tool-supplied credential headers (a laundered injection forging one) —
    // the real same-origin cookies come from the jar via the boundary. `dpop` is on
    // the list because the RFC 9449 proof slot is the boundary's to fill
    // (withDpopCredentials); anything a tool puts there is forged by construction.
    /** @type {Record<string, string>} */
    const safeHeaders = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (['cookie', 'authorization', 'proxy-authorization', 'dpop'].includes(k.toLowerCase())) continue;
      if (typeof v === 'string') safeHeaders[k] = v;
    }
    let reqBody = body;
    if (reqBody !== undefined && typeof reqBody !== 'string') {
      reqBody = JSON.stringify(reqBody);
      if (!safeHeaders['Content-Type'] && !safeHeaders['content-type']) safeHeaders['Content-Type'] = 'application/json';
    }
    try {
      const res = await scopedFetch(url, { method: httpMethod, headers: safeHeaders, body: /** @type {string|undefined} */ (reqBody) });
      const ct = res.headers.get('content-type') ?? '';
      const text = (await res.text()).slice(0, 200_000);   // hard cap on relayed bytes
      let json = null;
      if (/(json|graphql)/i.test(ct)) { try { json = JSON.parse(text); } catch { json = null; } }
      return { ok: true, value: { status: res.status, finalUrl: res.url ?? url, contentType: ct || null, body: text, json } };
    } catch (e) {
      const err = /** @type {{ reason?: string, message?: string }} */ (e);
      if (err?.reason === 'redirect_blocked') return { ok: false, error: `redirected: ${url} issued a redirect (not followed). Use the final URL.` };
      if (err?.reason === 'private_network') return { ok: false, error: `blocked: ${url} is a private/loopback host (SSRF defense).` };
      return { ok: false, error: err?.message ?? 'site_fetch_failed' };
    }
  },
};

// DESIGN-19 — the options-surface routes for stored site clients: list (metas
// only — no module bodies) + delete. The dossier/module are NOT secrets (they hold
// no credentials by construction), so this is ungated like the denylist routes.
const siteClientRoutes = {
  'site-client/list': async () => {
    try {
      const metas = await siteClientStore.listMeta();
      // Project to the UI-relevant fields (never the body).
      return { ok: true, clients: metas.map((/** @type {any} */ mMeta) => ({
        origin: mMeta.origin, summary: mMeta.summary, endpoints: mMeta.endpoints?.length ?? 0,
        auth: mMeta.auth, deriver: mMeta.deriver, sizeBytes: mMeta.sizeBytes,
        derivedAt: mMeta.derivedAt, lastVerifiedAt: mMeta.lastVerifiedAt, recentFailures: mMeta.recentFailures,
      })) };
    } catch (e) { return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }; }
  },
  'site-client/delete': async (/** @type {{ origin?: string }} */ { origin } = {}) => {
    if (typeof origin !== 'string' || !origin) return { ok: false, error: 'origin-required' };
    try { await siteClientStore.remove(origin); return { ok: true }; }
    catch (e) { return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }; }
  },
};

// ── DESIGN-19 — the capture MANAGER (Tap A CDP / Tap B scripting) ────────────
// One capability behind the two taps: CDP Network where the debugger ships
// (advancedAutomationOn — the SAME gate every other CDP path uses), else the
// chrome.scripting MAIN-world fetch/XHR wrap (all channels, no new permission).
// Returns a redacted, templatized endpoint inventory via the pure digester.
const siteCaptureManager = {
  /** @param {{ tabId: number, origins: string[] }} o */
  start: async ({ tabId }) => {
    if (advancedAutomationOn() && debuggerPool.startNetworkCapture) {
      await debuggerPool.startNetworkCapture(tabId);
      return { tap: 'cdp' };
    }
    await browser.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: installFetchTapInjected,
    });
    return { tap: 'tap' };
  },
  /** @param {{ tabId: number, origins: string[] }} o */
  stop: async ({ tabId, origins }) => {
    /** @type {any[]} */
    let events = [];
    let deriver = 'capture-tap';
    if (advancedAutomationOn() && debuggerPool.stopNetworkCapture && debuggerPool.isAttached?.(tabId)) {
      events = await debuggerPool.stopNetworkCapture(tabId);
      deriver = 'capture-cdp';
    } else {
      const [res] = await browser.scripting.executeScript({
        target: { tabId }, world: 'MAIN', func: drainFetchTapInjected,
      });
      events = /** @type {any} */ (res?.result)?.events ?? [];
    }
    return digestCapture(events, { origins, deriver: /** @type {any} */ (deriver) });
  },
};

// DESIGN-18 — API actors. An API integration is a `web` actor (backing:'api') with NO
// tab: it owns ONE FIXED origin and reaches it fetch-only. Keyed by (ownerChatId,
// origin) — origin-keyed (vs the tab store's tabId key) because an API origin never
// moves, and chat-scoped (v1 memory is per-chat). No onRemoved lifecycle — there is no
// tab to close; it ages out with its chat.
// why the binding stays EPHEMERAL (chrome.storage.session) yet memory survives a browser
// restart: the binding is just a routing CACHE; the API actor's accumulated memory lives
// durably on its session record (IDB). On a binding miss (post-restart), resolveApiActor
// RECONNECTS to the durable actor via sessions.findActorSession (instanceId=origin +
// parentSessionId) before minting — so the cache stays bounded (auto-clears on restart,
// no unbounded growth + no cleanup hook needed) while the durable session is the truth.
const apiActorBindings = makeApiActorBindings();
const API_ACTOR_KEY = 'apiActorBindings';
const persistApiActors = persistRegistry(API_ACTOR_KEY, apiActorBindings);
hydrateRegistry(API_ACTOR_KEY, apiActorBindings);

// DESIGN-18 P2 — the API-integration discovery surface (injected as ctx.listApiIntegrations,
// the integration rows of actor_list). The addressable set is the chat's FORMED integrations (origins it
// already worked, from the binding store) UNION the KEYED origins (vault origin:<origin>
// secrets — global, usable by any chat). keyed=true tells the agent an API key rides
// automatically; formed=true that it has state/memory here. A locked vault degrades to
// formed-only (no throw). The KEY VALUE is never read — only the secret NAMES (origins).
const listApiIntegrations = async (/** @type {string | null | undefined} */ chatId) => {
  const formed = chatId ? apiActorBindings.originsFor(chatId) : [];
  /** @type {string[]} */
  let keyed = [];
  try {
    const names = await vault.listSecretNames();
    keyed = /** @type {string[]} */ (names.map(originFromSecretName).filter(Boolean));
  } catch { keyed = []; }   // locked → formed-only
  const formedSet = new Set(formed);
  const keyedSet = new Set(keyed);
  const origins = [...new Set([...formed, ...keyed])].sort();
  return origins.map((origin) => ({ origin, keyed: keyedSet.has(origin), formed: formedSet.has(origin) }));
};

// DESIGN-17 P1 — the DURABLE MESSAGE MAILBOX. An in-flight engine message→reply
// correlation persists here, so an SW death between accept and deliver() doesn't
// silently drop the reply-wake; redrain() re-queues it on boot. chrome.storage.
// session (not local): a pending message only makes sense within ONE browser
// session — a full browser restart drops the orchestrator turn anyway, so a stale
// resurrection would be wrong. The blob is keyed by correlationId for O(1) removal.
const ACTOR_MAILBOX_KEY = 'actorMailbox';
// Serialize read-modify-write: a concurrent append+remove on the single blob would
// otherwise clobber. A promise chain makes each update see the prior one's write.
let mailboxChain = Promise.resolve();
const mailboxUpdate = (/** @type {(m: Record<string, any>) => Record<string, any>} */ mutate) => {
  mailboxChain = mailboxChain.then(async () => {
    const cur = await sessionCache.sessionGet(ACTOR_MAILBOX_KEY);
    const base = (cur && typeof cur === 'object') ? /** @type {Record<string, any>} */ (cur) : {};
    await sessionCache.sessionSet(ACTOR_MAILBOX_KEY, mutate(base));
    // why log (not swallow): a persist failure silently degrades a message to
    // heap-only (P0) durability — surface it so a lost-wake-after-restart is at
    // least explicable in the SW console rather than a mystery.
  }).catch((e) => console.warn('[actor] mailbox persist failed — message is heap-only this SW lifetime', e));
  return mailboxChain;
};
const actorMailbox = {
  append: (/** @type {{ id: string }} */ e) => mailboxUpdate((m) => ({ ...m, [e.id]: e })),
  remove: (/** @type {string} */ id) => mailboxUpdate((m) => { const n = { ...m }; delete n[id]; return n; }),
  // Carry the storage KEY as the entry id so redrain can PRUNE a malformed/legacy
  // value (one missing its own id) under its real key — else it would skip forever
  // and the blob would grow unbounded.
  load: async () => {
    const m = await sessionCache.sessionGet(ACTOR_MAILBOX_KEY);
    if (!m || typeof m !== 'object') return [];
    return Object.entries(/** @type {Record<string, any>} */ (m))
      .map(([k, v]) => (v && typeof v === 'object') ? { ...v, id: v.id ?? k } : { id: k });
  },
};

// Lazily mint a web actor for a tab (the analog of mintActor). No registry
// record + no session-default to bind (id-less engine tools don't apply); the
// only binding is tab→session, persisted so the actor's accumulated memory
// survives an SW restart while the tab lives.
// Shared web-actor session mint. The per-tab actor (mintWebActorForTab) and the
// chat-scoped actor (mintWebActor) differ ONLY in instanceId, the owner source, and
// which binding store they write; the create body (inherited provider/model/permission/
// toolManifest) + the audit append are identical, so they live here ONCE — a new
// inherited field is a one-site edit, not two that can silently drift.
// why inherit the owner chat's tool MANIFEST: a browse-only chat's web actor is held
// to the read DOM tools (+ fetch_url, a read), so the gate refuses click/type for it.
/** @param {{ instanceId: string, ownerChatId: string | null, bind: (sessionId: string) => void, backing?: 'tab' | 'api', actorType?: 'web' | 'dweb', ownedOrigin?: string, provisionalOrigin?: boolean }} o */
const mintWebSession = async ({ instanceId, ownerChatId, bind, backing, actorType = 'web', ownedOrigin, provisionalOrigin }) => {
  const ownerChat = ownerChatId ? await sessions.get(ownerChatId) : null;
  const perm = await resolvePermission(/** @type {any} */ (ownerChat));
  // why: the web actor is peerd's page reader/operator — a narrow, high-frequency,
  // latency-sensitive job that ingests untrusted page content — so it runs on a
  // fast, cheap model (Haiku by default), NOT the chat's stronger, pricier model.
  // resolveRunnerModel: explicit pin → local WebGPU → this provider's fast
  // default (Haiku) → inherit the chat model (''). Engine actors (webvm/notebook/
  // app, via mintActor) are UNCHANGED — they reason about code/shell and keep the
  // chat model.
  const actorProviderName = ownerChat?.provider ?? resolveActiveProvider().name;
  const runnerProvider = listProviders().find((p) => p.name === actorProviderName);
  const webActorModel = resolveRunnerModel({ settings: settingsStore.get(), provider: runnerProvider, localRunner: localRunnerState() });
  const created = await sessions.create({
    kind: 'actor',
    ...(ownerChatId ? { parentSessionId: ownerChatId } : {}),
    instanceId,
    actorType,
    // DESIGN-18: 'api' marks a fetch-only origin actor (no tab); absent = tab backing.
    ...(backing ? { backing } : {}),
    // why actorProviderName (not just ownerChat?.provider): a GLOBAL actor (the
    // dweb actor) has NO owner chat — without this fallback its session carries
    // provider: undefined and every model call dies before the wire.
    ...(actorProviderName ? { provider: actorProviderName } : {}),
    // '' from resolveRunnerModel means "inherit the chat model" — fall back to the
    // owner chat's model, then the active provider's model (the global-actor case).
    ...((webActorModel || ownerChat?.model || resolveActiveProvider().model)
      ? { model: webActorModel || ownerChat?.model || resolveActiveProvider().model } : {}),
    permissionMode: perm.mode,
    confirmActions: perm.confirmActions,
    ...(ownerChat?.toolManifest !== undefined ? { toolManifest: ownerChat.toolManifest } : {}),
    // issue 251 — the mode is decided at MINT, which is the only point that
    // knows why this actor exists. Everything peerd mints today browses on the
    // user's behalf without owning a site, so everything today is ROAMING; a
    // BOUND actor is minted by the handoff path, where the successor's origin
    // is known up front. Tab-backed web actors only: an API actor is already
    // pinned to one origin by its egress wrapper, and the engine kinds and the
    // dweb actor have no tab to land anywhere.
    // BOUND when the mint site knew which origin this actor exists to work on
    // (the handoff path, `site:<origin>`); ROAMING otherwise. Roaming is the
    // weaker of the two — it holds no authority — so the default is the safe one
    // and boundness has to be asked for explicitly.
    ...(actorType === 'web' && backing !== 'api'
      ? {
        originState: ownedOrigin
          // `provisional` marks an origin that was ASKED FOR rather than
          // OBSERVED, so the first landing may settle it onto the site's own
          // www-fold instead of ending. See decideLanding.
          ? { mode: 'bound', ownedOrigin, ...(provisionalOrigin ? { provisional: true } : {}) }
          : { mode: 'roaming' },
      }
      : {}),
  });
  bind(created.sessionId);
  auditLog.append({ type: 'actor_minted', sessionId: created.sessionId, details: { instanceId, kind: actorType, backing: backing ?? 'tab' } }).catch(() => {});
  return created.sessionId;
};

// issue 251 — a PER-TAB actor is minted BOUND to that tab's current origin, not
// roaming, and this is the case the roaming default gets wrong.
//
// A per-tab actor exists because someone addressed a SPECIFIC open page — from
// actor_list, or a tab the orchestrator itself opened, or the page the user is
// looking at right now and just asked about. That page is the job. Roaming would
// mean asking "what is this dashboard showing?" about a site you have an account
// on gets refused on the actor's very first snapshot, with a report explaining
// that helpers browsing the open web may not go where peerd would act as you —
// about the page you are sitting on and explicitly asked about. Adversarial
// review found that; the wiring comment's exemption reasoning ("the user's own
// tab") had quietly assumed the orchestrator reads that page, but the DOM tools
// are actor-only, so every such read goes through this actor.
//
// Binding is also STRICTLY TIGHTER than roaming here, not a carve-out: this
// actor may work on that one origin and is stopped the moment the tab leaves it.
// What it loses is permission to wander, which a tab-addressed actor never
// needed. A tab with no nameable origin (blank, chrome://) gets no ownedOrigin,
// so it adopts on first landing — the ordinary bound path.
const mintWebActorForTab = async (/** @type {number} */ tabId) => {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  const ownedOrigin = tab?.url ? normalizeApiOrigin(originOfTabUrl(/** @type {string} */ (tab.url))) : null;
  return mintWebSession({
    instanceId: String(tabId),
    ownerChatId: /** @type {string | null} */ (await sessionCache.sessionGet('currentSessionId')),
    ...(ownedOrigin ? { ownedOrigin } : {}),
    bind: (sessionId) => { webActorTabBindings.bind(tabId, sessionId); persistWebBindings(); },
  });
};

// Resolve (+ lazy-mint) the web actor that owns `tabId`. FAIL CLOSED: the tab
// must still exist (a web actor with no tab is unreachable, and we must never
// silently retarget a different tab). Re-mints when the bound session vanished
// (SW death cleared session storage) so a live tab is always reachable.
const resolveWebActorForTab = async (/** @type {number} */ tabId) => {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  let actorSessionId = webActorTabBindings.resolve(tabId);
  if (actorSessionId && !(await sessions.get(actorSessionId))) {
    webActorTabBindings.drop(tabId);
    persistWebBindings();
    actorSessionId = null;
  }
  // issue 251 — RE-BIND when the tab has moved on since this actor was minted.
  //
  // A tab actor is BOUND to the origin the tab had when it was first addressed
  // (mintWebActorForTab), which is right for the turn it was addressed in and
  // wrong for every turn after. Without this, a user who reads one page, then
  // browses that same tab somewhere else and asks again, gets a helper bound to
  // the site they LEFT — refused on its first tool call, with a report about a
  // page they are no longer looking at. The binding is durable and the tab is
  // long-lived, so that state persists for as long as the tab does.
  //
  // Addressing a tab is an authorization for THAT TAB AS IT IS NOW, so a fresh
  // addressing re-derives the binding. This does NOT loosen the lock: the
  // re-bind happens only here, between turns, on an explicit address. Inside a
  // turn the actor still cannot leave its origin, which is the property that
  // stops a hijacked page from moving it.
  if (actorSessionId) {
    const rec = await sessions.get(actorSessionId).catch(() => null);
    const owned = /** @type {any} */ (rec)?.originState?.ownedOrigin ?? null;
    const live = tab.url ? normalizeApiOrigin(originOfTabUrl(/** @type {string} */ (tab.url))) : null;
    if (owned && live && owned !== live) {
      webActorTabBindings.drop(tabId);
      persistWebBindings();
      originStates.forget(actorSessionId);
      actorSessionId = null;
    }
  }
  if (!actorSessionId) actorSessionId = await mintOnce(`web:${tabId}`, () => mintWebActorForTab(tabId));
  // why no `name` from the page: a tab's title/url are attacker-CONTROLLED
  // (document.title is page content). resolveActor's `name` flows UN-fenced
  // into the orchestrator's model memory — the deliver() reply lead and the
  // message_actor ack both interpolate it as trusted first-party prose
  // (actor-messaging.js). Sourcing it from the page would open a prompt-
  // injection sink the moment the user messages an actor on a hostile page. A
  // web actor's trusted identity IS its tabId (already the instanceId), so we
  // leave name undefined and the lead/ack render "the web actor 42 …". (Engine
  // actors keep record.name — a user/system label, not page-controlled.)
  return { instanceId: String(tabId), kind: 'web', actorSessionId, tabId };
};

// Lazily mint a CHAT's web actor (the 0-or-1-tab web operator, addressed by `to:'web'`).
// Binds to the OWNER CHAT, not a tab; instanceId is the literal 'web' — non-numeric, so
// the gate's tab-pin refuses any explicit tabId (the actor may only ever drive the tab
// it lazily adopts). Starts with NO tab; adoptWebTab binds one on the render decision.
const mintWebActor = async (/** @type {string} */ ownerChatId) => mintWebSession({
  instanceId: 'web',
  ownerChatId,
  bind: (sessionId) => { webActorRegistry.bind(ownerChatId, sessionId); persistWebActors(); },
});

// Resolve (+ lazy-mint) a chat's web actor. Owns 0-OR-1 tab: its owned tab (if it has
// rendered) is read back from webActorTabBindings.tabFor and threaded as actorTabId —
// undefined in the 0-tab state, where buildToolContext leaves activeTab unset so fetch_url
// works and the DOM tools fail closed (the pin) until navigate adopts a tab. Re-mints when
// the bound session vanished (SW death cleared session storage). The owner is the SENDER
// chat (threaded by the messaging layer), NOT the ambient active chat — equal on the live
// path (the sender gate proves it), but on a boot redrain the focused chat may differ, so
// resolving by sender is what re-attaches a redrained message to its real actor.
const resolveWebActor = async (/** @type {string | null | undefined} */ ownerOverride) => {
  const ownerChatId = ownerOverride ?? /** @type {string | null} */ (await sessionCache.sessionGet('currentSessionId'));
  if (!ownerChatId) return null;
  let actorSessionId = webActorRegistry.resolve(ownerChatId);
  if (actorSessionId && !(await sessions.get(actorSessionId))) {
    webActorRegistry.drop(ownerChatId);
    persistWebActors();
    // issue 251: the durable state died with the record, so the heap copy is now
    // the only thing asserting an owned origin — and the id will be reused by
    // nothing, so keeping it is pure leak. Drop it with the binding.
    originStates.forget(actorSessionId);
    actorSessionId = null;
  }
  if (!actorSessionId) actorSessionId = await mintOnce(`web-actor:${ownerChatId}`, () => mintWebActor(ownerChatId));
  // The owned tab (0-or-1). Verify it still exists — a tab can close between the
  // onRemoved drop and here; if it's gone, fall back to the 0-tab (fetch) state.
  let tabId = webActorTabBindings.tabFor(actorSessionId);
  if (tabId != null && !(await browser.tabs.get(tabId).catch(() => null))) {
    webActorTabBindings.drop(tabId); persistWebBindings(); tabId = undefined;
  }
  // name left undefined (like resolveWebActorForTab): a tab title is page-controlled,
  // and the actor's trusted identity is the literal 'web', not page-derived prose.
  return { instanceId: 'web', kind: 'web', actorSessionId, tabId };
};

// issue 251 — the (chat, origin)→session bindings for SITE actors, the same shape
// and the same ephemerality as the API-actor store next door (a routing cache;
// the durable truth is the session record, reconnected via findActorSession).
// A SEPARATE store rather than a shared one because the two are different actors
// for the same origin — a fetch-only integration and a tab-driving bound helper —
// and collapsing them would make addressing one silently reach the other.
const siteActorBindings = makeApiActorBindings();
const SITE_ACTOR_KEY = 'siteActorBindings';
const persistSiteActors = persistRegistry(SITE_ACTOR_KEY, siteActorBindings);
hydrateRegistry(SITE_ACTOR_KEY, siteActorBindings);

// Mint a SITE actor: a tab-backed web actor BOUND to `origin` from birth.
//
// why the mode is decided HERE and not on first landing: a bound actor with no
// owned origin adopts whatever it lands on first, which is fine for an actor
// somebody deliberately pointed at a site, and NOT fine for the handoff case —
// the whole point there is that the roaming actor was somewhere it shouldn't be,
// so "wherever it ends up" is precisely the wrong thing to trust. Stamping the
// origin at mint means the first landing is CHECKED rather than adopted.
const mintSiteActor = async (/** @type {string} */ ownerChatId, /** @type {string} */ origin) => mintWebSession({
  instanceId: siteHandleFor(origin),
  ownerChatId,
  ownedOrigin: origin,
  // The orchestrator SPELLED this origin from the user's words or its own
  // guess, so it is a request, not an observation — `https://reddit.com` really
  // does land on `https://www.reddit.com`.
  provisionalOrigin: true,
  bind: (sessionId) => { siteActorBindings.bind(ownerChatId, origin, sessionId); persistSiteActors(); },
});

// Resolve (+ lazy-mint) the SITE actor a chat owns for `origin`. Mirrors
// resolveApiActor: reconnect to the durable session on a binding miss before
// minting, so a service-worker death doesn't strand the actor's accumulated
// state — which for a bound actor includes its excursion counters, i.e. part of
// its authority, not just its memory.
const resolveSiteActor = async (/** @type {string} */ origin, /** @type {string | null | undefined} */ ownerOverride) => {
  const ownerChatId = ownerOverride ?? /** @type {string | null} */ (await sessionCache.sessionGet('currentSessionId'));
  if (!ownerChatId) return null;
  const handle = siteHandleFor(origin);
  let actorSessionId = siteActorBindings.resolve(ownerChatId, origin);
  if (actorSessionId && !(await sessions.get(actorSessionId))) {
    siteActorBindings.drop(ownerChatId, origin);
    persistSiteActors();
    originStates.forget(actorSessionId);
    actorSessionId = null;
  }
  if (!actorSessionId) {
    const reconnected = await sessions.findActorSession({ parentSessionId: ownerChatId, instanceId: handle, actorType: 'web' });
    if (reconnected) {
      siteActorBindings.bind(ownerChatId, origin, reconnected);
      persistSiteActors();
      actorSessionId = reconnected;
    }
  }
  if (!actorSessionId) actorSessionId = await mintOnce(`site:${ownerChatId}:${origin}`, () => mintSiteActor(ownerChatId, origin));
  // The owned tab (0-or-1), verified live — same contract as the roaming web
  // actor. With none, the actor is in the 0-tab state and navigate adopts one.
  let tabId = webActorTabBindings.tabFor(actorSessionId);
  if (tabId != null && !(await browser.tabs.get(tabId).catch(() => null))) {
    webActorTabBindings.drop(tabId); persistWebBindings(); tabId = undefined;
  }
  // instanceId IS the handle — it carries a scheme and a colon but no newline or
  // bracket (normalizeApiOrigin canonicalized it), so it is safe in the trusted
  // lead, exactly like the API actor's origin.
  return { instanceId: handle, kind: 'web', actorSessionId, tabId };
};

// DESIGN-18 — lazily mint an API actor (a fetch-only origin actor) for (chat, origin).
// The origin IS the instanceId (the egress boundary reads the owned origin straight off
// the ctx) and backing:'api' scopes its toolset to fetch_url + denies it a tab.
const mintApiActor = async (/** @type {string} */ ownerChatId, /** @type {string} */ origin) => mintWebSession({
  instanceId: origin,
  ownerChatId,
  backing: 'api',
  bind: (sessionId) => { apiActorBindings.bind(ownerChatId, origin, sessionId); persistApiActors(); },
});

// The DWEB ACTOR — the mesh operator: a GLOBAL singleton (one per profile, not
// per chat), addressed by the literal handle 'dweb'. Its session is the durable
// truth (IDB — its peer/publisher ledger is its memory); the binding here is
// just a routing cache (chrome.storage.session), so on a binding miss we
// RECONNECT to the durable session via findActorSession before minting — the
// API-actor pattern, minus the per-chat scoping. Opt-in: resolvable only when
// the network is on AND the user turned the agent on (dwebAgentEnabled).
const DWEB_ACTOR_KEY = 'dwebActorBinding';
let dwebActorSessionId = /** @type {string | null} */ (null);
Promise.resolve(sessionCache.sessionGet(DWEB_ACTOR_KEY))
  .then((v) => { if (typeof v === 'string') dwebActorSessionId = v; })
  .catch(() => {});
const bindDwebActor = (/** @type {string} */ sessionId) => {
  dwebActorSessionId = sessionId;
  sessionCache.sessionSet(DWEB_ACTOR_KEY, sessionId).catch(() => {});
};
const dwebAgentOn = () => DWEB_ENABLED
  && !!settingsStore.get().dwebEnabled && !!settingsStore.get().dwebAgentEnabled;

// Agent-inbox room membership. IDEMPOTENT: maybeStartBaseNetwork fires on every
// unlock/resume, and each raw join op ref-counts the room (dweb-base ensureRoom)
// — so without this guard repeated unlocks leak refs + presence beacons. The
// flag resets when the base host tears down (a fresh SW re-joins cleanly).
let dwebAgentRoomJoined = false;
const joinDwebAgentInbox = async () => {
  if (!dwebAgentOn() || dwebAgentRoomJoined) return;
  const r = /** @type {any} */ (await browser.runtime.sendMessage({
    type: 'dweb/base-host/room', roomId: DWEB_AGENT_ROOM, op: 'join', name: 'peerd agent',
  }).catch(() => null));
  if (r?.ok) { dwebAgentRoomJoined = true; console.log('[sw] dweb agent inbox joined'); }
};
const leaveDwebAgentInbox = async () => {
  if (!dwebAgentRoomJoined) return;
  dwebAgentRoomJoined = false;
  await browser.runtime.sendMessage({ type: 'dweb/base-host/room', roomId: DWEB_AGENT_ROOM, op: 'leave' }).catch(() => {});
  console.log('[sw] dweb agent inbox left');
};
// React to the toggle: joining/leaving the inbox when the user flips the agent
// on/off, so a disable withdraws presence instead of lingering until SW restart.
// Named onSettingsChanged so it wires to the settings route by shorthand (the
// deps-wiring meta-test forbids key:value mis-wires).
const onSettingsChanged = (/** @type {any} */ patch) => {
  if (dwebAgentOn()) joinDwebAgentInbox().catch(() => {});
  else leaveDwebAgentInbox().catch(() => {});
  // Watch mode: react to the TRANSITION, not the state. why: this fires on EVERY
  // settings write, so keying off `settings.watchAgentTab === true` meant picking a
  // model (or nudging any unrelated toggle) hours later teleported the user onto a
  // long-dead agent tab. normalizeSettingsPatch only emits keys the caller actually
  // sent, so the key's PRESENCE here is exactly "the user just touched the toggle".
  if (patch?.watchAgentTab === true) focusAgentTab();
  // Front door: re-mirror the choice into Chrome's native action-click
  // behavior the moment it changes (key PRESENCE = the user just touched it —
  // normalizeSettingsPatch only emits keys the caller actually sent).
  if (patch?.frontDoorView) syncFrontDoorBehavior();
};
// The base host tore down (master OFF) → every room closed, incl. the inbox, so
// clear the SW-side membership flag for a clean re-join on the next start.
const onBaseNetworkStopped = () => { dwebAgentRoomJoined = false; };
const mintDwebActor = async () => {
  // A GLOBAL actor has no owner chat to inherit a provider from, and the sync
  // resolveActiveProvider mintWebSession falls back to returns 'anthropic'
  // UNCONDITIONALLY (never checking key/daemon readiness) — so an Ollama-only or
  // just-keyed-OpenRouter user who enables the agent before their first chat
  // would get a keyless-anthropic session that fails every wake. ensureActiveProvider
  // (async) picks + persists the first USABLE provider, exactly as a fresh chat
  // does; after it runs, mintWebSession's sync fallback reads the good providerName.
  await ensureActiveProvider().catch(() => {});
  return mintWebSession({
    instanceId: 'dweb',
    ownerChatId: null,          // global — no parent chat; replies target the SENDER
    actorType: 'dweb',
    bind: bindDwebActor,
  });
};
const resolveDwebActor = async () => {
  if (!dwebAgentOn()) return null;
  let actorSessionId = dwebActorSessionId;
  if (actorSessionId && !(await sessions.get(actorSessionId))) actorSessionId = null;
  if (!actorSessionId) {
    // binding cache miss (SW/browser restart) → reconnect to the durable session
    const durable = await sessions.findActorSession({ instanceId: 'dweb', actorType: 'dweb' });
    if (durable) { bindDwebActor(durable); actorSessionId = durable; }
  }
  if (!actorSessionId) actorSessionId = await mintOnce('dweb-actor', () => mintDwebActor());
  return { instanceId: 'dweb', kind: 'dweb', actorSessionId };
};

// ── The dweb agent's INBOX ──────────────────────────────────────────────────
// Inbound mesh messages for THIS browser's agent arrive on the reserved agent
// room (a normal sub-protocol room — no new transport) and reach the SW as the
// same dweb/base-room/event push the dwapp bridge uses; we consume only our
// roomId. Every wake is INBOUND (synthetic && !trusted): the actor may observe,
// use its own dweb tools (ledger, block), and report — it can never delegate.
// why rate caps HERE (not in the actor): a cap must bind before a model call
// spends money; the actor's loop is the thing being protected.
const DWEB_AGENT_ROOM = 'peerd-agent';
const DWEB_AGENT_NO_REPORT = 'NO_REPORT';
// Inbound wake rate cap (background/dweb-inbound-rate-cap.js): 3/min per did +
// 30/hour global, bound BEFORE any model call so a Sybil peer can't drain budget.
const { allow: dwebInboundAllowed } = makeDwebInboundRateCap();

// ── A2A: the agent-to-agent mesh dispatch (the a2a_run code surface) ─────────
// ONE dispatch instance (state: pending asks) wired to real mesh IO on the
// peerd-agent room. The a2a/call route (from the sealed a2a_run worker, relayed)
// translates the mesh call, resolves per-did CONSENT for signing ops, and runs
// it here. handleInbound (below) feeds inbound DMs in so a reply resolves a
// pending ask. why a SW singleton: an ask sent from a worker run must still
// resolve when the reply lands AFTER that op returned — the pending map lives here.
const A2A_APPROVED_KEY = 'a2aApprovedDids';
// The consent target for publishCard: it broadcasts the user's OWN card (no peer
// did), so it can't key on a peer. A fixed sentinel gives it its own allowlist
// entry — approve "advertise my card" once, revoke it the same way as a peer.
const A2A_PUBLISH_CARD_KEY = 'self:publishCard';
/** @type {Set<string>} dids (+ the publishCard sentinel) the user has cleared. */
const a2aApprovedDids = new Set();
Promise.resolve(sessionCache.sessionGet(A2A_APPROVED_KEY))
  .then((v) => { if (Array.isArray(v)) for (const d of v) a2aApprovedDids.add(d); })
  .catch(() => {});
const a2aApprove = (/** @type {string} */ did) => {
  a2aApprovedDids.add(did);
  sessionCache.sessionSet(A2A_APPROVED_KEY, [...a2aApprovedDids]).catch(() => {});
};
// Revoke a first-contact grant (wired into dweb_block): blocking a peer must also
// withdraw its permission to be MESSAGED, else a blocked did stays talk-approved.
// This is the escape hatch for the grant — a peer approval is not permanent.
const a2aRevoke = (/** @type {string} */ did) => {
  if (!a2aApprovedDids.delete(did)) return;
  sessionCache.sessionSet(A2A_APPROVED_KEY, [...a2aApprovedDids]).catch(() => {});
};
// FIRST-CONTACT consent = a revocable ALLOWLIST decision (who my agent may talk
// to / that it may advertise me), NOT a per-action confirm. why it persists: the
// user is shown the exact target and deliberately clears it, like adding a
// contact; it lives in chrome.storage.session (cleared on browser restart) and is
// revocable via dweb_block. Already-cleared → silent; else pop the confirm.
const a2aResolveConsent = async (/** @type {string} */ target, /** @type {string} */ sessionId, /** @type {string} */ op = 'message') => {
  if (a2aApprovedDids.has(target)) return true;
  const answer = await confirmAction({ tool: 'a2a_contact', sessionId, origins: [target] });
  // "Allow for session" adds the peer to the revocable allowlist (silent after —
  // the intended contact-add); "Allow once" authorizes THIS call only and is NOT
  // persisted, so a one-time click can't become a standing signing grant. The
  // { ok, persist } split is the pure a2aConsentOutcome (background/a2a-consent.js).
  const { ok, persist } = a2aConsentOutcome(answer);
  if (persist) a2aApprove(target);
  auditLog.append({ type: 'a2a_consent', details: { target, op, approved: ok, standing: persist } }).catch(() => {});
  return ok;
};
const meshHostRoom = (/** @type {object} */ payload) =>
  browser.runtime.sendMessage({ type: 'dweb/base-host/room', roomId: DWEB_AGENT_ROOM, ...payload });
// Standing peer conversations (conversation-registry.js): the SW-side thread
// store, sibling to meshDispatch's pending-ask map. converse/say open + extend
// threads; an inbound turn carrying a known convId continues one (waking the
// actor with prior turns as context) and the actor's answer goes BACK to the
// peer under PER-CONVERSATION reply consent.
const conversationRegistry = createConversationRegistry();
const meshDispatch = makeMeshDispatch({
  sendDm: async (to, env) => { const r = /** @type {any} */ (await meshHostRoom({ op: 'dm', to, data: env }).catch(() => null)); return { ok: r?.ok === true, id: r?.id, error: r?.error }; },
  listPeers: async () => { const r = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'dweb/base-host/peers' }).catch(() => null)); return Array.isArray(r?.peers) ? r.peers.map((/** @type {any} */ p) => ({ did: p.did, name: p.name })) : []; },
  fetchCard: async (did) => { const r = /** @type {any} */ (await meshHostRoom({ op: 'card-get', did }).catch(() => null)); return r?.ok ? (r.card ?? null) : null; },
  publishCard: async (card) => { const r = /** @type {any} */ (await meshHostRoom({ op: 'card-set', card }).catch(() => null)); return { ok: r?.ok === true, did: r?.did, error: r?.error }; },
  conversations: conversationRegistry,
});

// Per-CONVERSATION reply consent (the owner-chosen gate for the new outbound
// edge). Replying to a peer on a standing thread needs the user's ok ONCE per
// thread; after that it flows for that thread's life, and dweb_block revokes it
// (closeDid drops the thread). Mirrors a2a first-contact, keyed by convId.
const resolveReplyConsent = async (/** @type {string} */ convId, /** @type {string} */ did, /** @type {string} */ sessionId) => {
  if (conversationRegistry.hasReplyConsent(convId)) return true;
  const answer = await confirmAction({ tool: 'a2a_reply', sessionId, origins: [did] });
  const granted = answer === 'yes_once' || answer === 'yes_session';
  // "Allow for session" grants the thread standing reply consent; "Allow once"
  // permits THIS reply only (no registry grant), so a one-off can't become a
  // standing back-channel.
  if (answer === 'yes_session') conversationRegistry.grantReplyConsent(convId);
  auditLog.append({ type: 'a2a_reply_consent', details: { did, convId, approved: granted, standing: answer === 'yes_session' } }).catch(() => {});
  return granted;
};

// The actors/call route — invoked by the offscreen relay for each `actors.*`
// call an actors-enabled `script` run makes. ownerSessionId / ownerToolUseId /
// runId are TRUSTED (job params, minted by the script tool SW-side); the
// worker's own words buy nothing. Every delegation runs the FULL messageActor
// gate chain (sender gate, rate caps, duplicate-intent, oneShot sandbox-only,
// audit) — this route adds only translation, the per-ask timeout, the Stop
// chain, and the live per-op feed the side panel renders on the script card.
const actorsCallRoute = async (/** @type {{ method?: string, args?: any, ownerSessionId?: string, ownerToolUseId?: string, runId?: string, seq?: number }} */ msg) => {
  const pushOp = (/** @type {string} */ phase, /** @type {object} */ extra = {}) => {
    try {
      uiPorts.broadcast({
        type: 'script/op',
        sessionId: msg.ownerSessionId, toolUseId: msg.ownerToolUseId ?? null,
        seq: msg.seq ?? 0, method: msg.method ?? '?', phase, ...extra,
      });
    } catch { /* panel closed — the trace in the result still records it */ }
  };
  try {
    const owner = msg.ownerSessionId ? await sessions.get(msg.ownerSessionId) : null;
    // v1 is the ORCHESTRATOR's surface only: a top-level chat session. An
    // actor must never delegate (the recursion rule message_actor already
    // enforces), and an actor's channel is its own message_actor grant.
    if (!owner || owner.kind === 'actor' || owner.kind === 'spawned') {
      return { ok: false, error: 'actors: only a chat session holds the script delegation surface' };
    }
    // why no inbound re-check HERE: the inbound (untrusted-origin) wall for this
    // path is enforced at the trusted MINT — script.js refuses to expose the
    // `actors` surface at all when ctx.inbound === true (folded SW-side by the
    // turn driver), so an inbound turn never reaches this route with an actors
    // op. inbound is a per-TURN property the untrusted worker cannot be trusted
    // to echo, so the mint is the only sound enforcement point; do NOT accept an
    // inbound flag off the relay message here.
    const { op, args } = actorsCallToOp({ method: msg.method, args: msg.args });
    if (op === 'list') {
      // The roster through the normal tool gates — actor_list with the owner's
      // main ctx, so exposure/manifest rules apply exactly as a direct call.
      const listCtx = await buildToolContext({ exposure: 'main', sessionId: msg.ownerSessionId });
      const r = await dispatchToolCall({ id: `${msg.runId ?? 'script'}-list-${msg.seq ?? 0}`, name: 'actor_list', args: {} }, /** @type {any} */ (listCtx));
      return r?.ok
        ? { ok: true, value: shapeActorsResult('list', { ok: true, roster: /** @type {any} */ (r).content }) }
        : { ok: false, error: /** @type {any} */ (r)?.error ?? 'actor_list failed' };
    }
    const target = /** @type {{ to: string, goal: string, timeoutMs?: number, oneShot?: boolean }} */ (args);
    // The UI preview: a chained goal can carry actor/web-derived bytes, so
    // collapse whitespace (no line-shaping) and cap — it renders as plain
    // text (Mithril escapes), same posture as the sanitized actor names.
    const goalPreview = target.goal.replace(/\s+/g, ' ').slice(0, 60);
    pushOp('sent', { to: target.to, goalPreview });
    // The SW-side op mirror: survives an offscreen crash, so the script tool's
    // failure path can still show the chain of events (script-runs.js).
    const mirror = (/** @type {Record<string, unknown>} */ opRecord) => {
      if (typeof msg.runId === 'string') scriptRuns.recordOp(msg.runId, { seq: msg.seq ?? 0, method: msg.method, to: target.to, ...opRecord });
    };
    if (op === 'send') {
      const r = await actorMessaging.messageActor({
        to: target.to, message: target.goal, senderSessionId: msg.ownerSessionId,
        toolUseId: msg.ownerToolUseId, oneShot: target.oneShot === true, via: 'script',
      });
      pushOp(r.ok ? 'handed-off' : 'failed', r.ok ? {} : { error: 'refused' });
      mirror({ ok: r.ok === true, ms: 0, ...(r.ok ? {} : { error: r.error }) });
      return r.ok
        ? { ok: true, value: shapeActorsResult('send', { ok: true }) }
        : { ok: false, error: r.error ?? 'send failed' };
    }
    // ask — awaitReply, raced against the per-ask timeout AND the run's Stop
    // signal (script-runs.js). Either abort cancels the underlying actor turn.
    const askTimeoutMs = target.timeoutMs ?? ACTORS_ASK_DEFAULT_TIMEOUT_MS;
    const runSignal = typeof msg.runId === 'string' ? scriptRuns.signalFor(msg.runId) : null;
    const askController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; askController.abort(); }, askTimeoutMs);
    const onRunAbort = () => askController.abort();
    if (runSignal) {
      if (runSignal.aborted) askController.abort();
      else runSignal.addEventListener('abort', onRunAbort, { once: true });
    }
    try {
      const t0 = Date.now();
      const r = await actorMessaging.messageActor({
        to: target.to, message: target.goal, senderSessionId: msg.ownerSessionId,
        toolUseId: msg.ownerToolUseId, oneShot: target.oneShot === true, via: 'script',
        // bareReply: the reply resolves into CODE — the fence is re-applied at
        // the script-result boundary (the one model-facing seam), so the raw
        // body is what plumbing composes with (no fence markup in goals).
        awaitReply: true, bareReply: true, awaitSignal: askController.signal,
      });
      const ms = Date.now() - t0;
      // The timeout / Stop-abort / system-refusal / actor-failure fork is the
      // pure askOutcome (actors-api.js) — provable without this route.
      const outcome = askOutcome(/** @type {any} */ (r), {
        timedOut, aborted: !timedOut && askController.signal.aborted,
        timeoutMs: askTimeoutMs, to: target.to,
      });
      if (!outcome.ok) {
        pushOp('failed', { ms, error: timedOut ? 'timeout' : 'refused' });
        mirror({ ok: false, ms, error: outcome.error });
        return { ok: false, error: outcome.error };
      }
      pushOp('replied', { ms, ...(outcome.failed ? { failed: true } : {}) });
      mirror({ ok: true, ms, ...(outcome.failed ? { actorFailed: true } : {}) });
      return { ok: true, value: shapeActorsResult('ask', { ok: true, reply: outcome.reply, failed: outcome.failed }) };
    } finally {
      clearTimeout(timer);
      if (runSignal) { try { runSignal.removeEventListener?.('abort', onRunAbort); } catch { /* stub */ } }
    }
  } catch (e) {
    // A throw after pushOp('sent') would otherwise leave the live-feed line
    // pulsing 'working…' forever — settle it, then report.
    pushOp('failed', { error: 'error' });
    return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
  }
};

// Design 5's session cost fold, SERIALIZED per session. why a chain: the
// sub-call route below is the first caller that is concurrent with ITSELF by
// design (a script can Promise.all its provider.call fan-out), and a bare
// get→setCost read-modify-write interleaves — two folds read the same tally
// and the later write drops the earlier call's spend from the very tally the
// spend-limit preflight reads. Entries self-evict once their chain drains.
/** @type {Map<string, Promise<void>>} */
const sessionCostFoldTails = new Map();
const foldSessionCost = (/** @type {string} */ sessionId, /** @type {any} */ usage, /** @type {number} */ cost) => {
  const tail = (sessionCostFoldTails.get(sessionId) ?? Promise.resolve())
    .then(async () => {
      const fresh = await sessions.get(sessionId);
      await sessions.setCost(sessionId, addUsage(normalizeTally(fresh?.cost), usage, cost));
    })
    .catch(() => { /* a persist hiccup must not fail the call */ });
  sessionCostFoldTails.set(sessionId, tail);
  tail.then(() => { if (sessionCostFoldTails.get(sessionId) === tail) sessionCostFoldTails.delete(sessionId); });
  return tail;
};

// The script/model-call route (design 5) — invoked by the offscreen relay for
// each peerd.provider.call a provider-enabled `script` run makes. The custody
// shape is actor/model-call's: getSecret + safeFetch are added HERE, so the
// key never enters the worker or the offscreen document; ownerSessionId/runId
// are TRUSTED job params (minted by the script tool SW-side) — the worker's
// own words buy nothing. On top of that custody this route adds: the live-run
// owner check, text-only arg validation, the per-run quota, the session
// provider PIN + model gate, the spend-limit preflight, the cost fold, and the
// Stop chain (the run's abort signal cancels an in-flight provider fetch).
const scriptModelCallRoute = async (/** @type {{ ownerSessionId?: string, runId?: string, args?: unknown }} */ msg) => {
  try {
    const owner = msg.ownerSessionId ? await sessions.get(msg.ownerSessionId) : null;
    // Same posture as actors/call: v1 is the ORCHESTRATOR's surface only. An
    // actor or spawned owner is refused even if a job param leaked — the
    // sub-call lane must never hand a fenced context the user's paid key.
    if (!owner || owner.kind === 'actor' || owner.kind === 'spawned') {
      return { ok: false, error: 'provider: only a chat session holds the sub-call surface' };
    }
    // The LIVE-RUN check: the runId must be registered (script-runs.js) and
    // bound to this owner — a call from a dead or foreign run is refused.
    const runId = typeof msg.runId === 'string' ? msg.runId : '';
    if (!runId || scriptRuns.ownerFor(runId) !== msg.ownerSessionId) {
      return { ok: false, error: 'provider: unknown or finished run' };
    }
    /** @type {ReturnType<typeof validateProviderCallArgs>} */
    let call;
    try { call = validateProviderCallArgs(msg.args); }
    catch (e) { return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) }; }
    // Quota BEFORE the call, counted before it flies (script-runs.js) —
    // overflow is a structured refusal the script can catch and degrade on
    // (ProviderQuotaError message), never a worker kill.
    const quotaRefusal = providerQuotaError(scriptRuns.providerUsageFor(runId));
    if (quotaRefusal) return { ok: false, error: quotaRefusal.message };
    // Spend-limit preflight — cheap-call's posture: sub-calls spend against
    // the OWNING session, so a session past the user's hard cap must not be
    // pushed further by its own script.
    // why no reservation: this reads owner.cost per-invocation with no hold, so
    // a concurrent fan-out can collectively overshoot the limit between the read
    // and each fold. That is DELIBERATE — the USD limit is a coarse safety lever,
    // not a ledger; the tight bound on a single run's spend is the per-run
    // call/token quota above (recordProviderCall), which the fan-out cannot dodge.
    const spendLimit = settingsStore.get().spendLimitUsd;
    if (limitExceeded(normalizeTally(owner.cost).cost, spendLimit)) {
      return { ok: false, error: `provider quota exceeded: the session spend limit ($${spendLimit}) is reached` };
    }
    // The session PIN: the endpoint is ALWAYS the owning session's provider
    // adapter — there is no provider arg, and an explicit `model` only picks a
    // model WITHIN it. That is design 5's "cannot name an arbitrary endpoint"
    // enforced by construction (registry.js resolves the adapter by name).
    const provider = owner.provider;
    const providerEntry = listProviders().find((p) => p.name === provider);
    if (!providerEntry) {
      return { ok: false, error: `provider: session provider not registered: ${provider}` };
    }
    const localProvider = !!providerEntry.keyless;
    const pricingOverrides = /** @type {any} */ (settingsStore.get().pricingOverrides);
    // The MODEL gate (design 5: an explicit model arg "must resolve within the
    // user's configured providers or is refused"): a worker-chosen id must be
    // the session's own model or one with a LOCAL RATE CARD (built-in table or
    // Settings override). why pricing as the resolver: costOf() prices an
    // unknown id at $0, so an unpriced model would spend real credits that the
    // cost tally — and therefore the spend-limit preflight above — never sees.
    // A keyless (local) provider genuinely costs $0 for any id, so it is
    // exempt by the same rule.
    const model = call.model || owner.model;
    if (call.model && call.model !== owner.model && !localProvider && !hasPricing(call.model, pricingOverrides)) {
      return { ok: false, error: `provider.call: unknown model '${call.model}' — use the session's model, or an id with a rate card (Settings → pricing overrides)` };
    }
    // Abort rides the RUN's controller (script-runs.js): Stop chains into it,
    // and release() aborts it when the run ends — either kills this fetch.
    const runSignal = scriptRuns.signalFor(runId);
    if (runSignal?.aborted) return { ok: false, error: 'aborted' };
    // Admission counts the call AND reserves its clamped maxTokens against the
    // run's output meter (settled to the actual bill below) — so a concurrent
    // fan-out is bounded by the run ceiling, not just the per-call clamp.
    scriptRuns.recordProviderCall(runId, call.maxTokens);
    /** @type {any[]} */
    const events = [];
    /** @type {string | undefined} */
    let streamError;
    try {
      // The context inspector sees the sub-call like every delegated model
      // call; identity from the trusted params, never a worker claim.
      contextSnapshots.record({
        provider, model, system: call.system ?? '', messages: call.messages,
        maxTokens: call.maxTokens, sessionId: msg.ownerSessionId, label: 'script:sub-call',
      });
      for await (const ev of callModel(/** @type {any} */ ({
        provider, model, system: call.system ?? '', messages: call.messages,
        maxTokens: call.maxTokens, signal: runSignal ?? undefined, getSecret, safeFetch,
        // issue #104: a remote Ollama daemon — same threading as turn-driver.
        ollamaHost: settingsStore.get().ollamaHost,
      }))) events.push(ev);
    } catch (e) {
      // A stream that THROWS mid-iteration (an aborted fetch, a network cut)
      // may already have yielded billed usage events — capture the error and
      // fall through to the same fold/cost path an error-EVENT stream takes,
      // so no billed tokens escape the meter or the tally.
      streamError = runSignal?.aborted ? 'aborted' : (/** @type {{ message?: string }} */ (e)?.message ?? String(e));
    }
    const folded = foldProviderEvents(events);
    scriptRuns.settleProviderCall(runId, call.maxTokens, folded.usage?.outputTokens ?? 0);
    // ONE usage shape on every return path — the job-runner meter sums
    // input+output; cache-token detail stays inside the cost fold.
    const usage = folded.usage ? { inputTokens: folded.usage.inputTokens, outputTokens: folded.usage.outputTokens } : null;
    // Cost: fold ANY usage — an errored stream's billed tokens are still
    // billed. Same fold as cheap-call: price locally, add into the owning
    // session's persisted tally (the cost meter + next turn's hard-limit
    // check see it), audit the sub_call so money moving leaves a record.
    if (folded.usage) {
      let cost = 0;
      try { cost = costOf(/** @type {any} */ (model), folded.usage, pricingOverrides, { localProvider })?.cost ?? 0; }
      catch { cost = 0; }
      await foldSessionCost(/** @type {string} */ (msg.ownerSessionId), folded.usage, cost);
      auditLog.append({
        type: 'provider_sub_call', sessionId: msg.ownerSessionId,
        details: { runId, provider, model, outputTokens: folded.usage.outputTokens, cost },
      }).catch(() => {});
    }
    // A Stop that fired mid-stream must never deliver a completed answer, even
    // if the provider flushed before the abort landed (actor/model-call's race
    // guard 2, same reasoning).
    if (runSignal?.aborted) return { ok: false, error: 'aborted', ...(usage ? { usage } : {}) };
    if (streamError) return { ok: false, error: streamError, ...(usage ? { usage } : {}) };
    if (folded.error) return { ok: false, error: folded.error, ...(usage ? { usage } : {}) };
    return {
      ok: true,
      value: {
        text: folded.text, model,
        // stopReason surfaces truncation: a maxTokens-clipped generation
        // ('max_tokens') must be distinguishable from a complete answer on a
        // surface whose per-call clamp is this tight.
        ...(folded.stopReason !== undefined ? { stopReason: folded.stopReason } : {}),
        ...(usage ? { usage } : {}),
      },
    };
  } catch (e) {
    return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
  }
};

// The a2a/call route — invoked by the offscreen relay for each mesh call the
// a2a_run worker makes. ownerSessionId is TRUSTED (job param); we verify it is
// THE dweb actor before touching the mesh, translate + gate + dispatch.
const a2aCallRoute = async (/** @type {{ method?: string, args?: any, ownerSessionId?: string }} */ msg) => {
  try {
    if (!dwebAgentOn()) return { ok: false, error: 'a2a: the dweb agent is off' };
    const owner = msg.ownerSessionId ? await sessions.get(msg.ownerSessionId) : null;
    if (!owner || owner.kind !== 'actor' || owner.actorType !== 'dweb') {
      return { ok: false, error: 'a2a: not the dweb actor' };
    }
    const { op, args, signs } = meshCallToOp({ method: msg.method, args: msg.args });
    // Every signing op needs a cleared CONSENT TARGET before it emits onto the
    // mesh as the user. Per-peer ops (ask/send) key on the peer's did; publishCard
    // has NO peer — it broadcasts the user's own card — so it keys on a fixed
    // sentinel. Fail CLOSED: an op with signs=true and no resolvable target, or a
    // declined prompt, is refused here (the dispatch's did-gate can't see the
    // no-did publishCard, so enforcement must land in this route).
    if (signs) {
      // Per-peer ops key on the peer's did; publishCard broadcasts the user's
      // own card (no peer) so it keys on a sentinel; `say` carries only a convId,
      // so resolve its thread's did — proactively continuing a thread is still
      // messaging that peer and needs the same cleared target.
      const consentTarget = op === 'publishCard'
        ? A2A_PUBLISH_CARD_KEY
        : op === 'say'
          ? conversationRegistry.didFor(/** @type {{ convId?: string }} */ (args).convId ?? '')
          : /** @type {{ did?: string }} */ (args).did;
      if (!consentTarget) return { ok: false, error: `a2a: ${op} has no consent target` };
      if (!a2aApprovedDids.has(consentTarget)) {
        const approved = await a2aResolveConsent(consentTarget, msg.ownerSessionId ?? '', op);
        if (!approved) return { ok: false, error: `a2a: the user declined ${op} to ${consentTarget}` };
      }
    }
    const opResult = await meshDispatch.dispatch(op, args, { signs, allowed: (did) => a2aApprovedDids.has(did) });
    return { ok: true, value: shapeMeshResult(msg.method ?? '', opResult) };
  } catch (e) {
    return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
  }
};

const handleDwebAgentInbound = (/** @type {{ from?: string, data?: unknown, ts?: number }} */ evt) => {
  if (!dwebAgentOn() || vault.isLocked()) return;           // opt-out or locked → drop
  const did = typeof evt?.from === 'string' ? evt.from : 'unknown';
  // A2A routing FIRST: an inbound a2a REPLY resolves a pending ask and is
  // consumed (never a wake); an a2a ask/tell falls through to the fenced wake
  // below (the actor sees a peer's request). A non-a2a DM also falls through.
  const routed = meshDispatch.handleInbound(did, evt?.data);
  if (routed.consumed) return;
  if (!dwebInboundAllowed(did)) {
    auditLog.append({ type: 'dweb_agent_rate_capped', details: { did } }).catch(() => {});
    return;
  }
  // Standing conversation? An inbound ask/tell carrying a convId continues a
  // thread: adopt it (a convId is a bearer token — adopt() rejects a foreign
  // did), record the peer's turn, and later reply BACK to the peer instead of
  // only noting the user. deliver is the pure handleInbound output.
  const deliver = routed.deliver;
  // Cap the wire convId (a peer controls it; an unbounded key is a memory sink).
  const rawConvId = typeof deliver?.convId === 'string' ? deliver.convId : null;
  const convId = rawConvId && rawConvId.length <= 128 ? rawConvId : null;
  // ADOPT BEFORE the gate, and only record the peer turn when the thread is
  // OURS to extend. adopt() binds convId→did (rejecting a foreign did), so a
  // fresh thread is owned by this sender and record() extends it; a convId
  // owned by ANOTHER did is refused here — record() has no did check of its
  // own, so this is where the bearer-token invariant is enforced for inbound.
  let ownsThread = false;
  if (convId && deliver) {
    conversationRegistry.adopt(convId, did);
    ownsThread = conversationRegistry.ownedBy(convId, did);
    if (ownsThread) conversationRegistry.record(convId, 'peer', deliver.message);
  }
  // Reply back only on an OWNED ask thread — computed AFTER adopt so a peer's
  // first converse turn (a fresh thread) can still be answered.
  const canReplyToPeer = ownsThread && deliver?.kind === 'ask';
  const body = typeof evt?.data === 'string' ? evt.data : JSON.stringify(evt?.data ?? null);
  auditLog.append({ type: 'dweb_agent_inbound', details: { did, chars: body.length, ...(convId ? { convId } : {}) } }).catch(() => {});
  (async () => {
    const actor = await resolveDwebActor();
    if (!actor) return;
    const fenced = wrapUntrusted({ origin: did, tool: 'mesh_inbound', body: body.slice(0, 16 * 1024) });
    // On a standing thread, hand the actor the recent turns (fenced — they carry
    // peer bytes) so it answers in context, and steer it to reply to the PEER.
    // Thread context only for a thread WE own (ownsThread) — a foreign convId
    // must not pull another peer's turns into this wake.
    const priorTurns = ownsThread ? conversationRegistry.turnsFor(/** @type {string} */ (convId)).slice(0, -1) : [];
    const threadContext = priorTurns.length
      ? `\n\nEarlier turns in this conversation (oldest first):\n${wrapUntrusted({ origin: did, tool: 'mesh_thread', body: priorTurns.map((t) => `${t.role === 'self' ? 'you' : 'peer'}: ${t.message}`).join('\n') })}`
      : '';
    const wake = canReplyToPeer
      ? `A mesh peer is having an ongoing conversation with your agent (their did is in the fence origin). Read their latest message and the thread, then END with either ${DWEB_AGENT_NO_REPORT} or a one-paragraph reply to send back to the PEER.${threadContext}\n\n${fenced}`
      : `A mesh peer sent your agent a direct message (their did is in the fence origin). Observe it, update your ledger, block if abusive, and END with either ${DWEB_AGENT_NO_REPORT} or a one-paragraph note for the user.\n\n${fenced}`;
    turnSlots.runWhenIdle(actor.actorSessionId, () => {
      (async () => {
        const before = ((await sessions.get(actor.actorSessionId))?.messages ?? []).length;
        // HEAP ISOLATION: the inbound wake feeds LIVE untrusted peer bytes to the
        // actor's reasoning, so it MUST run in the offscreen keyless worker like
        // every other actor turn — never in-SW alongside the vault DK. Mirror the
        // message_actor path: offscreen first, fall back to the in-SW driver only
        // where offscreen is unavailable (Firefox). runActorTurnOffscreen claims
        // the slot itself; we're already inside runWhenIdle, so no double-claim.
        const off = await runActorTurnOffscreen({
          actorSessionId: actor.actorSessionId, message: wake,
          instanceId: 'dweb', kind: 'dweb', oneShot: false, display: null,
        });
        if (!off) {
          // INBOUND: synthetic + NOT trusted — the sender gate refuses any delegation
          // from this turn; the tier gate holds it to the dweb toolset.
          await runAgentTurn({ sessionId: actor.actorSessionId, userText: wake, synthetic: true, trusted: false });
        }
        const s = await sessions.get(actor.actorSessionId);
        const note = off?.result ?? finalAssistantText(/** @type {any} */ ({ messages: (s?.messages ?? []).slice(before) })) ?? '';
        // Trickle up ONLY the notable: the lore's stay-quiet default is enforced
        // here by the NO_REPORT convention — silence costs the user nothing.
        if (!note.trim() || note.includes(DWEB_AGENT_NO_REPORT)) return;
        // STANDING CONVERSATION: the actor's answer goes BACK to the peer, gated
        // by per-conversation reply consent (the owner's chosen gate for this new
        // outbound edge). On grant, record the self turn and send the mesh reply;
        // a decline falls through to the user note so the answer isn't lost.
        if (canReplyToPeer) {
          const cid = /** @type {string} */ (convId);
          const consented = await resolveReplyConsent(cid, did, actor.actorSessionId);
          if (consented) {
            conversationRegistry.record(cid, 'self', note);
            meshDispatch.reply(did, /** @type {any} */ (deliver).reqId, note, cid);
            auditLog.append({ type: 'a2a_reply_sent', details: { did, convId } }).catch(() => {});
            return;
          }
        }
        const active = /** @type {string | null} */ (await sessionCache.sessionGet('currentSessionId'));
        if (!active) return;
        const lead = 'Your dweb agent flagged inbound mesh activity:';
        const userText = `${lead}\n\n${wrapUntrusted({ origin: 'dweb', tool: 'message_actor', body: note })}`;
        // runWhenIdle on the ACTIVE chat — NEVER steer-abort the user's live turn
        // (DECISIONS #20 work-theft; the deliver() path guards the same way). The
        // note is a fenced, untrusted-derived summary, so trusted:false — a mesh
        // event must not hand the orchestrator delegation authority.
        turnSlots.runWhenIdle(active, () => {
          runAgentTurn({
            sessionId: active, userText, synthetic: true, trusted: false,
            actorReply: { kind: 'dweb', instanceId: 'dweb', failed: false },
          }).catch((e) => console.warn('[sw] dweb agent trickle-up failed', e));
        });
      })().catch((e) => console.warn('[sw] dweb agent inbound wake failed', e));
    });
  })().catch(() => {});
};

browser.runtime.onMessage.addListener((/** @type {any} */ msg) => {
  if (msg?.type === 'dweb/base-room/event' && msg.roomId === DWEB_AGENT_ROOM && msg.event === 'direct') {
    handleDwebAgentInbound(msg.data ?? {});
  }
  return false;   // never claims the message — the dwapp bridge path is untouched
});

// Resolve (+ lazy-mint) the API actor a chat owns for `origin`. The integration
// AUTO-FORMS on first address (the same lazy-mint shape as the web actor). Re-mints when
// the bound session vanished (SW death cleared session storage). Owner is the SENDER chat
// (threaded by the messaging layer) so a boot redrain re-attaches to the right integration.
const resolveApiActor = async (/** @type {string} */ origin, /** @type {string | null | undefined} */ ownerOverride) => {
  const ownerChatId = ownerOverride ?? /** @type {string | null} */ (await sessionCache.sessionGet('currentSessionId'));
  if (!ownerChatId) return null;
  let actorSessionId = apiActorBindings.resolve(ownerChatId, origin);
  if (actorSessionId && !(await sessions.get(actorSessionId))) {
    apiActorBindings.drop(ownerChatId, origin);
    persistApiActors();
    actorSessionId = null;
  }
  // DESIGN-18: RECONNECT before minting. The (chat,origin) binding is ephemeral
  // (chrome.storage.session, cleared on browser restart), but an API actor's MEMORY is
  // its only state and lives durably on the session record. On a binding miss, find the
  // existing durable actor for (this chat, this origin) and re-bind to it — so re-opening
  // a chat and re-addressing the origin resumes the accumulated memory instead of minting
  // empty. (A tab actor needs none of this — it re-derives from the live DOM.)
  if (!actorSessionId) {
    const reconnected = await sessions.findActorSession({ parentSessionId: ownerChatId, instanceId: origin, actorType: 'web', backing: 'api' });
    if (reconnected) {
      apiActorBindings.bind(ownerChatId, origin, reconnected);
      persistApiActors();
      actorSessionId = reconnected;
    }
  }
  if (!actorSessionId) actorSessionId = await mintOnce(`api:${ownerChatId}:${origin}`, () => mintApiActor(ownerChatId, origin));
  // instanceId IS the origin — non-numeric, non-'web', so the gate's tab-pin never
  // fires and deliver() names it "The <origin> integration". The origin is canonical
  // (URL.origin), so it carries no newline/bracket into the trusted lead — safe un-fenced.
  return { instanceId: origin, kind: 'web', actorSessionId };
};

// The render-decision hook: a web actor in the 0-tab state OPENS its tab here (called
// from navigate via ctx.adoptWebTab when the actor owns no tab). Opens BLANK in the
// BACKGROUND (never yanks the user's focus — the actor-stays-in-background policy);
// navigate then drives it to the URL with its normal wait. Binds tab→actor in
// webActorTabBindings (so the next turn pins it, and `to:'<tabId>'` reaches the SAME
// actor), and tracks it as an agent-tab card. Returns the new tab so navigate can
// re-pin ctx.activeTab for the rest of THIS turn.
const adoptWebTab = async (/** @type {string} */ actorSessionId) => {
  const created = await browser.tabs.create({ active: false });
  const tabId = created?.id;
  if (typeof tabId !== 'number') throw new Error('adopt_web_tab: no tab id');
  webActorTabBindings.bind(tabId, actorSessionId);
  persistWebBindings();
  // AWAIT the network backstop before handing the tab back: the caller's very
  // next act is to navigate it. persistWebBindings already kicked the sync off;
  // this only waits for its turn in the queue, and it never rejects.
  await denylistNetGuard.sync();
  noteAgentTab(tabId, { kind: 'web', opened: true }).catch(() => {});
  return { tabId, windowId: created?.windowId };
};

// Prune a web actor's binding when its tab closes — for a per-tab actor it then
// becomes unreachable, and for the chat-scoped web actor this RELEASES its owned tab
// (tabFor → undefined → the actor falls back to the 0-tab fetch state). The orphaned
// session is harmless and ages out. Separate listener from the agent-tab-card cleanup
// so the two concerns stay independent.
browser.tabs?.onRemoved?.addListener((/** @type {number} */ tabId) => {
  if (webActorTabBindings.drop(tabId)) persistWebBindings();
  // The tab is gone, so both halves of the indicator are moot — but the
  // reporter still holds the id in its marked set, and tab ids are reused
  // within a session. Release drops it so a LATER tab that inherits the id
  // isn't mistaken for one peerd already grouped.
  pageActivity.release(tabId).catch(() => {});
});

// Heap-split phase 2: run an ENGINE actor's loop (vm/notebook/app) in its own
// offscreen Worker heap. Renders the actor prompt + descriptors SW-side (the
// worker never assembles them), seeds the worker with the actor's prior history
// (statefulness), forwards loop events to the card, and persists the turn back.
// Returns the runActorTurn reply shape, or null to FALL BACK to the in-SW turn
// (offscreen unavailable / never started). The worker holds no key, no engine
// clients, no chrome.* — its model call + every tool call relay to SW-gated routes.
const runActorTurnOffscreen = async (/** @type {any} */ { actorSessionId, message, instanceId, kind, actorTabId, oneShot, display }) => {
  if (!actorClient) return null;
  const loaded = await sessions.get(actorSessionId);
  if (!loaded) return null;
  // Engine-actor prewalk swap on the OFFSCREEN path. reconcileEngineActor is ALSO
  // wired into the in-SW turn-driver, but a Chrome engine actor runs HERE and
  // returns before that path is reached — so without this the swap NEVER fires on
  // the primary platform. why here: the worker is seeded from rec.provider/rec.model
  // below, so the swap must land (and persist) before we read them; costOf + the
  // card then also read the executor model. No-op for a non-engine / unarmed actor
  // (returns the record unchanged when there's no prewalk).
  let rec = loaded;
  try { rec = (await prewalk.reconcileEngineActor(rec)) ?? rec; }
  catch (e) { console.warn('[actor] engine prewalk reconcile failed', e); }
  const { controller, release } = turnSlots.claim(actorSessionId);
  try {
    // Prompt PARITY with the in-SW actor turn: temporal grounding + any /system
    // override (rec.customSystemPrompt). Actors get no memory/skills block (same
    // as turn-driver). Absolute-time temporal block (an actor has no prev-turn gap).
    const temporalBlock = buildTemporalBlock({ lastTurnAt: null, nowMs: Date.now() });
    // PR #119 surface parity: the OFFSCREEN actor path must thread the web
    // actor's action surface exactly like the in-SW path — same setting-derived
    // value buildToolContext falls back to. Without it a code-surface actor is
    // advertised the TOOLS descriptors (no page_code) and taught the tools
    // lore, so the whole code arm silently degrades on the offscreen heap.
    const actorSurface = (kind === 'web' && rec.backing !== 'api')
      ? (settingsStore.get().webActorActionSurface === 'code' ? 'code' : 'tools')
      : undefined;
    // #241 parity, and it is the load-bearing one: on Chrome EVERY actor turn
    // runs through this path, so a schemaReply stamped only in buildToolContext
    // would arm the validator while the actor was never told the format — every
    // web reply dropped. Read from the SAME setting, at the same moment, as the
    // getter injected into actorMessaging below.
    const schemaReply = settingsStore.get().schemaValidatedReplies === true;
    const systemPrompt = await renderSystemPrompt({
      actorType: kind, backing: rec.backing, instanceId, actorSurface, schemaReply,
      temporalBlock, customSystemPrompt: rec.customSystemPrompt,
    });
    const tools = actorDescriptors(listTools(), kind, rec.backing, actorSurface)
      .map((/** @type {any} */ t) => ({ name: t.name, description: t.description, schema: t.schema }));
    // Reasoning + dynamic context-window PARITY (extended thinking + trim scaling).
    const reasoning = {
      enabled: settingsStore.get().reasoningEnabled,
      budgetTokens: REASONING_BUDGET_TOKENS,
      effort: REASONING_EFFORT_LEVELS.includes(settingsStore.get().reasoningEffort)
        ? settingsStore.get().reasoningEffort : DEFAULT_SETTINGS.reasoningEffort,
    };
    const contextWindow = /** @type {any} */ (contextWindowFor(rec.model, {
      overrides: settingsStore.get().contextWindowOverrides,
      live: liveContextWindow(rec.provider, rec.model),
    }));
    // Minimal card display: mount on start, mirror the worker's state snapshots,
    // settle on done. fromIndex = the actor's length BEFORE this turn.
    const fromIndex = (rec.messages ?? []).length;
    if (display && uiConnected()) {
      uiPorts.broadcast({ type: 'turn/actor-start', parentToolUseId: display.parentToolUseId, sessionId: actorSessionId, fromIndex, kind: display.kind, instanceId: display.instanceId, name: display.name });
    }
    const onEvent = (display && uiConnected())
      ? (/** @type {any} */ ev) => {
        try {
          if (ev.type === 'state') uiPorts.broadcast({ type: 'turn/actor-state', parentToolUseId: display.parentToolUseId, session: ev.session, fromIndex, kind: display.kind, instanceId: display.instanceId, name: display.name });
        } catch { /* display best-effort */ }
      }
      : undefined;
    // Phase 3: the WEB/API actor self-fence provenance (the worker rebuilds
    // ctx.fenceActorSummary from it — the SW's closure can't cross postMessage). A
    // tab actor tags its turn-START tab url (the body-wrap is what matters; a tag
    // that lags a mid-turn navigate is cosmetic); an API actor tags its FIXED origin.
    let tabUrl;
    let apiOrigin;
    if (kind === 'web') {
      if (rec.backing === 'api') {
        apiOrigin = instanceId;
      } else {
        const ownedTab = actorTabId ?? webActorTabBindings.tabFor(actorSessionId);
        if (ownedTab != null) tabUrl = (await browser.tabs.get(ownedTab).catch(() => null))?.url;
      }
    }
    const r = await actorClient.run({
      actorSessionId, message, systemPrompt,
      provider: rec.provider, model: rec.model, depth: rec.depth,
      // maxSteps omitted → the worker's runUserTurn uses its OWN default (parity
      // with the in-SW path, not a hardcoded fifth of it). Seed the actor's prior
      // history for statefulness.
      tools, priorMessages: rec.messages ?? [], reasoning, contextWindow,
      // Phase 3 web/API parity: oneShot loop mode + the self-fence provenance.
      oneShot: oneShot === true, actorType: kind, backing: rec.backing, tabUrl, origin: apiOrigin,
    }, { signal: controller.signal, onEvent });
    if (!(r.ok || r.started)) return null; // never started → caller falls back to in-SW
    // Persist THIS turn's FULL transcript (user + assistant rounds + tool_use/
    // tool_result), not a lossy user+finalText pair — so a long-lived actor keeps
    // its tool-round memory across turns, matching the in-SW path.
    const newMessages = Array.isArray(r.newMessages) ? r.newMessages : [];
    let persistOk = true;
    for (const m of newMessages) {
      await sessions.appendMessage(actorSessionId, /** @type {any} */ (m)).catch(() => { persistOk = false; });
    }
    // Cost PARITY: price the turn's usage, PERSIST it on the actor's own session,
    // and surface it on the card (the reducer reads `cost`, not raw usage — the
    // earlier `usage` field never populated).
    //
    // why the fold is separate from the broadcast: an offscreen actor turn's spend
    // used to be broadcast to the UI and then dropped — nothing wrote it to a tally,
    // and the broadcast itself was conditional on a connected side panel, so a
    // headless/goal-mode actor turn cost nothing on the record at all. The fold runs
    // unconditionally now, and spendRefusalFor preflights THIS record, so the number
    // being tested is the number being incremented. It stays on the actor's own
    // session (not rolled up to the parent) — spawn.js documents that separation
    // deliberately, and changing it changes user-visible chat cost.
    if (r.usage) {
      try {
        const localProvider = !!listProviders().find((/** @type {any} */ p) => p.name === rec.provider)?.keyless;
        const cost = costOf(/** @type {any} */ (rec.model), /** @type {any} */ (r.usage), /** @type {any} */ (settingsStore.get().pricingOverrides), { localProvider });
        foldSessionCost(actorSessionId, r.usage, /** @type {any} */ (cost)?.cost ?? 0);
        // usage rides along RAW: costOf returns only { cost: USD } — consumers
        // that account TOKENS (the eval runner's ACTOR bucket) need the fields
        // costOf collapsed. Additive; the sidepanel reducer reads `cost` only.
        if (display && uiConnected()) {
          uiPorts.broadcast({ type: 'turn/actor-cost', parentToolUseId: display.parentToolUseId, cost, usage: r.usage });
        }
      } catch { /* cost telemetry is best-effort */ }
    }
    auditLog.append({ type: 'actor_ran_offscreen', details: { heapSplit: true, kind, instanceId, ok: r.ok === true, aborted: r.aborted === true, persistOk } }).catch(() => {});
    if (display && uiConnected()) uiPorts.broadcast({ type: 'turn/actor-done', parentToolUseId: display.parentToolUseId, sessionId: actorSessionId, ok: r.ok === true, aborted: r.aborted === true });
    return r.finalText ? { result: r.finalText } : { result: 'the actor turn was stopped before it produced a reply.', stopped: true };
  } finally {
    release();
    // The turn is over, so the pill comes down — leaving it up through the idle
    // gap would say "peerd is working" while nothing is happening, which is the
    // same misreading in the opposite direction. The tab GROUP stays: the actor
    // still owns this tab and will be back on the next turn, and shuffling it in
    // and out of the strip every exchange would be its own annoyance.
    const drivenTabId = webActorTabBindings.tabFor(actorSessionId);
    if (typeof drivenTabId === 'number') pageActivity.idle(drivenTabId).catch(() => {});
  }
};

// DESIGN-19: web/API actor sessions that have already had their site-client
// dossier injected this SW lifetime (once-per-session guard for mint injection).
// In-memory only — a fresh SW re-injects, which is harmless (it re-seeds a fenced
// note the actor already had).
const siteClientInjected = new Set();

// Resolve the ORIGIN a web/API actor is bound to, for the site-client lookup: an
// API actor owns its FIXED origin (the session record's instanceId/origin), a tab
// actor owns its tab's LIVE origin. Returns a normalized origin or null.
const resolveActorOrigin = async (/** @type {string} */ actorSessionId, /** @type {string} */ instanceId, /** @type {number|undefined} */ actorTabId) => {
  const rec = await sessions.get(actorSessionId).catch(() => null);
  if (rec?.backing === 'api') {
    // The API actor's owned origin is its instanceId (mintApiActor sets it).
    return normalizeApiOrigin(rec.instanceId ?? instanceId);
  }
  // A tab actor: the live origin of its owned tab.
  const tabId = typeof actorTabId === 'number' ? actorTabId : webActorTabBindings.tabFor(actorSessionId);
  if (typeof tabId !== 'number') return null;
  const t = await browser.tabs.get(tabId).catch(() => null);
  return t?.url ? normalizeApiOrigin(originOfTabUrl(/** @type {string} */ (t.url))) : null;
};

const actorMessaging = makeActorMessaging({
  resolveActor: async (/** @type {string} */ instanceId, /** @type {{ senderSessionId?: string | null }} */ opts = {}) => {
    // The chat's WEB ACTOR — the 0-or-1-tab entry point for page-driving / session web
    // work, addressed by the literal 'web'. It decides fetch-vs-render itself: a
    // pure-fetch task never opens a tab; navigate adopts one on the render path. Owned by
    // the SENDER chat (opts.senderSessionId), not the ambient active chat — so a boot
    // redrain re-attaches to the right actor. (A numeric tabId, below, targets the
    // actor owning that SPECIFIC existing tab — e.g. one the orchestrator open_tab'd.)
    if (String(instanceId) === 'web') return resolveWebActor(opts.senderSessionId);
    // The DWEB ACTOR — the global mesh operator, addressed by the literal 'dweb'.
    // Resolvable only when the network AND the agent toggle are on (opt-in daemon);
    // otherwise the handle doesn't exist and the caller gets the standard
    // no-instance refusal. Non-numeric + no dot + no engine prefix → unambiguous.
    if (String(instanceId) === 'dweb') return resolveDwebActor();
    // A per-tab WEB actor is addressed by its tabId-as-string (purely numeric, no
    // engine prefix); engine ids (vm-/notebook-/app-) carry a hyphen and never
    // match, so the branch is unambiguous.
    if (/^\d+$/.test(String(instanceId))) {
      return resolveWebActorForTab(Number(instanceId));
    }
    // issue 251: a SITE actor — a web actor BOUND to one origin, WITH a tab. The
    // successor a handoff names. Checked BEFORE the bare-origin branch below
    // because both spellings mention an origin and only the prefix distinguishes
    // them; getting the order wrong would silently hand every handoff a
    // fetch-only integration that cannot log in or click.
    const siteOrigin = parseSiteHandle(instanceId);
    if (siteOrigin) return resolveSiteActor(siteOrigin, opts.senderSessionId);
    // DESIGN-18: an API integration is addressed by its ORIGIN (a bare host or a full
    // URL). normalizeApiOrigin canonicalizes it and REJECTS anything that isn't a public
    // dotted host — so 'web', a tabId, and engine ids (vm-/notebook-/app-, no dot) all
    // fall through to the engine branch below. The origin is the integration's identity.
    const apiOrigin = normalizeApiOrigin(instanceId);
    if (apiOrigin) return resolveApiActor(apiOrigin, opts.senderSessionId);
    const prefix = String(instanceId).split('-')[0];
    const entry = /** @type {Record<string, { reg: any, kind: string }>} */ (ACTOR_REGISTRY_BY_PREFIX)[prefix];
    if (!entry) return null;
    const record = await entry.reg.get(instanceId);
    if (!record) return null;
    let actorSessionId = await entry.reg.getActorSession(instanceId);
    if (!actorSessionId) actorSessionId = await mintOnce(instanceId, () => mintActor(entry, record));
    return { instanceId, kind: entry.kind, actorSessionId, name: record.name };
  },
  // Drive ONE actor turn (the kind-aware runAgentTurn), then read its final
  // assistant text as the reply. runWhenIdle guaranteed the slot is free; the
  // turn claims it, and its release drains the next queued message to it.
  // actorTabId threads the WEB actor's owned tab into the turn so its DOM
  // tools (and the origin gate) target THAT tab; undefined for engine kinds, where
  // buildToolContext leaves activeTab unset (they act on their instance, not a tab).
  runActorTurn: async ({ actorSessionId, message, actorTabId, instanceId, kind, parentToolUseId, name, oneShot }) => {
    // DESIGN-19 mint-time injection: if this web/API actor's origin has a stored
    // site client, prepend its dossier — the tool-authored staleness header
    // OUTSIDE the fence, the dossier body wrapUntrusted-fenced (every byte is
    // derived, untrusted-provenance). ONCE per actor session (a guard Set), so it
    // seeds the actor's knowledge without re-bloating every turn. The module BODY
    // is never injected — the actor loads it on demand via site_client_read/run.
    let deliveredMessage = message;
    if (kind === 'web' && !siteClientInjected.has(actorSessionId)) {
      try {
        const originForClient = await resolveActorOrigin(actorSessionId, instanceId, actorTabId);
        if (originForClient) {
          const meta = await siteClientStore.getMeta(originForClient).catch(() => null);
          if (meta) {
            siteClientInjected.add(actorSessionId);
            deliveredMessage = `${buildMintInjection(meta)}\n\n---\n\n${message}`;
          }
        }
      } catch (e) { console.debug('[site-client] mint injection skipped', e); }
    }
    // DESIGN-18 tab-card anchoring: pin this actor's OWNED tab to the message_actor turn
    // driving it NOW (parentToolUseId), so its inline notice flows to this message's turn
    // (and resurfaces here when re-messaged) rather than to whatever user message is latest
    // when the actor's async tab touches physically fire. Resolve the owned tab per kind;
    // set BEFORE the turn so the touches it makes (engine ensureTab / web DOM noteTab) read
    // it. A not-yet-opened tab (first boot) maps nothing → that first touch keeps the
    // wall-clock anchor, which IS this turn for a first message.
    if (parentToolUseId) {
      const ownedTab = kind === 'web' ? (actorTabId ?? webActorTabBindings.tabFor(actorSessionId) ?? null)
        : kind === 'webvm' ? vmTabTracker.getTabId(instanceId)
        : kind === 'notebook' ? jsTabTracker.getTabId(instanceId)
        : kind === 'app' ? appTabTracker.getTabId(instanceId)
        : null;
      if (typeof ownedTab === 'number') setTabAnchor(ownedTab, parentToolUseId);
    }
    // DESIGN-17 P1 glass pane: when this turn was triggered by a live message_actor
    // call (parentToolUseId present — absent on a boot redrain), pass a `display`
    // descriptor so the turn driver re-emits the actor's stream as turn/actor-*
    // events keyed to that card. The orchestrator renders it inline (the actor
    // live-view, for an actor). Cheap: rendering only — the model-memory the
    // orchestrator keeps is still just the fenced reply (deliver()).
    const display = parentToolUseId
      ? { parentToolUseId, kind, instanceId, name }
      : undefined;
    // Count the actor's messages BEFORE the turn so we read only the reply THIS
    // turn produced — finalAssistantText scans backward and would otherwise return a
    // PRIOR exchange's reply when this turn was Stop-cascaded before emitting any
    // text (the stale-reply bug). `stopped` lets the caller mark the wake failed.
    const before = (await sessions.get(actorSessionId))?.messages?.length ?? 0;
    // issue 251 — clear any report left over from an earlier turn BEFORE running,
    // so a stop can only ever be attributed to the turn that caused it. A stale
    // report surfacing on a later, unrelated message would be a lie in the one
    // place the orchestrator is being asked to trust us.
    //
    // The delete alone is NOT enough, and adversarial review is the reason this
    // sentence exists: it only clears reports written before the turn starts,
    // while the dangerous one is written AFTER — by a navigate still inside its
    // 30-second load wait when the previous turn was aborted, whose judge runs
    // when it finally resolves. Opening a turn token makes that judge inert: it
    // captured the old token at context-build time, so it can neither file a
    // report against this turn nor abort it.
    landingStopReports.delete(actorSessionId);
    beginLandingTurn(actorSessionId);
    /**
     * If the origin lock stopped this actor mid-turn, its own reply is not the
     * answer — the report is. Overriding UNCONDITIONALLY is the point: a stopped
     * actor may still have emitted text, and text written after the moment we
     * decided it was somewhere it shouldn't be is exactly what must not reach the
     * orchestrator. `stopped:true` marks the delivery failed, so the reply arrives
     * as "this did not work, here is why" rather than as a result.
     * @param {{ result: string, stopped?: boolean }} reply
     * @returns {{ result: string, stopped?: boolean }}
     */
    const withLandingStop = (reply) => {
      const report = landingStopReports.get(actorSessionId);
      if (!report) return reply;
      landingStopReports.delete(actorSessionId);
      return { result: report, stopped: true };
    };
    // Heap-split: every BOUND actor runs its loop in its own offscreen Worker heap —
    // engine kinds (vm/notebook/app, phase 2) AND the web/API actor (phase 3, the
    // highest-value isolation: it ingests untrusted PAGE/response content). Its DOM
    // tools + fetch_url run SW-side via the 'actor/tool-dispatch' relay (chrome.* is
    // SW-only); the worker holds no key, no chrome.*. Returns the reply, or null to
    // fall back to the in-SW turn below (offscreen unavailable / never started).
    if (kind === 'webvm' || kind === 'notebook' || kind === 'app' || kind === 'web' || kind === 'dweb') {
      const off = await runActorTurnOffscreen({ actorSessionId, message: deliveredMessage, instanceId, kind, actorTabId, oneShot: oneShot === true, display });
      if (off) return withLandingStop(off);
    }
    // oneShot: the loop synthesizes the reply from the first clean tool round and
    // stops (no summarize inference) — finalAssistantText below reads that synthetic
    // assistant message exactly like a normal reply, so nothing else changes here.
    try {
      await runAgentTurn({ sessionId: actorSessionId, userText: deliveredMessage, synthetic: false, activeTabId: actorTabId, display, oneShot: oneShot === true });
    } finally {
      // why here too: runActorTurnOffscreen takes the pill down in its own
      // finally, but this is the IN-SW fallback the offscreen path returns null
      // for (Firefox has no offscreen API). Without it the pill outlives the
      // turn on Firefox and sits on "Thinking…" forever — peerd saying it is
      // working while nothing is happening, the exact misreading the indicator
      // exists to prevent. The GROUP still stays; only the pill comes down.
      const drivenTabId = webActorTabBindings.tabFor(actorSessionId);
      if (typeof drivenTabId === 'number') pageActivity.idle(drivenTabId).catch(() => {});
    }
    const s = await sessions.get(actorSessionId);
    const fresh = finalAssistantText(/** @type {any} */ ({ messages: (s?.messages ?? []).slice(before) }));
    return withLandingStop(fresh
      ? { result: fresh }
      : { result: 'the actor turn was stopped before it produced a reply.', stopped: true });
  },
  reenter: ({ userText, sessionId, synthetic, trusted, actorReply }) => runAgentTurn({ userText, sessionId, synthetic, trusted, actorReply }),
  turnSlots,
  getActiveSessionId: () => /** @type {Promise<any>} */ (sessionCache.sessionGet('currentSessionId')),
  // PR #134 phase 3 — the shell walk behind the trusted-lineage gate. The pure
  // walk (fail-closed rules + hop cap + cycle guard) lives in delegation-lineage
  // so it's unit-tested; here we only inject the store read. spawnedTrusted per
  // hop: a ROOT (no parent) is trusted by construction; a PARENTED record must
  // carry an explicit true — records written before the field existed read as
  // untrusted (fail-closed; those children never had delegation anyway).
  getAncestry: (/** @type {string} */ sessionId) =>
    buildAncestry({ sessionId, getRecord: (/** @type {string} */ id) => sessions.get(id) }),
  isVaultLocked: () => vault.isLocked(),
  wrapUntrusted,
  // #241 — the VALIDATOR half. A getter, not a boolean: this factory runs once at
  // SW boot, so a boolean would freeze at its boot value and ignore the user
  // flipping the setting. Reading it here, per reply, from the same store that
  // stamps the actor's prompt rule is what makes the two halves one switch.
  // KNOWN, ACCEPTED WINDOW: the prompt half samples at turn start and this
  // samples at settle, so toggling the setting DURING a live actor turn can
  // arm the validator against a prompt that never carried the rule (or the
  // reverse). Cost is one dropped, re-delegable reply, on a default-off
  // experimental flag, and it needs a human clicking the checkbox inside the
  // turn. Latching per turn would cost more machinery than the failure is
  // worth; sampling per reply is what makes the toggle take effect at all.
  schemaValidatedReplies: () => settingsStore.get().schemaValidatedReplies === true,
  appendAudit: (/** @type {any} */ e) => auditLog.append(e),
  mailbox: actorMailbox,
  log: (/** @type {any[]} */ ...a) => console.warn('[actor]', ...a),
});

// Redrain the durable mailbox ONCE per SW lifetime, the moment the vault is
// unlocked (a re-queued actor turn needs the model key). Boots already-unlocked
// → fires from the attemptResume chain below; booted locked → fires on the first
// unlock via the subscription. The once-guard prevents a double-drain (entries
// aren't cleared until their turn SETTLES, so a second drain would double-deliver).
let mailboxRedrained = false;
const maybeRedrainMailbox = () => {
  if (mailboxRedrained || vault.isLocked()) return;
  mailboxRedrained = true;
  Promise.resolve(actorMessaging.redrain())
    .then((r) => { if (r?.redrained) console.warn('[actor] redrained', r.redrained, 'pending message(s) after restart'); })
    .catch((e) => console.error('[sw] actor redrain failed', e));
};
vault.subscribe(() => { maybeRedrainMailbox(); });

// ---------------------------------------------------------------------------
// 5b. /init — workspace scan → draft AGENTS.md → confirm → persist (V1.5)
// ---------------------------------------------------------------------------
//
// peerd's workspace is a browsing context, not just a file tree, so the
// probe composes @tab (live page via the user's session) + peerd Apps +
// (best-effort) a WebVM listing. The draft is PURE (draftAgentsMd); the
// confirm round-trip is the same SW ↔ side panel channel memory writes
// use — /init never silently persists.

const postChatNote = (/** @type {string} */ text, /** @type {any} */ action = null) => {
  if (!uiConnected()) return;
  try { uiPorts.broadcast({ type: 'turn/system-note', text, ...(action ? { action } : {}) }); }
  catch { /* panel gone */ }
};

// /init orchestration lives in peerd-runtime/memory/init-orchestrator.js
// (scan → draft → confirm → persist); the SW binds the IO. The
// vault-locked gate stays HERE: VaultLockedError is an egress type, and
// the runtime never imports concrete egress adapters (the DI rule).
const initOrchestrator = makeInitOrchestrator({
  tabs: browser.tabs,
  scripting: browser.scripting,
  listApps: () => appRegistry.list(),
  memory,
  confirm: /** @type {any} */ (confirmAction),
  postChatNote,
});
const runInit = async () => {
  if (vault.isLocked()) throw new VaultLockedError();
  return initOrchestrator.runInit();
};

// ---------------------------------------------------------------------------
// 5c. /system — per-session custom system-prompt augmentation
// ---------------------------------------------------------------------------
//
// SW-handled composer command (same registration pattern as /init and
// /loop: intercepted in agent/send, never sent to the model). Three forms:
//   /system            show the active session instructions (or none)
//   /system clear      remove them for the current session
//   /system <text>     set them for the current session
// The text becomes session.customSystemPrompt and is APPENDED to the base
// system prompt as a <session_instructions> block on every turn — never a
// replacement (the base carries the security/defense text). The per-change
// prompt-cache break is accepted by design.
// Lazily create a chat session when a SETTING command (/system <text>,
// /tools <preset>) runs before the first message — same create shape as
// runAgentTurn's lazy path, so the chat that follows is the one carrying
// the setting. Returns the (existing or fresh) current session id.
const ensureCurrentSession = async () => {
  let sessionId = /** @type {any} */ (await sessionCache.sessionGet('currentSessionId'));
  if (sessionId) return sessionId;
  const ap = await ensureActiveProvider();
  const inherited = await resolvePermission(null);
  const created = await sessions.create({
    provider: ap.name,
    model: ap.model,
    permissionMode: inherited.mode,
    confirmActions: inherited.confirmActions,
  });
  sessionId = created.sessionId;
  await sessionCache.sessionSet('currentSessionId', sessionId);
  sessionState.set(created);
  return sessionId;
};

const handleSystemCommand = async (/** @type {string} */ arg) => {
  if (vault.isLocked()) throw new VaultLockedError();
  let sessionId = /** @type {any} */ (await sessionCache.sessionGet('currentSessionId'));

  // Show the active state.
  if (!arg) {
    const s = /** @type {any} */ (sessionId ? await sessions.get(sessionId) : null);
    const active = typeof s?.customSystemPrompt === 'string' && s.customSystemPrompt.length > 0;
    postChatNote(active
      ? `Session instructions active (${s.customSystemPrompt.length} chars): ${s.customSystemPrompt}`
      : 'No session instructions set. "/system <text>" sets them for this chat; "/system clear" removes them.');
    return;
  }

  if (/^clear$/i.test(arg)) {
    if (!sessionId) {
      postChatNote('No active chat - nothing to clear.');
      return;
    }
    sessionState.set(await sessions.setCustomSystemPrompt(/** @type {any} */ (sessionId), null));
    auditLog.append({ type: 'session_instructions_cleared', sessionId }).catch(() => {});
    postChatNote('Session instructions cleared.');
    pushState();
    return;
  }

  // Set. Lazily create a session if the user runs /system before the
  // first message, so the chat that follows is the one carrying the
  // instructions (shared helper — /tools does the same).
  sessionId = await ensureCurrentSession();
  sessionState.set(await sessions.setCustomSystemPrompt(/** @type {any} */ (sessionId), arg));
  // why: audit the EVENT and size, never the text — session instructions
  // are user-authored prompt content, not something the audit log should
  // retain a copy of.
  auditLog.append({
    type: 'session_instructions_set',
    sessionId,
    details: { chars: arg.length },
  }).catch(() => {});
  postChatNote(`Session instructions set for this chat (${arg.length} chars). They augment the base system prompt; "/system" shows them, "/system clear" removes them.`);
  pushState();
};

// ---------------------------------------------------------------------------
// 5d. /tools — per-session tool exposure manifest
// ---------------------------------------------------------------------------
//
// Same SW-handled registration pattern as /system (intercepted in
// agent/send, never sent to the model). The grammar + store/audit/note
// choreography live in peerd-runtime/tools/manifest-command.js (the
// functional core, in-browser-tested without a SW); this binds the IO.
const toolsCommand = makeToolsCommand({
  sessions,
  getCurrentSessionId: () => /** @type {Promise<any>} */ (sessionCache.sessionGet('currentSessionId')),
  ensureSession: /** @type {any} */ (ensureCurrentSession),
  postNote: postChatNote,
  audit: (/** @type {any} */ entry) => auditLog.append(entry),
});
const handleToolsCommand = async (/** @type {string} */ arg) => {
  if (vault.isLocked()) throw new VaultLockedError();
  const { session } = await toolsCommand(arg);
  // A changed manifest re-renders the chat chip + descriptor set next
  // turn; the read-only forms (/tools, /tools list) change nothing.
  if (session) {
    sessionState.set(session);
    pushState();
  }
};

// ---------------------------------------------------------------------------
// 6. Message handlers — one-shot sendMessage routes
// ---------------------------------------------------------------------------

// Goal-mode handles for the session routes, defined here so they wire as plain
// SHORTHAND below (the route-wiring guard requires it — no key:value). goalRunner
// is built above; ensureSession is the same lazy session-create the model turn
// uses, so a Goal send on a fresh chat gets a session (like /system and /tools).
// Goal mode (the Goal toggle). Autonomy is NOT a stored flip — resolvePermission
// computes Act+confirm-off from the live run — so start/halt are just the runner
// surface. resumeGoalRuns re-drives persisted runs after an interactive unlock.
// why arm-then-start: prewalk state must be on the session BEFORE the run's
// first turn renders its system prompt (the planning nudge reads it). Arming
// is a quiet no-op when the setting is off or no distinct executor resolves.
const startGoalRun = async (/** @type {{ sessionId: string, goal: string }} */ req) => {
  await prewalk.armForRun(req?.sessionId);
  return /** @type {any} */ (goalRunner)?.start(req);
};
// why stop() not halt(): user-initiated cancels (Stop button, steer-takeover,
// new-chat, archive) must DURABLY end the run — halt() only marks an in-memory
// run, so a vault-lock-PAUSED run (evicted from the runner's map but kept in the
// kv mirror for resume) would survive a Stop and resurrect on the next unlock.
const haltGoalRun = (/** @type {string} */ sid) => /** @type {any} */ (goalRunner)?.stop(sid);
const resumeGoalRuns = () => /** @type {any} */ (goalRunner)?.resume();
// Background scheduling: drive a full scheduler catch-up. The SINGLE entry point
// for every wake (alarm, onStartup, cold boot, vault unlock) so the ordering is
// defined in ONE place and can't drift per-caller.
//
// why resume goal runs FIRST: tick()'s isRunning() guard (which stops a goal-mode
// routine from firing a second session while its previous run is still going)
// reads goalRunner.isActive(lastSessionId) — the IN-MEMORY map. After an SW
// eviction / auto-lock, a paused goal run lives only in the kv mirror until
// goalRunner.resume() re-adds it, and resume() re-adds AFTER an `await kv.get`. If
// tick() ran first it would see the routine as not-running and fire a duplicate
// while resume() re-drives the original — two concurrent runs for one routine.
// Sequencing resume() → load() → tick() closes that window. Both resume() and
// load() are idempotent (skip ids already live), so calling this from every wake
// — even one where goal runs were already resumed — is safe.
const resumeSchedules = () => Promise.resolve(/** @type {any} */ (goalRunner)?.resume())
  .catch(() => {})
  .then(() => /** @type {any} */ (scheduler)?.load())
  .then(() => /** @type {any} */ (scheduler)?.tick())
  .catch((e) => console.error('[sw] schedule catch-up failed', e));
const ensureSession = ensureCurrentSession;

// Message routes live in background/routes/*.js as import-free, deps-injected
// factories. Each is wired with an EXPLICIT per-module deps object naming
// exactly the stable collaborators that module needs — so the coupling is
// visible at the call site and ESLint no-undef guards every name.
// tests/meta/sw-routes-wiring.test.ts proves each module's deps object matches
// what it destructures, exactly (no missing, no dead).
//
// ALL 103 routes now live in modules — none are inline here. The reassigned
// module state that once forced routes inline lives in stores (settings-store /
// denylist-store / session-state / local-model-state / profile-state); routes
// reach it through a store method (always-live) handed in via deps. A new route
// belongs in a routes/ module too; if it needs mutable SW state, give that state
// a store and inject it, rather than reaching for a module-level let.
browser.runtime.onMessage.addListener(/** @type {any} */ (makeDispatcher({
  // The heap split: the offscreen→SW relays for the ONE agent-loop client — model-call
  // (getSecret + safeFetch added in the handler; the key never left the SW), the
  // SW-side pin+gate tool-dispatch, and the fire-and-forget loop-event (→ the actor/
  // actor card + cost meter). Serves both spawned reasoners and bound actors; a
  // reasoning child never exercises tool-dispatch. actorClient is defined above (after
  // ensureOffscreen), before this dispatcher literal — safe to spread.
  ...(actorClient?.routes ?? {}),
  // A2A: the sealed a2a_run worker's mesh calls relay here (owner-verified,
  // consent-gated, dispatched on the peerd-agent room).
  'a2a/call': (/** @type {any} */ msg) => a2aCallRoute(msg),
  // actors: the script tool's delegation surface — each actors.* call an
  // actors-enabled headless run makes relays here (owner-verified, fully
  // re-gated through messageActor).
  'actors/call': (/** @type {any} */ msg) => actorsCallRoute(msg),
  // provider (design 5): the script tool's sub-model surface — each
  // peerd.provider.call a provider-enabled headless run makes relays here
  // (owner/run-verified, quota-capped, the key added SW-side).
  'script/model-call': (/** @type {any} */ msg) => scriptModelCallRoute(msg),
  ...makeVaultRoutes({
    vault, auditLog, kv, idb, base64ToBytes, ensureOffscreen, maybeStartBaseNetwork,
    pushState, purgeVaultBlob, confirmCoordinator, sessionCache, maybeAutoResume, resumeGoalRuns,
    resumeSchedules,
    VaultAlreadyInitializedError, WrongPassphraseError, VaultNotInitializedError,
    RecoveryPassphraseNotSetError, PrfNotEnrolledError, PrfUnlockFailedError,
    VaultLockedError,
  }),
  ...makeProviderRoutes({
    vault, auditLog, pushState, settingsStore, listProviders, listProviderModels, listOpenRouterModels,
    OPENROUTER_POPULAR, callModel, getSecret, safeFetch, secretNameForProvider, maskKey,
    buildModelOptions, ProviderHttpError, ProviderKeyMissingError, VaultLockedError,
  }),
  ...makeHooksRoutes({
    auditLog, kv, listHooks, DEFAULT_HOOKS, parseHookMarkdown, saveUserHook, removeHook, exportHooks,
  }),
  ...makeSkillsRoutes({
    skillRegistry, webFetch, pushState, REMOTE_SKILL_INSTALL,
    installFromLocal, installFromGit, installFromManifest,
    SkillExistsError, SkillParseError, SkillInstallError,
  }),
  ...makeMemoryRoutes({
    vault, auditLog, pushState, memory, memorySuggestions, runInit, postChatNote,
    USER_DOC_SCOPE, appendNoteToUserDoc, profileState, seedUserDocBody,
  }),
  ...makeContactsRoutes({ vault, auditLog, contacts, appRegistry, mergeContacts }),
  ...makeSessionRoutes({
    vault, auditLog, sessions, sessionCache, turnSlots, manifestLabel, buildToolContext,
    applyComposer, commandSources, prepareUserAttachmentsWithDocs, runAgentTurn, runInit,
    // Attached-document conversion: the SAME offscreen reader read_doc uses,
    // fed inline bytes instead of a URL (doc-extract has always accepted a
    // bytesB64 source). null on Firefox — the prepare step then refuses with
    // a legible message rather than attaching an empty file.
    convertDocAttachment,
    handleSystemCommand, handleToolsCommand, postChatNote, spawnActor, requestReview, appClient,
    browser, originOfTabUrl, matchesDenylist, denylistStore,
    // goal mode (the mode-row Goal toggle): start an autonomous run, and halt
    // any active one when the user stops or steers with a fresh message.
    startGoalRun, haltGoalRun, ensureSession,
    // DESIGN-17 P1: agent/stop cascades to this chat's in-flight actors.
    actorMessaging,
    // PR #134 phase 5: agent/stop also cascades through the live actor
    // subtree (children run under their own turn slots now).
    actorLifecycle,
    // The debug surface: session/debugBundle + session/contextSnapshots.
    settingsStore, contextSnapshots, assembleDebugBundle, childSessionIdsOf, CHANNEL,
  }),
  ...makeEngineRoutes({
    vault, auditLog, pushState, browser, vmHttpFetch, appRegistry, vmRegistry, jsRegistry,
    appClient, appTabTracker, opfsHelpers, NOTEBOOK_OPFS_ROOT, IMAGE_PIN_STORAGE_KEY,
    buildAppExport, buildNotebookExport, buildVmRecipeExport,
    openEnvelope, inspectEnvelope, exportFilename,
    ArtifactTooLargeError, EnvelopeFormatError, EnvelopeIntegrityError,
    ensureOffscreen, settingsStore, DWEB_ENABLED, applyWebExtract,
  }),
  ...makeSystemRoutes({
    vault, auditLog, sessions, pushState, kv, memory, buildStateSnapshot, closeSidePanel,
    uiPorts, loadUserEndpoints, inspectImport, applyImport, settingsStore, saveUserHook,
    CHANNEL, DEFAULT_SETTINGS, ExportPassphraseError,
  }),
  // denylistNetGuard: an edit changes what the network backstop blocks, so the
  // rule is rebuilt on every edit — including the removal path, where a stale
  // rule would keep blocking a site the user just unblocked.
  ...makeDenylistRoutes({ denylistStore, auditLog, getSeedCategories, denylistNetGuard }),
  // The settings view of the LEARNED origin set (+ the only un-learn path).
  // Settings-surface only: routes are unreachable from the tool dispatcher, so
  // no agent or page-fed actor can erase its own containment.
  // why no auditLog: the STORE's onForget hook appends the audit entry, so
  // passing one here would double-record every removal (meta test: the deps
  // object must match what the module destructures).
  ...makeLearnedOriginRoutes({ learnedOrigins, normalizeApiOrigin }),
  // issue 251 — a READ-ONLY inspection route for the e2e verify loop.
  //
  // why a route at all: the two properties that matter most about the lock are
  // invisible from the transcript. "The refused tab was released" and "this
  // origin was learned" are internal state, and an e2e that cannot see them can
  // only assert that something stopped — not that the actor recovered, which is
  // the difference between a working feature and a bricked web actor.
  //
  // Read-only and additive: it reveals whether an origin is known and whether
  // the chat's web actor currently owns a tab. It grants nothing, and it is not
  // reachable by the model — routes are the side panel's surface, and the tool
  // dispatcher has no path to them.
  'debug/originLock': async (/** @type {{ origin?: string }} */ msg = {}) => {
    const origin = normalizeApiOrigin(msg.origin);
    const chatId = /** @type {string | null} */ (await sessionCache.sessionGet('currentSessionId'));
    const actorSessionId = chatId ? webActorRegistry.resolve(chatId) : null;
    return {
      ok: true,
      learned: origin ? learnedOrigins.snapshot().has(origin) : false,
      keyed: origin ? keyedOrigins.has(origin) : false,
      ownedTabId: actorSessionId ? (webActorTabBindings.tabFor(actorSessionId) ?? null) : null,
      originState: actorSessionId ? (originStates.read(actorSessionId) ?? null) : null,
      // The SITE actor for this origin, if the chat has formed one. Its mode is
      // the property that distinguishes a real handoff successor from a roaming
      // helper that merely happens to be on the right page.
      siteActorState: (() => {
        const sid = (origin && chatId) ? siteActorBindings.resolve(chatId, origin) : null;
        return sid ? (originStates.read(sid) ?? null) : null;
      })(),
    };
  },
  ...makeSettingsRoutes({
    vault, auditLog, pushState, kv, memory, settingsStore,
    normalizeSettingsPatch, normalizeVariant, normalizeEngine, listProviders,
    REASONING_EFFORT_LEVELS, DWEB_ENABLED, DEFAULT_SETTINGS,
    buildExport, CHANNEL, exportHooks, skillRegistry,
    // React to the dweb-agent toggle: join/leave the inbox room so a disable
    // withdraws mesh presence immediately (idempotent; no-op for other keys).
    onSettingsChanged,
  }),
  ...makeSessionMutationRoutes({
    vault, auditLog, pushState, sessions, sessionCache, sessionState, autoMemory,
    resolvePermission, normalizeMode, normalizeConfirmActions, SessionNotFoundError,
    maybeAutoResume, haltGoalRun,
    // session/reset (New chat) must stop the abandoned session's live turn AND
    // cascade to its in-flight actors — same primitives agent/stop uses — so
    // background web/VM/App work doesn't keep running on the orphaned session.
    turnSlots, actorMessaging,
    // Session teardown drops the durable script workspace subtree.
    nukeSessionWorkspace,
  }),
  ...makeLocalModelRoutes({ ensureOffscreen, browser, localModelState }),
  ...makeDwebRoutes({
    vault, auditLog, kv, ensureOffscreen, browser,
    appRegistry, appClient, appTabTracker, opfsHelpers, settingsStore,
    DWEB_ENABLED, DWEB_IDENTITY_SECRET, APP_TAB_GROUP_TITLE,
    onBaseNetworkStopped,
  }),

  // --- git credentials (host-bound bearer tokens; same vault as API keys) ---
  // #53: stored under git:<host>, decrypted only in injectGitAuth at request
  // time, never shown to the agent or the VM. `list` returns HOST NAMES ONLY.
  // Built by makeGitCredentialRoutes (vm-net) — see the const above.
  ...(/** @type {any} */ (gitCredentialRoutes)),

  // --- DESIGN-18 API integrations (origin-bound API keys) ---
  // Stored under origin:<origin>, decrypted only in withApiCredentials at request
  // time, never shown to the agent. `list` returns origins + header NAME only.
  ...(/** @type {any} */ (originCredentialRoutes)),

  // --- PR #119 code-REPL arm: the web actor's page.<method> bridge route ---
  // A sealed-worker page.* call → the SAME gated dispatch the tool-call actor
  // uses, pinned to the actor's owned tab (owner + tab resolved trusted-side).
  ...(/** @type {any} */ (pageCallRoute)),

  // --- DESIGN-19: the site-client run's ONLY egress (origin-pinned, confirmed) ---
  // A sealed-worker site.fetch call → the actor's session-scoped webFetch, pinned
  // to the client's origin (owner + origin resolved trusted-side; cross-origin
  // refused; non-GET confirmed via the shared web:write key).
  ...(/** @type {any} */ (siteFetchCallRoute)),

  // --- DESIGN-19: the options surface for stored site clients (list + delete) ---
  ...(/** @type {any} */ (siteClientRoutes)),

  // --- design 06: toolbox module resolution (body read for the sealed-worker
  // resolver) + post-run rot bookkeeping ---
  ...makeToolboxRoutes({ toolboxStore }),
})));

// The toolbar icon + Alt+Shift+P front door (open the panel or home, per the
// frontDoorView setting) lives in background/tab-affordances.js alongside the
// agent-tab card and web-tab hint — it owns the sync-gesture pull-in and its
// listeners.
loadUserEndpoints();
// why the chained mirror: it must apply AFTER hydration (the store serves
// channel defaults until load() lands), and Chrome persists the behavior
// browser-side, so by the time a click wakes a future cold SW the native
// open already reflects the user's real choice.
loadSettings().then(() => syncFrontDoorBehavior()).catch(() => {});

// SW boot logging — we want a clear timeline of when the SW comes up
// (cold start, extension reload, idle respawn). The console clears
// when the SW dies, so each fresh boot starts a new transcript.
console.log('[sw] BOOT at', new Date().toISOString(), '— UA:', navigator.userAgent);

// Independent 5s liveness tick. If the SW is being killed at the 30s
// idle timer, we'll see 5–6 ticks then the console goes dead. The
// next boot's transcript starts at the next user action. Comparing
// the timestamps between a heartbeat and a death tells us whether
// the heartbeat is actually keeping the SW alive.
setInterval(() => {
  console.log('[sw] tick at', new Date().toISOString(),
    `(keepalive ports: ${keepalivePorts.size})`);
}, 5_000);

// Bring the always-on BASE NETWORK online (S1b/S4). The lobby host lives in
// the offscreen doc, but it needs the vault for identity (which it fetches via
// the SW), so vault unlock — passphrase, PRF, or session resume — is the
// natural trigger. This is what makes the network "always on" rather than
// merely hostable: it comes up with the vault, before any tab opens.
//
// Idempotent (the offscreen host's start() returns the existing handle on a
// repeat) and best-effort: a signaling outage or a disabled dweb must NEVER
// block or fail an unlock, so everything is swallowed to a warning. Gated
// preview + setting; on the store build maybeStart is a no-op (DWEB_ENABLED
// false) — and this file names no dweb module, so the store verifier stays clean.
function maybeStartBaseNetwork(/** @type {string} */ reason) {
  if (!DWEB_ENABLED || !settingsStore.get().dwebEnabled) return;
  console.log('[sw] dweb base network — auto-start on', reason);
  (async () => {
    await ensureOffscreen();
    const r = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'dweb/base-host/start' }));
    if (r?.ok) {
      console.log('[sw] dweb base network ONLINE', { did: r.did, peers: r.peers, present: r.present });
      reseedSharedApps().catch((e) => console.warn('[sw] re-seed after start failed (non-fatal):', (/** @type {{ message?: string }} */ (e))?.message ?? e));
      // The dweb AGENT's inbox: join the reserved agent room (idempotent) so
      // inbound peer messages flow as dweb/base-room/event 'direct' events the
      // listener consumes. Opt-in — no join, no inbox, no wakes.
      joinDwebAgentInbox().catch((e) => console.warn('[sw] dweb agent inbox join failed (non-fatal):', (/** @type {{ message?: string }} */ (e))?.message ?? e));
    } else console.warn('[sw] dweb base network start returned', r);
  })().catch((e) => console.warn('[sw] dweb base network auto-start failed (non-fatal):', (/** @type {{ message?: string }} */ (e))?.message ?? e));
}

// why: the offscreen base network's discovery Library AND content store are
// in-memory, so an MV3 recycle (SW/offscreen killed on idle while the browser
// stays open) wipes the user's OWN shared apps off the network — empty snapshots
// to subscribers, no bytes served — until a manual re-share. Re-seed them on
// every start: re-publish the bytes (we serve them again) and re-announce the
// card with the STORED seq so it's the SAME version (no spurious bump). AUTHORED
// apps only (dweb.local) — we can't re-sign a peer's card. Best-effort and async;
// it never blocks start, and the no-downgrade rule makes a re-announce a peer
// already has a harmless no-op.
async function reseedSharedApps() {
  if (!DWEB_ENABLED || !settingsStore.get().dwebEnabled || vault.isLocked()) return;
  let mine;
  try {
    const apps = await appRegistry.list();
    mine = apps.filter((a) => a.shared && a.dweb?.local && a.dweb?.slug);
  } catch (e) {
    console.warn('[sw] re-seed: listing apps failed (non-fatal):', (/** @type {{ message?: string }} */ (e))?.message ?? e);
    return;
  }
  if (!mine.length) return;
  let seeded = 0;
  for (const app of mine) {
    try {
      const opfs = opfsHelpers(['peerd-apps', app.id]);
      /** @type {Record<string, any>} */ const files = {};
      for (const f of await opfs.list()) { const path = f.path.replace(/^\/+/, ''); files[path] = await opfs.read(path); }
      if (!Object.keys(files).length) continue;       // nothing on disk — skip
      const res = /** @type {any} */ (await browser.runtime.sendMessage({
        type: 'dweb/base-host/share-app',
        name: app.name, entry: app.entryFile, files,
        slug: (/** @type {any} */ (app.dweb)).slug, seq: (/** @type {any} */ (app.dweb)).seq, description: (/** @type {any} */ (app.dweb)).description ?? '',
      }));
      if (res?.ok) seeded += 1;
    } catch (e) { console.debug('[sw] re-seed failed for', app.id, (/** @type {{ message?: string }} */ (e))?.message ?? e); }
  }
  if (seeded) console.log('[sw] re-seeded', seeded, 'shared app(s) after base network start');
}

// Spawn the offscreen doc immediately on SW boot. Previously this was
// only called from vault/unlock and vault/initialize; in practice the
// SW often boots cold (extension reload, browser restart) into a state
// where there's no offscreen yet, and the 30s idle timer fires before
// the user gets a chance to unlock. Spawning at boot eliminates that
// window. The offscreen doc holds the keepalive port and voice host;
// the WebVMs live in their own tabs (vm-tab/index.html).
console.log('[sw] boot — ensuring offscreen for keepalive + voice');
ensureOffscreen().catch((e) => console.error('[sw] boot ensureOffscreen failed', e));

// Instance registry + tracker init for all three kinds: pull persisted
// catalogs and re-discover live tabs (a SW restart while tabs are open
// is common — Chrome kills the SW after 30s idle but leaves tabs alone).
(async () => {
  try {
    await vmRegistry.load();
    await vmTabTracker.bootstrap();
    await jsRegistry.load();
    await jsTabTracker.bootstrap();
    await appRegistry.load();
    await appTabTracker.bootstrap();
    console.log('[sw] instance registries initialized — live tabs:',
      { vm: vmTabTracker.listLive(), js: jsTabTracker.listLive(), app: appTabTracker.listLive() });
    // An SW restart re-adopts engine tabs that never stopped running, so the
    // network backstop's tab scope has to be rebuilt from what bootstrap found.
    denylistNetGuard.sync();
  } catch (e) {
    console.error('[sw] instance init failed', e);
  }
})();

// Attempt to resume the vault from chrome.storage.session. If the SW
// died and respawned within the same browser session, the unwrapped DK
// is still there and we can pick up where we left off — no passphrase
// re-entry required. Returns false (no-op) if the vault was never
// unlocked or session storage was cleared.
vault.attemptResume().then((resumed) => {
  if (resumed) {
    console.log('[sw] vault resumed from session storage');
    auditLog.append({ type: 'vault_unlocked' }).catch(() => {});
    pushState();
    maybeStartBaseNetwork('resume');
    // why: the SW can die MID-TURN; on respawn the DK is back from session
    // storage but the interrupted turn stays frozen until the user re-opens
    // the chat. Drive the SAME auto-resume the unlock + session-open routes
    // use (routes/vault.js) for the session in view — a wake is precisely when
    // we most want to resume the turn the eviction killed. maybeAutoResume
    // self-gates on the setting, an interrupted-turn verdict, vault state, the
    // not-busy slot, and a per-marker dedupe, so firing here is safe even if a
    // later session-open fires it too.
    // why settingsStore.load() first: loadSettings() runs un-awaited at boot, so
    // the autoResumeInterruptedTurns gate inside maybeAutoResume could read the
    // channel default (ON) before the user's stored value hydrates — resuming a
    // user who explicitly DISABLED it, once, in the cold-start window. load() is
    // idempotent (re-reads kv, recomputes the merged view), so gating on it here
    // just guarantees the setting is hydrated before the gate consults it.
    // why goal resume BEFORE auto-resume: goalRunner.resume() synchronously
    // re-adds a persisted run to the runner's map (isActive → true) before its
    // drive() awaits. Sequencing it ahead of maybeAutoResume guarantees the
    // goalActiveFor guard in maybeAutoResume sees the goal run and bails —
    // otherwise the two could race to drive the SAME interrupted session.
    Promise.resolve(goalRunner?.resume())
      .catch((e) => console.error('[sw] goal resume failed', e))
      .then(() => settingsStore.load())
      .then(() => sessionCache.sessionGet('currentSessionId'))
      .then((/** @type {any} */ cur) => maybeAutoResume(cur)).catch(() => {});
  } else {
    // Vault not resumed (locked): still rehydrate goal runs so the Goal bar is
    // restored; their next turn pauses on the locked vault and waits for unlock.
    // No auto-resume here — it needs an unlocked vault to call the model.
    goalRunner?.resume().catch((e) => console.error('[sw] goal resume failed', e));
  }
  // DESIGN-17 P1: redrain any in-flight actor message→reply correlations the SW
  // death interrupted. Once-guarded + internally gated on an unlocked vault (a
  // re-queued actor turn needs the model key); also fires on the first vault
  // unlock if the SW booted locked. resolveActor lazy-loads the registries, so
  // no ordering vs goal/auto-resume above is needed (actor sessions are separate).
  maybeRedrainMailbox();
}).catch((e) => console.error('[sw] attemptResume failed', e));

// One-time cleanup of Ralph's leftover storage. Ralph (removed 2026-06-22) wrote
// its plan + loop state to these storage.local keys; nothing reads them now, so
// delete them so an upgraded install doesn't carry dead state forever. Cheap
// no-op once gone; safe to run every boot.
for (const deadKey of ['ralph.plan.v1', 'ralph.loop.v1']) {
  Promise.resolve(kv.delete(deadKey)).catch(() => {});
}

// Background scheduling: rehydrate the registered routines on every SW spawn and
// run a catch-up pass. This is the primary "run it as soon as peerd is back on"
// junction — a routine whose nextRunAt already passed (browser was off, SW was
// evicted) fires here. resumeSchedules self-defers while the vault is locked (a
// firing needs the model key) and the vault/unlock path re-runs it, so calling it
// unconditionally is safe. It resumes goal runs BEFORE ticking (so a paused
// goal-mode routine isn't fired twice — see resumeSchedules). The chrome.alarms +
// onStartup wakes cover the cases where no SW spawn otherwise happens.
resumeSchedules();
