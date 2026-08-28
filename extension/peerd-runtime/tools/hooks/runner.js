// @ts-check
// Hook runner — the functional core of the lifecycle-hook system (§10).
//
// A *hook* is a small policy function that observes or BLOCKS a tool call as it
// flows through the
// dispatcher. Two events ship in V1 — the two load-bearing ones:
//
//   pre-tool-use   runs AFTER the first synchronous gate pass and BEFORE
//                  confirmation or authority admission. A pre-hook may deny
//                  the call; arguments remain the model's admitted proposal.
//   post-tool-use  runs AFTER tool.execute() returns. Observe-only —
//                  it sees the result but cannot change it (V1).
//
// Why this lives next to the dispatcher and stays pure: the dispatcher
// is the one chokepoint every tool call passes through, so the hook
// phase belongs there. But the runner itself imports no IO — the
// registry and the per-hook fns are *injected* via ctx.hooks. That's
// the same functional-core / imperative-shell split the gates use, and
// it's what makes block / observe / fail-closed behavior unit-testable without
// a browser.
//
// User hooks are semantic/model guardrails, so they fail closed within that
// runtime: a pre-hook that throws, returns garbage, or times out blocks the
// semantic call instead of silently weakening the user's configured rule.
// Mandatory security floors also run independently at the host's exact-op
// edge; hooks are not authority against a compromised semantic heap.

/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult} ToolResult */

/**
 * @typedef {Object} HookInvocation   what every hook fn receives
 * @property {string} event           'pre-tool-use' | 'post-tool-use'
 * @property {string} toolName
 * @property {Record<string, any>} args   the proposed call args
 * @property {ToolResult} [result]    present only for post-tool-use
 * @property {ToolContext} ctx        frozen data-only policy projection
 */

/**
 * @typedef {Object} HookDecision     what a pre-tool-use hook may return
 * @property {'allow' | 'block'} [action]   default 'allow'
 * @property {string} [reason]        human-readable; surfaces in audit + UI lineage
 *
 * post-tool-use hooks return nothing meaningful (observe-only in V1);
 * any return value is ignored except that a THROW still fails closed.
 */

/**
 * @typedef {Object} Hook
 * @property {string} id              stable identifier, e.g. 'egress-allowlist'
 * @property {'pre-tool-use' | 'post-tool-use'} event
 * @property {boolean} [enabled]      default true; disabled hooks are skipped
 * @property {number} [order]         lower runs first; default 100. The egress
 *                                    allowlist hook uses a low order so it vetoes
 *                                    before softer policy hooks bother running.
 * @property {string} [match]         optional tool-name glob ('*' or 'fetch' or
 *                                    'page_*'); when set, the hook only runs for
 *                                    matching tools. Default: every tool.
 * @property {string} [description]   one human line for the management UI.
 *                                    For default (code) hooks this doubles as
 *                                    the visible reason the hook can't be
 *                                    disabled from config.
 * @property {(inv: HookInvocation) => (HookDecision | void | Promise<HookDecision | void>)} run
 */

/**
 * @typedef {Object} HookOutcome      one record per hook that ran, for lineage
 * @property {string} id
 * @property {'allow' | 'block' | 'observe'} action
 * @property {string} reason
 */

const DEFAULT_ORDER = 100;

/**
 * Glob match for the optional `match` field. Deliberately tiny: exact
 * name, '*' (all), or a single trailing '*' prefix glob ('page_*'). We
 * do NOT pull in a regex/minimatch dependency — the surface is two
 * shapes and keeping it inline keeps the trust boundary small.
 *
 * @param {string | undefined} pattern @param {string} name
 */
