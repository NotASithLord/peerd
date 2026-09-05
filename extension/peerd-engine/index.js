// @ts-check
// peerd-engine — public surface.
//
// Four instance kinds. Each is a SEALED ISOLATE (a V8 realm: Notebook/Pod/App -
// or a WASM machine in one — WebVM), HOSTED today in its own discrete tab the
// user can see. The tab is the host + observability surface, NOT the sandbox
// itself; "hosted in a tab," not "is a tab". Visible-by-default is a deliberate
// trust choice — a headless offscreen-Worker host is a reserved future option
// for cheap parallel compute (the spawn* placeholders in the worker peerd.*
// surface mark the slot). See DECISIONS #25.
//
//   • WebVM (vm-tab/) — CheerpX-emulated Debian. POSIX, binaries, the
//     heavy hitter. Use for real shells and multi-language stacks.
//   • Notebook (notebook-tab/) — a Web Worker with its own JS realm and an
//     OPFS-backed scratch. Lightweight (~hundreds of ms to boot). Use
//     for vanilla JS compute the agent owns.
//   • App (app-tab/) — a stored HTML document rendered in a sandboxed
//     iframe. User-facing artifacts the agent built FOR the user
//     (calculators, charts, tools). Metadata in chrome.storage.local,
//     body in IDB, content-addressable + searchable.
//
// Per kind we export: a registry (persistent catalog + per-session
// "current" pointer) and a tab path constant. Tab spawning + live
// tabId tracking live in background/<kind>-tab-tracker.js. The
// runtimes themselves (CheerpX, the worker, the iframe) live in the
// respective tab pages.

// --- WebVM (CheerpX Linux) ----------------------------------------------
export {
  createVmRegistry,
  VM_TAB_PATH,
} from './vm-registry.js';

// --- Module resolver (used by Notebooks; pure, host-injects file I/O) ---
// resolveRelativePath/stripExports are internal-only — their tests import
// them via the deep path, so they're not re-exported here.
export {
  buildModule,
  buildEntry,
  isRemoteSpecifier,
  makeFetchRemote,
} from './module-resolver.js';
export { linkSingleModuleWorker, linkSingleModuleWorkerDetailed } from './single-module-linker.js';

// --- Editor (CodeMirror + file tree + OPFS, used by Notebook & App tabs) ---
export { createEditor } from './editor.js';

// --- OPFS helpers (rooted; usable in any extension context) ---
export { opfsHelpers } from './opfs.js';

// --- Browser-native Git repositories (trusted engine resource) ----------
export { createRepositoryService } from './repository/repository-service.js';
export { normalizeGitRemote } from './repository/remote.js';
export { buildAppManifest, parseAppManifest } from './app-manifest.js';

// --- App asset classification (text composition vs byte delivery) -------
export {
  isBinaryAssetPath,
  isBinaryAppFile,
  inferAppFileKind,
  isLosslessUtf8Text,
  MAX_MODEL_APP_FILE_BYTES,
} from './app-assets.js';

// --- App composition (multi-file → single HTML body for the runner) ---
export { composeApp, stripMetaRefresh } from './app-compose.js';
export {
  VMNotReadyError,
  VMNetworkDeniedError,
  VMBootFailedError,
  VMRunTimeoutError,
  VMTabClosedError,
  REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE,
  REMOTE_MODULE_IMPORTS_UNAVAILABLE_MESSAGE,
  UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE,
  UNSUPPORTED_NATIVE_MODULE_IMPORT_MESSAGE,
  MODULE_SYNTAX_ERROR_CODE,
  MODULE_LINK_ERROR_CODE,
  REMOTE_MODULE_CAPABILITY_BLOCKED_CODE,
  REMOTE_MODULE_RESTRICTED_CODE,
  REMOTE_MODULE_CAPABILITY_BLOCKED_MESSAGE,
  remoteModuleCapabilityBlockedMessage,
  MODULE_IMPORT_POLICY_MESSAGES,
  moduleImportPolicyMessage,
  RemoteModuleImportsUnavailableError,
  UnsupportedNativeModuleImportError,
  ModuleSyntaxError,
  ModuleLinkError,
  RemoteImportBlockedError,
  RemoteModuleCapError,
  RemoteModuleIntegrityError,
  ArtifactTooLargeError,
  EnvelopeFormatError,
  EnvelopeIntegrityError,
} from './errors.js';

// --- Artifact export/import (.peerd envelopes — DESIGN-10) ---------------
// Pure-ish builders + inspect; the SW injects all IO (registry records,
// OPFS trees, the stored image pin).
export {
  buildAppExport,
  buildNotebookExport,
  buildVmRecipeExport,
  openEnvelope,
  inspectEnvelope,
  exportFilename,
  EXPORT_LIMIT_BYTES,
  EXPORT_FILE_LIMIT_BYTES,
} from './export.js';

// --- Per-VM command serialization (pure keyed FIFO; IO injected) ---------
export { createKeyedQueue } from './command-queue.js';

// --- WebVM HTTP-native networking (pure cores; vm-tab.js injects IO) ------
// The wire codec, archive-clone planner, cache policy, and socket stubs
// behind the VM's one networking chokepoint (vm-net/README + VM-NETWORKING.md).
export {
  GET_MARKER,
  REQ_MARKER,
  MAX_REQ_BODY_BYTES,
  isWriteMethod,
  needsWebWriteConfirm,
  normalizeRequest,
  encodeRequest,
  decodeRequest,
  parseMarkerLine,
  findNextMarker,
  partialMarkerHoldIndex,
  encodeResponseMeta,
  normalizeGitHost,
  isPlausibleGitToken,
  gitSecretName,
  gitHostFromSecretName,
  authHostForRequestUrl,
  gitAuthHeader,
  MAX_CACHE_ENTRY_BYTES,
  isRequestCacheable,
  isResponseStorable,
  cacheKey,
  revalidationHeaders,
  isFresh,
  UNSUPPORTED_NET_COMMANDS,
  stubMessage,
  stubsBash,
  runControlOp,
  makeVmHttpFetch,
  makeInjectGitAuth,
  WEB_WRITE_CONFIRM_KEY,
  bannerText,
  peerdNetBash,
  aptShimsBash,
  friendlyFetchError,
} from './vm-net/index.js';

// --- Base-image integrity pin (pure decision logic; vm-tab injects IO) ---
export {
  IMAGE_PIN_HEAD_BYTES,
  IMAGE_PIN_STORAGE_KEY,
  parseContentRangeTotal,
  evaluateImagePin,
} from './image-pin.js';

// Internal scaffolding kept for the engine tests (openOverlay
// covers the IDB block device). vm-tab.js doesn't import it
// because it talks to CheerpX directly.
export { openOverlay } from './overlay.js';

// --- Notebook (Web Worker) ----------------------------------------------
export {
  createNotebookRegistry,
  NOTEBOOK_TAB_PATH,
  NOTEBOOK_OPFS_ROOT,
} from './notebook-registry.js';

// --- Pod (sealed shell/WASI jobs + OPFS workspace) ----------------------
export {
  createPodRegistry,
  POD_TAB_PATH,
  POD_OPFS_ROOT,
} from './pod-registry.js';
export {
  PodShellSyntaxError,
  tokenizePodShell,
  parsePodShell,
  podGitRemoteIntents,
  podGitRemoteOperation,
  matchPodGrep,
  expandPodWord,
  executePodShell,
} from './pod-shell.js';

// --- App (multi-file in OPFS, rendered in a sandboxed iframe) -----------
export {
  createAppRegistry,
  APP_TAB_PATH,
} from './app-registry.js';
