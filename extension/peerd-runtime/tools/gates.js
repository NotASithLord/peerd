// @ts-check
// Tool dispatcher gates.
//
// Each gate is a pure (synchronous) function:
//   (tool, args, ctx) => { allowed: boolean, reason: string }
//
// The dispatcher composes them in a fixed order (see GATES below) and
// records every result in the tool's meta so the side-panel can render
// the full lineage by default — not only on /verify. The "architecture
// is legible in every interaction" thesis depends on this.
//
// Gate order matters for the UI more than for correctness:
//
//   persona      — active: Plan/Act enforcement via decideAction. Plan
//                  mode blocks every non-read action outright; Act mode
//                  passes here and defers auto-vs-ask to the dispatcher.
//   exposure     — active: enforces the main-agent tool boundary at
//                  dispatch. ctx.exposure === 'main' is refused any
//                  runner-only tool even if the model emits its name. Also
//                  carries the DESIGN-17 resident capability tier (flag-gated):
//                  the instance-mutating set is resident-only, and a resident
//                  is positively scoped to its own kind + pinned to its own
//                  instance.
//   origin       — active (denylist)
//   confirmation — active as a lineage placeholder: computes the policy's
//                  PLANNED verdict; the dispatcher resolves the real
//                  async confirm after the chain and overwrites it.
//   egress       — no-op IN THE CHAIN. The real egress enforcement lives
//                  in the default egress-allowlist pre-tool-use hook
//                  (hooks/defaults/egress-allowlist.js) plus safeFetch at
//                  the actual fetch boundary; this gate stays so the
//                  lineage shows where a per-call check would slot in.
//   audit        — active (always passes; dispatcher writes the log)
//
// Five enforce (or feed) live policy, one (egress) is a deliberate
// chain no-op whose teeth live in the hook layer. New checks slot in
// WITHOUT changing the dispatcher composition.

// Deep import of the PURE matcher (not the /peerd-egress/index.js barrel,
// which pulls in vault/storage + the browser polyfill and would make this
// module unimportable under the bun test runner). Same pattern as
// composer/resolvers.js and tools/defs/dom-helpers.js.
import { findDenylistMatch } from '../../peerd-egress/denylist/denylist.js';
import {
  isHiddenFromMain, isInstanceGatedOut, instanceGateKind,
  EXPOSURE_RESIDENT, isResidentMutatingTool, isAllowedForResidentKind, residentTargetId,
} from './exposure.js';
import { RESIDENT_TAB_AGENTS } from '/shared/flags.js';
import {
  decideAction,
  PERMISSION_MODES,
  DEFAULT_CONFIRM_ACTIONS,
  normalizeMode,
} from '../permissions/index.js';

/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').GateResult} GateResult */

/**
 * The gate-relevant extras the dispatcher stamps onto the tool context.
 * None are on the base ToolContext contract — the SW/dispatcher inject
 * them per turn — so the gates narrow ctx to this superset. why: the
 * permission/exposure/manifest state is dispatch-time policy, not part of
 * the tool-facing contract.
 *
 * @typedef {ToolContext & {
 *   permission?: { mode?: string, confirmActions?: boolean },
 *   exposure?: string,
 *   instanceState?: { webvm?: boolean, notebook?: boolean, app?: boolean } | null,
 *   toolAllow?: Set<string> | null,
 *   toolManifestLabel?: string,
 *   residentInstanceId?: string,
 *   residentKind?: string,
 * }} GateContext
 */

/**
 * Persona / Plan-Act (Feature 03). This is the realization of the
 * persona axis ARCHITECTURE.md §2.4 reserved ("whether the agent can act
 * at all", orthogonal to which origins it may touch). It enforces the
 * SYNCHRONOUS half of the permission policy: PLAN mode blocks every
 * non-read action outright (allowed:false). The CONFIRMATION half (auto
 * vs ask, by the confirmActions toggle) can't run here because it needs
 * an async user round-trip — the
 * dispatcher does it after the gate chain, also via decideAction, so the
 * single policy function is the only place the rules live.
 *
 * ctx.permission = { mode: 'plan'|'act', confirmActions: boolean }.
 * Missing/garbage → safe defaults (plan + confirm ON), so a legacy
 * session record can never accidentally widen authority.
 *
 * @param {Tool} tool @param {any} _args @param {GateContext} ctx
 * @returns {Omit<GateResult, 'name'>}
 */
const personaGate = (tool, _args, ctx) => {
  const mode = normalizeMode(ctx.permission?.mode);
  const confirmActions = ctx.permission?.confirmActions ?? DEFAULT_CONFIRM_ACTIONS;
  const verdict = decideAction({ mode, confirmActions, tool });
  if (!verdict.allowed) {
    return { allowed: false, reason: verdict.reason };
  }
  // Allowed here; whether it still needs confirmation is decided in the
  // dispatcher's async step. Surface the mode + action class so the
  // lineage UI shows e.g. "act/auto · external".
  const modeLabel = mode === PERMISSION_MODES.ACT
    ? (confirmActions === false ? 'act/auto' : 'act/confirm')
    : 'plan';
  return { allowed: true, reason: `${modeLabel} · ${verdict.actionClass}` };
};

