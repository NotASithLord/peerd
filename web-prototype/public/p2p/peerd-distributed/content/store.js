// peerd-distributed/content/store.js — the announce-set content store.
//
// THE LIABILITY FIREWALL (ARCHITECTURE §4.3, THREAT-MODEL §2). A peer
// serves a chunk ONLY if that chunk belongs to a manifest the user
// explicitly announced. There is no pass-through / opportunistic caching:
// a chunk this store never announced is simply not serveable. Accidental
// possession is structurally impossible because the serve path consults
// the announce set before returning any byte.
//
// PHASE 0: in-memory. The same surface backs OPFS (chunk bytes) + IDB
// (manifest index, announce set) later (ARCHITECTURE §9) by swapping the
// Maps for injected stores — no caller change.

export const createContentStore = () => {
  const manifests = new Map(); // contentHash -> manifest
  const chunkData = new Map(); // chunkHash -> Uint8Array
  const announced = new Set(); // contentHash
  const serveable = new Map(); // chunkHash -> refcount across announced manifests

  const refUp = (manifest) => {
    for (const m of manifest.chunks) serveable.set(m.hash, (serveable.get(m.hash) || 0) + 1);
  };

  // why: un-share. Drop a chunk's refcount; at zero it leaves the serveable
  // set so the serve path returns null for it. The manifest + bytes stay in
  // memory (the user still has the app installed) — only the SERVE permission
  // is revoked. Mirrors refUp exactly.
  const refDown = (manifest) => {
    for (const m of manifest.chunks) {
      const n = (serveable.get(m.hash) || 0) - 1;
      if (n > 0) serveable.set(m.hash, n);
      else serveable.delete(m.hash);
    }
  };

  const announce = (hash) => {
    const manifest = manifests.get(hash);
    if (!manifest) throw new Error(`announce: unknown content ${hash}`);
    if (announced.has(hash)) return;
    announced.add(hash);
    refUp(manifest);
  };

  // why: un-share / delete. Stop serving this content. After this, getManifest
  // and every getChunk for this bundle return null — peers can no longer pull
  // it from us (the liability firewall now refuses what we used to announce).
  // Idempotent + safe on unknown hashes (a never-shared app deletes cleanly).
  const unannounce = (hash) => {
    if (!announced.has(hash)) return false;
    announced.delete(hash);
    const manifest = manifests.get(hash);
    if (manifest) refDown(manifest);
    return true;
  };

  // Ingest a built bundle and announce it. chunks are the Uint8Array
  // pieces from buildManifest (same order as manifest.chunks).
  const publish = ({ manifest, hash, chunks }) => {
    manifests.set(hash, manifest);
    manifest.chunks.forEach((m, i) => chunkData.set(m.hash, chunks[i]));
    announce(hash);
    return hash;
  };

  return {
    publish,
    announce,
    unannounce,
    isAnnounced: (hash) => announced.has(hash),
    // Serve-path getters: gated on the announce set.
    getManifest: (hash) => (announced.has(hash) ? manifests.get(hash) : null),
    getChunk: (chunkHash) => (serveable.has(chunkHash) ? chunkData.get(chunkHash) : null),
  };
};
