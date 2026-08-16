// @ts-check
// Offscreen-only engine surface for the sealed headless script worker. The
// CodeMirror editor and tab/registry shells are page/background concerns.

export {
  buildEntry, buildModule, isRemoteSpecifier, makeFetchRemote, TOOLBOX_SPECIFIER_PREFIX,
} from './module-resolver.js';
export { opfsHelpers } from './opfs.js';
export {
  MODULE_SYNTAX_ERROR_CODE, remoteModuleCapabilityBlockedMessage,
  UnsupportedNativeModuleImportError,
} from './errors.js';
