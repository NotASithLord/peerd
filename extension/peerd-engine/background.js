// @ts-check
// Background-only engine surface. The universal engine barrel also exports the
// CodeMirror editor, which is a page concern and must not join the MV3 worker's
// cold-start graph.

export { createVmRegistry, VM_TAB_PATH } from './vm-registry.js';
export { createNotebookRegistry, NOTEBOOK_OPFS_ROOT, NOTEBOOK_TAB_PATH } from './notebook-registry.js';
export { createPodRegistry, POD_TAB_PATH } from './pod-registry.js';
export { createAppRegistry, APP_TAB_PATH } from './app-registry.js';
export {
  appFileCheckpointContent, inferAppFileKind, isBinaryAppFile,
  isBinaryAssetPath, isLosslessUtf8Text, MAX_MODEL_APP_FILE_BYTES,
} from './app-assets.js';
export { opfsHelpers } from './opfs.js';
export { IMAGE_PIN_STORAGE_KEY } from './image-pin.js';
export {
  ArtifactTooLargeError, EnvelopeFormatError, EnvelopeIntegrityError,
  VMNotReadyError, VMNetworkDeniedError, VMBootFailedError,
  VMRunTimeoutError, VMTabClosedError,
  REMOTE_MODULE_IMPORTS_UNAVAILABLE_CODE,
  UNSUPPORTED_NATIVE_MODULE_IMPORT_CODE,
  REMOTE_MODULE_CAPABILITY_BLOCKED_MESSAGE,
  REMOTE_MODULE_RESTRICTED_CODE,
  moduleImportPolicyMessage,
} from './errors.js';
export {
  makeVmHttpFetch, WEB_WRITE_CONFIRM_KEY,
} from './vm-net/vm-http-fetch.js';
export { makeGitCredentialRoutes } from './vm-net/git-credential-routes.js';
export { needsWebWriteConfirm } from './vm-net/http-bridge.js';
export { setAppBodyWriteGate } from './app-store.js';
export { buildAppManifest, parseAppManifest } from './app-manifest.js';
export {
  gitRemoteOwnsRequest,
  normalizeGitRemote,
  smartHttpAuthHeader,
} from './repository/remote.js';
export { createKeyedQueue } from './command-queue.js';
export { parsePodShell, podGitRemoteIntents, podGitRemoteOperation } from './pod-shell.js';
