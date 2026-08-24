// @ts-check
// Controller-independent composer browser projections. Full tab URLs are
// consumed only by the authority policy and never leave this module.

import {
  projectComposerTabRows,
  renderComposerTabs,
} from '../shared/composer-tab-view.js';
import { disarmText } from '../shared/disarm-text.js';
import { createKernelAppFileReader } from './kernel-app-file-reader.js';
import { kernelTabOrigin } from './kernel-denylist-policy.js';

// Public constructor for this exact composer-policy family. Keeping the entry
// on one reviewed edge prevents each small cold adapter from consuming another
// top-level import while its own native module remains independently measured.
export {
  createKernelDenylistNetworkCustody,
  createKernelDenylistPolicy,
  makeKernelDenylistRoutes,
} from './kernel-denylist-policy.js';
const COMMAND_PREFIX = 'peerd.commands.';
const SKILLS_DB = 'peerd-skills';
const SKILLS_VERSION = 1;
const SKILL_META = 'meta';

const skillDescription = (/** @type {unknown} */ value) => {
  const flat = disarmText(value ?? 'from a skill').replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}…` : flat;
};

/**
 * Metadata-only slash-command palette. Bodies remain demand-loaded by the
 * composer or skill owner that executes the selected command.
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
  /** @type {Promise<IDBDatabase>|null} */ let opened = null;
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
    .map((row) => ({ name: row.name, description: skillDescription(row.description) }));

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

/**
 * @param {Object} deps
 * @param {any} deps.browser
 * @param {{list:(prefix:string)=>Promise<Record<string,any>>}} deps.kv
 * @param {{get:(store:string,key:string)=>Promise<any>}} deps.idb
 * @param {{sessionGet:(key:string)=>Promise<any>}} deps.sessionCache
 * @param {{isLocked:()=>boolean}} deps.vault
 * @param {{ready:()=>Promise<{ok:boolean}>,blocks:(hostname:string)=>boolean,patterns:()=>string[],snapshot:()=>Promise<any>}} deps.denylist
 * @param {{list:()=>Promise<Array<{name:string,description:string}>>}} [deps.commands]
 * @param {{list:()=>Promise<string[]>}} [deps.appFiles]
 */
export const makeKernelComposerRoutes = ({
  browser, kv, idb, sessionCache, vault, denylist,
  commands = createKernelCommandReader({ kv }),
  appFiles = createKernelAppFileReader({ idb, sessionCache }),
}) => {
  return Object.freeze({
    'denylist/list': async () => denylist.snapshot(),
    'commands/list': async () => ({ ok: true, commands: await commands.list() }),
    'composer/files': async () => {
      if (vault.isLocked()) return { ok: true, files: [] };
      try { return { ok: true, files: await appFiles.list() }; }
      catch { return { ok: true, files: [] }; }
    },
    'composer/tabs': async () => {
      await denylist.ready();
      let tabs = [];
      try { tabs = await browser.tabs.query({}); } catch { tabs = []; }
      return renderComposerTabs(projectComposerTabRows(tabs, {
        originOfTabUrl: kernelTabOrigin,
        matchesDenylist: (host) => denylist.blocks(host),
        patterns: denylist.patterns,
      }));
    },
  });
};
