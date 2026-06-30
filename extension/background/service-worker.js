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
import { CHANNEL_DEFAULTS, CHANNEL, DWEB_ENABLED } from '/shared/channel-config.js';
import { openHome } from '/shared/open-home.js';
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
  // DESIGN-18 P1: the API actor's credentialed boundary fetch (session scope + the
  // keyless origin:<origin> key injection) + the Settings → API integrations routes.
  withApiCredentials,
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

import {
  listProviders,
  // page-reader (do/get/check) runner-model resolution: pin → local → provider
  // default → inherit. Pure; the SW resolves it per tool-context build.
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
  // cost telemetry (feature 06): local pricing table + cost math.
  costOf,
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
  // core (fail closed) before the turn starts.
  prepareUserAttachments,
  makeSpawnSubagent,
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
  filterByInstanceState,
  filterByDwebEnabled,
  filterByDwebActive,
  filterByGoalActive,
  makeGoalRunner,
  GOAL_MAX_ITERATIONS,
  makeToolsCommand,
  dispatchToolCall,
  BUILTIN_TOOLS,
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
  normalizeTally, makeTurnCostTracker,
  // transfer (settings export/import — dual-distribution §10)
  buildExport,
  inspectImport,
  applyImport,
  ExportPassphraseError,
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
  // DESIGN-11: wrap an async-subagent's model-authored result (possibly
  // page-derived) as UNTRUSTED before it re-enters the parent's context.
  wrapUntrusted,
  // DESIGN-11: the async-subagent orchestrator (testable; the SW injects its IO).
  makeAsyncSubagents,
  // DESIGN-17: the message_actor orchestrator + the actor capability-tier
  // helpers the actor tool context is built from (keyless strip + kind scope).
  makeActorMessaging, restrictCtxCapabilities, actorAllowedToolsFor, EXPOSURE_ACTOR,
  // DESIGN-17: web-actor core — tab→session bindings, the chat→web-actor
  // registry (the 0-or-1-tab actor), + the self-fenced summary.
  makeWebActorTabBindings, makeWebActorRegistry, fenceWebActorSummary,
  // DESIGN-18: API-actor core — the origin-keyed bindings, the origin normalizer
  // (addressing + same-origin-lock anchor), and the "what I learned" self-fence.
  makeApiActorBindings, normalizeApiOrigin, fenceApiActorSummary,
  finalAssistantText,
  // The informational "pull peerd in" reminder injected into peerd-opened web tabs.
  pullInHintInjected,
} from '/peerd-runtime/index.js';

import { flattenCategorisedDenylist, normalizeDenylistPattern } from '/peerd-egress/index.js';

import { createVmClient } from './vm-client.js';
import { createVmTabTracker } from './vm-tab-tracker.js';
import { createJsClient } from './notebook-client.js';
import { createJsTabTracker } from './notebook-tab-tracker.js';
import { makeOffscreenJsClient } from './offscreen-js-client.js';
import { makeOffscreenPdfClient } from './offscreen-pdf-client.js';
import { makeUiPorts } from './ui-ports.js';
import { decidePullIn } from './panel-affordance.js';
import { createAppClient, APP_TAB_GROUP_TITLE } from './app-client.js';
import { createAppTabTracker } from './app-tab-tracker.js';
import {
  createVmRegistry,
  createNotebookRegistry,
  createAppRegistry,
  // artifact export/import (.peerd envelopes — DESIGN-10)
  opfsHelpers,
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
} from '/peerd-engine/index.js';
import { createDebuggerPool } from './debugger-pool.js';
import { normalizeSettingsPatch } from './settings-patch.js';
import { makeSettingsStore } from './settings-store.js';
import { makeDenylistStore } from './denylist-store.js';
import { makeSessionState } from './session-state.js';
import { makeLocalModelState } from './local-model-state.js';
import { makeProfileState } from './profile-state.js';
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
import { makeSettingsRoutes } from './routes/settings.js';
import { makeSessionMutationRoutes } from './routes/session-mutations.js';
import { makeLocalModelRoutes } from './routes/local-model.js';
import { makeDwebRoutes } from './routes/dweb.js';

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
    // why: the page-reader runner's fast default for this provider (Haiku on
    // Anthropic). Surfaced so the settings UI can show it as the "blank =
    // this" placeholder and buildToolContext can resolve the runner model.
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

// Curated model options per provider, for the per-chat model picker.
// Conservative on purpose — only ids we're confident resolve, so the
// picker never offers a 404. Exotic models go through the free-form
// model field in Settings. The picker also appends whatever model the
// user has configured in Settings if it isn't already listed here.
const MODEL_CATALOG = Object.freeze({
  anthropic: [
    { model: 'claude-opus-4-8',            label: 'Claude Opus 4.8' },
    { model: 'claude-sonnet-4-6',          label: 'Claude Sonnet 4.6' },
    { model: 'claude-haiku-4-5-20251001',  label: 'Claude Haiku 4.5' },
  ],
  // The fallback set shown until the user curates their own (openrouterChatCatalog).
  // Led by the current best open-weights tool-calling models (mid-2026), so a
  // fresh OpenRouter user gets a strong default without curating first.
  openrouter: [
    { model: 'z-ai/glm-5.1',          label: 'GLM-5.1 (open · tool-calling)' },
    { model: 'moonshotai/kimi-k2.6',  label: 'Kimi K2.6 (open)' },
    { model: 'minimax/minimax-m2',    label: 'MiniMax M2 (open · cheap)' },
    { model: 'openai/gpt-4o',         label: 'GPT-4o' },
  ],
  // Local WebGPU — only surfaced once downloaded/resident (gated in buildModelOptions).
  'local-webgpu': [
    { model: LOCAL_MODEL_ID, label: 'Gemma 4 E2B' },
  ],
});

// Live model inventory cache (providers with `liveModels`, i.e. Ollama
// /api/tags). Short TTL: chat-view mounts call models/options freely, and
// hammering the local daemon buys nothing. A FAILED probe (daemon down)
// is cached as null for the same TTL so the picker degrades quietly
// instead of retry-storming localhost.
const LIVE_MODELS_TTL_MS = 30_000;
/** @type {Map<string, { at: number, list: Array<{model:string,label:string}> | null }>} */
const liveModelsCache = new Map();
const liveProviderModels = async (/** @type {string} */ name) => {
  const hit = liveModelsCache.get(name);
  if (hit && Date.now() - hit.at < LIVE_MODELS_TTL_MS) return hit.list;
  let list = null;
  // ollamaHost (issue #104) lets the live inventory fetch a remote daemon's
  // /api/tags; non-ollama adapters ignore it.
  try { list = await listProviderModels(name, { safeFetch, ollamaHost: settingsStore.get().ollamaHost }); }
  catch { list = null; }
  liveModelsCache.set(name, { at: Date.now(), list });
  return list;
};

// OpenRouter's chat catalog = the user's CURATED selection (Settings →
// Providers), each id mapped to a picker option. why curated and not the live
// ~300-model list: the gateway has too many models to dump into a chat
// dropdown. Until the user curates, fall back to the small static set we KNOW
// resolves, so a fresh OpenRouter user still gets a working picker (no 404).
const openrouterChatCatalog = () => {
  const picked = Array.isArray(settingsStore.get().openrouterModels) ? settingsStore.get().openrouterModels : [];
  const ids = picked.filter((/** @type {any} */ id) => typeof id === 'string' && id.trim()).map((/** @type {any} */ id) => id.trim());
  if (ids.length === 0) return MODEL_CATALOG.openrouter;
  return ids.map((/** @type {any} */ id) => ({ model: id, label: id }));
};

