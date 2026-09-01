// @ts-check
import { APP_DWEB_GENERATION_PREFIX } from '/shared/dweb-interface.js';
export class AppRoomAuthorityChangedError extends Error { constructor() { super('App room authority changed'); this.name = 'AppRoomAuthorityChangedError'; } }
/** @param {{get:(key:null)=>Promise<Record<string,unknown>>}} storage */
export const createAppRoomAuthority = (storage) => {
  const floors = new Map(), tails = new Map();
  const ready = storage.get(null).then((values) => {
    for (const [key, value] of Object.entries(values)) if (key.startsWith(APP_DWEB_GENERATION_PREFIX)
      && Number.isSafeInteger(value) && Number(value) >= 0) floors.set(key.slice(APP_DWEB_GENERATION_PREFIX.length), Number(value));
  }); ready.catch(() => {});
  const isCurrent = (/** @type {string} */ appId, /** @type {number} */ generation) => Number.isSafeInteger(generation) && generation >= 0 && generation >= (floors.get(appId) ?? 0);
  /** @template T @param {string} appId @param {()=>Promise<T>|T} operation */
  const queue = (appId, operation) => {
    const current = (tails.get(appId) ?? Promise.resolve()).catch(() => {}).then(operation); tails.set(appId, current);
    return current.finally(() => { if (tails.get(appId) === current) tails.delete(appId); });
  };
  /** @template T @param {string} appId @param {number} generation @param {(current:()=>boolean,advanced:boolean)=>Promise<T>|T} operation */
  const run = (appId, generation, operation) => ready.then(() => queue(appId, () => {
    const floor = floors.get(appId) ?? 0; if (!isCurrent(appId, generation)) throw new AppRoomAuthorityChangedError();
    floors.set(appId, generation); return operation(() => isCurrent(appId, generation), generation > floor);
  }));
  /** @template T @param {string} appId @param {number} generation @param {()=>Promise<T>|T} operation */
  const rotate = (appId, generation, operation) => ready.then(() => {
    if (!isCurrent(appId, generation)) throw new AppRoomAuthorityChangedError(); floors.set(appId, generation); return queue(appId, operation);
  });
  return { run, rotate };
};
