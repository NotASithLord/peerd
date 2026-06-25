// peerd-distributed/content/chunk.js — 256KB chunking + SHA-256.
//
// why a re-export: the pure chunking + hashing primitives moved to
// /shared/bundle/ (DESIGN-10) so .peerd artifact exports work in store
// builds, which prune this module entirely. The dweb keeps its public
// API here and imports the implementation from shared — the legal
// direction across the dweb boundary.

export { chunkBytes, sha256hex, CHUNK_SIZE } from '/shared/bundle/chunk.js';
