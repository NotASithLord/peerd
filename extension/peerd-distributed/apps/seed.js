// @ts-check
// peerd-distributed/apps/seed.js — the built-in seed app (Q5 pattern).
//
// The commons ships INSIDE the preview artifact as ordinary files under
// apps/commons/ and installs into the engine App runtime on first open —
// so the App-Store-shaped surface exists before the network does, with
// no chicken-and-egg. A seed app is just an app whose bytes ship in the
// extension; the same app, published by any member into a room, installs
// peer-to-peer like any other bundle (beat 1).
//
// IO is injected: the caller (the SW route) supplies fetchText — usually
// fetch(runtime.getURL(path)) — because this module must not assume a
// browser context.

export const COMMONS_SEED = Object.freeze({
  key: 'commons',
  name: 'commons',
  entryFile: 'index.html',
  paths: ['index.html'],
  base: '/peerd-distributed/apps/commons/',
  // The Library presents it as a dweb-capable app: the tag is filterable,
  // and source 'dweb' labels its provenance. The dweb slot (below) is what
  // actually unlocks the app-tab bridge — the tag is just how a human spots
  // it in the grid.
  tags: ['dweb'],
});

/**
 * Resolve the seed app's files. Returns the shape appClient.create wants.
 * @param {{ fetchText: (absolutePath: string) => Promise<string> }} io
 */
export const loadSeedApp = async ({ fetchText }) => {
  /** @type {Record<string, string>} */
  const files = {};
  for (const p of COMMONS_SEED.paths) {
    files[p] = await fetchText(COMMONS_SEED.base + p);
  }
  return {
    name: COMMONS_SEED.name,
    entryFile: COMMONS_SEED.entryFile,
    files,
    tags: [...COMMONS_SEED.tags],
    source: 'dweb',
    dweb: { uri: null, publisher: null, hash: null, seed: COMMONS_SEED.key },
  };
};
