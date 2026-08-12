// @ts-check
// The durable-surface registry (contract §11.1 + §12) — WHICH stores are
// durable, what schema version this build speaks for each, and how far
// each one's data is allowed to travel.
//
// §11.1: every durable surface carries its OWN schema version. The
// numbers here ratchet INDEPENDENTLY — bumping `sessions` says nothing
// about `memory`, so a change to one surface never forces a lockstep
// migration of the rest. `guardStore` (store-version.js) consumes these
// numbers as its `supported` input; this file is the only place they are
// declared.
//
// §12: durability tiers say how long a surface's data is scoped to live,
// and `portable` says whether it may cross installs at all. Device-bound
// state (a non-extractable key handle, an OPFS root, a tab id) is
// STRUCTURALLY untransferable — so the export must NAME what it left
// behind rather than silently shipping a profile that is missing it.
//
// Pure policy plus an injected boot shell. Nothing here touches chrome.*
// storage directly.

import { guardStore } from './store-version.js';

/**
 * §12 durability tiers.
 *
 * why these four: they are the four answers to "what does this data
 * outlive?" —
 *   EPHEMERAL  dies with the process that made it (a turn, a worker
 *              heap, a service-worker generation); never persisted, so
 *              never in this registry.
 *   SESSION    outlives the process but is scoped to one conversation /
 *              engine session; meaningless once that session is gone.
 *   PROFILE    outlives every session, scoped to this install's profile;
 *              the default for durable state.
 *   PORTABLE   scoped to the USER, not the install — designed to be
 *              carried to another peerd via export/import.
 */
export const DURABILITY_TIERS = Object.freeze({
  EPHEMERAL: 'ephemeral',
  SESSION: 'session',
  PROFILE: 'profile',
  PORTABLE: 'portable',
});

/** @typedef {'ephemeral' | 'session' | 'profile' | 'portable'} DurabilityTier */

/**
 * @typedef {Object} StoreEntry
 * @property {string} store          lowercase-hyphenated surface name
 * @property {number} version        schema version THIS build speaks
 * @property {DurabilityTier} tier   §12 durability tier
 * @property {boolean} portable      may this surface cross installs via the
 *   FILE export? (the hand-carried peerd-export path)
 * @property {boolean} [personPortable] may this surface cross installs via
 *   VERIFIED SELF-DEVICE SYNC? A third axis added by the portable-identity
 *   arc. It is deliberately BROADER than `portable`: a surface can be
 *   unsafe to write to a JSON file a stranger might read (sessions carry
 *   conversation bodies; apps carry executable artifacts) yet safe to
 *   replicate to a peer that has cryptographically proven it is the same
 *   person's device. `portable` gates the file box; `personPortable` gates
 *   the sync offer. Device-bound state is never either.
 * @property {string} [syncSurface] the self/sync.js SYNC_SURFACES name this
 *   store shapes into, when personPortable: the translation the sync host
 *   uses without knowing store internals.
 * @property {boolean} [deviceBound] structurally untransferable state
 * @property {{ kvKeys?: string[], kvPrefixes?: string[], idbStores?: string[],
 *   selfHosted?: string[] }} [physical]
 *   where the surface's bytes actually live — the write guard
 *   (write-guard.js) maps a read-only verdict onto these locations.
 *   kvKeys/kvPrefixes: chrome.storage.local via the egress kv adapter;
 *   idbStores: object stores in the `peerd` IndexedDB; selfHosted: whole
 *   DATABASES or roots a module opens itself. Those modules receive the live
 *   guard explicitly because adapter wrapping cannot reach their writes.
 */

/**
 * The durable surfaces.
 *
 * why `tier` and `portable` are separate axes: tier answers "what does
 * this outlive", portable answers "may it leave this install" — and they
 * genuinely disagree. The vault is PROFILE-tier (the DK never leaves it)
 * yet its secrets are portable-where-policy-permits, re-encrypted under a
 * user passphrase by the transfer surface. A device-bound entry is never
 * portable: no policy can make a non-extractable key handle travel.
 *
 * All versions start at 1 and move independently (§11.1).
 *
 * @type {readonly StoreEntry[]}
 */
