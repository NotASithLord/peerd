// @ts-check
// Kernel-owned skills metadata authority: list, enable/disable, uninstall.
// why metadata-only: SKILL.md parsing and every install path stay
// demand-loaded; long rationale in docs/THIN-KERNEL-ARCHITECTURE.md.

const DB_NAME = 'peerd-skills';
const DB_VERSION = 1;
const META_STORE = 'meta';
const BODY_STORE = 'bodies';

/**
 * @param {Object} [deps]
 * @param {IDBFactory} [deps.idbFactory]
 * @param {(() => void)|null} [deps.canWrite] shared schema write gate
 * @param {(entry:{type:string,details?:Record<string,any>})=>Promise<any>} [deps.audit]
 * @param {() => unknown} [deps.pushState]
 */
export const createKernelSkillsAuthority = ({
  idbFactory = globalThis.indexedDB,
  canWrite = null,
  audit = async () => {},
  pushState = async () => {},
} = {}) => {
  /** @type {Promise<IDBDatabase>|null} */ let opened = null;
  const openDb = () => {
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      if (!idbFactory) {
        reject(new Error('indexedDB not available in this context'));
        return;
      }
      const request = idbFactory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(BODY_STORE)) {
          db.createObjectStore(BODY_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opened = null; };
        db.onclose = () => { opened = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('open failed'));
    });
    return opened;
  };

  /**
   * @template T
   * @param {string|string[]} stores
   * @param {IDBTransactionMode} mode
   * @param {(transaction: IDBTransaction) => T | Promise<T>} operate
   * @returns {Promise<T>}
   */
  const transact = async (stores, mode, operate) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(stores, mode);
      /** @type {T} */ let result;
      Promise.resolve(operate(transaction)).then((value) => { result = value; }).catch(reject);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error('tx failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('tx aborted'));
    });
  };

  /** @template T @param {IDBRequest<T>} request @returns {Promise<T>} */
  const settled = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const listMetas = async () => (/** @type {any[]} */ (
    await transact(META_STORE, 'readonly', (transaction) =>
      settled(transaction.objectStore(META_STORE).getAll()))
  )).sort((left, right) => left.name.localeCompare(right.name));

  const setEnabled = async (/** @type {string} */ name, /** @type {boolean} */ enabled) => {
    canWrite?.();
    // why the body round-trips too: the legacy toggle re-puts meta AND body
    // (materializing an empty body row when missing) — keep rows identical.
    return transact([META_STORE, BODY_STORE], 'readwrite', async (transaction) => {
      const meta = await settled(transaction.objectStore(META_STORE).get(name));
      if (!meta) return null;
      const next = { ...meta, enabled: !!enabled };
      const body = await settled(transaction.objectStore(BODY_STORE).get(name));
      transaction.objectStore(META_STORE).put(next);
      transaction.objectStore(BODY_STORE).put({ id: next.id, body: body?.body ?? '' });
      return next;
    });
  };

  const remove = async (/** @type {string} */ name) => {
    const existing = await transact(META_STORE, 'readonly', (transaction) =>
      settled(transaction.objectStore(META_STORE).get(name)));
    if (!existing) return false;
    canWrite?.();
    await transact([META_STORE, BODY_STORE], 'readwrite', (transaction) => {
      transaction.objectStore(META_STORE).delete(name);
      transaction.objectStore(BODY_STORE).delete(name);
    });
    audit({ type: 'skill_removed', details: { name } }).catch(() => {});
    return true;
  };

  const routes = Object.freeze({
    'skills/list': async () => ({ ok: true, skills: await listMetas() }),
    'skills/setEnabled': async (/** @type {any} */ { name, enabled } = {}) => {
      if (typeof name !== 'string') return { ok: false, error: 'name-required' };
      try {
        const meta = await setEnabled(name, !!enabled);
        if (!meta) return { ok: false, error: `no skill named '${name}'` };
        void pushState();
        return { ok: true, skill: meta };
      } catch (cause) {
        return {
          ok: false,
          error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause),
        };
      }
    },
    'skills/remove': async (/** @type {any} */ { name } = {}) => {
      if (typeof name !== 'string') return { ok: false, error: 'name-required' };
      const removed = await remove(name);
      void pushState();
      return { ok: true, removed };
    },
  });

  return Object.freeze({ routes, list: listMetas });
};