/**
 * DESIGN-17 resident capability tier — pure, flag injected. Returns a REFUSAL
 * `{allowed:false, reason}` when the call violates the tier, or `null` when the
 * tier has no opinion (the gate continues). Three rules:
 *   (1) flag ON, non-resident ctx → the instance-MUTATING set is refused (it's
 *       resident-only); a `spawn_subagent({tools:['app_delete']})` can't escalate.
 *   (2) flag ON, resident ctx → POSITIVELY constrained to its own kind's toolset
 *       (a hallucinated/injected non-env tool fails closed here, not just in the
 *       descriptor list — the keyless/narrow runner trust model).
 *   (3) flag ON, resident ctx → per-instance pin: an EXPLICIT target that isn't
 *       this resident's instance is refused (defense in depth — the resident
 *       dispatch wrapper already force-injects the bound id).
 * flag OFF → no mutating-tier refusals (instance tools stay on the main agent),
 * but `message_resident` is refused by name (its orchestrator isn't wired).
 *
 * @param {Tool} tool @param {any} args @param {GateContext} ctx @param {boolean} flagOn
 * @returns {Omit<GateResult, 'name'> | null}
 */
export const residentTierGate = (tool, args, ctx, flagOn) => {
  if (!flagOn) {
    return tool.name === 'message_resident'
      ? { allowed: false, reason: `'message_resident' is not enabled` }
      : null;
  }
  if (ctx?.exposure !== EXPOSURE_RESIDENT) {
    if (isResidentMutatingTool(tool.name)) {
      return { allowed: false, reason: `'${tool.name}' is resident-only — message the instance's resident (message_resident)` };
    }
    return null;
  }
  if (!isAllowedForResidentKind(tool.name, ctx.residentKind)) {
    return { allowed: false, reason: `'${tool.name}' is not in this resident's (${ctx.residentKind ?? 'unknown'}) toolset` };
  }
  // The resident dispatch wrapper (turn-driver pinResidentCall) already FORCE-
  // normalizes any id/name arg to the bound instance id before dispatch, so by
  // the time the gate runs an explicit target is the bound id. This is the
  // defense-in-depth backstop: an explicit id that ISN'T the bound one (e.g. a
  // path that somehow skipped the wrapper) is refused.
  const explicit = residentTargetId(tool.name, args);
  if (explicit && explicit !== ctx.residentInstanceId) {
    return { allowed: false, reason: `resident is pinned to ${ctx.residentInstanceId ?? 'its instance'}; refusing ${tool.name} targeting ${explicit}` };
  }
  return null;
};

/**
 * Exposure — enforces the main-agent tool boundary at DISPATCH, not just
 * in the advertised descriptor list. The low-level DOM/page tools
 * (snapshot, click, type, page_exec, …) are hidden from the main agent and
 * belong to the disposable browser-runner. mainAgentDescriptors() keeps
 * them out of the model's tool list, but that's advisory — a
 * prompt-injected model can still EMIT a hidden tool name. This gate makes
 * the boundary real: a context marked `exposure: 'main'` (set only on the
 * main turn) is refused any hidden tool. The runner and subagents leave
 * `exposure` unset — they legitimately hold these tools, narrowed by the
 * orchestrator's own allow-list (spawn.js).
 *
 * SECOND check: the per-session tool manifest (tools/manifests.js).
 * ctx.toolAllow is the session's RESOLVED allow-set (null = no manifest =
 * everything). Descriptor filtering keeps excluded tools out of the
 * model's advertised list, but that's advisory too — this refusal makes
 * the manifest real at dispatch. Unlike the runner-only check it applies
 * to EVERY context that carries it, main turn AND children: spawn.js
 * inherits the manifest into child session records, so a child's
 * effective set can intersect with, but never escalate past, its
 * parent's manifest.
 *
 * @param {Tool} tool @param {any} args @param {GateContext} ctx
 * @returns {Omit<GateResult, 'name'>}
 */
export const exposureGate = (tool, args, ctx) => {
  if (ctx?.exposure === 'main') {
    if (isHiddenFromMain(tool.name)) {
      return { allowed: false, reason: `'${tool.name}' is runner-only, not available to the main agent` };
    }
    // Progressive disclosure: an instance-gated op (webvm/notebook/app secondary
    // op) is refused until the chat has a current instance of that kind. The
    // descriptor list already hides it from the model; this makes the boundary
    // real at dispatch — a hallucinated/injected early call FAILS CLOSED with a
    // recovery hint. ctx.instanceState is restamped per step (SW refreshTools),
    // so an op revealed after a mid-turn create also passes the gate.
    if (isInstanceGatedOut(tool.name, ctx.instanceState)) {
      const kind = instanceGateKind(tool.name);
      const create = kind === 'app' ? 'app_create' : kind === 'notebook' ? 'js_create or js_notebook' : 'vm_create or vm_boot';
      return { allowed: false, reason: `'${tool.name}' needs a current ${kind} in this chat — create one first (${create})` };
    }
  }
  // DESIGN-17: the resident capability tier (flag-gated; see tools/exposure.js).
  // The WALL behind the advisory descriptor filters — enforced for every
  // dispatch path so a `spawn_subagent({tools:['app_delete']})` can't escalate.
  // Extracted to a pure, flag-INJECTED function so the boundary test can prove
  // the structure with flagOn:true regardless of the source const (the same DI
  // pattern the dweb descriptor filters use). null = no resident-tier opinion.
  const resident = residentTierGate(tool, args, ctx, RESIDENT_TAB_AGENTS);
  if (resident) return resident;
  if (ctx?.toolAllow instanceof Set && !ctx.toolAllow.has(tool.name)) {
    const label = ctx.toolManifestLabel ?? 'manifest';
    return { allowed: false, reason: `'${tool.name}' is excluded by this session's tool manifest (${label})` };
  }
  return { allowed: true, reason: 'exposed' };
};

