// peerd-distributed/content/bundle.js — app file-map <-> payload bytes.
//
// why a re-export: the pure pack/unpack primitives moved to
// /shared/bundle/ (DESIGN-10) so .peerd artifact exports work in store
// builds, which prune this module entirely. The dweb keeps its public
// API here (index.js re-exports from this file) and imports the
// implementation from shared — the legal direction across the dweb
// boundary. The consumer story is unchanged: unpack, then hand the file
// map to peerd-engine's composeApp to render in the sandbox
// (MIGRATION §3).

export { packBundle, unpackBundle, unpackBundleText } from '/shared/bundle/bundle.js';