// Live per-model context window, for the dynamic trim trigger. A model's
// window is effectively constant for its id, so once we learn it we keep it
// for the LIFETIME of this service worker — no timer, no TTL. The cache is a
// plain Map checked lazily when a turn needs the value; the MV3 SW's own
// frequent teardown (idle reclaim wipes module state) is what eventually
// re-fetches, so a time-based expiry would be redundant theater on top of it.
//
// why NON-BLOCKING: the lookup is a network round-trip and the trigger has a
// correct static-table fallback, so blocking the turn on it would add latency
// for no correctness gain. A cache MISS returns undefined (the turn uses the
// table) and kicks off a one-shot background fetch; the live value refines
// LATER turns — the mechanical-fallback-then-async-refine shape used
// elsewhere (trim enrichment). We cache only SUCCESSES; a failed/null lookup
// is left UNCACHED so a transient failure (locked vault, daemon briefly down)
// is retried next turn instead of sticking.
/** @type {Map<string, { window: number } | { fetching: true }>} */
/** @type {Map<string, any>} */ const contextWindowCache = new Map();
const liveContextWindow = (/** @type {string} */ provider, /** @type {string} */ model) => {
  if (!provider || !model) return undefined;
  const key = `${provider}::${model}`;
  const hit = contextWindowCache.get(key);
  if (hit && typeof hit.window === 'number') return hit.window; // learned → keep for SW lifetime
  if (hit && hit.fetching) return undefined;                    // in-flight → don't fire a second
  contextWindowCache.set(key, { fetching: true });
  providerModelContextWindow(provider, model, { getSecret, safeFetch })
    .then((w) => {
      if (typeof w === 'number') contextWindowCache.set(key, { window: w });
      else contextWindowCache.delete(key); // miss → drop so the next turn retries
    })
    .catch(() => contextWindowCache.delete(key));
  return undefined;
};

/**
 * Build the per-chat model options + the currently-selected value
 * (`provider::model`). The side panel shows a picker above the composer when
 * there are 2+ options.
 *
 * Two modes:
 *   - FRESH chat (no sessionId, or the session doesn't exist): every
 *     key-configured provider's catalog + the Settings-configured model;
 *     `selected` follows the active provider; `sessionProvider` is null.
 *   - MID-SESSION (sessionId resolves to a session): scoped to THAT session's
 *     provider only (model-only switching — the provider is fixed once a chat
 *     starts); `selected` is the session's current model and is always present
 *     even if it's a custom id; `sessionProvider` names the locked provider.
 *
 * Keyless/live providers (Ollama): the "has a key" gate becomes "the daemon
 * answered" — its real pulled-model inventory is the catalog. OpenRouter uses
 * the curated catalog above.
 *
 * @param {{ sessionId?: string | null }} [opts]
 */
const buildModelOptions = async ({ sessionId = null } = {}) => {
  const sess = sessionId ? await sessions.get(sessionId).catch(() => null) : null;
  const lockProvider = sess?.provider ?? null;

  const options = [];
  for (const p of listProviders()) {
    // Mid-session is model-only within the session's provider.
    if (lockProvider && p.name !== lockProvider) continue;
    let hasKey = false;
    if (p.keyless) {
      hasKey = true;
    } else {
      try { hasKey = !!(await vault.getSecret(/** @type {string} */ (p.vaultSecretName))); }
      catch { hasKey = false; }
    }
    // why: when locked to a session whose provider key was since removed we
    // still surface that provider's models (and the current one) rather than
    // render an empty picker; the missing-key skip applies to fresh chats only.
    if (!hasKey && !lockProvider) continue;
    // The local WebGPU model only appears once downloaded + resident (the
    // offscreen engine reports `available`); otherwise selecting it would error
    // on the first turn ("local model not loaded"). Hardware capability is gated
    // earlier, at download time (Settings → WebGPU models).
    if (p.name === 'local-webgpu' && !localModelState.available()) continue;
    let catalog = (/** @type {any} */ (MODEL_CATALOG))[p.name] ?? [{ model: p.defaultModel, label: p.defaultModel }];
    if (p.name === 'openrouter') catalog = openrouterChatCatalog();
    if (p.liveModels) {
      const live = await liveProviderModels(p.name);
      if (live) catalog = live;
      else if (!lockProvider) continue; // unreachable → offer nothing, not a guess
    }
    for (const c of catalog) {
      options.push({
        provider: p.name,
        providerLabel: p.label,
        model: c.model,
        label: c.label,
        value: `${p.name}::${c.model}`,
      });
    }
    // Append the user's Settings-configured model for this provider if
    // it's a custom id not already in the catalog.
    if (settingsStore.get().providerName === p.name && settingsStore.get().providerModel
        && !options.some((o) => o.value === `${p.name}::${settingsStore.get().providerModel}`)) {
      options.push({
        provider: p.name,
        providerLabel: p.label,
        model: settingsStore.get().providerModel,
        label: `${settingsStore.get().providerModel} (custom)`,
        value: `${p.name}::${settingsStore.get().providerModel}`,
      });
    }
  }

  /** @type {any} */ let selected;
  let sessionProvider = null;
  if (sess?.provider) {
    sessionProvider = sess.provider;
    selected = `${sess.provider}::${sess.model}`;
    // Always keep the session's CURRENT model selectable, even if it's a
    // custom id outside the catalog — otherwise the dropdown would show the
    // wrong value as selected.
    if (!options.some((o) => o.value === selected)) {
      options.push({
        provider: sess.provider,
        providerLabel: listProviders().find((p) => p.name === sess.provider)?.label ?? sess.provider,
        model: sess.model,
        label: `${sess.model} (current)`,
        value: selected,
      });
    }
  } else {
    const active = resolveActiveProvider();
    selected = `${active.name}::${active.model}`;
    // If the active selection isn't a usable option (e.g. its provider has
    // no key), fall back to the first option so the picker shows something
    // valid.
    if (!options.some((o) => o.value === selected)) {
      selected = options[0]?.value ?? selected;
    }
  }
  return { options, selected, sessionProvider };
};

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
  audit: (e) => { auditLog.append(e).catch(() => {}); },
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
// reads from this; inspect_denylist (the tool) reads from it too.
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
const loadDenylist = async () => {
  /** @type {any[]} */ let seed = [];
  try {
    const res = await fetch('/peerd-egress/denylist/default.json');
    if (!res.ok) console.error('[sw] denylist seed fetch failed:', res.status);
    else seed = flattenCategorisedDenylist(await res.json());
  } catch (e) {
    console.error('[sw] denylist load threw', e);
  }
  await denylistStore.load(seed);
  console.log('[sw] denylist loaded —', denylistStore.patterns().length, 'patterns');
};
/** @type {Promise<void>} */
const denylistReady = loadDenylist();

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

/**
 * Build a ToolContext for the current call. The agent loop (commit 2)
 * will pass this into the dispatcher per tool call; the side-panel
 * verify-without-LLM affordance uses it directly. We snapshot the
 * provider + vault state so tools see a consistent view during a
 * single dispatch.
 */