/**
 * Origin — denylist match. The denylist is the only origin restriction
 * that exists; tools that touch no origins pass trivially.
 *
 * @param {Tool} tool @param {any} args @param {GateContext} ctx
 * @returns {Omit<GateResult, 'name'>}
 */
const originGate = (tool, args, ctx) => {
  const origins = tool.origins(args, ctx) ?? [];
  if (origins.length === 0) {
    return { allowed: true, reason: 'no origins touched' };
  }
  const patterns = ctx.denylist ?? [];
  for (const origin of origins) {
    const hostname = hostnameOf(origin);
    if (!hostname) continue;
    const match = findDenylistMatch(hostname, patterns);
    if (match) {
      return {
        allowed: false,
        reason: `denylist hit: ${hostname} matches '${match}'`,
      };
    }
  }
  return {
    allowed: true,
    reason: `${origins.length} origin${origins.length === 1 ? '' : 's'} checked, no denylist match`,
  };
};

/**
 * Confirmation — a placeholder entry in the lineage. The actual confirm
 * decision (auto vs ask) is async, so the dispatcher resolves it AFTER
 * the gate chain and overwrites this entry's allowed/reason with the real
 * outcome (approved / rejected / auto-allowed). Here we just compute the
 * policy's PLANNED verdict from (mode, confirmActions, tool) so that even
 * before the round-trip the lineage shows whether a prompt is coming.
 *
 * @param {Tool} tool @param {any} _args @param {GateContext} ctx
 * @returns {Omit<GateResult, 'name'>}
 */
const confirmationGate = (tool, _args, ctx) => {
  if (tool.sideEffect === 'read') {
    return { allowed: true, reason: 'read-only, no confirmation needed' };
  }
  const mode = normalizeMode(ctx.permission?.mode);
  const confirmActions = ctx.permission?.confirmActions ?? DEFAULT_CONFIRM_ACTIONS;
  const verdict = decideAction({ mode, confirmActions, tool });
  // (Plan-mode blocks already failed the persona gate, so we only reach
  // here in Act mode or for reads.)
  return {
    allowed: true,
    reason: verdict.confirm ? `will prompt (${verdict.actionClass})` : verdict.reason,
  };
};

/**
 * Egress — only fires for tools that themselves make network calls.
 * The introspection tools don't; DOM tools that read from a page the
 * user navigated to don't either. The gate exists so when a tool DOES
 * call safeFetch (e.g., a "summarize URL" tool fetching an arbitrary
 * page), we have an obvious place to add the per-call origin check.
 *
 * @param {Tool} tool @param {any} _args @param {GateContext} _ctx
 * @returns {Omit<GateResult, 'name'>}
 */
const egressGate = (tool, _args, _ctx) => {
  if (tool.sideEffect !== 'mutate_external') {
    return { allowed: true, reason: 'no network touched' };
  }
  return { allowed: true, reason: 'mutate_external — per-call egress check V1.x' };
};

/**
 * Audit — always passes. The actual log write happens in the dispatcher
 * after execute() returns. This gate exists in the chain so the UI can
 * render "audit ✓ logged" as a positive affordance: the user sees that
 * every action is recorded, not just the ones we happened to remember.
 *
 * @param {Tool} _tool @param {any} _args @param {GateContext} _ctx
 * @returns {Omit<GateResult, 'name'>}
 */
const auditGate = (_tool, _args, _ctx) => ({
  allowed: true,
  reason: 'will record',
});

/** @param {string} origin @returns {string} */
const hostnameOf = (origin) => {
  try { return new URL(origin).hostname; }
  catch { return origin; }
};

/**
 * The canonical gate composition. Order is stable and load-bearing for
 * the UI (it dictates the lineage display order). Adding a gate means
 * adding an entry here and updating the dispatcher's V1.x roadmap
 * comment.
 */
export const GATES = Object.freeze([
  { name: 'persona',      fn: personaGate },
  { name: 'exposure',     fn: exposureGate },
  { name: 'origin',       fn: originGate },
  { name: 'confirmation', fn: confirmationGate },
  { name: 'egress',       fn: egressGate },
  { name: 'audit',        fn: auditGate },
]);
