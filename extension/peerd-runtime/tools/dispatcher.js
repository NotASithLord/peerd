// @ts-check
// Tool dispatcher.
//
// The dispatcher composes the six gates (gates.js) in order, audits the
// result, and returns a ToolResult with a `meta` field that carries the
// full gate chain + primitive + duration. That meta is what the
// side-panel reads to render the lineage display by default — every
// tool call shows what kind of thing it is and which gates it passed.
//
// Architectural property worth stating: tools don't return meta. The
// dispatcher attaches it. Tool authors only worry about correctness;
// the rendering and audit story is taken care of around them. This is
// the same DI / functional-core / imperative-shell pattern we use
// everywhere else.

import { getTool } from './registry.js';
import { GATES } from './gates.js';
import { listHooks } from './hooks/registry.js';
import { runPreToolUse, runPostToolUse } from './hooks/runner.js';
import {
  decideAction,
  DEFAULT_CONFIRM_ACTIONS,
  normalizeMode,
} from '../permissions/index.js';

/** @typedef {import('/shared/tool-types.js').Tool} Tool */

/**
 * Resolve a tool's touched origins without letting a throwing origins()
 * crash the confirm prompt. The origin gate already ran origins() above
 * (and failed closed on throw); here we only want a best-effort list for
 * the human-readable prompt, so swallow and return [].
 *
 * @param {Tool} tool @param {any} args @param {ToolContext} ctx
 * @returns {string[]}
 */
const safeOrigins = (tool, args, ctx) => {
  try { return tool.origins(args, ctx) ?? []; }
  catch { return []; }
};

/**
 * One-line, human-readable summary of a tool call for the confirm
 * prompt — e.g. `click({ selector: "button.send" })`. Values are
 * truncated; this is a glanceable label, not a full serialization.
 *
 * @param {string} name @param {Record<string, unknown>} args
 * @returns {string}
 */
const summarizeCall = (name, args) => {
  if (!args || typeof args !== 'object') return `${name}()`;
  const parts = Object.entries(args).map(([k, v]) => {
    let val;
    if (typeof v === 'string') val = `"${v.length > 40 ? `${v.slice(0, 39)}…` : v}"`;
    else if (Array.isArray(v)) val = `[${v.length}]`;
    else if (v && typeof v === 'object') val = '{…}';
    else val = String(v);
    return `${k}: ${val}`;
  });
  return `${name}({ ${parts.join(', ')} })`;
};

/** @typedef {import('/shared/tool-types.js').ToolCall} ToolCall */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult} ToolResult */
/** @typedef {import('/shared/tool-types.js').GateResult} GateResult */
/** @typedef {import('/shared/tool-types.js').ToolMeta} ToolMeta */

/**
 * The dispatch-time extras the SW/agent-loop stamp onto the tool context.
 * None are on the base ToolContext contract — the dispatcher reads them
 * here — so it narrows ctx to this superset. why: hook population +
 * permission policy are dispatch-time state, not part of the tool-facing
 * contract.
 *
 * @typedef {ToolContext & {
 *   hooks?: import('./hooks/runner.js').Hook[],
 *   permission?: { mode?: string, confirmActions?: boolean },
 * }} DispatchContext
 */

/**
 * The dispatcher records the EXECUTION mechanism (`dispatch`) alongside the
 * lineage. The shared ToolMeta typedef doesn't carry `dispatch` yet (it's a
 * UI hint, off the wire), so we widen locally; the widened meta is still
 * structurally a ToolMeta where the result type needs one.
 *
 * @typedef {ToolMeta & { dispatch?: 'inline' | 'subagent' }} DispatchMeta
 */

/**
 * Dispatch a single tool call. Returns a ToolResult with meta populated.
 *
 * @param {ToolCall} call
 * @param {DispatchContext} ctx
 * @returns {Promise<ToolResult>}
 */
