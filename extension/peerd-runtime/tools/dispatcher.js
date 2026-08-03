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
import { ugcWriteConfirm } from '../actor/ugc-registry.js';
import { describeToolActivity, displayOrigin } from '../actor/activity-label.js';
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

// The one sentence the #242 confirm card adds. why this wording: it names the
// property that makes the page dangerous (someone else wrote it) and the
// property that makes the action dangerous (it runs as you), in the user's
// words, with no jargon and no security theatre. It does NOT claim an attack is
// happening — most of the time there isn't one, and a prompt that cries wolf is
// a prompt that gets clicked through.
const UGC_CONFIRM_NOTE = 'This page can contain text written by other people, '
  + 'and this action would run with your signed-in access to it.';

/**
 * The URL of the page a browser-session call is about to act on, read LIVE.
 *
 * why not just ctx.activeTab.url: that pin is stamped when the turn's context is
 * built and re-stamped by navigate(), but a same-origin SPA hop moves the page
 * with no tool call at all — the actor clicks from a repo root into an issue and
 * the pin still says the root. The UGC registry classifies on PATH, so a stale
 * pin silently under-protects exactly the case #242 exists for. One
 * tabs.get() is the honest read.
 *
 * Never throws and never blocks the dispatch: a failed read falls back to the
 * pin, and a missing pin to ''. classifyUrl fails open on both.
 *
 * @param {ToolContext} ctx
 * @returns {Promise<string>}
 */
const liveTabUrl = async (ctx) => {
  const pin = ctx.activeTab;
  if (!pin?.id) return pin?.url ?? '';
  try {
    // ctx.tabs is the opaque `Object` contract slot; narrow to the one read.
    const tabsApi = /** @type {{ get?: (id: number) => Promise<{ url?: string }> }} */ (ctx.tabs);
    const live = await tabsApi?.get?.(pin.id);
    return live?.url || pin.url || '';
  } catch {
    return pin.url ?? '';
  }
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
 *   onToolActivity?: {
 *     begin: (tabId: number, label: string, origin: string) => unknown,
 *     end: (tabId: number) => unknown,
 *   } | null,
 * }} DispatchContext
 */

