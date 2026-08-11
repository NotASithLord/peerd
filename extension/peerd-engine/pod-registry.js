// @ts-check
// Pod registry: durable catalog for lightweight shell/WASI environments.
// A persistent record promises durable workspace bytes, not a durable process:
// Workers, jobs, cwd, and environment may disappear and are never reconstructed
// as though an interrupted side effect had completed.

import { createRegistry } from './registry-factory.js';

export const POD_TAB_PATH = '/engine-tabs/pod-tab/index.html';
export const POD_OPFS_ROOT = 'peerd-pods';

/**
 * @typedef {Object} PodRecord
 * @property {string} id
 * @property {string} name
 * @property {string|null} ownerSessionId
 * @property {boolean} pinned
 * @property {boolean} persistent
 * @property {number} createdAt
 * @property {number} lastUsedAt
 * @property {string} [actorSessionId]
 */

/**
 * @param {{ storage: { get:(key:string)=>Promise<any>, set:(key:string,value:any)=>Promise<void> }, onActorArchive?: (actorSessionId:string)=>void }} deps
 */
export const createPodRegistry = (deps) => createRegistry({
  storageKey: 'pods.v1',
  collectionKey: 'pods',
  currentKey: 'currentId',
  idPrefix: 'pod',
  defaultNamePrefix: 'pod',
  notFoundLabel: 'Pod',
  buildExtra: (_id, opts) => ({
    pinned: !!opts.pinned,
    persistent: opts.persistent !== false,
    lastUsedAt: Date.now(),
  }),
  applyPatch: (next, patch) => {
    if (typeof patch.name === 'string') next.name = patch.name;
    if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned;
    if (typeof patch.ownerSessionId === 'string' || patch.ownerSessionId === null) {
      next.ownerSessionId = patch.ownerSessionId;
    }
    if (typeof patch.lastUsedAt === 'number') next.lastUsedAt = patch.lastUsedAt;
  },
  touchOnSetDefault: true,
}, deps);