export const STORE_REGISTRY = Object.freeze([
  // Conversation state: durable across service-worker generations, but its
  // meaning dies with the SESSION it belongs to, so it stays non-portable
  // to the FILE box (a stranger reading the JSON would read your chats).
  // It IS personPortable: a proven self-device may replicate the durable
  // conversation content (a stripped record; actor/runtime bookkeeping does
  // not travel, self-sync-surfaces.js owns that projection).
  Object.freeze({
    store: 'sessions', version: 1, tier: DURABILITY_TIERS.SESSION, portable: false,
    personPortable: true, syncSurface: 'sessions',
    physical: Object.freeze({ idbStores: ['sessions', 'session_messages'] }),
  }),
  // The encrypted blob travels; the DK does not (transfer re-encrypts the
  // plaintext secrets under a passphrase the user types at export time).
  // The session DK mirror lives in chrome.storage.session — session-tier
  // by definition, outside the guard's remit. personPortable via the
  // explicit, consent-gated secrets surface (never silently).
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
  // Skill METADATA travels; bodies reinstall from their origin. The store
  // opens its OWN database (peerd-skills) — unreachable through the
  // injected adapters, so read-only enforcement is a per-module follow-up.
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
  // Consent is granted to THIS install by THIS user; a transplanted grant
  // would be consent nobody gave here, so it never travels: NOT portable,
  // NOT personPortable (issue invariant 13: permission grants never arrive
  // via profile sync). (The durable tool_grants object store exists in the
  // schema but nothing writes it yet, live grants are in-memory.)
  Object.freeze({
    store: 'permission-grants', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false,
    physical: Object.freeze({ idbStores: ['tool_grants'], kvKeys: ['learnedOrigins.v1'] }),
  }),
  // Append-only local record; importing one elsewhere would misattribute
  // history to a device that never did it: NOT personPortable either
  // (issue invariant 14: audit provenance is not rewritten).
  Object.freeze({
    store: 'audit', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false,
    physical: Object.freeze({ idbStores: ['audit_log', 'audit_meta'] }),
  }),
  // Rung 2 of the credential ladder: non-extractable keypair HANDLES. Not
  // "policy says no" — the platform cannot export the key material at all.
  Object.freeze({
    store: 'dpop-keys', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false, deviceBound: true,
    physical: Object.freeze({ idbStores: ['dpop_keys'] }),
  }),
  // The per-install device key (portable-identity arc). Same custody as the
  // did:key root: a vault secret under the device-key prefix, but UNLIKE
  // the root it is deviceBound: it must NEVER travel (issue invariant 9).
  // A fresh install mints its own and gets it certified during enrollment.
  Object.freeze({
    store: 'device-key', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false, deviceBound: true,
    physical: Object.freeze({ kvKeys: ['secret:distributed/device-key/v1'] }),
  }),
  // Live instance bookkeeping (tab ids, engine handles) — valid only for
  // the browser session that minted it. NOTE: the `apps` blob is shared
  // with app-manifests below — the two surfaces version independently but
  // physically co-locate, so blocking either blocks the shared blob.
  Object.freeze({
    store: 'engine-registries', version: 1, tier: DURABILITY_TIERS.SESSION, portable: false, deviceBound: true,
    physical: Object.freeze({ idbStores: ['vms', 'notebooks', 'pods', 'apps'] }),
  }),
  // OPFS handles are device-bound and must remain so, but the workspace
  // CONTENTS are not inherently device-bound. The `opfs-workspaces` store's
  // physical HANDLES never travel (deviceBound); the portable-identity arc
  // adds a distinct LOGICAL snapshot surface (self-sync-surfaces.js walks
  // the tree into path→bytes and re-materializes it into a fresh receiving
  // OPFS root: never a platform handle). That logical surface is what
  // `personPortable`+`syncSurface:'workspaces'` names here; the deviceBound
  // flag still forbids the file box and the raw-handle path.
  Object.freeze({
    store: 'opfs-workspaces', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false,
    deviceBound: true, personPortable: true, syncSurface: 'workspaces',
    physical: Object.freeze({ selfHosted: ['opfs'] }),
  }),
  // Manifest metadata shares the `apps` blob (see engine-registries). Current
  // App files live in OPFS; peerd-app-bodies is a reserved legacy database.
  // personPortable via LOGICAL App artifacts (manifest + content-addressed
  // body/assets), never the local IDB handle, self-sync-surfaces.js shapes
  // them; the receiver re-installs into fresh local storage.
  Object.freeze({
    store: 'app-manifests', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false,
    personPortable: true, syncSurface: 'apps',
    physical: Object.freeze({
      idbStores: ['apps'], selfHosted: ['opfs:peerd-apps', 'peerd-app-bodies'],
    }),
  }),
  // The did:key keypair is a vault secret — physically under the vault's
  // secret: prefix, encrypted under the DK.
  Object.freeze({
    store: 'dweb-identity', version: 1, tier: DURABILITY_TIERS.PROFILE, portable: false,
    physical: Object.freeze({ kvKeys: ['secret:distributed/identity/v1', 'dweb.seededApps'] }),
  }),
]);

/**
 * The single kv key the service-worker adapter stores the stamps under.
 *
 * Shape: a `{ [store]: number }` map — one record holding every surface's
 * stamped version, absent entirely until the first `stampStores` run.
 *
 * why the WHOLE map through one key (and why `read`/`write` below take no
 * store name): stamping is a cross-surface decision made once at startup,
 * and a single read/write keeps it atomic — a per-store key layout would
 * let a crash land a half-stamped profile, which is exactly the state
 * §11's guard cannot tell apart from a genuine version skew.
 */
