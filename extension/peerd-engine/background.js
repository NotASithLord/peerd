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
export { buildModule } from './module-resolver.js';
export { IMAGE_PIN_STORAGE_KEY } from './image-pin.js';
export {
  buildAppExport, buildNotebookExport, buildVmRecipeExport,
  openEnvelope, inspectEnvelope, exportFilename,
} from './export.js';
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
  makeVmHttpFetch, makeGitCredentialRoutes, WEB_WRITE_CONFIRM_KEY,
  needsWebWriteConfirm,
} from './vm-net/index.js';
export { setAppBodyWriteGate } from './app-store.js';
export { buildAppManifest, parseAppManifest } from './app-manifest.js';
export { createRepositoryService } from './repository/repository-service.js';
export { normalizeGitRemote } from './repository/remote.js';
export { createKeyedQueue } from './command-queue.js';
export { parsePodShell, podGitRemoteIntents, podGitRemoteOperation } from './pod-shell.js';