/**
 * The dispatcher records the EXECUTION mechanism (`dispatch`) alongside the
 * lineage. The shared ToolMeta typedef doesn't carry `dispatch` yet (it's a
 * UI hint, off the wire), so we widen locally; the widened meta is still
 * structurally a ToolMeta where the result type needs one.
 *
 * @typedef {ToolMeta & { dispatch?: 'inline' | 'spawned' }} DispatchMeta
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

  // ---- The UGC-zone forced confirmation (#242) ---------------------------
  // A non-read browser-session action on a page that hosts THIRD-PARTY content
  // (a GitHub issue, a Jira ticket, a Reddit thread — actor/ugc-registry.js) is
  // the lethal trifecta at its sharpest: the text steering the agent was written
  // by a stranger, and the cookies it would act with belong to the user. So this
  // asks EVEN WHEN confirmActions is off. That override is deliberate: the
  // toggle expresses "I trust this agent to act unattended", which is a
  // statement about the AGENT, and on a UGC page the instruction under
  // consideration did not come from the agent. Same reasoning as `selfConfirms`
  // above, which is why memory keeps its own always-on prompt and is excluded
  // here rather than double-prompted.
  //
  // Skipped entirely when the policy already blocked the call — no reason to
  // read a tab for an action that is not going to run.
  const ugcRuleId = verdict.allowed && !selfConfirms
    ? ugcWriteConfirm({
      toolName: call.name,
      primitive: tool.primitive,
      sideEffect: tool.sideEffect,
      url: await liveTabUrl(ctx),
    })
    : null;

  if (verdict.allowed && (verdict.confirm || ugcRuleId) && !selfConfirms) {
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
        // why the note and not a longer summary: summarizeCall truncates every
        // string arg to 40 chars, so the card can't show the payload anyway —
        // what it CAN do is tell the user the one fact they can't see, which is
        // that this page is attacker-authorable. Absent on an ordinary confirm,
        // so the card is unchanged for the common case.
        note: ugcRuleId ? UGC_CONFIRM_NOTE : undefined,
        sessionId: ctx.session?.sessionId ?? null,
      });
    } catch {
      answer = 'no';  // fail closed — a broken confirm channel blocks the action
    }
    const approved = answer === 'yes_once' || answer === 'yes_session';
    if (confirmEntry) {
      confirmEntry.allowed = approved;
      // why the ruleId rides in the reason: the lineage chip in the transcript
      // renders `${gate}: ${reason}` as its tooltip (sidepanel/components/
      // message-list.js), so attributing the zone here surfaces WHICH rule
      // forced the prompt with no new UI and no new plumbing.
      const how = ugcRuleId ? ` [ugc zone: ${ugcRuleId}]` : '';
      confirmEntry.reason = (approved
        ? (answer === 'yes_session' ? 'approved by user (session)' : 'approved by user')
        : 'rejected by user') + how;
    }
    if (!approved) {
      ctx.audit({
        type: 'tool_rejected',
        details: { tool: call.name, gate: 'confirmation', answer, ugcZone: ugcRuleId ?? undefined },
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
      details: { tool: call.name, answer, ugcZone: ugcRuleId ?? undefined },
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

  // ---- In-page activity indicator ----------------------------------------
  // why here and not in each tab tool: this is the one place every page-acting
  // call passes through, on every path (main turn, bound actor, the offscreen
  // actor relay whose ctx the SW rebuilds). Wiring it per-tool would mean a tool
  // added later silently going dark.
  //
  // why FIRE-AND-FORGET rather than awaited: `begin` is an executeScript round
  // trip into a page that may be busy, unresponsive, or refusing injection. The
  // user asked for the action, not for the decoration — a cosmetic surface must
  // never delay it, and must never be able to fail it. Both calls swallow.
  const activity = tool.primitive === 'tab' ? ctx.onToolActivity : null;
  const activityTabId = typeof args?.tabId === 'number' ? args.tabId : ctx.activeTab?.id;
  if (activity && typeof activityTabId === 'number') {
    const phrase = describeToolActivity(call.name, args, { isTabTool: true });
    if (phrase) {
      Promise.resolve(activity.begin(activityTabId, phrase, displayOrigin(ctx.activeTab?.origin))).catch(() => {});
    }
  }

  const start = performance.now();
  try {
    const result = await tool.execute(args, execCtx);
    const durationMs = Math.round(performance.now() - start);
    if (activity && typeof activityTabId === 'number') {
      Promise.resolve(activity.end(activityTabId)).catch(() => {});
    }
    // why: most tools signal failure by returning { ok: false }, not by
    // throwing — only one tool file throws. Auditing the whole non-throw
    // path as tool_executed made the audit log report ≈zero failures while
    // the transcript's is_error flag showed them. Branch on result.ok so a
    // returned failure lands in the SAME tool_failed bucket as a throw.
    ctx.audit(result?.ok === false
      ? {
        type: 'tool_failed',
        details: { tool: call.name, primitive: tool.primitive, dispatch: tool.dispatch, durationMs, error: result.error },
      }
      : {
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
    // why the failure path settles the indicator too: a tool that throws would
    // otherwise leave the pill frozen on "Typing…" forever, which reads as a
    // hang — the exact misreading this whole surface exists to prevent.
    if (activity && typeof activityTabId === 'number') {
      Promise.resolve(activity.end(activityTabId)).catch(() => {});
    }
    const message = /** @type {{ message?: string }} */ (e)?.message ?? String(e);
    ctx.audit({
      type: 'tool_failed',
      // why: same rich shape as the returned-{ok:false} failure above so
      // BOTH failure sources are uniform — audit mining can group throws and
      // returned failures by the same primitive/dispatch keys.
      details: { tool: call.name, primitive: tool.primitive, dispatch: tool.dispatch, error: message, durationMs },
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
