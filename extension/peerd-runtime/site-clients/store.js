// @ts-check
// DESIGN-19 — the site-client STORE: the persistence substrate. Two-tier, keyed
// by origin, the skills-store shape (store.js is the template): a small META
// record (the dossier — listed/loaded at mint) and a large BODY record (the
// client module — read only on site_client_run / site_client_read).
//
// A SITE CLIENT IS A DISTINCT TRUST CLASS from a skill: its own DB, so a client
// can NEVER be loaded as a skill (a skill's body is injected into the prompt as
// instructions; a client's body only ever executes behind the sealed-worker
// origin-pin, and its dossier only ever enters context fenced). Keeping the DBs
// separate is that boundary made structural.
//
// Functional-core discipline: IO (indexedDB) is INJECTED so this is Bun-testable
// with fake-indexeddb, never imported here. MV3: IDB-backed (survives the 30s SW
// death), never in-memory-only.

import { stampRecord, validateDossier, validateClientBody, siteClientValidatedOperations } from './core.js';

const DB_NAME = 'peerd-site-clients';
const DB_VERSION = 1;
const META_STORE = 'meta';
const BODY_STORE = 'bodies';

/**
 * Build a site-client store over an injected IDB-like surface. Production passes
 * the real `indexedDB`; tests pass fake-indexeddb.
 *
 * @param {Object} [deps]
 * @param {IDBFactory} [deps.idbFactory]  defaults to globalThis.indexedDB
 * @param {() => number} [deps.now]        injected clock (deterministic tests)
 * @param {() => string} [deps.makeRevision] host-generated opaque identity
 * @param {string} [deps.dbName]           DB name override — tests use a unique
 *   name per case for isolation; production always uses the default.
 */
