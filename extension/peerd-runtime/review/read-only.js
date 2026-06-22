// @ts-check
// Read-only enforcement for the clean-context reviewer.
//
// CRITICAL invariant (feature 03 / single-threaded writes): the reviewer
// is a SECOND agent instance with NO authority to change anything. Only
// the writer agent edits. If a reviewer could click, type, navigate, run
// VM commands, or create/update an App, two agents would be writing to
// the same workspace at once — a race the harness explicitly forbids, and
// a lethal-trifecta amplifier (the reviewer reads the diff = untrusted
// content, so it must not also have an exfiltration/mutation channel).
//
// Two layers, both here:
//   1. readOnlyToolNames(descriptors)  — what the reviewer SEES. We narrow
//      to tools whose descriptor declares `sideEffect: 'read'`. This is the
//      allowlist the spawn machinery's `tools:[...]` param consumes.
//   2. assertReadOnly(name, descriptors) — what the reviewer can DO. A
//      defense-in-depth predicate the dispatcher wrapper consults so even a
//      hallucinated/renamed write tool is refused at call time.
//
// Pure functions only. The dispatcher wrapper that USES assertReadOnly
// lives in orchestrator.js (the imperative shell).

// why: spawn_subagent is read-classified nowhere — it's a 'write'
// sideEffect — but we name it explicitly too, so a future re-tagging can't
// silently hand the reviewer the ability to fan out its own agents.
const ALWAYS_DENIED = Object.freeze(new Set(['spawn_subagent', 'request_review']));

/**
 * The set of tool names a reviewer may be granted: declared read-only AND
 * not on the always-denied list. This is the `permissions.readOnlyTools()`
 * adapter's local implementation — feature 03 can supply its own set; if
 * it does, intersect the two (see orchestrator.js) so neither can widen
 * the other.
 *
 * @param {ReadonlyArray<{ name: string, sideEffect?: string }>} descriptors
 * @returns {string[]}
 */
export const readOnlyToolNames = (descriptors) =>
  descriptors
    .filter((d) => d.sideEffect === 'read' && !ALWAYS_DENIED.has(d.name))
    .map((d) => d.name);

/**
 * Defense-in-depth predicate: is `name` safe for the reviewer to execute?
 * Consulted by the dispatcher wrapper at call time. A tool the reviewer
 * was never granted, OR any non-read tool, fails closed.
 *
 * @param {string} name
 * @param {ReadonlyArray<{ name: string, sideEffect?: string }>} descriptors
 * @returns {boolean}
 */
export const isReadOnlyTool = (name, descriptors) => {
  if (ALWAYS_DENIED.has(name)) return false;
  const d = descriptors.find((x) => x.name === name);
  // Unknown tool → not in the read-only set → refuse. Fail closed.
  return !!d && d.sideEffect === 'read';
};

/**
 * Intersect the local read-only set with an externally-supplied allowlist
 * (feature 03's `permissions.readOnlyTools()`), when present. Intersection,
 * not union: the reviewer gets only what BOTH gates agree is read-only, so
 * a permissive external set can't loosen the local floor and vice versa.
 *
 * @param {string[]} local
 * @param {Iterable<string> | null | undefined} external
 * @returns {string[]}
 */
export const intersectReadOnly = (local, external) => {
  if (!external) return local;
  const ext = external instanceof Set ? external : new Set(external);
  return local.filter((n) => ext.has(n));
};
