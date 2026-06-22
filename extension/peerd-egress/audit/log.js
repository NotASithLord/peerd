// @ts-check
// Append-only audit log over IndexedDB, with capped retention.
//
// The log is the *only* sanctioned write path for security events. Every
// gate-related action (egress denial, denylist hit, tool block, vault
// state change, etc.) lands here. The UI's audit-log view reads via
// `list()`. The user can export to JSON — exports never leave the device.
//
// Retention: append-only WITHIN a cap. Entries are never updated, but
// once the store crosses `maxEntries` the oldest are pruned so a
// long-lived install doesn't grow unbounded (and the Logs view's
// getAll() stays fast). Pruning is amortized — one count() every
// `pruneCheckEvery` appends, then a single ranged delete — never a full
// scan per write. The policy arithmetic is pure (see retention.js).
//
// Why a factory and not a singleton: the SW wires its own audit log;
// tests pass a fake idb (or a recording array) and assert on writes.

import { uuidv7 } from '/shared/util.js';
import { normalizeMaxEntries, excessEntries, DEFAULT_PRUNE_CHECK_EVERY } from './retention.js';

/** @typedef {import('./types.js').AuditEntry} AuditEntry */
/** @typedef {import('./types.js').AuditEntryInput} AuditEntryInput */

const STORE = 'audit_log';

/**
 * The slice of the IDB wrapper (storage/idb.js) the audit log writes
 * through. Narrowed to exactly what it uses so tests can inject a fake.
 *
 * why method-shorthand (not arrow-typed properties): the key params are
 * written METHOD-style so they're checked bivariantly — the wrapper hands
 * back the wide IDBValidKey while a fake idb may declare string-keyed
 * versions (the keys are always UUIDv7 strings in practice), and both must
 * be injectable.
 *
 * @typedef {{
 *   put(store: string, value: AuditEntry): Promise<void>,
 *   getAll(store: string): Promise<any[]>,
 *   count(store: string): Promise<number>,
 *   getAllKeys(store: string, limit?: number): Promise<IDBValidKey[]>,
 *   delUpTo(store: string, key: IDBValidKey): Promise<void>,
 * }} AuditIdb
 */

/**
 * Build an audit log bound to a specific IDB-like backend.
 *
 * @param {Object} deps
 * @param {AuditIdb} deps.idb                  IDB wrapper with put/getAll/count/getAllKeys/delUpTo
 * @param {() => number} [deps.now]           injectable clock (tests)
 * @param {() => string} [deps.makeId]        injectable id generator (tests)
 * @param {number} [deps.maxEntries]          retention cap (channel-overridable; see retention.js)
 * @param {number} [deps.pruneCheckEvery]     appends between prune checks (tests shrink this)
 */
export const createAuditLog = ({ idb, now = Date.now, makeId, maxEntries, pruneCheckEvery }) => {
  const generateId = makeId ?? (() => uuidv7(now));
  const cap = normalizeMaxEntries(maxEntries);
  const checkEvery = (typeof pruneCheckEvery === 'number' && pruneCheckEvery >= 1)
    ? Math.floor(pruneCheckEvery)
    : DEFAULT_PRUNE_CHECK_EVERY;

  // Start AT the check threshold so the first append after a SW boot
  // runs a prune check — an install that grew past the cap before this
  // shipped (or while the cap was larger) gets trimmed promptly instead
  // of waiting out a full batch.
  let appendsSinceCheck = checkEvery;
  /** @type {Promise<void> | null} */
  let pruneInFlight = null;

  // Delete the oldest entries down to the cap: one count, one
  // keys-only read of the excess, one ranged delete. UUIDv7 ids make
  // IDB key order chronological, so "first N keys" IS "oldest N".
  const prune = async () => {
    const total = await idb.count(STORE);
    const excess = excessEntries(total, cap);
    if (excess === 0) return;
    const doomed = await idb.getAllKeys(STORE, excess);
    if (doomed.length === 0) return;
    await idb.delUpTo(STORE, doomed[doomed.length - 1]);
  };

  // Concurrent appends share one in-flight prune rather than stacking
  // redundant count/delete transactions.
  const maybePrune = () => {
    pruneInFlight ??= prune().finally(() => { pruneInFlight = null; });
    return pruneInFlight;
  };

  /**
   * Append one entry. The caller passes type + optional sessionId/details;
   * id and timestamp are filled in here so callers can't accidentally
   * forge them.
   *
   * Returns a Promise that resolves when the write commits. Caller
   * decides whether to await — most policy code fires-and-forgets so
   * logging latency doesn't leak timing information.
   *
   * @param {AuditEntryInput} input
   * @returns {Promise<AuditEntry>}
   */
  const append = async (input) => {
    if (!input || typeof input.type !== 'string') {
      throw new TypeError('appendAudit: input.type is required');
    }
    /** @type {AuditEntry} */
    const entry = {
      id: generateId(),
      when: now(),
      type: input.type,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.details   !== undefined ? { details: input.details } : {}),
    };
    await idb.put(STORE, entry);
    // Retention rides the append path (there is no other timer in the
    // MV3 SW to hang it off), awaited so a pruning failure surfaces to
    // whoever DOES await the append — but only one append per batch
    // pays the cost.
    if (++appendsSinceCheck >= checkEvery) {
      appendsSinceCheck = 0;
      await maybePrune();
    }
    return entry;
  };

  /**
   * Read all retained entries. Returns them in insertion order (UUIDv7
   * keys make this equivalent to chronological order). The UI is
   * expected to reverse-paginate as needed.
   */
  const list = () => idb.getAll(STORE);

  return Object.freeze({ append, list });
};
