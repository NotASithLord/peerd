// @ts-check

import { guardStore } from './store-version.js';

// Detailed durability/portability rationale lives in the architecture doc;
// this cold module retains the executable registry and public types.
export const DURABILITY_TIERS = Object.freeze({
  EPHEMERAL: 'ephemeral',
  SESSION: 'session',
  PROFILE: 'profile',
  PORTABLE: 'portable',
});

/** @typedef {'ephemeral'|'session'|'profile'|'portable'} DurabilityTier */
/** @typedef {{store:string,version:number,tier:DurabilityTier,portable:boolean,
 * personPortable?:boolean,syncSurface?:string,deviceBound?:boolean,
 * physical?:{kvKeys?:string[],kvPrefixes?:string[],idbStores?:string[],selfHosted?:string[]}}} StoreEntry */

/** @type {readonly StoreEntry[]} */
export const STORE_REGISTRY = Object.freeze([
  Object.freeze({
    store: 'sessions', version: 1, tier: DURABILITY_TIERS.SESSION, portable: false,
    personPortable: true, syncSurface: 'sessions',
    physical: Object.freeze({ idbStores: ['sessions', 'session_messages'] }),
  }),
  Object.freeze({
    store: 'vault', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: true,
    personPortable: true, syncSurface: 'secrets',
    physical: Object.freeze({ idbStores: ['vault'], kvKeys: ['vault.v1'], kvPrefixes: ['secret:'] }),
  }),
  Object.freeze({
    store: 'memory', version: 1, tier: DURABILITY_TIERS.PORTABLE, portable: true,
    personPortable: true, syncSurface: 'memory',
    physical: Object.freeze({ idbStores: ['agents_memory'], kvKeys: ['memory_suggestions.v1'] }),
  }),
  Object.freeze({
    store: 'profiles', version: 1, tier: DURABILITY_TIERS.PORTABLE, portable: true,
    physical: Object.freeze({ idbStores: ['profiles'] }),
  }),
  Object.freeze({
    store: 'skills', version: 1, tier: DURABILITY_TIERS.PORTABLE, portable: true,
    personPortable: true, syncSurface: 'skills',
    physical: Object.freeze({ selfHosted: ['peerd-skills'] }),
  }),
  Object.freeze({
    store: 'hooks', version: 1, tier: DURABILITY_TIERS.PORTABLE, portable: true,
    personPortable: true, syncSurface: 'hooks',
    physical: Object.freeze({ kvKeys: ['hooks.user.v1'] }),
  }),
  Object.freeze({
    store: 'permission-grants', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false,
    physical: Object.freeze({ idbStores: ['tool_grants'], kvKeys: ['learnedOrigins.v1'] }),
  }),
  Object.freeze({
    store: 'audit', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false,
    physical: Object.freeze({ idbStores: ['audit_log', 'audit_meta'] }),
  }),
  Object.freeze({
    store: 'dpop-keys', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false, deviceBound: true,
    physical: Object.freeze({ idbStores: ['dpop_keys'] }),
  }),
  Object.freeze({
    store: 'device-key', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false, deviceBound: true,
    physical: Object.freeze({ kvKeys: ['secret:distributed/device-key/v1'] }),
  }),
  Object.freeze({
    store: 'engine-registries', version: 1, tier: DURABILITY_TIERS.SESSION, portable: false, deviceBound: true,
    physical: Object.freeze({ idbStores: ['vms', 'notebooks', 'pods', 'apps'] }),
  }),
  Object.freeze({
    store: 'opfs-workspaces', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false,
    deviceBound: true, personPortable: true, syncSurface: 'workspaces',
    physical: Object.freeze({ selfHosted: ['opfs'] }),
  }),
  Object.freeze({
    store: 'app-manifests', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false,
    personPortable: true, syncSurface: 'apps',
    physical: Object.freeze({
      idbStores: ['apps'], selfHosted: ['opfs:peerd-apps', 'peerd-app-bodies'],
    }),
  }),
  Object.freeze({
    store: 'dweb-release-history', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false,
    physical: Object.freeze({ kvKeys: ['dweb.metaHighWater.v1'] }),
  }),
  Object.freeze({
    store: 'dweb-identity', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false,
    physical: Object.freeze({ kvKeys: ['secret:distributed/identity/v1', 'dweb.seededApps'] }),
  }),
]);

