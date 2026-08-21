// @ts-check
// Metadata-only slash-command palette for the native kernel. Command and skill
// bodies never enter this graph or response; they remain demand-loaded by the
// composer/skill feature that actually executes a selected command.

import { disarmText } from '../shared/disarm-text.js';

const COMMAND_PREFIX = 'peerd.commands.';
const SKILLS_DB = 'peerd-skills';
const SKILLS_VERSION = 1;
const SKILL_META = 'meta';

const skillDescription = (/** @type {unknown} */ value) => {
  const flat = disarmText(value ?? 'from a skill').replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}…` : flat;
};

/**
 * @param {Object} deps
 * @param {{list:(prefix:string)=>Promise<Record<string,any>>}} deps.kv
 * @param {IDBFactory} [deps.idbFactory]
 * @param {string} [deps.skillsDbName]
 */
export const createKernelCommandReader = ({
  kv,
  idbFactory = globalThis.indexedDB,
  skillsDbName = SKILLS_DB,
}) => {
  if (typeof kv?.list !== 'function') throw new TypeError('kernel-command-kv-invalid');
  /** @type {Promise<IDBDatabase>|null} */
  let opened = null;
  const openSkills = () => {
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      if (!idbFactory) {
        reject(new Error('indexedDB not available in this context'));
        return;
      }
      const request = idbFactory.open(skillsDbName, SKILLS_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SKILL_META)) {
          db.createObjectStore(SKILL_META, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('bodies')) {
          db.createObjectStore('bodies', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const retire = () => { db.close(); opened = null; };
        db.onversionchange = retire;
        db.onclose = () => { opened = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('open failed'));
    });
    return opened;
  };
  const listSkills = async () => {
    const db = await openSkills();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(SKILL_META, 'readonly');
      const request = transaction.objectStore(SKILL_META).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error ?? new Error('tx failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('tx aborted'));
    });
  };

  const localRows = async () => Object.values(await kv.list(COMMAND_PREFIX))
    .filter((row) => row && typeof row.name === 'string')
    .map((row) => ({
      name: row.name,
      description: typeof row.description === 'string' ? row.description : '',
    }));
  const skillRows = async () => (/** @type {any[]} */ (await listSkills()))
    .filter((row) => row?.enabled === true && typeof row.name === 'string')
    .map((row) => ({
      name: row.name,
      description: skillDescription(row.description),
    }));

  return Object.freeze({
    list: async () => {
      const [local, skills] = await Promise.all([
        localRows().catch(() => []),
        skillRows().catch(() => []),
      ]);
      /** @type {Map<string,{name:string,description:string}>} */
      const merged = new Map();
      for (const row of [...local, ...skills]) {
        if (!merged.has(row.name)) merged.set(row.name, row);
      }
      return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
    },
  });
};
