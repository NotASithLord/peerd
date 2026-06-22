// @ts-check
// Persistent catalog of WebVMs.
//
// Each VM is a discrete instance with its own disk overlay (IDB DB) and
// hosted in its own browser tab (extension://<id>/vm-tab/index.html#<id>).
// This module owns the metadata — the live tabs themselves are tracked
// by the SW in-memory (vmId → tabId) and reconstructed from
// chrome.tabs.query on SW boot.
//
// What lives here:
//   - The VM records (id, name, disk key, etc.)
//   - The session → currentVmId map (which VM each chat most recently
//     used; the agent's vm_boot defaults here unless overridden)
//
// What does NOT live here:
//   - Whether a VM tab is currently alive (in-memory in SW)
//   - CheerpX instances (in the tab pages themselves)
//   - Boot progress / shell output (in-tab boot card)
//
// The CRUD/persistence/session-default machinery is shared with the
// Notebook and App registries via createRegistry — this file is the
// VM-shaped config over it.

import { createRegistry } from './registry-factory.js';

const STORAGE_KEY = 'webvms.v1';

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   diskOverlayKey: string,
 *   ownerSessionId: string | null,
 *   pinned: boolean,
 *   createdAt: number,
 *   lastUsedAt: number,
 * }} VmRecord
 */

/** @param {string} vmId */
const newDiskKey = (vmId) => `peerd-vm-${vmId}`;

/**
 * Create a VM registry backed by the injected key-value store.
 *
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void> }} deps.storage
 * @returns the registry; snapshot() returns { vms, currentVmId }.
 */
export const createVmRegistry = (deps) =>
  createRegistry({
    storageKey: STORAGE_KEY,
    collectionKey: 'vms',
    currentKey: 'currentVmId',
    idPrefix: 'vm',
    defaultNamePrefix: 'vm',
    notFoundLabel: 'vm',
    touchOnSetDefault: true,
    // why: diskOverlayKey is derived from the id and immutable — set once
    // at create, never patchable.
    buildExtra: (id, opts) => ({
      diskOverlayKey: newDiskKey(id),
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

export const VM_TAB_PATH = '/vm-tab/index.html';