export const VERSION_STAMP_KEY = 'peerd.lifecycle.storeVersions';

/**
 * Look a surface up by name.
 *
 * @param {string} name
 * @returns {StoreEntry | undefined}
 */
export const storeEntry = (name) => STORE_REGISTRY.find((entry) => entry.store === name);

/** @returns {readonly StoreEntry[]} surfaces an export may carry */
export const portableStores = () => STORE_REGISTRY.filter((entry) => entry.portable);

/**
 * Surfaces a VERIFIED SELF-DEVICE SYNC may carry (the broader axis)
 * settings/providerEndpoints are transfer sections rather than registry
 * stores, so the sync host adds them explicitly; this returns the registry
 * stores that opt in.
 * @returns {readonly StoreEntry[]}
 */
export const personPortableStores = () => STORE_REGISTRY.filter((entry) => entry.personPortable);

/**
 * The self/sync.js surface names this build can offer, mapped from their
 * owning store. Used by the sync host to assert an offered/pulled surface
 * corresponds to a real, opted-in store.
 * @returns {Record<string, string>} syncSurface -> store
 */
export const syncSurfaceStores = () => Object.fromEntries(
  STORE_REGISTRY
    .filter((entry) => entry.personPortable && entry.syncSurface)
    .map((entry) => [/** @type {string} */ (entry.syncSurface), entry.store]),
);

/**
 * The §12 disclosure list: names of the surfaces an export STRUCTURALLY
 * cannot carry. The export format must identify these — a profile that
 * silently arrives without its device-bound state looks corrupt, not
 * incomplete.
 *
 * @returns {string[]}
 */
export const omittedDeviceBoundStores = () =>
  STORE_REGISTRY.filter((entry) => entry.deviceBound).map((entry) => entry.store);

/**
 * @typedef {Object} StoreCheck
 * @property {string} store
 * @property {unknown} stamped        the version found on disk (undefined = never stamped)
 * @property {'read-write' | 'migrate' | 'read-only'} mode
 * @property {import('./store-version.js').VersionClass} versionClass
 * @property {string} reason
 * @property {string} [diagnosticId]
 * @property {true} [firstRun]        unstamped: a fresh profile, about to be stamped
 */

/**
 * Classify every registered surface against the stamps on disk.
 *
 * An UNSTAMPED store is a fresh profile, not a skew: it is classified as
 * current (nothing has been written under an older schema yet) and marked
 * `firstRun` so the caller can tell "brand new" from "verified current" —
 * only the former should be stamped without a migration having run.
 *
 * @param {Object} io
 * @param {() => Promise<Record<string, number> | undefined>} io.read  the whole stamp map
 * @returns {Promise<{ ok: boolean, stores: StoreCheck[] }>}
 */
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
    // why fail closed here: runMigration is a reusable pure engine, but a
    // store is not migratable in production until the registry carries a
    // concrete plan for that store. Treating "migrate" as writable before
    // such a plan exists lets current code mutate older data in place.
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
  // A migrate verdict is converted above until that store has a real plan.
  // Any read-only verdict keeps the boot shell out of the stamping path.
  return { ok: stores.every((check) => check.mode !== 'read-only'), stores };
};

/**
 * Stamp this build's versions for every surface that is unstamped or
 * already current.
 *
 * The two refusals are the whole point:
 *   - a NEWER stamp is never lowered — that is the §11.5 downgrade
 *     refusal; overwriting it would tell the next (newer) build that its
 *     own data is old and invite a destructive "migration".
 *   - an OLDER stamp is never raised — stamping is a migration's final
 *     act, and only after it succeeded. Raising it here would declare
 *     data migrated that nobody migrated.
 * A malformed stamp is left alone for the same reason: unclassifiable
 * data is retained for diagnosis, never clobbered.
 *
 * @param {Object} io
 * @param {() => Promise<Record<string, number> | undefined>} io.read
 * @param {(map: Record<string, number>) => Promise<void>} io.write
 * @returns {Promise<string[]>} names now stamped at this build's version
 */
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
  // why only on change: a rerun of an already-stamped profile is a no-op
  // write that would still wake every storage listener.
  if (changed) await write(next);
  return stamped;
};

/**
 * Apply the production store posture once at service-worker boot.
 *
 * why one shell: checking, blocking, and stamping must stay one decision. A
 * caller must not accidentally stamp after a blocked check or forget to arm
 * the physical write guard for an incompatible store.
 *
 * @param {Object} io
 * @param {() => Promise<Record<string, number> | undefined>} io.read
 * @param {(map: Record<string, number>) => Promise<void>} io.write
 * @param {(stores: StoreCheck[]) => void} io.block
 * @returns {Promise<{ ok: boolean, stores: StoreCheck[], blocked: StoreCheck[] }>}
 */
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