export const hookMatches = (pattern, name) => {
  if (!pattern || pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
};

/**
 * Order the hooks registered for one event: enabled only, sorted by
 * `order` then by id for determinism. Pure — given the same registry it
 * always yields the same sequence, which keeps lineage reproducible.
 *
 * @param {Hook[]} hooks
 * @param {string} event
 * @param {string} toolName
 * @returns {Hook[]}
 */
export const selectHooks = (hooks, event, toolName) =>
  (hooks ?? [])
    .filter((h) => h && h.event === event && h.enabled !== false && hookMatches(h.match, toolName))
    .sort((a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER) || String(a.id).localeCompare(String(b.id)));

/**
 * Validate + normalize a single hook's decision. A pre-hook that
 * returns something we can't interpret is treated as a BLOCK, not an
 * allow — fail closed on garbage, not just on throws.
 *
 * @param {Hook} hook @param {HookDecision | void} decision
 * @returns {{ action: 'allow'|'block', reason: string }}
 */
const normalizeDecision = (hook, decision) => {
  // No return value === implicit allow. This is the common case for a
  // pre-hook that only wants to veto in rare conditions.
  if (decision == null) return { action: 'allow', reason: `${hook.id}: allow` };
  if (typeof decision !== 'object') {
    return { action: 'block', reason: `${hook.id}: invalid decision (not an object) — failing closed` };
  }
  const action = decision.action ?? 'allow';
  if (action === 'allow') return { action: 'allow', reason: decision.reason ?? `${hook.id}: allow` };
  if (action === 'block') return { action: 'block', reason: decision.reason ?? `${hook.id}: blocked` };
  // Unknown action verb — fail closed.
  return { action: 'block', reason: `${hook.id}: unknown action '${action}' — failing closed` };
};

/**
 * Run the pre-tool-use phase.
 *
 * Walks the matching pre-hooks in order. The FIRST hook to block wins and
 * short-circuits the rest — there's no point running
 * softer policy after a hard veto. A hook that throws (or its decision
 * is malformed) blocks too.
 *
 * Optional `runWithTimeout` lets the shell bound a hook's wall-clock
 * time; a timeout is a fail-closed BLOCK (a hook that hangs must not
 * stall the dispatcher into letting the action through).
 *
 * @param {Object} p
 * @param {Hook[]} p.hooks                 the full registry
 * @param {string} p.toolName
 * @param {Record<string, any>} p.args
 * @param {ToolContext} p.ctx
 * @param {(fn: () => any) => Promise<any>} [p.invoke]  wrapper around each hook.run (timeout/sandbox); defaults to direct call
 * @returns {Promise<{ allowed: boolean, args: Record<string, any>, reason: string, outcomes: HookOutcome[] }>}
 */
export const runPreToolUse = async ({ hooks, toolName, args, ctx, invoke }) => {
  const selected = selectHooks(hooks, 'pre-tool-use', toolName);
  /** @type {HookOutcome[]} */
  const outcomes = [];
  const call = invoke ?? ((fn) => fn());

  for (const hook of selected) {
    let decision;
    try {
      decision = await call(() => hook.run({ event: 'pre-tool-use', toolName, args, ctx }));
    } catch (e) {
      // why: a throwing pre-hook is the canonical fail-closed case. If
      // an exfiltration guard crashes we must NOT run the tool — that's
      // exactly when an attacker would want it to "fail open".
      const reason = `${hook.id}: threw (${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}) — failing closed`;
      outcomes.push({ id: hook.id, action: 'block', reason });
      return { allowed: false, args, reason, outcomes };
    }
    const norm = normalizeDecision(hook, decision);
    if (norm.action === 'block') {
      outcomes.push({ id: hook.id, action: 'block', reason: norm.reason });
      return { allowed: false, args, reason: norm.reason, outcomes };
    }
    outcomes.push({ id: hook.id, action: 'allow', reason: norm.reason });
  }

  return { allowed: true, args, reason: 'pre-hooks passed', outcomes };
};

/**
 * Run the post-tool-use phase. Observe-only in V1: hooks see the result
 * but their return value is ignored (no post-hook veto of an already-run
 * side effect). A throwing post-hook is logged into outcomes but does
 * NOT change the result — the side effect already happened, so failing
 * closed here would mean lying to the model about what occurred. We
 * still record the throw so a broken observer is visible in the audit.
 *
 * @param {Object} p
 * @param {Hook[]} p.hooks
 * @param {string} p.toolName
 * @param {Record<string, any>} p.args
 * @param {ToolResult} p.result
 * @param {ToolContext} p.ctx
 * @param {(fn: () => any) => Promise<any>} [p.invoke]
 * @returns {Promise<{ outcomes: HookOutcome[] }>}
 */
export const runPostToolUse = async ({ hooks, toolName, args, result, ctx, invoke }) => {
  const selected = selectHooks(hooks, 'post-tool-use', toolName);
  /** @type {HookOutcome[]} */
  const outcomes = [];
  const call = invoke ?? ((fn) => fn());

  for (const hook of selected) {
    try {
      await call(() => hook.run({ event: 'post-tool-use', toolName, args, result, ctx }));
      outcomes.push({ id: hook.id, action: 'observe', reason: `${hook.id}: observed` });
    } catch (e) {
      // why: NOT fail-closed — the effect already ran. Record and move
      // on so one buggy observer can't corrupt the result the model sees.
      outcomes.push({ id: hook.id, action: 'observe', reason: `${hook.id}: post-hook threw (${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}) — ignored` });
    }
  }
  return { outcomes };
};