export const dispatchToolCall = async (call, ctx) => {
  const tool = getTool(call.name);
  if (!tool) {
    return {
      ok: false,
      error: `unknown_tool: ${call.name}`,
      meta: {
        toolName: call.name,
        primitive: 'unknown',
        gates: [],
        hooks: [],
        durationMs: 0,
      },
    };
  }

  // why: `let`, not `const` — a pre-tool-use hook may MODIFY the args
  // before execute() runs (see the hook phase below). After that point
  // `args` is the rewritten set; the gates above still see the original
  // (gates are about authorization, not arg transformation).
  let args = call.args ?? {};

  // why: the live hook population + a per-call lineage accumulator. Hook
  // outcomes ride along in meta next to gate results so the same legible
  // "what ran and why" story the gates get extends to hooks. The runner
  // is injected (ctx.hooks) when present so tests can supply a fixed set;
  // production falls back to the module registry.
  const hooks = ctx.hooks ?? listHooks();
  /** @type {import('./hooks/runner.js').HookOutcome[]} */
  const hookOutcomes = [];

  // ---- Gate chain --------------------------------------------------------
  /** @type {GateResult[]} */
  const gateResults = [];
  for (const { name, fn } of GATES) {
    let result;
    try {
      result = fn(tool, args, ctx);
    } catch (e) {
      // A gate that throws is a bug, but we want to fail closed rather
      // than crash the dispatcher. Treat as a denial with the error
      // surface so the issue is visible in the audit log + UI.
      result = { allowed: false, reason: `gate threw: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    gateResults.push({ name, ...result });
    if (!result.allowed) {
      // Fire-and-forget audit; don't block on it.
      ctx.audit({
        type: 'tool_blocked',
        details: { tool: call.name, gate: name, reason: result.reason },
      }).catch(() => {});
      return {
        ok: false,
        error: `gate_blocked:${name}:${result.reason}`,
        meta: /** @type {DispatchMeta} */ ({
          toolName: call.name,
          primitive: tool.primitive, dispatch: tool.dispatch,
          gates: gateResults,
          hooks: hookOutcomes,
          durationMs: 0,
        }),
      };
    }
  }

  // ---- Async confirmation (driven by the Plan/Act permission policy) -----
  // The six sync gates above can't await a user round-trip, so the
  // confirmation step lives here. The persona gate already BLOCKED any
  // non-read action in Plan mode; by this point mode is Act (or the call
  // is read-only). The confirmActions toggle decides whether the action
  // still needs the user to approve it: ON confirms every non-read
  // action, OFF confirms nothing (the 2026-06-12 tier collapse — the old
  // suggest/full-auto endpoints kept, the auto-edit middle removed).
  // decideAction is the single source of that rule. Outcome is reflected
  // back into the confirmation gate's meta entry so the lineage stays
  // honest.
  // why: memory tools (primitive 'memory') run their OWN always-on
  // confirmation inside execute() — the lethal-trifecta defense that can't
  // be toggled off, rendered as a diff. Skip the generic dispatcher prompt
  // for them so the user isn't asked twice.
  const selfConfirms = tool.primitive === 'memory';
  const permMode = normalizeMode(ctx.permission?.mode);
  const permConfirm = ctx.permission?.confirmActions ?? DEFAULT_CONFIRM_ACTIONS;
  const verdict = decideAction({ mode: permMode, confirmActions: permConfirm, tool });
  if (verdict.allowed && verdict.confirm && !selfConfirms) {
    const confirmEntry = gateResults.find((g) => g.name === 'confirmation');
    /** @type {import('/shared/tool-types.js').ConfirmAnswer | undefined} */
    let answer = 'no';
    try {
      // why: the SW's confirm coordinator accepts a richer prompt than the
      // ConfirmPrompt typedef (it adds `tool`/`summary`/`sessionId` for the
      // side-panel card). Cast the call so the dispatcher keeps building the
      // shape the coordinator actually consumes without widening the contract.
      const confirm = /** @type {((p: Record<string, unknown>) => Promise<import('/shared/tool-types.js').ConfirmAnswer>) | undefined} */ (ctx.confirm);
      answer = await confirm?.({
        tool: call.name,
        sideEffect: tool.sideEffect,
        actionClass: verdict.actionClass,
        origins: safeOrigins(tool, args, ctx),
        summary: summarizeCall(call.name, args),
        sessionId: ctx.session?.sessionId ?? null,
      });
    } catch {
      answer = 'no';  // fail closed — a broken confirm channel blocks the action
    }
    const approved = answer === 'yes_once' || answer === 'yes_session';
    if (confirmEntry) {
      confirmEntry.allowed = approved;
      confirmEntry.reason = approved
        ? (answer === 'yes_session' ? 'approved by user (session)' : 'approved by user')
        : 'rejected by user';
    }
    if (!approved) {
      ctx.audit({
        type: 'tool_rejected',
        details: { tool: call.name, gate: 'confirmation', answer },
      }).catch(() => {});
      return {
        ok: false,
        error: `gate_blocked:confirmation:${confirmEntry?.reason ?? 'rejected by user'}`,
        meta: /** @type {DispatchMeta} */ ({
          toolName: call.name,
          primitive: tool.primitive, dispatch: tool.dispatch,
          gates: gateResults,
          hooks: hookOutcomes,
          durationMs: 0,
        }),
      };
    }
    ctx.audit({
      type: 'tool_confirmed',
      details: { tool: call.name, answer },
    }).catch(() => {});
  }

  // ---- Pre-tool-use hooks ------------------------------------------------
  // why: this is the LAST programmable veto before a side effect runs —
  // central to the lethal-trifecta defense. It sits after the sync gates
  // and the async confirmation (so a human "yes" can still be overruled
  // by a deterministic policy hook), and before execute(). A pre-hook may
  // BLOCK (fail-closed) or MODIFY the args. Hook errors fail closed: the
  // runner converts a throw/garbage into a block, never a silent pass.
  //
  // We give hooks a read view of tool metadata (sideEffect/origins) and
  // the egress allowlist via ctx augmentation so the default egress hook
  // can reason about a call's footprint without the dispatcher special-
  // casing it.
  const hookCtx = {
    ...ctx,
    /** @param {string} n */
    getToolMeta: (n) => {
      const t = getTool(n);
      return t && { sideEffect: t.sideEffect, primitive: t.primitive, origins: t.origins };
    },
  };
  const pre = await runPreToolUse({ hooks, toolName: call.name, args, ctx: hookCtx });
  hookOutcomes.push(...pre.outcomes);
  if (!pre.allowed) {
    ctx.audit({
      type: 'tool_blocked',
      details: { tool: call.name, gate: 'pre-tool-use-hook', reason: pre.reason },
    }).catch(() => {});
    return {
      ok: false,
      error: `hook_blocked:pre-tool-use:${pre.reason}`,
      meta: /** @type {DispatchMeta} */ ({
        toolName: call.name,
        primitive: tool.primitive, dispatch: tool.dispatch,
        gates: gateResults,
        hooks: hookOutcomes,
        durationMs: 0,
      }),
    };
  }
  // Adopt any args the pre-hooks rewrote. execute() + the audit see these.
  args = pre.args;

  // ---- Execute -----------------------------------------------------------
  // why: thread the call's tool_use_id into ctx so tools that stream
  // intermediate state back to the UI (currently vm_boot) can key their
  // outbound messages by it. The UI maps each in-flight tool_use card
  // to its own stream entry; without an id the chunks have no anchor
  // and the renderer drops them.
  const execCtx = { ...ctx, toolUseId: call.id };
  const start = performance.now();
  try {
    const result = await tool.execute(args, execCtx);
    const durationMs = Math.round(performance.now() - start);
    ctx.audit({
      type: 'tool_executed',
      details: { tool: call.name, primitive: tool.primitive, dispatch: tool.dispatch, durationMs },
    }).catch(() => {});
    // ---- Post-tool-use hooks --------------------------------------------
    // why: observe-only in V1. Post-hooks see the result but cannot
    // change it — the side effect already happened, so a post-hook throw
    // is recorded and ignored rather than failing closed (failing closed
    // here would mean misreporting an effect that already occurred).
    const post = await runPostToolUse({ hooks, toolName: call.name, args, result, ctx: hookCtx });
    hookOutcomes.push(...post.outcomes);
    /** @type {ToolResult} */
    const enriched = {
      ...result,
      meta: /** @type {DispatchMeta} */ ({
        toolName: call.name,
        primitive: tool.primitive, dispatch: tool.dispatch,
        // why: sideEffect + origins complete the lineage spine on EXECUTED
        // results — the two fields lineage compaction reads to decide what to
        // compact (sideEffect class) and to render where it touched (origins).
        // Captured here, on the final post-hook args. Both stay off the wire.
        sideEffect: tool.sideEffect,
        origins: safeOrigins(tool, args, ctx),
        gates: gateResults,
        hooks: hookOutcomes,
        durationMs,
      }),
    };
    return enriched;
  } catch (e) {
    const durationMs = Math.round(performance.now() - start);
    const message = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    ctx.audit({
      type: 'tool_failed',
      details: { tool: call.name, error: message },
    }).catch(() => {});
    // why: post-hooks still observe a FAILED execution — a failure is an
    // observable event (e.g. an audit/metrics hook wants to count it).
    const post = await runPostToolUse({
      hooks, toolName: call.name, args, result: { ok: false, error: message }, ctx: hookCtx,
    });
    hookOutcomes.push(...post.outcomes);
    return {
      ok: false,
      error: message,
      meta: /** @type {DispatchMeta} */ ({
        toolName: call.name,
        primitive: tool.primitive, dispatch: tool.dispatch,
        // Same spine fields on the FAILED path — an errored result still has a
        // body and a lineage (the spine renders "… · error · N chars").
        sideEffect: tool.sideEffect,
        origins: safeOrigins(tool, args, ctx),
        gates: gateResults,
        hooks: hookOutcomes,
        durationMs,
      }),
    };
  }
};
