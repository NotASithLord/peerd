// @ts-check

import { uuidv7 } from '/shared/cold-util.js';
import { normalizeMaxEntries, excessEntries, DEFAULT_PRUNE_CHECK_EVERY } from './retention.js';
import { computeChainHash, verifyChain, CHAIN_HEAD_KEY } from './chain.js';

/** @typedef {import('./types.js').AuditEntry} AuditEntry */
/** @typedef {import('./types.js').AuditEntryInput} AuditEntryInput */

const STORE = 'audit_log';
const META_STORE = 'audit_meta';

/** @typedef {{
 *   put(store: string, value: object): Promise<void>,
 *   get?(store: string, key: string): Promise<any>,
 *   getAll(store: string): Promise<any[]>,
 *   count(store: string): Promise<number>,
 *   getAllKeys(store: string, limit?: number): Promise<IDBValidKey[]>,
 *   delUpTo(store: string, key: IDBValidKey): Promise<void>,
 * }} AuditIdb
 */

/** @param {Object} deps @param {AuditIdb} deps.idb
 * @param {()=>number} [deps.now] @param {()=>string} [deps.makeId]
 * @param {number} [deps.maxEntries] @param {number} [deps.pruneCheckEvery] */
export const createAuditLog = ({ idb, now = Date.now, makeId, maxEntries, pruneCheckEvery }) => {
  const generateId = makeId ?? (() => uuidv7(now));
  const cap = normalizeMaxEntries(maxEntries);
  const checkEvery = (typeof pruneCheckEvery === 'number' && pruneCheckEvery >= 1)
    ? Math.floor(pruneCheckEvery)
    : DEFAULT_PRUNE_CHECK_EVERY;

  let appendsSinceCheck = checkEvery;
  /** @type {Promise<void> | null} */
  let pruneInFlight = null;

  /** @type {{ id: string, chain: string } | null} */
  let chainTail = null;
  let chainTailLoaded = false;
  /** @type {Promise<any>} */
  let writeQueue = Promise.resolve();

  const loadChainTail = async () => {
    if (chainTailLoaded) return;
    chainTailLoaded = true;
    try {
      const head = await idb.get?.(META_STORE, CHAIN_HEAD_KEY);
      if (head?.chain) chainTail = { id: head.id, chain: head.chain };
    } catch {}
  };

  const prune = async () => {
    const total = await idb.count(STORE);
    const excess = excessEntries(total, cap);
    if (excess === 0) return;
    const doomed = await idb.getAllKeys(STORE, excess);
    if (doomed.length === 0) return;
    await idb.delUpTo(STORE, doomed[doomed.length - 1]);
  };

  const maybePrune = () => {
    pruneInFlight ??= prune().finally(() => { pruneInFlight = null; });
    return pruneInFlight;
  };

  /** @param {AuditEntryInput} input @returns {Promise<AuditEntry>} */
  const append = (input) => {
    if (!input || typeof input.type !== 'string') {
      return Promise.reject(new TypeError('appendAudit: input.type is required'));
    }
    const job = writeQueue.then(async () => {
      await loadChainTail();
      /** @type {AuditEntry & { chain: string }} */
      const entry = {
        id: generateId(),
        when: now(),
        type: input.type,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.details   !== undefined ? { details: input.details } : {}),
        chain: '',
      };
      entry.chain = await computeChainHash(chainTail?.chain ?? '', entry);
      await idb.put(STORE, entry);
      chainTail = { id: entry.id, chain: entry.chain };
      try {
        await idb.put(META_STORE, { key: CHAIN_HEAD_KEY, id: entry.id, chain: entry.chain });
      } catch {}
      if (++appendsSinceCheck >= checkEvery) {
        appendsSinceCheck = 0;
        await maybePrune();
      }
      return entry;
    });
    writeQueue = job.catch(() => {});
    return job;
  };

  const verify = async () => {
    const readSnapshot = async () => {
      const entries = await idb.getAll(STORE);
      let head = null;
      try { head = await idb.get?.(META_STORE, CHAIN_HEAD_KEY) ?? null; } catch { head = null; }
      return verifyChain(entries, head);
    };
    const job = writeQueue.then(readSnapshot);
    writeQueue = job.catch(() => {});
    return job;
  };

  const list = () => idb.getAll(STORE);

  return Object.freeze({ append, list, verify });
};