export const createSiteClientStore = (deps = {}) => {
  const idbFactory = deps.idbFactory ?? globalThis.indexedDB;
  const now = deps.now ?? Date.now;
  const makeRevision = deps.makeRevision ?? (() => crypto.randomUUID());
  const dbName = deps.dbName ?? DB_NAME;
  /** @type {Promise<IDBDatabase> | null} */
  let openPromise = null;

  const openDb = () => {
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
      if (!idbFactory) { reject(new Error('indexedDB not available in this context')); return; }
      const req = idbFactory.open(dbName, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'origin' });
        if (!db.objectStoreNames.contains(BODY_STORE)) db.createObjectStore(BODY_STORE, { keyPath: 'origin' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Mirror the skills/egress idb wrapper: yield to another context's
        // version-change / delete so we never block an upgrade, and re-open clean.
        db.onversionchange = () => { db.close(); openPromise = null; };
        db.onclose = () => { openPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('open failed'));
    });
    return openPromise;
  };

  /**
   * @template T
   * @param {string | string[]} stores @param {IDBTransactionMode} mode
   * @param {(t: IDBTransaction) => T | Promise<T>} fn
   * @param {AbortSignal} [signal]
   * @returns {Promise<T>}
   */
  const tx = async (stores, mode, fn, signal) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Stopped', 'AbortError')); return; }
      const t = db.transaction(stores, mode);
      const stop = () => { try { t.abort(); } catch { /* already committed */ } };
      const cleanup = () => signal?.removeEventListener('abort', stop);
      signal?.addEventListener('abort', stop, { once: true });
      /** @type {T} */
      let result;
      Promise.resolve(fn(t)).then((r) => { result = r; }).catch(reject);
      t.oncomplete = () => { cleanup(); resolve(result); };
      t.onerror = () => { cleanup(); reject(t.error ?? new Error('tx failed')); };
      t.onabort = () => { cleanup(); reject(t.error ?? new DOMException('Transaction aborted', 'AbortError')); };
    });
  };

  /** @template T @param {IDBRequest<T>} request @returns {Promise<T>} */
  const reqP = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return {
    /**
     * Persist a client (meta + body) atomically after a CONFIRMED write. Takes the
     * validated dossier + body and folds staleness metadata against any prior
     * record (createdAt preserved; derivedAt bumped; failures reset). Returns the
     * stamped meta. A '' body is a delete (handled by the caller via remove()).
     * @param {{ dossier: Partial<import('./core.js').SiteClientMeta>, body: string }} input
     * @returns {Promise<import('./core.js').SiteClientMeta>}
     */
    put: async ({ dossier, body }) => {
      const validated = validateDossier(dossier);
      const validBody = validateClientBody(body);
      // why: deriving the next revision and writing it share one transaction;
      // concurrent validation/run bookkeeping cannot resurrect an older proof.
      return tx([META_STORE, BODY_STORE], 'readwrite', async (t) => {
        const prior = await reqP(t.objectStore(META_STORE).get(validated.origin)) ?? null;
        const priorBody = (await reqP(t.objectStore(BODY_STORE).get(validated.origin)))?.body ?? '';
        const { meta } = stampRecord({ dossier: validated, body: validBody, prior, priorBody,
          now: now(), revision: makeRevision() });
        t.objectStore(META_STORE).put(meta);
        t.objectStore(BODY_STORE).put({ origin: meta.origin, body: validBody });
        return meta;
      });
    },

    /**
     * List ALL client metas (the mint-time + options hot path — meta store ONLY,
     * so no client body is ever deserialized here).
     * @returns {Promise<import('./core.js').SiteClientMeta[]>}
     */
    listMeta: () => tx(META_STORE, 'readonly', (t) => reqP(t.objectStore(META_STORE).getAll())),

    /**
     * The meta for one origin, or null. The mint-injection path reads THIS.
     * @param {string} origin
     * @returns {Promise<import('./core.js').SiteClientMeta | null>}
     */
    getMeta: (origin) => tx(META_STORE, 'readonly', async (t) =>
      /** @type {import('./core.js').SiteClientMeta | undefined} */ (await reqP(t.objectStore(META_STORE).get(origin))) ?? null),

    /**
     * The full record (meta + body) for one origin, or null — the on-run/on-read
     * path (site_client_run loads the body from here).
     * @param {string} origin
     * @returns {Promise<{ meta: import('./core.js').SiteClientMeta, body: string } | null>}
     */
    get: (origin) => tx([META_STORE, BODY_STORE], 'readonly', async (t) => {
      const meta = /** @type {import('./core.js').SiteClientMeta | undefined} */ (await reqP(t.objectStore(META_STORE).get(origin)));
      if (!meta) return null;
      const bodyRow = await reqP(t.objectStore(BODY_STORE).get(origin));
      return { meta, body: /** @type {any} */ (bodyRow)?.body ?? '' };
    }),

    /**
     * Record the OUTCOME of a run against the client's staleness metadata: a
     * success records execution only; a failure invalidates typed validation.
     * A late outcome cannot change a replacement revision.
     * @param {string} origin @param {{ ok: boolean, revision?:string, signal?:AbortSignal }} outcome
     * @returns {Promise<void>}
     */
    recordRun: (origin, { ok, revision, signal }) => tx(META_STORE, 'readwrite', async (t) => {
      const store = t.objectStore(META_STORE);
      const meta = /** @type {import('./core.js').SiteClientMeta | undefined} */ (await reqP(store.get(origin)));
      if (!meta || revision !== undefined && (meta.revision ?? '') !== revision) return;
      meta.lastRunAt = now();
      meta.lastRunOk = ok;
      if (ok) {
        meta.recentFailures = 0;
        if (!siteClientValidatedOperations(meta).length) meta.lastVerifiedAt = 0;
      }
      else {
        meta.recentFailures = (meta.recentFailures ?? 0) + 1;
        meta.lastVerifiedAt = 0;
        meta.validation = { schema: 1, revision: meta.revision, status: 'failed', cases: [] };
        delete meta.validationAttempt;
      }
      meta.updatedAt = now();
      store.put(meta);
    }, signal),

    /** A new attempt invalidates prior proof and supersedes any older attempt.
     * @param {string} origin @param {string} revision @param {AbortSignal} [signal] @returns {Promise<string|null>} */
    beginValidation: (origin, revision, signal) => tx(META_STORE, 'readwrite', async (t) => {
      const store = t.objectStore(META_STORE);
      const meta = await reqP(store.get(origin));
      if (!meta || meta.revision !== revision) return null;
      const attempt = makeRevision();
      meta.validationAttempt = attempt;
      meta.lastVerifiedAt = 0;
      meta.validation = { schema: 1, revision, status: 'pending', cases: [] };
      meta.updatedAt = now();
      store.put(meta);
      return attempt;
    }, signal),

    /** Receipts are host-authored. Only the still-current attempt may promote.
     * @param {string} origin
     * @param {{revision:string,attempt:string,cases:Array<{index:number,operation:string,ok:boolean}>,signal?:AbortSignal}} outcome
     * @returns {Promise<import('./core.js').SiteClientMeta|null>} */
    recordValidation: (origin, { revision, attempt, cases, signal }) => tx(META_STORE, 'readwrite', async (t) => {
      const store = t.objectStore(META_STORE);
      const meta = await reqP(store.get(origin));
      if (!meta || meta.revision !== revision || meta.validationAttempt !== attempt) return null;
      meta.validation = { schema: 1, revision, attempt, status: 'validated', checkedAt: now(), cases };
      const passed = siteClientValidatedOperations(meta).length > 0;
      if (!passed) meta.validation.status = 'failed';
      meta.lastVerifiedAt = passed ? now() : 0;
      meta.recentFailures = passed ? 0 : (meta.recentFailures ?? 0) + 1;
      meta.updatedAt = now();
      delete meta.validationAttempt;
      store.put(meta);
      return meta;
    }, signal),

    /** Roll back only this attempt when final custody was lost during commit.
     * A replacement or a newer validation attempt must remain untouched.
     * @param {string} origin @param {{revision:string,attempt:string}} proof */
    revokeValidation: (origin, { revision, attempt }) => tx(META_STORE, 'readwrite', async (t) => {
      const store = t.objectStore(META_STORE);
      const meta = await reqP(store.get(origin));
      if (meta?.revision !== revision || meta.validation?.attempt !== attempt) return;
      meta.validation = { ...meta.validation, status: 'failed', reason: 'authority_lost' };
      meta.lastVerifiedAt = 0;
      meta.updatedAt = now();
      store.put(meta);
    }),

    /**
     * Remove a client entirely (reversibility — every derivation is deletable).
     * Drops both records.
     * @param {string} origin
     */
    remove: (origin) => tx([META_STORE, BODY_STORE], 'readwrite', (t) => {
      t.objectStore(META_STORE).delete(origin);
      t.objectStore(BODY_STORE).delete(origin);
    }),
  };
};

/** @typedef {ReturnType<typeof createSiteClientStore>} SiteClientStore */
