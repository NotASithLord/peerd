// @ts-check
// vm-net — the WebVM's HTTP-native networking layer (pure cores).
//
// The VM has no sockets; all networking rides one host-side chokepoint that
// turns a stdout sentinel into a denylist-gated webFetch. These modules are the
// pure logic behind that bridge — the wire codec, the archive-clone planner,
// the cache policy, and the unsupported-command stubs — kept testable and free
// of CheerpX/DataDevice IO (which lives in vm-tab.js + the bash wrappers).

export {
  GET_MARKER,
  REQ_MARKER,
  MAX_REQ_BODY_BYTES,
  ALLOWED_METHODS,
  WRITE_METHODS,
  isWriteMethod,
  needsWebWriteConfirm,
  normalizeRequest,
  encodeRequest,
  decodeRequest,
  parseMarkerLine,
  findNextMarker,
  partialMarkerHoldIndex,
  encodeResponseMeta,
} from './http-bridge.js';

export {
  GIT_SECRET_PREFIX,
  canonicalGitHost,
  normalizeGitHost,
  isPlausibleGitToken,
  gitSecretName,
  gitHostFromSecretName,
  authHostForRequestUrl,
  gitAuthHeader,
} from './git-credentials.js';

export {
  MAX_CACHE_ENTRY_BYTES,
  isRequestCacheable,
  isResponseStorable,
  cacheKey,
  revalidationHeaders,
  isFresh,
} from './http-cache.js';

export {
  UNSUPPORTED_NET_COMMANDS,
  stubMessage,
  stubsBash,
} from './socket-stubs.js';

export {
  NET_CAPABILITIES,
  capabilitiesText,
  bannerText,
  peerdNetBash,
  aptShimsBash,
  friendlyFetchError,
} from './capability-info.js';

// Host-side orchestration for the peerd:// control ops (git-clone, pkg
// installs) — pure, IO injected; vm-tab.js builds the IO from swFetch +
// DataDevice stage. The git-archive + npm/pip/gem resolvers it composes stay
// module-internal (control-ops is their only consumer; their own tests import
// them directly).
export { runControlOp } from './control-ops.js';

// SW-side egress orchestration for the bridge (anti-exfil gate + host-bound
// git-auth injection + IDB cache), and the git-credential provisioning routes.
// Both are IO-injected factories — the imperative shell the SW used to inline,
// pulled here so it's bun-testable (a SW can't run under bun).
export { makeVmHttpFetch, makeInjectGitAuth, WEB_WRITE_CONFIRM_KEY, MAX_VM_FETCH_BODY } from './vm-http-fetch.js';
export { makeGitCredentialRoutes } from './git-credential-routes.js';
