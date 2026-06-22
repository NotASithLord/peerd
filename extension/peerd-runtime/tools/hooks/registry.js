// @ts-check
// Hook registry — the imperative shell around the pure runner.
//
// Two populations of hooks live here:
//
//   1. DEFAULT (code) hooks — registered by the chassis at boot. These
//      are trusted, in-tree JS. The egress-allowlist hook is the
//      flagship: the network-origin check is implemented AS a default
//      pre-tool-use hook (see ./defaults/egress-allowlist.js), proving
//      the model is load-bearing and not a toy.
//   2. USER (config) hooks — authored by the user as markdown + JS in
//      the peerd workspace at `.peerd/hooks/`. peerd has no real
//      filesystem, so "`.peerd/hooks/`" is a logical path; the bytes
//      live in chrome.storage.local under HOOKS_STORAGE_KEY. The store
//      is injected (DI) so this module stays testable and so the SW
//      owns the single sanctioned write path.
//
// Registration is synchronous against module state (same shape as the
// tool registry). Loading user hooks from storage is async and happens
// once at boot; the result is folded into the same module-level list so
// the runner sees one merged, ordered population.
//
// Reversibility (a hard constraint): user hooks are plain serializable
// records. exportHooks() returns them for download; importHooks()
// restores; removeHook()/clearUserHooks() delete. Nothing about a hook
// is hidden in opaque state.

import { compileUserHook } from './compile.js';

/** @typedef {import('./runner.js').Hook} Hook */
/** @typedef {import('./compile.js').UserHookRecord} UserHookRecord */
/** A compiled user hook carries its source record back for export. @typedef {Hook & { _record: UserHookRecord }} CompiledUserHook */

// why: a versioned, namespaced key so a future schema change can migrate
// rather than silently mis-parse. Matches the `settings.v1` convention.
export const HOOKS_STORAGE_KEY = 'hooks.user.v1';

/** @type {Map<string, Hook>} default (code) hooks, keyed by id */
const defaultHooks = new Map();
/** @type {Map<string, CompiledUserHook>} compiled user hooks, keyed by id */
const userHooks = new Map();

/**
 * Register a DEFAULT (trusted, in-tree) hook. The chassis calls this at
 * boot for each built-in. Re-registering an id replaces it (tests swap
 * fakes). Validates the minimal shape so a malformed default surfaces
 * loudly at boot rather than silently never running.
 *
 * @param {Hook} hook
 */
export const registerHook = (hook) => {
  assertHookShape(hook);
  defaultHooks.set(hook.id, hook);
};

/**
 * The merged, live hook population the runner consumes. Defaults first,
 * then user hooks; the runner re-sorts by `order` anyway, so this order
 * only decides ties — and we want a default (e.g. egress) to win a tie
 * against a same-order user hook, hence defaults first.
 *
 * @returns {Hook[]}
 */
export const listHooks = () => [...defaultHooks.values(), ...userHooks.values()];

/**
 * The raw, serializable user-hook records (NOT the compiled fns). This
 * is the reversibility surface: export to JSON, re-import, diff. Default
 * hooks are code and intentionally excluded — you can't export your way
 * out of the egress allowlist.
 *
 * @returns {import('./compile.js').UserHookRecord[]}
 */
export const exportHooks = () => [...userHooks.values()].map((h) => h._record).filter(Boolean);

/**
 * Load user hooks from storage and compile them into the live registry.
 * Called once at boot by the SW. A hook record that fails to compile is
 * skipped with a console warning — one bad user hook must not take the
 * whole system down, and (per fail-closed) a hook that can't be loaded
 * simply doesn't run rather than running in some degraded mode.
 *
 * @param {Object} deps
 * @param {{ get: (k: string) => Promise<any> }} deps.kv
 * @param {(msg: string, err?: unknown) => void} [deps.warn]
 * @returns {Promise<{ loaded: number, skipped: number }>}
 */
export const loadUserHooks = async ({ kv, warn = (m, e) => console.warn(m, e) }) => {
  userHooks.clear();
  const records = (await kv.get(HOOKS_STORAGE_KEY)) ?? [];
  if (!Array.isArray(records)) {
    warn(`[hooks] ${HOOKS_STORAGE_KEY} is not an array — ignoring`);
    return { loaded: 0, skipped: 0 };
  }
  let loaded = 0;
  let skipped = 0;
  for (const record of records) {
    try {
      const hook = compileUserHook(record);
      userHooks.set(hook.id, hook);
      loaded += 1;
    } catch (e) {
      skipped += 1;
      warn(`[hooks] skipping malformed user hook '${record?.id ?? '?'}'`, e);
    }
  }
  return { loaded, skipped };
};

/**
 * Persist + install a single user hook. Writes the full record set back
 * (single-threaded writes — the SW is the only writer) and recompiles
 * into the live registry so it takes effect without a reload.
 *
 * @param {Object} deps
 * @param {{ get: (k: string) => Promise<any>, set: (k: string, v: any) => Promise<void> }} deps.kv
 * @param {import('./compile.js').UserHookRecord} record
 */
export const saveUserHook = async ({ kv }, record) => {
  const compiled = compileUserHook(record); // throws on malformed — caller surfaces
  const existing = (await kv.get(HOOKS_STORAGE_KEY)) ?? [];
  const next = Array.isArray(existing) ? existing.filter((r) => r.id !== record.id) : [];
  next.push(record);
  await kv.set(HOOKS_STORAGE_KEY, next);
  userHooks.set(compiled.id, compiled);
  return compiled;
};

/**
 * Delete one user hook by id (reversibility). Removes from storage and
 * the live registry. Default hooks can't be removed this way.
 *
 * @param {Object} deps
 * @param {{ get: (k: string) => Promise<any>, set: (k: string, v: any) => Promise<void> }} deps.kv
 * @param {string} id
 */
export const removeHook = async ({ kv }, id) => {
  const existing = (await kv.get(HOOKS_STORAGE_KEY)) ?? [];
  const next = Array.isArray(existing) ? existing.filter((r) => r.id !== id) : [];
  await kv.set(HOOKS_STORAGE_KEY, next);
  userHooks.delete(id);
};

/**
 * Clear ALL user hooks (defaults untouched). Reversibility / reset.
 *
 * @param {{ kv: { set: (k: string, v: any) => Promise<void> } }} deps
 */
export const clearUserHooks = async ({ kv }) => {
  await kv.set(HOOKS_STORAGE_KEY, []);
  userHooks.clear();
};

/** Test-only: wipe both populations so each case starts clean. */
export const _clearAllHooks = () => { defaultHooks.clear(); userHooks.clear(); };

/** @param {Hook} hook */
const assertHookShape = (hook) => {
  if (!hook || typeof hook.id !== 'string' || !hook.id) {
    throw new TypeError('registerHook: hook.id is required');
  }
  if (hook.event !== 'pre-tool-use' && hook.event !== 'post-tool-use') {
    throw new TypeError(`registerHook: hook '${hook.id}' has invalid event '${hook.event}'`);
  }
  if (typeof hook.run !== 'function') {
    throw new TypeError(`registerHook: hook '${hook.id}' has no run()`);
  }
};
