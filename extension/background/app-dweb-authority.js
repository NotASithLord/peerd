// @ts-check
// One kernel-owned consent generation shared by cold UI and rich App paths.
import { APP_DWEB_GENERATION_PREFIX } from '/shared/dweb-interface.js';

export class AppDwebAuthorityChangedError extends Error {
  constructor(/** @type {number} */ generation) {
    super('App dweb authority changed after approval');
    this.name = 'AppDwebAuthorityChangedError';
    this.generation = generation;
  }
}

/** @param {{storage:{get:(key:null)=>Promise<Record<string,any>>,set:(value:Record<string,any>)=>Promise<any>},
 * tabIds:(appId:string)=>Promise<number[]>,stopTab:(appId:string,tabId:number)=>Promise<any>,
 * closeTab:(tabId:number)=>Promise<any>,purgeOwners:(appId:string,generation:number)=>Promise<any>}} deps */
export const createAppDwebAuthority = ({ storage, tabIds, stopTab, closeTab, purgeOwners }) => {
  /** @type {Map<string,number>} */ const generations = new Map();
  /** @type {Map<string,Promise<unknown>>} */ const tails = new Map();
  /** @type {Map<number,{appId:string,generation:number}>} */ const retiredTabs = new Map();
  const ready = storage.get(null).then((values) => {
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith(APP_DWEB_GENERATION_PREFIX) && Number.isSafeInteger(value) && value >= 0) {
        generations.set(key.slice(APP_DWEB_GENERATION_PREFIX.length), value);
      }
    }
  });
  ready.catch(() => {});
  const generation = (/** @type {string} */ appId) => generations.get(appId) ?? 0;
  const advance = async (/** @type {string} */ appId) => {
    await ready;
    const next = generation(appId) + 1;
    if (!Number.isSafeInteger(next)) throw new Error('App consent generation exhausted');
    generations.set(appId, next);
    await storage.set({ [`${APP_DWEB_GENERATION_PREFIX}${appId}`]: next });
    return next;
  };
  const invalidate = async (/** @type {string} */ appId) => {
    const ids = await tabIds(appId);
    const next = await advance(appId);
    const stopped = await Promise.allSettled(ids.map((id) => stopTab(appId, id)));
    let failure;
    for (const [index, result] of stopped.entries()) {
      if (result.status === 'fulfilled') continue;
      failure ??= result.reason;
      try { await closeTab(ids[index]); } catch { /* mutation still fails closed */ }
    }
    // why: persistence precedes the host purge. A renderer or worker restart
    // cannot admit an old join while a content mutation is in flight.
    await purgeOwners(appId, next);
    if (failure) throw failure;
    for (const tabId of ids) retiredTabs.set(tabId, { appId, generation: next });
    return ids.length > 0;
  };
  /** @template T @param {string} appId @param {()=>Promise<T>} operation
   * @param {{invalidate?:boolean,expectedGeneration?:number}} [options] */
  const run = (appId, operation, { invalidate: rotate = false, expectedGeneration } = {}) => {
    const current = (tails.get(appId) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await ready;
      if (expectedGeneration != null && generation(appId) !== expectedGeneration) {
        throw new AppDwebAuthorityChangedError(generation(appId));
      }
      if (rotate) await invalidate(appId);
      return operation();
    });
    tails.set(appId, current);
    return current.finally(() => { if (tails.get(appId) === current) tails.delete(appId); });
  };
  return Object.freeze({
    ready: () => ready, generation, invalidate, run,
    snapshot: async () => {
      await ready;
      return Object.fromEntries([...generations].map(([id, value]) => [`${APP_DWEB_GENERATION_PREFIX}${id}`, value]));
    },
    activateTab: (/** @type {string} */ appId, /** @type {number} */ tabId) => {
      if (retiredTabs.get(tabId)?.appId === appId) retiredTabs.delete(tabId);
    },
    retire: (/** @type {string} */ appId, /** @type {number|undefined} */ tabId = undefined) => run(appId, async () => {
      const retired = tabId == null ? null : retiredTabs.get(tabId);
      // why: closing/reloading a document already invalidated by this mutation
      // must not immediately invalidate the conflict token it is returning.
      if (retired?.appId === appId && retired.generation === generation(appId)) return;
      const next = await advance(appId);
      await purgeOwners(appId, next);
      if (tabId != null) retiredTabs.set(tabId, { appId, generation: next });
    }),
  });
};