const buildToolContext = async (/** @type {any} */ { sessionId: overrideSessionId, activeTabId, exposure, synthetic, trusted, actorInstanceId, actorType, actorBacking } = {}) => {
  // SECURITY: never build a tool context against an unloaded denylist. The seed
  // loads async; this await closes the cold-start race so the origin gate always
  // sees the real denylist before any tool can dispatch. Resolves (never
  // rejects) — it cannot hang the turn. Every dispatch path (main turn, direct
  // dispatch, subagents) routes through here, so all are covered.
  await denylistReady;
  // why: the override lets the subagent orchestrator build a context
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
  // here — main turn, direct dispatch, subagents — enforces it.
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
    // why: a browser-runner (do/get/check) is PINNED to one specific tab,
    // passed as activeTabId. Resolve activeTab to THAT tab so its DOM tools
    // target it — and, critically, so ctx.activeTab.origin is the runner's tab
    // for the origin/denylist gate. With no activeTabId this is the original
    // behaviour: the chat's current active tab.
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
  // The page-reader runner (do/get/check) model, resolved once per ctx build:
  // explicit pin → local WebGPU runner (when it ships) → this provider's fast
  // default (Haiku) → inherit (''). get/check read ctx.runnerModel; runRunner
  // still falls back to the inherited chat model at runtime if it struggles.
  const runnerProvider = listProviders().find((p) => p.name === ctxProviderName);
  const runnerModel = resolveRunnerModel({ settings: settingsStore.get(), provider: runnerProvider, localRunner: localRunnerState() });
  const ctx = {
    // why: the exposure gate (gates.js) reads this. 'main' is set ONLY on
    // the main agent turn; it makes the main-hidden DOM/page tools refuse
    // at dispatch, so a prompt-injected model can't reach them by name. The
    // runner / subagents leave it unset (they hold those tools by design).
    // DESIGN-17: an actor turn sets 'actor' — the kind-scoped, instance-
    // pinned tier (and the capability strip below makes its ctx keyless).
    exposure: exposure ?? null,
    synthetic: synthetic === true,
    // DESIGN-17: the message_actor sender gate's untrusted-ORIGIN signal. A
    // synthetic turn (goal continuation / async wake / actor reply-wake) is
    // "inbound" — refused — UNLESS it is an explicit first-party continuation
    // that set trusted:true (goal turns + actor reply-wakes do). FAIL-CLOSED:
    // any NEW re-entry source (future peer messages / scheduled tasks) is inbound
    // by default and must never set trusted; the gate's `=== active` check is the
    // second wall. Direct/composer builds: synthetic false → inbound false.
    inbound: synthetic === true && trusted !== true,
    // DESIGN-17: an actor's bound instance + kind (the gate's per-instance pin
    // + positive kind-scope read these; absent on non-actor ctx).
    ...(actorInstanceId ? { actorInstanceId } : {}),
    ...(actorType ? { actorType } : {}),
    // DESIGN-18: a web actor's backing (the gate reads it to refuse DOM tools for an
    // API actor, which has no tab). Absent = tab backing (the DESIGN-17 default).
    ...(actorBacking ? { backing: actorBacking } : {}),
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
    // why: progressive-disclosure state for the exposure gate (which is sync).
    // ONLY the main turn gates on it; subagents / the runner / direct dispatch
    // hold full tools, so leave it null there (the gate skips the check). The
    // main turn restamps this per step via refreshTools so an op revealed after
    // a mid-turn create also passes the gate.
    instanceState: exposure === 'main' ? await computeMainInstanceState(sessionId) : null,
    session: {
      sessionId: sessionId ?? null,
      // why: the spawn_subagent tool reads ctx.session.depth to compute
      // the child's depth (parent + 1) and enforce maxDepth. Defaults to
      // 0 for legacy sessions written before the field existed.
      depth: activeSession?.depth ?? 0,
    },
    // Plan/Act permission policy input. The persona gate reads
    // permission.mode to enforce Plan's read-only block; the dispatcher
    // reads permission.confirmActions to decide whether each non-read
    // action confirms. { mode: 'plan'|'act', confirmActions: boolean }.
    permission,
    activeTab,
    // why: the bound subagent orchestrator. The spawn_subagent tool calls
    // ctx.spawnSubagent(...) to decompose a task into a child session
    // that runs the same loop. Wired below; see makeSpawnSubagent.
    spawnSubagent,
    // DESIGN-17: the message_actor orchestrator (wired below). An actor's own
    // ctx strips this back out (it's not in its toolset, so the keyless narrowing
    // removes it).
    messageActor: (/** @type {any} */ req) => actorMessaging.messageActor(req),
    // why: DESIGN-11 async subagents. spawnSubagentAsync fires the child
    // fire-and-forget and returns a handle; its result re-enters the parent
    // as a later synthetic turn. subagentTasks/subagentCancel back the
    // subagent_tasks (peek) and subagent_cancel tools, scoped to THIS session.
    spawnSubagentAsync,
    subagentTasks: () => subagentTasksSnapshot(sessionId),
    subagentCancel: (/** @type {string} */ taskId) => subagentCancel(sessionId, taskId),
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
    // js_run — a HEADLESS sibling: the same sealed worker, hosted in the
    // offscreen doc (no tab). Defined after ensureOffscreen below.
    jsOffscreenClient,
    // read_pdf — PDF text extraction in the offscreen doc (pdf.js needs a
    // Worker the SW can't host). Defined after ensureOffscreen below.
    pdfOffscreenClient,
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
      block: async (/** @type {any} */ { did, block = true, reason } = {}) => { await ensureOffscreen(); return browser.runtime.sendMessage({ type: block ? 'dweb/base-host/ban' : 'dweb/base-host/unblock', did, reason }); },
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
    // it's absent on the main/runner/subagent ctx (actorType unset). adoptWebTab
    // is defined later in the file — referenced lazily here (called at turn time),
    // the same late-bound pattern as noteAgentTab.
    // DESIGN-18: an API actor (backing:'api') never renders — no tab, ever — so it
    // does NOT get the render hook (only a tab-backed web actor lazily adopts a tab).
    ...(actorType === 'web' && actorBacking !== 'api' ? { adoptWebTab: () => adoptWebTab(sessionId) } : {}),
    scripting: browser.scripting,
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
    // why: web tools open background tabs unconditionally (never-steal-
    // focus policy, 2026-06-12); settings ride along for other consumers.
    settings: { ...settingsStore.get() },
    // why: the resolved page-reader runner model (see above). get/check pass
    // it as the runner's model; '' means inherit the chat model.
    runnerModel,
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
  // DESIGN-17: an ACTOR gets a KEYLESS, kind-narrowed tool context — the
  // do/get/check runner trust model generalized. restrictCtxCapabilities strips
  // every capability closure (getSecret, safeFetch, webFetch, spawnSubagent,
  // memory, messageActor, …) that none of the actor's OWN kind tools need,
  // so a confused/injected tool has no path to secrets/egress/spawn. The loop
  // still gets the provider key via the turn driver's injected getSecret (off
  // this ctx), exactly like a subagent. Non-actor ctx is unchanged.
  if (exposure === EXPOSURE_ACTOR) {
    // DESIGN-18: an API actor's allow-set is fetch_url-only (backing-aware), so the
    // strip drops the closures keyed in CAPABILITY_CONSUMERS that fetch_url doesn't use
    // (getSecret/safeFetch/adoptWebTab/engine/spawn/…). NB scripting + debuggerPool are
    // NOT in CAPABILITY_CONSUMERS (shared with the do/get/check runner), so they survive
    // here — the no-DOM guarantee for an API actor rests on the GATE refusing every DOM
    // tool (isAllowedForActor → fetch_url only), not on this strip.
    const resCtx = restrictCtxCapabilities(ctx, new Set(actorAllowedToolsFor(actorType, actorBacking)));
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
      resCtx.webFetch = withApiCredentials(webFetch, () => ownedOrigin, {
        getSecret: (/** @type {string} */ name) => vault.getSecret(name),
        audit: (/** @type {any} */ e) => auditLog.append(e),
      });
      // No repinActiveTab / adoptWebTab: an API actor has no tab to adopt or re-pin.
    } else if (actorType === 'web') {
      resCtx.webFetch = withSessionScopedCredentials(
        webFetch,
        () => /** @type {{ origin?: string } | undefined} */ (resCtx.activeTab)?.origin,
      );
      // navigate adopts the actor's tab MID-TURN (0->1). It re-pins through this setter
      // — which closes over the SHARED resCtx — NOT a direct activeTab= on the per-call
      // {...ctx} copy the dispatcher hands each tool (that write would die with the copy),
      // so the rest of the turn's DOM tools + the session-scoped webFetch above see the
      // adopted tab. (The >=1-tab case mutates activeTab in place, which the shallow copy
      // already shares; only the 0->1 reassignment needs the setter.)
      resCtx.repinActiveTab = (/** @type {any} */ tab) => { resCtx.activeTab = tab; };
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
// Subagent orchestrator — one orchestrator, two surfaces.
// ---------------------------------------------------------------------------
//
// makeSpawnSubagent (peerd-runtime/subagent) stays pure with everything
// injected; the SW binds the real loop/model/dispatcher/store/prompt/
// audit. Both the spawn_subagent tool (via ctx.spawnSubagent) and the
// subagent/spawn route (Notebook peerd.runtime.runAgent) call the same bound fn,
// so they share audit, gates, trust inheritance, and caps. The bound fn
// also defaults a live-event forwarder that streams the child's turn to
// the side panel's nested transcript, keyed by the child session id.

const forwardSubagentEvent = (/** @type {any} */ ev) => {
  if (!uiConnected()) return;
  const post = (/** @type {any} */ msg) => {
    try { uiPorts.broadcast(msg); }
    catch (e) { console.warn('[sw] subagent forward failed', e); }
  };
  // why: distinct turn/subagent-* types (not the parent's turn/*) so the
  // side panel routes them into the per-child nested store instead of
  // clobbering the active chat's transcript.
  switch (ev.type) {
    case 'subagent-start':
      post({ type: 'turn/subagent-start', parentToolUseId: ev.parentToolUseId, parentSessionId: ev.parentSessionId, sessionId: ev.sessionId, depth: ev.depth, task: ev.task });
      break;
    case 'subagent-stop':
      post({ type: 'turn/subagent-done', parentToolUseId: ev.parentToolUseId, sessionId: ev.sessionId, depth: ev.depth });
      break;
    case 'state':
      post({ type: 'turn/subagent-state', session: ev.session });
      break;
    case 'delta':
      post({ type: 'turn/subagent-delta', sessionId: ev.sessionId, messageId: ev.messageId, text: ev.text });
      break;
    case 'tool-use':
      post({ type: 'turn/subagent-tool-use', sessionId: ev.sessionId, messageId: ev.messageId, toolUseId: ev.toolUseId, name: ev.name, input: ev.input });
      break;
    case 'tool-result':
      post({ type: 'turn/subagent-tool-result', sessionId: ev.sessionId, toolUseId: ev.toolUseId, result: ev.result });
      break;
    case 'stop':
      post({ type: 'turn/subagent-stop', sessionId: ev.sessionId, messageId: ev.messageId, stopReason: ev.stopReason });
      break;
    case 'error':
      post({ type: 'turn/subagent-error', sessionId: ev.sessionId, messageId: ev.messageId, error: ev.error });
      break;
    case 'usage':
      // why: subagent/runner spend is SEPARATE from the main turn tally (the
      // main usage handler only folds its own session). Forward it so the eval
      // harness — and any future runner-cost meter — can attribute the offloaded
      // do/get/check work honestly instead of it looking free.
      post({ type: 'turn/subagent-cost', sessionId: ev.sessionId, usage: ev.usage });
      break;
    default:
      break;
  }
};

const spawnSubagentCore = makeSpawnSubagent({
  sessions,
  runUserTurn,
  callModel: /** @type {any} */ (callModel),
  getSecret,
  safeFetch,
  appendAudit: /** @type {any} */ (auditLog.append),
  buildToolContext,
  dispatchToolCall: /** @type {any} */ (dispatchToolCall),
  // why: resolve background-tabs from CURRENT settings at call time, not
  // boot — settings load async and can change over the SW's life. This
  renderSystemPrompt: (opts) => renderSystemPrompt(opts),
  getToolDescriptors: () => listTools().map((t) => ({ name: t.name, description: t.description, schema: t.schema })),
});

// SW-bound spawn. Defaults the live forwarder so neither surface has to
// wire streaming; an explicit onEvent in `req` still wins.
const spawnSubagent = (/** @type {any} */ req) => spawnSubagentCore({ onEvent: forwardSubagentEvent, ...req });

// ---------------------------------------------------------------------------
// Async subagents (DESIGN-11) — orchestration in peerd-runtime/subagent.
// ---------------------------------------------------------------------------
//
// The spawn -> settle -> drain -> re-enter logic lives in a TESTABLE module
// (makeAsyncSubagents, peerd-runtime/subagent/async-subagents.js); the SW only
// injects its IO. spawn_subagent's async path returns a handle immediately and
// the child's result re-enters the parent as a synthetic wake turn via
// turnSlots.runWhenIdle (never aborts a live turn — DECISIONS #20). A per-chat
// LIFETIME cap stops a re-spawn runaway (the live force-quit bug; reproduced in
// tests/peerd-runtime/subagent/async-subagents.test.js).

// Generic, content-free desktop notification (DECISIONS #20): title only —
// NEVER the result text or any watched content.
const notifyAsyncSubagent = (/** @type {number} */ count) => {
  try {
    browser.notifications?.create?.({
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon128.png'),
      title: count > 1 ? `${count} subagents finished` : 'A subagent finished',
      message: 'Open peerd to see the result.',
    });
  } catch (e) { console.warn('[sw] async-subagent notify failed', e); }
};

// Push the live async-task snapshot to the side panel (DESIGN-11 status bar).
// why a snapshot push (not per-event): the orchestrator owns the task list;
// the panel just mirrors it, keyed by parent session so it renders only the
// active chat's in-flight tasks. References asyncSubagentsOrchestrator (defined
// just below) lazily — only ever called at a status transition, long after boot.
const pushAsyncTasks = (/** @type {string} */ parentSessionId) => {
  if (!uiConnected()) return;
  try {
    uiPorts.broadcast({
      type: 'async-tasks/update',
      parentSessionId,
      tasks: asyncSubagentsOrchestrator.subagentTasks(parentSessionId),
    });
  } catch (e) { console.warn('[sw] async-tasks push failed', e); }
};

const asyncSubagentsOrchestrator = makeAsyncSubagents({
  spawnSubagent: (req) => spawnSubagent(req),
  // why lazy (arrows): turnSlots + runAgentTurn are defined LATER in this module
  // (after the agent loop). The orchestrator only calls these at wake time (long
  // after boot), so deferring the references avoids a TDZ at module load.
  turnSlots: {
    runWhenIdle: (sessionId, fn) => turnSlots.runWhenIdle(sessionId, fn),
    isBusy: (sessionId) => turnSlots.isBusy(sessionId),
  },
  // async-subagent wakes are NOT trusted to delegate (a parent reacting to a
  // subagent result stays attended-gated for message_actor, like today) —
  // so this reenter deliberately does not forward trusted.
  reenter: ({ userText, sessionId, synthetic }) => runAgentTurn({ userText, sessionId, synthetic }),
  getActiveSessionId: () => /** @type {Promise<any>} */ (sessionCache.sessionGet('currentSessionId')),
  isVaultLocked: () => vault.isLocked(),
  wrapUntrusted,
  forwardEvent: forwardSubagentEvent,
  notify: notifyAsyncSubagent,
  // Mirror the live task list to the side-panel status bar on every status
  // transition (spawn / settle / cancel / deliver) so the bar never goes stale.
  onTasksChanged: (parentSessionId) => pushAsyncTasks(parentSessionId),
  // Only the runaway guard (REFUSED) logs now — a rare, worth-seeing event.
  log: (msg, data) => console.warn('[async-subagent]', msg, data),
});
const { spawnSubagentAsync } = asyncSubagentsOrchestrator;
// ctx aliases — the subagent_tasks / subagent_cancel tools call these scoped to
// their own session.
const subagentTasksSnapshot = (/** @type {string} */ parentSessionId) => asyncSubagentsOrchestrator.subagentTasks(parentSessionId);
const subagentCancel = (/** @type {string} */ parentSessionId, /** @type {string} */ taskId) => asyncSubagentsOrchestrator.subagentCancel(parentSessionId, taskId);

// On vault unlock, re-drain any async children that finished while locked.
vault.subscribe(() => { if (!vault.isLocked()) asyncSubagentsOrchestrator.onVaultUnlock(); });

// ---------------------------------------------------------------------------
// Clean-context review orchestrator (feature 08).
// ---------------------------------------------------------------------------
//
// makeRequestReview reuses the SAME bound spawnSubagent above — the reviewer
// is a spawned child with a clean session and a READ-ONLY tool subset. We
// inject the full descriptor set WITH sideEffect (the read-only filter's
// input), the audit log, the feature-02 checkpoint adapter (the `since`
// path diffs the current App workspace against a checkpoint), and the
// feature-03 permissions adapter (policy-side read classification,
// intersected with the local filter). Explicit diff / before+after
// snapshots still take priority over the checkpoint path.
const requestReview = makeRequestReview({
  spawnSubagent,
  // why: read-only filtering needs the sideEffect field; the subagent's
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
// Both features share ONE call shape: a tools:[] subagent spawn (clean
// context, output cap) with the spend-limit preflight and the cost fold
// into the parent session's tally built into makeCheapCall — so the
// cost tracker and the user's spendLimitUsd see this background work.

const cheapCall = makeCheapCall({
  spawnSubagent,
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

// Progressive disclosure: the per-session engine-instance snapshot the main
// agent's tool exposure keys on. { webvm, notebook, app } booleans = does THIS
// chat have a current instance of that kind (the secondary ops default to it).
// The create paths (vm_create/vm_boot, js_create/js_notebook, app_create/app_open)
// set the session default, so a kind flips true the moment one is made — and the
// main turn's per-step refresh reveals that kind's ops on the next step. Each
// query self-heals a stale default; a failure degrades to false (fail-closed:
// the ops stay hidden rather than wrongly exposed).
const computeMainInstanceState = async (/** @type {string} */ sid) => {
  if (!sid) return { webvm: false, notebook: false, app: false };
  const [webvm, notebook, app] = await Promise.all([
    vmRegistry.getDefaultForSession(sid).catch(() => null),
    jsRegistry.getDefaultForSession(sid).catch(() => null),
    appRegistry.getDefaultForSession(sid).catch(() => null),
  ]);
  return { webvm: !!webvm, notebook: !!notebook, app: !!app };
};

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
// Prefix match, not exact: the runner-facing tools (snapshot/click/type/
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
// trip — so js_run/read_pdf report a clean "not supported in this build" signal
// the agent can act on, instead of dispatching a job message no context answers
// and surfacing an opaque "headless job failed".
const offscreenAvailable = typeof (/** @type {any} */ (browser)).offscreen?.createDocument === 'function';

// The headless-JS client (the js_run tool). execHeadless ensures the offscreen
// doc, then dispatches a 'job/run' message to job-runner.js hosted there.
// Defined after ensureOffscreen; buildToolContext reads it lazily at dispatch.
const jsOffscreenClient = offscreenAvailable ? makeOffscreenJsClient({
  ensureOffscreen,
  sendMessage: (m) => browser.runtime.sendMessage(m),
}) : null;

// The PDF-extraction client (the read_pdf tool). ensureOffscreen, then a
// 'pdf/extract' message to offscreen/pdf-extract.js (pdf.js in a Worker).
const pdfOffscreenClient = offscreenAvailable ? makeOffscreenPdfClient({
  ensureOffscreen,
  sendMessage: (m) => browser.runtime.sendMessage(m),
}) : null;

// ── Local WebGPU runner bridge (FEATURE-LOCAL-WEBGPU B / M1) ────────────────
// The local-webgpu adapter generates by calling generateLocalForAdapter, which
// drives the offscreen engine (offscreen/local-model.js) and streams its tokens
// back. local-model/{status,init} flip localModelAvailable, which feeds
// resolveRunnerModel step 2 (local-when-available) — so once the model is
// resident it becomes the page-reader runner default with no pin.
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
  // Web-write gate (shared key for fetch_url + the WebVM bridge): when the user
  // has turned confirmWebWrites OFF, non-GET egress is auto-approved — their
  // explicit, risk-acknowledged choice. The session-grant cache still applies
  // when it's on.
  if (prompt.tool === WEB_WRITE_CONFIRM_KEY && settingsStore.get().confirmWebWrites === false) {
    return 'yes_once';
  }
  // why scope the web-write grant by host: the prompt names a SPECIFIC host
  // ("…send a POST request to {host}?"), so "approve for this session" must mean
  // THIS host this session — not a blanket pass for non-GET egress to any host
  // for the rest of the session. The prompt already carries origins:[host]; fold
  // it into the grant key. Every other tool keys by its (already host-specific
  // or host-agnostic-by-design) tool name.
  const grantKey = prompt.tool === WEB_WRITE_CONFIRM_KEY
    ? `${WEB_WRITE_CONFIRM_KEY}|${(Array.isArray(prompt.origins) && prompt.origins[0]) || ''}`
    : prompt.tool;
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
  const answer = await confirmCoordinator.confirm(/** @type {any} */ (prompt));
  if (answer === 'yes_session' && sid && !ephemeral) {
    if (!sessionConfirmGrants.has(sid)) sessionConfirmGrants.set(sid, new Set());
    (/** @type {Set<string>} */ (sessionConfirmGrants.get(sid))).add(grantKey);
  }
  // Ephemeral: an actor's yes_session approves THIS call only (no standing grant).
  return ephemeral && answer === 'yes_session' ? 'yes_once' : answer;
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
      // why: the page-reader runner's fast default for this provider — the
      // Settings "Page-reader model" field shows it as the blank placeholder
      // so "blank" honestly reads as e.g. claude-haiku-4-5, not "inherit".
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
  if (msg?.type === 'vm/tab-ready') {
    if (typeof msg.vmId !== 'string' || sender?.tab?.id == null) return false;
    vmTabTracker.onTabReady(msg.vmId, sender.tab.id);
    return false;
  }
  if (msg?.type === 'js/tab-ready') {
    if (typeof msg.notebookId !== 'string' || sender?.tab?.id == null) return false;
    jsTabTracker.onTabReady(msg.notebookId, sender.tab.id);
    return false;
  }
  if (msg?.type === 'app/tab-ready') {
    if (typeof msg.appId !== 'string' || sender?.tab?.id == null) return false;
    appTabTracker.onTabReady(msg.appId, sender.tab.id);
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
const { runAgentTurn, maybeAutoResume } = makeTurnDriver({
  vault, VaultLockedError, sessionCache, ensureActiveProvider, resolvePermission,
  sessions, sessionState, turnSlots, buildTemporalBlock, memory, browser, originOfTabUrl,
  skillRegistry, renderSystemPrompt, resolveManifestAllow, buildToolContext,
  computeMainInstanceState, filterByDwebActive, filterByDwebEnabled, filterByInstanceState,
  filterDescriptorsByManifest, mainAgentDescriptors, listTools, settingsStore, DWEB_ENABLED,
  filterByGoalActive, goalActiveFor: (/** @type {string} */ sid) => goalRunner?.isActive(sid) ?? false,
  dwebEngagedSessions, markDwebEngaged, dispatchToolCall, maybeNudgeDebuggerGrant, getTool,
  decideAction, listProviders, costOf, makeTurnCostTracker, uiConnected, uiPorts, auditLog,
  resolveFailoverChain, shouldFailover, callModel, runUserTurn, getSecret,
  safeFetch, REASONING_BUDGET_TOKENS, REASONING_EFFORT_LEVELS, DEFAULT_SETTINGS, trimEnricher,
  contextWindowFor, liveContextWindow, currentAppScope, checkpointMgr, detectInterruptedTurn,
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
  onRunEnd: (/** @type {any} */ _sid, /** @type {any} */ info) => {
    if (info?.phase === 'capped') postChatNote(`Goal run stopped — hit the ${GOAL_MAX_ITERATIONS}-turn limit without finishing.`);
    else if (info?.phase === 'halted') postChatNote(info?.reason ? `Goal run stopped (${info.reason}).` : 'Goal run stopped.');
  },
  // why kv: a goal run must survive an SW restart and keep going while the user
  // is in another chat — the runner mirrors active runs to storage.local and
  // resume() (on vault unlock) re-drives them. Without it the run is in-memory
  // only and an MV3 recycle would silently drop it.
  kv,
});

// ---------------------------------------------------------------------------
// 5b2. DESIGN-17 — actor tab agents: the message_actor orchestrator
// ---------------------------------------------------------------------------
// An actor is a per-instance agent that OWNS one tab-hosted instance and
// exclusively holds its tools. The orchestrator (the async-subagents shape,
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
const mintInFlight = new Map();
/** @param {string} key @param {() => Promise<string>} fn @returns {Promise<string>} */
const mintOnce = (key, fn) => {
  const existing = mintInFlight.get(key);
  if (existing) return existing;
  const p = (async () => { try { return await fn(); } finally { mintInFlight.delete(key); } })();
  mintInFlight.set(key, p);
  return p;
};

// Start the actor process on demand: lazily mint an actor session for an
// instance (on the first message_actor). Inherits the spawning chat's RESOLVED
// Plan/Act posture — resolved + stored EXPLICITLY so it can't silently widen to the
// global default (the subagent guardrail-3 precedent). Binds BOTH directions:
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
    // (the subagent precedent, spawn.js): a /tools-narrowed chat can't widen its
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
  return created.sessionId;
};

// DESIGN-17 — WEB actors (a fourth `kind:'web'` actor that owns one TAB).
// Unlike the three engine kinds, a web actor has no registry record: the TAB
// is the durable handle and the binding is tab→session, held here and mirrored to
// session storage (ephemeral by design — on a cold miss we re-mint against the
// live tab, whose DOM re-derives state). The address the orchestrator uses is the
// tabId AS A STRING (the actor's instanceId).
const webActorTabBindings = makeWebActorTabBindings();
const WEB_BINDINGS_KEY = 'webActorTabBindings';
const persistWebBindings = () => {
  sessionCache.sessionSet(WEB_BINDINGS_KEY, webActorTabBindings.entries()).catch(() => {});
};
// Rehydrate on SW boot (best-effort; a missing/garbage value just starts empty).
Promise.resolve(sessionCache.sessionGet(WEB_BINDINGS_KEY))
  .then((e) => { if (Array.isArray(e)) webActorTabBindings.load(/** @type {any} */ (e)); })
  .catch(() => {});

// The chat→web-actor registry — the 0-or-1-tab web actor (addressed by `to:'web'`,
// the SINGLE entry point for web work). Separate from webActorTabBindings because
// the actor exists BEFORE it owns a tab; its tab (when it renders) is read back
// from webActorTabBindings.tabFor (one source of truth). Persisted/rehydrated like
// the tab bindings — ephemeral is fine (re-mint on loss).
const webActorRegistry = makeWebActorRegistry();
const WEB_ACTOR_KEY = 'webActorRegistry';
const persistWebActors = () => {
  sessionCache.sessionSet(WEB_ACTOR_KEY, webActorRegistry.entries()).catch(() => {});
};
Promise.resolve(sessionCache.sessionGet(WEB_ACTOR_KEY))
  .then((e) => { if (Array.isArray(e)) webActorRegistry.load(/** @type {any} */ (e)); })
  .catch(() => {});

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
const persistApiActors = () => {
  sessionCache.sessionSet(API_ACTOR_KEY, apiActorBindings.entries()).catch(() => {});
};
Promise.resolve(sessionCache.sessionGet(API_ACTOR_KEY))
  .then((e) => { if (Array.isArray(e)) apiActorBindings.load(/** @type {any} */ (e)); })
  .catch(() => {});

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
/** @param {{ instanceId: string, ownerChatId: string | null, bind: (sessionId: string) => void, backing?: 'tab' | 'api' }} o */
const mintWebSession = async ({ instanceId, ownerChatId, bind, backing }) => {
  const ownerChat = ownerChatId ? await sessions.get(ownerChatId) : null;
  const perm = await resolvePermission(/** @type {any} */ (ownerChat));
  const created = await sessions.create({
    kind: 'actor',
    ...(ownerChatId ? { parentSessionId: ownerChatId } : {}),
    instanceId,
    actorType: 'web',
    // DESIGN-18: 'api' marks a fetch-only origin actor (no tab); absent = tab backing.
    ...(backing ? { backing } : {}),
    ...(ownerChat?.provider ? { provider: ownerChat.provider } : {}),
    ...(ownerChat?.model ? { model: ownerChat.model } : {}),
    permissionMode: perm.mode,
    confirmActions: perm.confirmActions,
    ...(ownerChat?.toolManifest !== undefined ? { toolManifest: ownerChat.toolManifest } : {}),
  });
  bind(created.sessionId);
  auditLog.append({ type: 'actor_minted', sessionId: created.sessionId, details: { instanceId, kind: 'web', backing: backing ?? 'tab' } }).catch(() => {});
  return created.sessionId;
};

const mintWebActorForTab = async (/** @type {number} */ tabId) => mintWebSession({
  instanceId: String(tabId),
  ownerChatId: /** @type {string | null} */ (await sessionCache.sessionGet('currentSessionId')),
  bind: (sessionId) => { webActorTabBindings.bind(tabId, sessionId); persistWebBindings(); },
});

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

// DESIGN-18 — lazily mint an API actor (a fetch-only origin actor) for (chat, origin).
// The origin IS the instanceId (the egress boundary reads the owned origin straight off
// the ctx) and backing:'api' scopes its toolset to fetch_url + denies it a tab.
const mintApiActor = async (/** @type {string} */ ownerChatId, /** @type {string} */ origin) => mintWebSession({
  instanceId: origin,
  ownerChatId,
  backing: 'api',
  bind: (sessionId) => { apiActorBindings.bind(ownerChatId, origin, sessionId); persistApiActors(); },
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
});

const actorMessaging = makeActorMessaging({
  resolveActor: async (/** @type {string} */ instanceId, /** @type {{ senderSessionId?: string | null }} */ opts = {}) => {
    // The chat's WEB ACTOR — the 0-or-1-tab entry point for page-driving / session web
    // work, addressed by the literal 'web'. It decides fetch-vs-render itself: a
    // pure-fetch task never opens a tab; navigate adopts one on the render path. Owned by
    // the SENDER chat (opts.senderSessionId), not the ambient active chat — so a boot
    // redrain re-attaches to the right actor. (A numeric tabId, below, targets the
    // actor owning that SPECIFIC existing tab — e.g. one the orchestrator open_tab'd.)
    if (String(instanceId) === 'web') return resolveWebActor(opts.senderSessionId);
    // A per-tab WEB actor is addressed by its tabId-as-string (purely numeric, no
    // engine prefix); engine ids (vm-/notebook-/app-) carry a hyphen and never
    // match, so the branch is unambiguous.
    if (/^\d+$/.test(String(instanceId))) {
      return resolveWebActorForTab(Number(instanceId));
    }
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
      if (typeof ownedTab === 'number') tabMsgAnchor.set(ownedTab, parentToolUseId);
    }
    // DESIGN-17 P1 glass pane: when this turn was triggered by a live message_actor
    // call (parentToolUseId present — absent on a boot redrain), pass a `display`
    // descriptor so the turn driver re-emits the actor's stream as turn/actor-*
    // events keyed to that card. The orchestrator renders it inline (the subagent
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
    // oneShot: the loop synthesizes the reply from the first clean tool round and
    // stops (no summarize inference) — finalAssistantText below reads that synthetic
    // assistant message exactly like a normal reply, so nothing else changes here.
    await runAgentTurn({ sessionId: actorSessionId, userText: message, synthetic: false, activeTabId: actorTabId, display, oneShot: oneShot === true });
    const s = await sessions.get(actorSessionId);
    const fresh = finalAssistantText(/** @type {any} */ ({ messages: (s?.messages ?? []).slice(before) }));
    return fresh
      ? { result: fresh }
      : { result: 'the actor turn was stopped before it produced a reply.', stopped: true };
  },
  reenter: ({ userText, sessionId, synthetic, trusted }) => runAgentTurn({ userText, sessionId, synthetic, trusted }),
  turnSlots,
  getActiveSessionId: () => /** @type {Promise<any>} */ (sessionCache.sessionGet('currentSessionId')),
  isVaultLocked: () => vault.isLocked(),
  wrapUntrusted,
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

// The CURRENT AGENT TAB — the single tab the loop most recently created OR
// interacted with (ran a command in, navigated, clicked, …). Agent tabs open in
// the BACKGROUND now (never steal focus), so the chat shows ONE persistent,
// sticky "go to the tab peerd is working in" card pointing here; clicking it is
// the user gesture that focuses the tab AND opens the side panel (Chrome won't
// let the agent/SW open the panel on its own — DESIGN-12). Updated on every
// touch, so it always tracks where the agent IS, not just the last tab created.
// p·cyan e·red e·amber r·green d·magenta — the home agent-tab card's Open button
// draws a fresh one each time the card is (re)generated.
const AGENT_TAB_COLORS = ['#00B7EB', '#EF4444', '#F59E0B', '#22C55E', '#D946EF'];
// DESIGN-17/18 tab-card anchoring: maps an agent tab → the message_actor tool_use that
// LAST drove it. The inline "peerd opened …" notice anchors to THAT message's turn, not
// the wall-clock-latest user message — actor work is async, so a physical tab touch
// (engine ensureTab / web DOM noteTab) often lands during a later turn, which would clump
// the cards at the chat's end. Set at each actor-turn start (runActorTurn) for the actor's
// owned tab; never cleared — overwritten only when a NEW message re-drives that tab, which
// is exactly when the card should resurface to the newer turn. Orchestrator-opened tabs
// (open_tab) are absent here → they keep the wall-clock anchor (correct; they're synchronous).
/** @type {Map<number, string>} tabId → parentToolUseId */
const tabMsgAnchor = new Map();
/** @type {number | null} */ let agentTabId = null;
/** @type {any} */ let agentTabInfo = null;   // the last { tabId, windowId, kind, name, label, color } noted
/** @type {number | null} */ let activeTabId = null;    // the currently-active tab — hide the card when you're ON it
// Broadcast the current-agent-tab pointer. `noted` is true ONLY when this fires
// from a real agent touch (noteAgentTab) — the inline notice creates/resurfaces
// on those; a passive refresh (tab activation, a fresh surface replay) sends
// noted:false so clicking around tabs never bumps a notice.
const broadcastAgentTab = (noted = false) => {
  uiPorts.broadcast({
    type: 'agent/tab',
    tab: agentTabInfo ? { ...agentTabInfo, current: agentTabInfo.tabId === activeTabId, noted } : null,
  });
};
const noteAgentTab = async (/** @type {number} */ tabId, /** @type {any} */ info = {}) => {
  if (typeof tabId !== 'number') return;
  const { kind = null, name = null, label = null, opened = true, parentToolUseId: ptuArg = null } = (typeof info === 'string' ? { label: info } : info);
  // The message_actor turn driving this tab (see tabMsgAnchor) — caller-supplied or the
  // last actor-turn-start mapping. Flows to the agent/tab event so the notice anchors to
  // that message's turn instead of the wall-clock-latest user message.
  const parentToolUseId = ptuArg ?? tabMsgAnchor.get(tabId) ?? null;
  let windowId; let title = null;
  try { const t = await browser.tabs.get(tabId); windowId = t.windowId; title = t.title || t.url || null; }
  catch { return; } // tab already gone — don't point the card at a dead tab
  agentTabId = tabId;
  // Instance tabs carry a kind + the instance NAME (the card reads like a tab:
  // "Notebook | my-nb"); a web tab (open_tab / DOM) just shows its page label.
  const text = (kind && name) ? `${kind} · ${name}` : (label || title || 'a tab');
  // why a fresh brand color each generation (owner): the home card's Open button
  // cycles a peerd brand color (p·cyan e·red e·amber r·green d·magenta) so it
  // stays eye-catching — the sanctioned "peers/actions are the content" accent.
  const color = AGENT_TAB_COLORS[Math.floor(Math.random() * AGENT_TAB_COLORS.length)];
  // `opened`: true when peerd OPENED this tab (open_tab / an engine create) — the
  // only case that mints an inline notice; false when the agent merely ACTED on a
  // tab via do/get/check (the runner), which resurfaces an existing notice but
  // never invents one for a tab the USER opened. `noted: true` marks this as a
  // real agent touch (vs. a passive current-flag refresh on tab activation).
  agentTabInfo = { tabId, windowId, kind, name, label: text, color, opened, parentToolUseId };
  broadcastAgentTab(true);
};
// Track the active tab so the card hides when you're on the agent tab, and shows
// again when you move away.
browser.tabs?.onActivated?.addListener(({ tabId }) => {
  activeTabId = tabId;
  if (agentTabInfo) broadcastAgentTab();
});
// Clear the card when the agent tab closes (clicking a dead tab does nothing).
browser.tabs?.onRemoved?.addListener((tabId) => {
  if (tabId === agentTabId) { agentTabId = null; agentTabInfo = null; broadcastAgentTab(); }
});

// "Pull peerd in" reminder on the regular web pages peerd opens. A peerd-opened
// WEB tab gets a brief, auto-dismissing caption (top-right) that types out
// "Press <shortcut> to pull peerd in" — engine tabs carry the real button, a
// third-party page can't, so this points you at the shortcut/icon. INFORMATIONAL
// ONLY (it never messages the SW back), so it crosses no boundary and needs no
// new permission (docs/PULL-IN-PEERD-WEB-SCOPE.md). One-shot, on first load, via
// chrome.scripting; never on a denylisted/sensitive origin; the injected script
// itself waits until the tab is actually visible before it shows.
// Peerd-opened web tabs (tabId → origin), tracked persistently so we can show
// the reminder at the RIGHT moment: when the user is ACTIVELY VIEWING one with
// the SIDEBAR CLOSED — they walked onto it, OR they closed the panel while on it.
// The page world can't read sidebar state, so the SW gates the inject; the
// injected script is idempotent + auto-dismissing, so re-injecting is safe.
/** @type {Map<number, string>} */
const peerdWebTabs = new Map();
// The peerd toolbar icon as a data: URL, so the injected hint can show it on a
// third-party page without a chrome-extension:// fetch (no web_accessible_
// resources needed). Fetched + cached once; '' if it ever fails (the hint then
// falls back to the wordmark text).
/** @type {string | null} */ let pullInIconUrl = null;
const getPullInIconUrl = async () => {
  if (pullInIconUrl !== null) return pullInIconUrl;
  try {
    const res = await fetch(browser.runtime.getURL('icons/icon32.png'));
    const bytes = new Uint8Array(await res.arrayBuffer());
    pullInIconUrl = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
  } catch (e) {
    console.debug('[sw] pull-in icon load failed', (/** @type {{ message?: string }} */ (e))?.message ?? e);
    pullInIconUrl = '';
  }
  return pullInIconUrl;
};
const showWebTabHint = async (/** @type {number} */ tabId) => {
  if (!peerdWebTabs.has(tabId)) return;
  if (uiPorts.hasNamed('sidepanel')) return;          // sidebar open → the chat's already here
  let tab;
  try { tab = await browser.tabs.get(tabId); } catch { return; }
  if (!tab || tab.status !== 'complete' || tab.active !== true) return; // only when actually being viewed
  // Still the page peerd opened? (don't graffiti the user's own later navigation.)
  let origin;
  try { origin = new URL(/** @type {string} */ (tab.url)).origin; } catch { return; }
  if (origin !== peerdWebTabs.get(tabId)) { peerdWebTabs.delete(tabId); return; }
  let shortcut = '';
  try {
    const cmds = await browser.commands?.getAll?.();
    shortcut = (cmds ?? []).find((c) => c.name === 'pull-in-peerd')?.shortcut || '';
  } catch { /* no commands API in this build */ }
  const iconUrl = await getPullInIconUrl();
  try {
    await browser.scripting.executeScript({ target: { tabId }, func: pullInHintInjected, args: [shortcut, iconUrl] });
  } catch (e) {
    // Pages the browser refuses to inject into (chrome:, the stores, a hard CSP)
    // — harmless; the hint just doesn't show.
    console.debug('[sw] pull-in hint inject skipped', (/** @type {{ message?: string }} */ (e))?.message ?? e);
  }
};
const scheduleWebTabHint = (/** @type {number} */ tabId, /** @type {string} */ url) => {
  if (typeof tabId !== 'number' || typeof url !== 'string') return;
  let u;
  try { u = new URL(url); } catch { return; } // not a real web URL → no hint
  if (!u.protocol.startsWith('http')) return;
  if (matchesDenylist(u.hostname, denylistStore.patterns())) return; // never graffiti a sensitive site
  peerdWebTabs.set(tabId, u.origin);
  showWebTabHint(tabId); // if the user is already viewing it with the sidebar closed
};
// Show when the user WALKS ONTO a peerd web tab, or it finishes loading while
// they're on it. (Sidebar-close is handled at the port disconnect, below.)
browser.tabs?.onActivated?.addListener(({ tabId }) => { showWebTabHint(tabId); });
browser.tabs?.onUpdated?.addListener((tabId, changeInfo) => { if (changeInfo.status === 'complete') showWebTabHint(tabId); });
browser.tabs?.onRemoved?.addListener((tabId) => { peerdWebTabs.delete(tabId); });

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
const startGoalRun = (/** @type {{ sessionId: string, goal: string }} */ req) => /** @type {any} */ (goalRunner)?.start(req);
// why stop() not halt(): user-initiated cancels (Stop button, steer-takeover,
// new-chat, archive) must DURABLY end the run — halt() only marks an in-memory
// run, so a vault-lock-PAUSED run (evicted from the runner's map but kept in the
// kv mirror for resume) would survive a Stop and resurrect on the next unlock.
const haltGoalRun = (/** @type {string} */ sid) => /** @type {any} */ (goalRunner)?.stop(sid);
const resumeGoalRuns = () => /** @type {any} */ (goalRunner)?.resume();
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
  ...makeVaultRoutes({
    vault, auditLog, kv, idb, base64ToBytes, ensureOffscreen, maybeStartBaseNetwork,
    pushState, purgeVaultBlob, confirmCoordinator, sessionCache, maybeAutoResume, resumeGoalRuns,
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
    applyComposer, commandSources, prepareUserAttachments, runAgentTurn, runInit,
    handleSystemCommand, handleToolsCommand, postChatNote, spawnSubagent, requestReview, appClient,
    browser, originOfTabUrl, matchesDenylist, denylistStore,
    // goal mode (the mode-row Goal toggle): start an autonomous run, and halt
    // any active one when the user stops or steers with a fresh message.
    startGoalRun, haltGoalRun, ensureSession,
    // DESIGN-17 P1: agent/stop cascades to this chat's in-flight actors.
    actorMessaging,
  }),
  ...makeEngineRoutes({
    vault, auditLog, pushState, browser, vmHttpFetch, appRegistry, vmRegistry, jsRegistry,
    appClient, appTabTracker, opfsHelpers, NOTEBOOK_OPFS_ROOT, IMAGE_PIN_STORAGE_KEY,
    buildAppExport, buildNotebookExport, buildVmRecipeExport,
    openEnvelope, inspectEnvelope, exportFilename,
    ArtifactTooLargeError, EnvelopeFormatError, EnvelopeIntegrityError,
    ensureOffscreen, settingsStore, DWEB_ENABLED,
  }),
  ...makeSystemRoutes({
    vault, auditLog, sessions, pushState, kv, memory, buildStateSnapshot, closeSidePanel,
    uiPorts, loadUserEndpoints, inspectImport, applyImport, settingsStore, saveUserHook,
    CHANNEL, DEFAULT_SETTINGS, ExportPassphraseError,
  }),
  ...makeDenylistRoutes({ denylistStore, auditLog }),
  ...makeSettingsRoutes({
    vault, auditLog, pushState, kv, memory, settingsStore,
    normalizeSettingsPatch, normalizeVariant, normalizeEngine, listProviders,
    REASONING_EFFORT_LEVELS, DWEB_ENABLED, DEFAULT_SETTINGS,
    buildExport, CHANNEL, exportHooks, skillRegistry,
  }),
  ...makeSessionMutationRoutes({
    vault, auditLog, pushState, sessions, sessionCache, sessionState, autoMemory,
    resolvePermission, normalizeMode, normalizeConfirmActions, SessionNotFoundError,
    maybeAutoResume, haltGoalRun,
  }),
  ...makeLocalModelRoutes({ ensureOffscreen, browser, localModelState }),
  ...makeDwebRoutes({
    vault, auditLog, kv, ensureOffscreen, browser,
    appRegistry, appClient, appTabTracker, opfsHelpers, settingsStore,
    DWEB_ENABLED, DWEB_IDENTITY_SECRET, APP_TAB_GROUP_TITLE,
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
})));

// ---------------------------------------------------------------------------
// 7. Toolbar icon + "pull in peerd" shortcut → home, or pull the chat to the side
// ---------------------------------------------------------------------------

// The toolbar icon is peerd's FRONT DOOR. With no home up yet it opens the
// full-page home — peerd should feel first-party, not a bolted-on sidebar
// (DESIGN-12, owner 2026-06-20). Once home IS up, the icon COMPLEMENTS: it pulls
// the chat into the window-global side panel (Chrome) / sidebar (Firefox) so the
// chat follows you onto ANY tab — including a plain web page peerd opened, the
// case the engine-tab "pull in peerd" button couldn't reach without breaching the
// fail-closed SW boundary (docs/PULL-IN-PEERD-WEB-SCOPE.md). The Alt+Shift+P
// command is the dedicated twin: it ALWAYS pulls the panel in, from anywhere.
//
// Hard constraint: sidePanel.open()/sidebarAction.open() must run SYNCHRONOUSLY
// inside the click/keystroke gesture — no await before them or the activation is
// dropped. So every decision input must be available without awaiting: the
// window id (from the listener's tab arg) and "is home open?" (two sync signals
// below). We cannot tabs.query() in the gesture; decidePullIn is a pure sync fn.

// Sync "is home open?" — a boot-seeded set of home tab ids OR a live home port.
// why both: the set survives an SW respawn (the home port may not have
// reconnected in the instant the icon fires); the port covers a home tab the set
// hasn't learned yet. A miss is benign — openHome() is focus-or-create, so the
// worst case is the first post-respawn click focusing home instead of the panel.
const HOME_URL = browser.runtime.getURL('home/home.html');
/** @type {Set<number>} */
const homeTabIds = new Set();
const trackHomeTab = (/** @type {number} */ tabId, /** @type {string} */ url) => {
  if (typeof url !== 'string') return;
  if (url.startsWith(HOME_URL)) homeTabIds.add(tabId);
  else homeTabIds.delete(tabId);
};
browser.tabs?.query?.({}).then((tabs) => {
  for (const t of tabs) if (t.id != null) trackHomeTab(t.id, t.url ?? '');
}).catch((e) => console.debug('[sw] home-tab bootstrap failed', e));
// A second onUpdated/onRemoved pair (the DOM-ref ones live earlier) — keeping the
// home-tab bookkeeping self-contained here reads cleaner than threading it in.
browser.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url != null || tab?.url != null) trackHomeTab(tabId, /** @type {string} */ (changeInfo.url ?? tab.url));
});
browser.tabs?.onRemoved?.addListener((tabId) => { homeTabIds.delete(tabId); });
const isHomeOpen = () => homeTabIds.size > 0 || uiPorts.hasNamed('home');

// A synchronous current-window id for sidePanel.open({ windowId }). onClicked and
// (modern) onCommand both supply the tab, so this only backstops engines whose
// command callback omits it. Seeded at boot, kept warm on focus changes.
/** @type {number | null} */ let lastFocusedWindowId = null;
browser.windows?.getLastFocused?.().then((w) => { lastFocusedWindowId = w?.id ?? lastFocusedWindowId; }).catch(() => {});
browser.windows?.onFocusChanged?.addListener((winId) => {
  if (winId != null && winId !== browser.windows.WINDOW_ID_NONE) lastFocusedWindowId = winId;
});

// The pull-in itself — open() runs synchronously (no await before it) to keep the
// gesture; a failed/declined open falls back to home so the icon never dead-ends.
const pullInPeerd = (/** @type {number} */ windowId, { fromShortcut = false } = {}) => {
  const target = decidePullIn({
    homeOpen: isHomeOpen(),
    panelOpen: uiPorts.hasNamed('sidepanel'),
    hasSidePanel: !!(/** @type {any} */ (browser)).sidePanel?.open,
    hasSidebar: !!browser.sidebarAction?.open,
    fromShortcut,
  });
  // Toggle-closed (shortcut only) — close needs no gesture, so fire and forget.
  if (target === 'close') { closeSidePanel(); return; }
  try {
    if (target === 'panel' && windowId != null) {
      const p = (/** @type {any} */ (browser)).sidePanel.open({ windowId });
      if (p?.catch) p.catch((/** @type {any} */ e) => { console.warn('[sw] sidePanel.open failed', e); openHome(); });
      return;
    }
    if (target === 'sidebar') {
      const p = browser.sidebarAction.open();
      if (p?.catch) p.catch((e) => { console.warn('[sw] sidebarAction.open failed', e); openHome(); });
      return;
    }
  } catch (e) { console.warn('[sw] pull-in open threw', e); }
  openHome();
};

browser.action?.onClicked?.addListener((tab) => {
  pullInPeerd(/** @type {number} */ (tab?.windowId ?? lastFocusedWindowId), { fromShortcut: false });
});
// Alt+Shift+P (user-rebindable at the browser's extension-shortcuts page) —
// TOGGLES the panel: pulls it in, or closes it if already open. The command
// handler is a VALID user-gesture context on BOTH Chrome and Firefox, so it needs
// no content-script relay — and thus no hole in the fail-closed SW boundary the
// injected-web-page button would have required.
browser.commands?.onCommand?.addListener((command, tab) => {
  if (command !== 'pull-in-peerd') return;
  pullInPeerd(/** @type {number} */ (tab?.windowId ?? lastFocusedWindowId), { fromShortcut: true });
});

loadUserEndpoints();
loadSettings();

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
