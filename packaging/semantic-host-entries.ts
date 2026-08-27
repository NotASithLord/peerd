// One packaging authority for the semantic dispatcher shell and every
// fixed-literal route-family cluster it can demand-load. Runtime code still
// spells each import literally; build identity and archive closure share this
// list so a new cluster cannot be packaged but unattested, or attested but
// absent from an artifact.

export const SEMANTIC_HOST_CLUSTER_ENTRIES = Object.freeze([
  'offscreen/semantic-routes/actors.js',
  'offscreen/semantic-routes/apps.js',
  'offscreen/semantic-routes/contacts.js',
  'offscreen/semantic-routes/contributor.js',
  'offscreen/semantic-routes/memory.js',
  'offscreen/semantic-routes/providers.js',
] as const);

export const SEMANTIC_HOST_CORE_CLUSTER_ENTRIES = Object.freeze(
  SEMANTIC_HOST_CLUSTER_ENTRIES.filter((entry) =>
    entry !== 'offscreen/semantic-routes/contributor.js'),
);

export const SEMANTIC_HOST_BUILD_ENTRIES = Object.freeze([
  'offscreen/semantic-route-host.js',
  ...SEMANTIC_HOST_CLUSTER_ENTRIES,
] as const);

export const SEMANTIC_HOST_CORE_BUILD_ENTRIES = Object.freeze([
  'offscreen/semantic-route-host.js',
  ...SEMANTIC_HOST_CORE_CLUSTER_ENTRIES,
] as const);
