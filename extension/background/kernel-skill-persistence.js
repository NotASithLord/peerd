// @ts-check

import { parseSkillDocument, validSkillProjection } from '../shared/skill-document.js';

const DB_NAME = 'peerd-skills';
const DB_VERSION = 1;
const META_STORE = 'meta';
const BODY_STORE = 'bodies';

export class KernelSkillExistsError extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`a skill named '${name}' is already installed`);
    this.name = 'SkillExistsError';
  }
}

/**
 * @param {Object} [deps]
 * @param {IDBFactory} [deps.idbFactory]
 * @param {(() => void)|null} [deps.canWrite]
 * @param {(entry:{type:string,details?:Record<string,any>})=>Promise<any>} [deps.audit]
 * @param {() => unknown} [deps.pushState]
 * @param {()=>number} [deps.now]
 */
export const createKernelSkillPersistence = ({
  idbFactory = globalThis.indexedDB,
  canWrite = null,
  audit = async () => {},
  pushState = async () => {},
  now = Date.now,
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

  /** @template T @param {IDBRequest<T>} request @returns {Promise<T>} */
  const settle = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  /**
   * @template T
   * @param {string|string[]} stores
   * @param {IDBTransactionMode} mode
   * @param {(transaction:IDBTransaction)=>T|Promise<T>} operation
   * @returns {Promise<T>}
   */
  const transact = async (stores, mode, operation) => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(stores, mode);
      /** @type {T} */ let result;
      Promise.resolve(operation(transaction)).then((value) => { result = value; }).catch((cause) => {
        try { transaction.abort(); } catch {}
        reject(cause);
      });
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error('tx failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('tx aborted'));
    });
  };

  const list = async () => (/** @type {any[]} */ (
    await transact(META_STORE, 'readonly', (transaction) =>
      settle(transaction.objectStore(META_STORE).getAll()))
  )).sort((left, right) => left.name.localeCompare(right.name));

  const commit = async (/** @type {string} */ text, /** @type {{
   * origin?:string|null,replace?:boolean,source?:'local'|'git'|'manifest'}} */ options = {}) => {
    const parsed = parseSkillDocument(text);
    if (!validSkillProjection(parsed)) throw new TypeError('skill-projection-invalid');
    canWrite?.();
    const skill = /** @type {Record<string,any>} */ (parsed);
    const meta = {
      id: skill.name,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      license: skill.license,
      allowedTools: skill.allowedTools,
      source: options.source ?? 'local',
      origin: options.origin ?? null,
      sizeBytes: new TextEncoder().encode(skill.body).length,
      enabled: true,
      installedAt: now(),
    };
    await transact([META_STORE, BODY_STORE], 'readwrite', async (transaction) => {
      const prior = await settle(transaction.objectStore(META_STORE).get(meta.id));
      if (prior && options.replace !== true) throw new KernelSkillExistsError(meta.id);
      transaction.objectStore(META_STORE).put(meta);
      transaction.objectStore(BODY_STORE).put({ id: meta.id, body: skill.body, text });
    });
    audit({ type: 'skill_installed', details: {
      name: meta.id, source: meta.source, origin: meta.origin,
    } }).catch(() => {});
    try { void pushState(); } catch {}
    return meta;
  };

  const setEnabled = async (/** @type {string} */ name, /** @type {boolean} */ enabled) => {
    canWrite?.();
    const meta = await transact([META_STORE, BODY_STORE], 'readwrite', async (transaction) => {
      const prior = await settle(transaction.objectStore(META_STORE).get(name));
      if (!prior) return null;
      const next = { ...prior, enabled };
      const body = await settle(transaction.objectStore(BODY_STORE).get(name));
      transaction.objectStore(META_STORE).put(next);
      transaction.objectStore(BODY_STORE).put({
        ...body, id: next.id, body: body?.body ?? '',
      });
      return next;
    });
    if (meta) { try { void pushState(); } catch {} }
    return meta;
  };

  const remove = async (/** @type {string} */ name) => {
    const removed = await transact([META_STORE, BODY_STORE], 'readwrite', async (transaction) => {
      const meta = await settle(transaction.objectStore(META_STORE).get(name));
      if (!meta) return false;
      canWrite?.();
      transaction.objectStore(META_STORE).delete(name);
      transaction.objectStore(BODY_STORE).delete(name);
      return true;
    });
    if (removed) {
      audit({ type: 'skill_removed', details: { name } }).catch(() => {});
      try { void pushState(); } catch {}
    }
    return removed;
  };

  const routes = Object.freeze({
    'skills/list': async () => ({ ok: true, skills: await list() }),
    'skills/setEnabled': async (/** @type {any} */ { name, enabled } = {}) => {
      if (typeof name !== 'string') return { ok: false, error: 'name-required' };
      try {
        const meta = await setEnabled(name, enabled === true);
        return meta ? { ok: true, skill: meta } : { ok: false, error: `no skill named '${name}'` };
      } catch (cause) {
        return { ok: false, error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause) };
      }
    },
    'skills/remove': async (/** @type {any} */ { name } = {}) => {
      if (typeof name !== 'string') return { ok: false, error: 'name-required' };
      return { ok: true, removed: await remove(name) };
    },
  });

  return Object.freeze({ routes, list, commit, setEnabled, remove });
};
