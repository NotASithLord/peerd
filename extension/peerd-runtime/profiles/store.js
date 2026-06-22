// @ts-check
// Profile store — CRUD over the IDB `profiles` object store.
//
// A pure store factory over injected idb, mirroring sessions/store.js:
// IO is a parameter, never an import (the functional-core /
// imperative-shell rule). V1 ships exactly ONE profile — 'default' —
// but the API is already shaped the way multi-profile will need it
// (get/list/update by id), so profiles can later multiply without a
// store rewrite. Nothing here namespaces other subsystems; everything
// global stays global until multi-profile actually lands.

import { ProfileNotFoundError } from '../errors.js';
import {
  DEFAULT_PROFILE_ID,
  defaultProfileRecord,
  normalizePeerName,
} from './profile.js';

const STORE = 'profiles';

/** @typedef {import('./profile.js').ProfileRecord} ProfileRecord */

/**
 * @param {Object} deps
 * @param {{
 *   get: (store: string, key: string) => Promise<any>,
 *   put: (store: string, value: any) => Promise<void>,
 *   getAll: (store: string) => Promise<any[]>,
 * }} deps.idb
 * @param {() => number} [deps.now]  injectable clock
 */
export const createProfileStore = ({ idb, now = Date.now }) => {
  if (!idb || typeof idb.get !== 'function') {
    throw new TypeError('createProfileStore: idb adapter is required');
  }

  /**
   * @param {string} profileId
   * @returns {Promise<ProfileRecord | undefined>}
   */
  const get = (profileId) => idb.get(STORE, profileId);

  /** All profiles, oldest first — stable for a future profile picker. */
  const list = async () => {
    /** @type {ProfileRecord[]} */
    const all = await idb.getAll(STORE);
    return all.sort((a, b) => a.createdAt - b.createdAt);
  };

  /**
   * Idempotent first-run create of the default profile. Returns the
   * existing record untouched when present — callers can hit this on
   * every state push without ever clobbering the user's peerName or
   * re-arming the onboarding latch.
   *
   * @returns {Promise<ProfileRecord>}
   */
  const ensureDefault = async () => {
    const existing = await get(DEFAULT_PROFILE_ID);
    if (existing) return existing;
    const record = defaultProfileRecord({ now });
    await idb.put(STORE, record);
    return record;
  };

  /**
   * Shallow-patch a profile and persist. Throws if the profile is gone.
   *
   * @param {string} profileId
   * @param {Partial<ProfileRecord>} patch
   * @returns {Promise<ProfileRecord>}
   */
  const update = async (profileId, patch) => {
    const existing = await get(profileId);
    if (!existing) throw new ProfileNotFoundError(profileId);
    // why pin id/createdAt: they are the record's identity — a patch
    // must never move a record to another key or rewrite its origin.
    const updated = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
    };
    await idb.put(STORE, updated);
    return updated;
  };

  /**
   * Onboarding's single write: set the peer's display name (normalized
   * at this chokepoint) and latch onboardingComplete so the first-run
   * flow never re-fires. Skip and Start both land here — skipping the
   * basic-facts fields still completes onboarding.
   *
   * @param {Object} [input]
   * @param {string} [input.profileId]
   * @param {string} [input.peerName]
   * @returns {Promise<ProfileRecord>}
   */
  const completeOnboarding = async ({ profileId = DEFAULT_PROFILE_ID, peerName } = {}) => {
    // why ensureDefault first: onboarding may complete before any state
    // push ever materialized the record (fresh install, fast clicker).
    await ensureDefault();
    return update(profileId, {
      peerName: normalizePeerName(peerName),
      onboardingComplete: true,
      onboardedAt: now(),
    });
  };

  return Object.freeze({ get, list, ensureDefault, update, completeOnboarding });
};
