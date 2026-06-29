// @ts-check
// The egress allowlist, implemented AS a default pre-tool-use hook.
//
// This is the deliberate dogfooding the §10 design calls for: peerd's
// single most important security primitive — the network-origin
// allowlist that `safeFetch` enforces (peerd-egress/fetch/safe-fetch.js)
// — is re-expressed here as a pre-tool-use hook. The point is to prove
// the hook model is load-bearing: if the allowlist can be a hook, the
// hook layer is a real policy chokepoint, not a toy observer.
//
// HOW IT RELATES TO safeFetch. safeFetch is still the hard floor inside
// peerd-egress: any tool that calls ctx.safeFetch() is checked there too,
// belt-and-suspenders. This hook adds a SECOND, EARLIER veto at the
// dispatcher layer — it inspects a tool call's declared origins BEFORE
// execute() runs, so a network tool whose target is off-allowlist is
// blocked before it ever reaches its body. Defense in depth: the gate
// chain checks the denylist (origin gate), this hook checks the egress
// ALLOWLIST, and safeFetch checks again at the actual fetch boundary.
//
// FAIL-CLOSED. A tool that declares no origins is allowed (nothing to
// check). A tool that declares an origin we can't parse is BLOCKED — an
// unparseable target is exactly the shape an injection uses to smuggle a
// request past a naive check. The hook reads the live allowlist from the
// tool context (ctx.allowlist), injected by the SW, so user-added
// provider endpoints are honored without rebuilding the hook.
//
// Scope: the agent's OWN outbound fetches only. Browser-session tools
// (primitive 'tab' — open_tab, navigate, type, click…) are EXEMPT:
// they act on the user's logged-in browser (peerd's whole thesis), gated
// by the denylist + confirmation, not the provider allowlist. Of the rest,
// only sideEffect 'mutate_external' is in scope; read/write tools that
// touch no external origin skip entirely (`origins()` returns []).

import { originOf } from '/peerd-egress/index.js';

/** @typedef {import('/shared/tool-types.js').Tool} Tool */

/**
 * The two SW-injected extras this hook reads off the live tool context.
 * Neither is on the base ToolContext contract (the SW wires them in for
 * the dispatcher's hook phase), so we narrow ctx to a local shape with an
 * erased cast. why: matches the opaque-slot pattern used elsewhere — keep
 * the read honest without widening the shared contract.
 *
 * @typedef {Object} EgressHookCtx
 * @property {(name: string) => Tool | undefined} [getToolMeta]
 * @property {readonly string[]} [allowlist]
 */

/** @type {import('../runner.js').Hook} */
export const egressAllowlistHook = {
  id: 'egress-allowlist',
  event: 'pre-tool-use',
  // why: rendered verbatim in the Context → Hooks tab. This hook is the
  // always-on egress floor, so the description doubles as the visible
  // reason there is no off switch for it.
  description: 'Blocks network tools whose target origin is off the provider '
    + 'allowlist — the always-on egress floor. Built-in code, registered at '
    + 'boot; cannot be disabled or removed.',
  // why: very low order so the network veto runs before softer policy
  // hooks — no point letting a user observability hook fire on a request
  // we're about to reject.
  order: 10,
  match: '*',
  run: (inv) => {
    const { args, toolName } = inv;
    const ctx = /** @type {import('/shared/tool-types.js').ToolContext & EgressHookCtx} */ (inv.ctx);
    const tool = ctx.getToolMeta?.(toolName);
    // why: the egress allowlist governs the agent's OWN outbound fetches
    // (safeFetch). Browser-session tools (primitive 'tab' — open_tab,
    // navigate, type, click, …) act on the USER's logged-in browser:
    // reaching their own apps is peerd's whole thesis, governed by the
    // DENYLIST (origin gate) + the confirmation gate, NOT the provider
    // allowlist. Gating them here wrongly blocked the user from opening
    // Gmail (open_tab is mutate_external → was caught). Skip them.
    if (tool?.primitive === 'tab') {
      return { action: 'allow', reason: 'egress-allowlist: browser-session tool (denylist-governed), skipped' };
    }
    // Only network-bucket tools are in scope. If we can't resolve the
    // tool's sideEffect, treat unknown as in-scope (fail closed) rather
    // than skipping the check.
    const sideEffect = tool?.sideEffect;
    if (sideEffect && sideEffect !== 'mutate_external') {
      return { action: 'allow', reason: 'egress-allowlist: non-network tool, skipped' };
    }

    // Resolve the origins this call would touch. The tool declares them
    // via origins(args, ctx) — the same function the origin gate uses.
    /** @type {string[]} */
    let origins = [];
    try {
      origins = tool?.origins?.(args, ctx) ?? [];
    } catch (e) {
      // why: a throwing origins() means we cannot know what this call
      // touches. Block — never run a network action whose footprint we
      // can't enumerate.
      return { action: 'block', reason: `egress-allowlist: origins() threw (${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}) — failing closed` };
    }
    if (!origins.length) {
      return { action: 'allow', reason: 'egress-allowlist: no external origins' };
    }

    const allowlist = ctx.allowlist ?? [];
    for (const origin of origins) {
      let normalized;
      try {
        normalized = originOf(origin);
      } catch {
        // Unparseable target → block. (See header: this is the smuggling
        // shape we explicitly refuse.)
        return { action: 'block', reason: `egress-allowlist: unparseable origin '${origin}' — failing closed` };
      }
      if (!allowlist.includes(normalized)) {
        return {
          action: 'block',
          reason: `egress-allowlist: '${normalized}' is not on the provider allowlist`,
        };
      }
    }
    return { action: 'allow', reason: `egress-allowlist: ${origins.length} origin(s) on allowlist` };
  },
};
