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

// why: actor_create is read-classified nowhere — it's a 'write'
// sideEffect — but we name it explicitly too, so a future re-tagging can't
// silently hand the reviewer the ability to fan out its own agents.
const ALWAYS_DENIED = Object.freeze(new Set(['actor_create', 'request_review']));

// The reviewer's grant, BY NAME. This list is the floor.
//
// why a positive allowlist and not "everything tagged sideEffect:'read'":
// `sideEffect:'read'` means the tool does not MUTATE. It does NOT mean the tool
// cannot EXFILTRATE — and peerd's own `fetch_url` is `sideEffect:'read'` while
// taking an attacker-chosen url, method and body. So the old filter would have
// handed this module's stated adversary (see the header: the reviewer reads the
// diff = untrusted content, so it must not also hold an exfiltration channel)
// exactly the channel it exists to deny.
//
// It did not, in fact, leak: `actor/spawn.js` recomputes the grantable universe
// as filterActorSurface(mainAgentDescriptors(...)) and INTERSECTS this request
// against it, and `fetch_url` sits in MAIN_AGENT_HIDDEN_TOOLS — so it was never
// grantable. But that is the wrong place for this invariant to live: that list
// is a CONTEXT-HYGIENE policy about what the orchestrator should delegate rather
// than call, not a security boundary, and nothing sits behind it (the
// egress-allowlist hook early-returns allow for any non-`mutate_external` tool,
// fetch_url confirms only non-GET, the denylist is default-allow, and
// exposureGate does not fire for a spawned ctx). Un-hiding `fetch_url` for
// unrelated product reasons would have silently armed the reviewer.
//
// A positive list fails CLOSED: a newly-added tool is ungrantable here until
// someone adds it deliberately. A denylist, or an `egress: true` descriptor
// flag, both fail OPEN — a new egress-capable read tool that nobody remembers to
// mark is granted by default, which is precisely the shape of the near-miss above.
//
// The names below are exactly the set the reviewer already received before this
// list existed, so this change is behavior-preserving by construction (pinned by
// review.test.ts against the REAL pipeline). Some of them are worth a second
// look on their own merits — `inspect` (storage/audit/denylist/provider config),
// `read_memory` (the user's durable notes), `app_search` (returns App body-HTML
// snippets, which #159 tiered `app_read_file` actor-only to contain), and
// `capture` (active-tab screenshot; redacted to a sentinel before the model sees
// it, but the tab origin still lands) all give a CODE REVIEWER more private reach
// than reviewing a diff plausibly needs. Narrowing them is a deliberate product
// call, not a safety floor, so it is intentionally NOT bundled here.
const REVIEWER_TOOLS = Object.freeze(new Set([
  'actor_list', 'actor_tasks', 'app_search', 'capture', 'complete_goal',
  'inspect', 'load_skill', 'now', 'read_memory', 'schedule_list',
  'todo_add', 'todo_check', 'todo_init',
]));

/** Exported for the invariant tests (and so the grant is greppable). */
export const REVIEWER_ALLOWED_TOOLS = REVIEWER_TOOLS;

/**
 * The set of tool names a reviewer may be granted: on the positive allowlist,
 * still declared read-only (belt-and-braces — a tool re-tagged to a write drops
 * out without anyone editing this list), and not always-denied. This is the
 * `permissions.readOnlyTools()` adapter's local implementation — feature 03 can
 * supply its own set; if it does, intersect the two (see orchestrator.js) so
 * neither can widen the other.
 *
 * @param {ReadonlyArray<{ name: string, sideEffect?: string }>} descriptors
 * @returns {string[]}
 */
export const readOnlyToolNames = (descriptors) =>
  descriptors
    .filter((d) => REVIEWER_TOOLS.has(d.name) && d.sideEffect === 'read' && !ALWAYS_DENIED.has(d.name))
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
  // Same positive floor as the grant above — a name off the allowlist is refused
  // at call time even if it somehow reached the reviewer's granted set.
  if (!REVIEWER_TOOLS.has(name)) return false;
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
