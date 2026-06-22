// @ts-check
// Persistent catalog of Notebooks.
//
// A Notebook is the lighter-weight peer of a WebVM: instead of a full
// Linux kernel emulation, it's a Web Worker hosted inside a chrome-
// extension tab. The worker has its own JS realm, an OPFS-backed scratch
// directory (`/peerd-notebooks/<id>/`), and a shimmed fetch that routes
// through peerd-egress. Use this when vanilla JS is enough — processing
// a CSV, running a parser, exercising a library — without paying the
// ~10s CheerpX boot.
//
// Mirrors vm-registry's shape on purpose so the SW patterns line up
// 1:1 (same persistence story, same session-default semantics, same
// tab-tracker model) — both are thin configs over the shared
// createRegistry. Deliberately no legacy migration — Notebooks didn't
// exist before.

import { createRegistry } from './registry-factory.js';

const STORAGE_KEY = 'notebooks.v1';

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   ownerSessionId: string | null,
 *   pinned: boolean,
 *   createdAt: number,
 *   lastUsedAt: number,
 * }} NotebookRecord
 */

/**
 * Create a Notebook registry backed by the injected key-value store.
 *
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void> }} deps.storage
 * @returns the registry; snapshot() returns { notebooks, currentId }.
 */
export const createNotebookRegistry = (deps) =>
  createRegistry({
    storageKey: STORAGE_KEY,
    collectionKey: 'notebooks',
    currentKey: 'currentId',
    idPrefix: 'notebook',
    defaultNamePrefix: 'notebook',
    notFoundLabel: 'notebook',
    touchOnSetDefault: true,
    buildExtra: (_id, opts) => ({
      pinned: !!opts.pinned,
      lastUsedAt: Date.now(),
    }),
    applyPatch: (next, patch) => {
      if (typeof patch.name === 'string') next.name = patch.name;
      if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned;
      if (typeof patch.ownerSessionId === 'string') next.ownerSessionId = patch.ownerSessionId;
      if (typeof patch.lastUsedAt === 'number') next.lastUsedAt = patch.lastUsedAt;
    },
  }, deps);

export const NOTEBOOK_TAB_PATH = '/notebook-tab/index.html';

/** OPFS subdirectory under the extension origin's root. */
export const NOTEBOOK_OPFS_ROOT = 'peerd-notebooks';
