// @ts-check
// peerd-runtime/site-clients — DESIGN-19 per-origin derived API clients.
//
// Public surface, re-exported through /peerd-runtime/index.js. Functional-core /
// imperative-shell: core.js + digest.js are pure over their inputs; store.js is a
// two-tier IDB adapter with IO injected. The SW owns the confirm round-trip, the
// sealed-worker run surface (siteFetch capability), the capture taps, and
// mint-time dossier injection.
//
// See docs/specs/DESIGN-19-site-clients.md.

export {
  normalizeSiteOrigin,
  validateDossier,
  normalizeEndpoints,
  validateClientBody,
  buildClientWriteProposal,
  lineDelta,
  endpointDelta,
  stalenessHeader,
  fenceDossier,
  buildMintInjection,
  resolveSiteUrl,
  stampRecord,
  MAX_CLIENT_BODY_CHARS,
  MAX_DOSSIER_CHARS,
  MAX_ENDPOINTS,
} from './core.js';

export {
  createSiteClientStore,
} from './store.js';

export {
  redactHeaders,
  redactParamValue,
  templatizeUrl,
  shapeSketch,
  inScope,
  digestCapture,
} from './digest.js';