// One atomic map prevents half-stamped cross-surface profiles.
export const VERSION_STAMP_KEY = 'peerd.lifecycle.storeVersions';

/** @param {string} name @returns {StoreEntry | undefined} */
export const storeEntry = (name) => STORE_REGISTRY.find((entry) => entry.store === name);

/** @returns {readonly StoreEntry[]} */
export const portableStores = () => STORE_REGISTRY.filter((entry) => entry.portable);

/** @returns {readonly StoreEntry[]} */
export const personPortableStores = () => STORE_REGISTRY.filter((entry) => entry.personPortable);

/** @returns {Record<string, string>} */
export const syncSurfaceStores = () => Object.fromEntries(
  STORE_REGISTRY
    .filter((entry) => entry.personPortable && entry.syncSurface)
    .map((entry) => [/** @type {string} */ (entry.syncSurface), entry.store]),
);

/** @returns {string[]} */
export const omittedDeviceBoundStores = () =>
  STORE_REGISTRY.filter((entry) => entry.deviceBound).map((entry) => entry.store);

/** @typedef {{store:string,stamped:unknown,mode:'read-write'|'migrate'|'read-only',
 * versionClass:import('./store-version.js').VersionClass,reason:string,
 * diagnosticId?:string,firstRun?:true}} StoreCheck */
/** @param {{read:()=>Promise<Record<string,number>|undefined>}} io
 * @returns {Promise<{ok:boolean,stores:StoreCheck[]}>} */
export const checkStores = async ({ read }) => {
  const stamps = (await read()) ?? {};
  const stores = STORE_REGISTRY.map((entry) => {
    const stamped = stamps[entry.store];
    const firstRun = stamped === undefined;
    const guard = guardStore({
      store: entry.store,
      found: firstRun ? entry.version : stamped,
      supported: entry.version,
    });
    const productionGuard = guard.mode === 'migrate'
      ? {
          ...guard,
          mode: /** @type {const} */ ('read-only'),
          reason: `schema v${String(stamped)} requires migration to v${entry.version}, `
            + `but this build has no migration plan for ${entry.store}; original data retained`,
          diagnosticId: `store-${entry.store}-migration-unavailable-v${String(stamped)}-to-v${entry.version}`,
        }
      : guard;
    return /** @type {StoreCheck} */ ({
      store: entry.store,
      stamped,
      ...productionGuard,
      ...(firstRun ? { firstRun: true } : {}),
    });
  });
  return { ok: stores.every((check) => check.mode !== 'read-only'), stores };
};

/** @param {{read:()=>Promise<Record<string,number>|undefined>,
 * write:(map:Record<string,number>)=>Promise<void>}} io @returns {Promise<string[]>} */
export const stampStores = async ({ read, write }) => {
  const stamps = (await read()) ?? {};
  /** @type {Record<string, number>} */
  const next = { ...stamps };
  /** @type {string[]} */
  const stamped = [];
  let changed = false;
  for (const entry of STORE_REGISTRY) {
    const found = stamps[entry.store];
    if (found !== undefined && found !== entry.version) continue;
    if (found === undefined) {
      next[entry.store] = entry.version;
      changed = true;
    }
    stamped.push(entry.store);
  }
  if (changed) await write(next);
  return stamped;
};

/** @param {{read:()=>Promise<Record<string,number>|undefined>,
 * write:(map:Record<string,number>)=>Promise<void>,block:(stores:StoreCheck[])=>void}} io
 * @returns {Promise<{ok:boolean,stores:StoreCheck[],blocked:StoreCheck[]}>} */
export const applyStoreBootPosture = async ({ read, write, block }) => {
  const check = await checkStores({ read });
  if (check.ok) {
    await stampStores({ read, write });
    return { ...check, blocked: [] };
  }
  const blocked = check.stores.filter((store) => store.mode === 'read-only');
  block(blocked);
  return { ...check, blocked };
};
