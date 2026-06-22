// @ts-check
// Thin adapter to feature 03's plan/act permission policy.
//
// Feature 03 (plan/act permissions) is built in parallel. Its contract,
// as agreed: a `permissions` object exposing `canWrite(ctx)` that returns
// `{ allowed: boolean, reason?: string }` (sync or async). In Plan mode
// it denies writes; in Act mode it allows them. The edit_file tool and
// the checkpoint manager must route every write through it.
//
// Until 03 lands, this default ALWAYS ALLOWS, so feature 02 is fully
// functional standalone. The integrator swaps `defaultWritePermissions`
// for 03's real object at the single call site in service-worker.js
// (search: EDIT_03_ADAPTER). No other code changes — the tool reads
// `ctx.permissions?.canWrite` and falls back to allow only if absent,
// so wiring 03 is purely additive.
//
// why a separate file: keeps the 03 seam in one named place the
// integrator can grep for, instead of an `|| true` scattered across the
// tool and the manager.

/**
 * @typedef {Object} WritePermissions
 * @property {(ctx: object) => ({ allowed: boolean, reason?: string }
 *   | Promise<{ allowed: boolean, reason?: string }>)} canWrite
 */

/** The fail-open default used when feature 03 isn't wired yet. */
export const defaultWritePermissions = Object.freeze({
  canWrite: () => ({ allowed: true, reason: 'no plan/act policy (feature 03 not wired)' }),
});

/**
 * Resolve the effective write permission for a tool context. Accepts
 * either 03's real object (on ctx.permissions) or nothing, and normalizes
 * the result to a settled { allowed, reason }.
 *
 * @param {object} ctx  the ToolContext (permissions? rides it off-spine)
 * @returns {Promise<{ allowed: boolean, reason?: string }>}
 */
export const resolveCanWrite = async (ctx) => {
  // why: feature-03 permissions ride ctx off the typed ToolContext spine —
  // narrow to the canWrite surface this adapter reads.
  const perms = /** @type {Partial<WritePermissions> | undefined} */ (
    /** @type {{ permissions?: unknown }} */ (ctx)?.permissions) ?? defaultWritePermissions;
  if (typeof perms.canWrite !== 'function') {
    return { allowed: true, reason: 'permissions.canWrite missing — defaulting to allow' };
  }
  try {
    return await perms.canWrite(ctx);
  } catch (e) {
    // why: fail CLOSED on a throwing policy. A broken permission check
    // must not become a silent write bypass — same posture as the
    // dispatcher's gate error handling.
    return { allowed: false, reason: `permission check failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
  }
};
