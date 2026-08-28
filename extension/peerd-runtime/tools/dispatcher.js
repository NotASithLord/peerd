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

import { GATES } from './gates.js';
import {
  AUTH_BOUNDARY_STOPPED_MESSAGE, AUTH_STATE_UNAVAILABLE_MESSAGE,
  AUTH_WAITING_FOR_USER_CODE, AUTH_WAITING_FOR_USER_MESSAGE,
} from '../actor/auth-wait.js';
import { listHooks } from './hooks/registry.js';
import { runPreToolUse, runPostToolUse } from './hooks/runner.js';
import { ugcWriteConfirm } from '../actor/ugc-registry.js';
import { describeToolActivity, displayOrigin } from '../actor/activity-label.js';
import {
  normalizeBrowserChildPolicyNotices,
  withAsyncBrowserChildPolicyNotices,
  withBrowserChildPolicyNotices,
} from '../browser-authority/child-policy-result.js';
import {
  decideAction,
  DEFAULT_CONFIRM_ACTIONS,
  normalizeMode,
} from '../permissions/policy.js';
// The lifecycle classifier — pure, no IO. Used ONLY by the fail-closed
// backstop below, so the dispatcher never has to duplicate (and drift
// from) the retry-class taxonomy.
import { retryClassForTool } from '../lifecycle/tool-retry-class.js';
import { RETRY_CLASSES } from '../lifecycle/retry-class.js';
import { FAILURE_OUTCOMES } from '../lifecycle/failure-taxonomy.js';
import { resolveDeclaredToolOrigins } from '../tool-origin-policy.js';
import { DEFAULT_HOOKS } from './hooks/defaults/index.js';

/** @typedef {ReturnType<typeof import('./metadata/descriptor.js').toToolDescriptor>} ToolDescriptor */

/**
 * Resolve a tool's touched origins without letting a throwing origins()
 * crash the confirm prompt. The origin gate already ran origins() above
 * (and failed closed on throw); here we only want a best-effort list for
 * the human-readable prompt, so swallow and return [].
 *
 * @param {ToolDescriptor} tool @param {any} args @param {ToolContext} ctx
 * @returns {string[]}
 */
const safeOrigins = (tool, args, ctx) => {
  try { return resolveDeclaredToolOrigins(tool, args, ctx); }
  catch { return []; }
};

/**
 * Stable external target for lifecycle intent. Tools normally return origins,
 * but normalize defensively so equivalent URL spellings cannot split the
 * sibling-actor replay guard. Non-URL capability addresses remain exact.
 *
 * @param {ToolDescriptor} tool @param {any} args @param {ToolContext} ctx
 * @returns {string}
 */
const lifecycleTarget = (tool, args, ctx) => {
  const raw = safeOrigins(tool, args, ctx).find((value) =>
    typeof value === 'string' && value.trim().length > 0);
  if (!raw) return `tool:${tool.name ?? 'unknown-tool'}`;
  const trimmed = raw.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.origin === 'null' ? parsed.href : parsed.origin;
  } catch { return trimmed; }
};

const EXPOSED_ERROR_CODE = /^[a-z][a-z0-9_]{0,79}$/;
const TOOL_RESULT_CODE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const EXPOSED_ERROR_CONTENT_MAX_CHARS = 6000;
const EXPOSED_ERROR_DETAILS_MAX_CHARS = 8000;
const FAILURE_OUTCOME_VALUES = new Set(Object.values(FAILURE_OUTCOMES));
const BROWSER_POLICY_REASONS = new Set([
  'invalid_url', 'unsupported_scheme', 'private_network', 'cloud_metadata',
  'sensitive_site', 'unverified_target', 'network_guard_unavailable', 'network_guard_unsupported',
  'network_guard_install_failed',
]);
const BROWSER_POLICY_STAGES = new Set(['pre_navigation', 'committed_origin']);
const BROWSER_POLICY_OUTCOMES = new Set(['not_run', 'page_loaded_not_automated']);

/**
 * Keep only the fixed browser-policy fields that are safe for the audit log.
 * The URL, correction text, and any unrecognized structured value stay out.
 * @param {unknown} carrier
 */
const browserPolicyAuditDetails = (carrier) => {
  const value = /** @type {any} */ (carrier);
  const structured = value?.structured;
  if (!structured || typeof structured !== 'object'
      || typeof value?.error !== 'string'
      || structured.code !== value.error
      || !EXPOSED_ERROR_CODE.test(value.error)) return null;
  if (!BROWSER_POLICY_REASONS.has(structured.reason)
      || !BROWSER_POLICY_STAGES.has(structured.stage)
      || !BROWSER_POLICY_OUTCOMES.has(structured.outcome)
      || typeof structured.retryable !== 'boolean') return null;
  return {
    reason: structured.reason,
    stage: structured.stage,
    outcome: structured.outcome,
    retryable: structured.retryable,
    ...(typeof structured.neutralized === 'boolean'
      ? { neutralized: structured.neutralized }
      : {}),
  };
};

/**
 * Project an explicitly exposed typed tool error without depending on the
 * concrete error class or realm that created it. Unknown thrown fields remain
 * private. The marker alone is not enough: every projected field is bounded
 * and validated before it can enter the model or audit result.
 *
 * @param {unknown} error
 * @returns {{ error: string, content: string, structured: Record<string, unknown>, outcomeKind: any } | null}
 */
const projectExposedToolError = (error) => {
  if (!error || typeof error !== 'object') return null;
  const value = /** @type {Record<string, unknown>} */ (error);
  if (value.exposeToModel !== true) return null;
  if (typeof value.code !== 'string' || !EXPOSED_ERROR_CODE.test(value.code)) return null;
  if (typeof value.content !== 'string' || value.content.length > EXPOSED_ERROR_CONTENT_MAX_CHARS) return null;
  if (!value.structured || typeof value.structured !== 'object' || Array.isArray(value.structured)) return null;
  if (!FAILURE_OUTCOME_VALUES.has(/** @type {any} */ (value.outcomeKind))) return null;
  try {
    if (JSON.stringify(value.structured).length > EXPOSED_ERROR_DETAILS_MAX_CHARS) return null;
  } catch {
    return null;
  }
  return {
    error: value.code,
    content: value.content,
    structured: /** @type {Record<string, unknown>} */ (value.structured),
    outcomeKind: value.outcomeKind,
  };
};

/**
 * Preserve only closed custody fields from an internal semantic executor
 * failure. These fields describe whether retry is safe; they are not an
 * authority claim, and any host receipt still overrides them at settlement.
 * @param {unknown} error
 */
const projectSemanticFailureCustody = (error) => {
  if (!error || typeof error !== 'object') return {};
  const value = /** @type {Record<string, unknown>} */ (error);
  const code = typeof value.code === 'string' && TOOL_RESULT_CODE.test(value.code)
    ? value.code : null;
  const outcomeKnown = typeof value.outcomeKnown === 'boolean'
    ? value.outcomeKnown : null;
  return {
    ...(code ? { code } : {}),
    ...(outcomeKnown !== null ? { outcomeKnown } : {}),
    ...(typeof value.retryable === 'boolean'
      ? { retryable: outcomeKnown === false ? false : value.retryable } : {}),
  };
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

/** @param {DispatchContext} ctx @param {ToolDescriptor} tool */
const withToolMetadata = (ctx, tool) => ({
  ...ctx,
  /** @param {string} name */
  getToolMeta: (name) => {
    return name === tool.name ? {
      sideEffect: tool.sideEffect,
      primitive: tool.primitive,
      origins: tool.origins,
    } : undefined;
  },
});

/** @param {unknown} value */
const freezePlainSnapshot = (value) => {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)
      || value instanceof ArrayBuffer) return value;
  for (const child of Object.values(/** @type {Record<string,unknown>} */ (value))) {
    freezePlainSnapshot(child);
  }
  return Object.freeze(value);
};

/**
 * User hook code gets data, never the live controller context or the shared
 * hook registry. This keeps code-owned floors, metadata resolvers, clients,
 * confirmation and authority closures outside the programmable policy realm.
 * @param {DispatchContext} ctx @param {ToolDescriptor} tool
 */
const userHookContext = (ctx, tool) => freezePlainSnapshot(structuredClone({
  session: ctx.session ? {
    sessionId: ctx.session.sessionId,
    kind: ctx.session.kind,
  } : null,
  permission: ctx.permission ? {
    mode: ctx.permission.mode,
    confirmActions: ctx.permission.confirmActions,
  } : null,
  activeTab: ctx.activeTab ? {
    id: ctx.activeTab.id,
    origin: ctx.activeTab.origin,
  } : null,
  backing: /** @type {any} */ (ctx).backing,
  exposure: /** @type {any} */ (ctx).exposure,
  actorType: /** @type {any} */ (ctx).actorType,
  actorInstanceId: /** @type {any} */ (ctx).actorInstanceId,
  allowlist: Array.isArray(/** @type {any} */ (ctx).allowlist)
    ? [.../** @type {any} */ (ctx).allowlist] : [],
  denylist: Array.isArray(/** @type {any} */ (ctx).denylist)
    ? [.../** @type {any} */ (ctx).denylist] : [],
  tool: {
    name: tool.name, primitive: tool.primitive, sideEffect: tool.sideEffect,
  },
}));

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
*   judgeLanding?: (url: string) => Promise<{ action: string } | null>,
*   onToolActivity?: {
*     begin: (tabId: number, label: string, origin: string, policy?: {
*       denylist?: readonly string[],
*       judgeLanding?: (url: string) => Promise<{ action: string } | null>,
*     }) => unknown,
 *     end: (tabId: number) => unknown,
 *   } | null,
 *   lifecycle?: ReturnType<import('../lifecycle/dispatch-tracking.js').makeDispatchTracker> | null,
 *   lifecycleTurnId?: string,
 *   lifecycleUserInitiated?: boolean,
 *   consumeBrowserChildPolicyNotice?: (tabId: number) => Array<{ reason: string, outcome: string, child: string, retryable: boolean }>,
 *   waitForBrowserChildPolicyNotice?: (tabId: number, timeoutMs: number, terminal?: boolean) => Promise<boolean>,
 *   hasPendingBrowserChildPolicy?: (tabId: number) => boolean,
 *   browserChildQuarantineRequired?: boolean,
 *   armBrowserChildQuarantine?: (tabId: number) => Promise<{ok?:boolean,reason?:string,error?:string,code?:string}>,
 *   authorityOwnsLifecycle?: boolean,
 * }} DispatchContext
 */

/**
 * The dispatcher records the EXECUTION mechanism (`dispatch`) alongside the
 * lineage. The shared ToolMeta typedef doesn't carry `dispatch` yet (it's a
 * UI hint, off the wire), so we widen locally; the widened meta is still
 * structurally a ToolMeta where the result type needs one.
 *
 * @typedef {ToolMeta & { dispatch?: 'inline' | 'spawned',
 *   recovery?: Record<string, unknown>,
 *   browserPolicies?: Array<{ reason: string, outcome: string, child: string, retryable: boolean }>,
 *   browserAsyncPolicies?: Array<{ reason: string, outcome: string, child: string, retryable: boolean }> }} DispatchMeta
 *   `recovery` is the lifecycle contract's agent-facing semantic record —
 *   present only when a dispatch settled as interrupted/outcome_unknown/
 *   refused-replay, so the agent hears the recovery category, not a
 *   generic error string.
 */

/**
 * @param {ToolCall} call
 * @param {DispatchContext} ctx
 * @param {ToolDescriptor} [descriptor]
 * @returns {Promise<ToolResult | Record<string, any>>}
 */
export const prepareToolCall = async (call, ctx, descriptor = undefined) => {
  const tool = descriptor?.name === call.name ? descriptor : null;
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

  const args = call.args ?? {};

  // why: the live hook population + a per-call lineage accumulator. Hook
  // outcomes ride along in meta next to gate results so the same legible
  // "what ran and why" story the gates get extends to hooks. The runner
  // is injected (ctx.hooks) when present so tests can supply a fixed set;
  // production falls back to the module registry.
  const hooks = ctx.hooks ?? listHooks();
  const userHooks = /** @type {import('./hooks/runner.js').Hook[]} */ (hooks)
    // why: provenance is object identity, not the display ID. A historical
    // user record may collide with a now-reserved built-in ID; that retired
    // sentinel must still run fail-closed while the real code-owned default
    // continues through its mandatory floor below.
    .filter((hook) => !DEFAULT_HOOKS.includes(hook));
  /** @type {import('./hooks/runner.js').HookOutcome[]} */
  const hookOutcomes = [];

  // ---- Gate chain --------------------------------------------------------
  /** @type {GateResult[]} */
  const gateResults = [];
  /** @param {string} stage @returns {ToolResult} */
  const abortedResult = (stage) => {
    ctx.audit({ type: 'tool_blocked', details: { tool: call.name, gate: 'abort', reason: stage } }).catch(() => {});
    return {
      ok: false,
      error: `tool_aborted:${call.name}:${stage}`,
      meta: /** @type {DispatchMeta} */ ({
        toolName: call.name, primitive: tool.primitive, dispatch: tool.dispatch,
        gates: gateResults, hooks: hookOutcomes, durationMs: 0,
      }),
    };
  };
  /** @returns {Promise<ToolResult | null>} */
  const refuseInvalidLanding = async () => {
    if (!ctx.revalidateActorLanding) return null;
    let landing;
    try {
      landing = await ctx.revalidateActorLanding();
    } catch (e) {
      const reason = /** @type {{ message?: string }} */ (e)?.message ?? 'auth_state_unavailable';
      gateResults.push({ name: 'live-landing', allowed: false, reason });
      ctx.audit({ type: 'tool_blocked', details: { tool: call.name, gate: 'live-landing', reason } }).catch(() => {});
      return {
        ok: /** @type {const} */ (false),
        error: 'auth_state_unavailable',
        content: AUTH_STATE_UNAVAILABLE_MESSAGE,
        endTurn: true,
        meta: /** @type {DispatchMeta} */ ({
          toolName: call.name, primitive: tool.primitive, dispatch: tool.dispatch,
          gates: gateResults, hooks: hookOutcomes, durationMs: 0,
        }),
      };
    }
    if (!landing || landing.action === 'continue') return null;
    const waiting = landing.action === 'wait';
    gateResults.push({ name: 'live-landing', allowed: false, reason: landing.reason });
    ctx.audit({
      type: 'tool_blocked',
      details: { tool: call.name, gate: 'live-landing', reason: landing.reason },
    }).catch(() => {});
    return {
      ok: false,
      error: waiting ? AUTH_WAITING_FOR_USER_CODE : `origin_lock: ${landing.reason}`,
      content: waiting
        ? AUTH_WAITING_FOR_USER_MESSAGE
        : AUTH_BOUNDARY_STOPPED_MESSAGE,
      endTurn: true,
      meta: /** @type {DispatchMeta} */ ({
        toolName: call.name, primitive: tool.primitive, dispatch: tool.dispatch,
        gates: gateResults, hooks: hookOutcomes, durationMs: 0,
      }),
    };
  };
  // A web actor's tab may move while the model is choosing a tool. Recheck the
  // live landing immediately before policy gates and any effect, across the
  // whole actor surface. Persistence failures end the turn fail-closed.
  const initialLandingRefusal = await refuseInvalidLanding();
  if (initialLandingRefusal) return initialLandingRefusal;
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
      const authWait = name === 'auth-wait' && result.reason === AUTH_WAITING_FOR_USER_CODE;
      return {
        ok: false,
        error: authWait ? AUTH_WAITING_FOR_USER_CODE : `gate_blocked:${name}:${result.reason}`,
        ...(authWait ? { content: AUTH_WAITING_FOR_USER_MESSAGE, endTurn: true } : {}),
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

  // ---- Pre-tool-use hooks ------------------------------------------------
  // Hooks may veto the semantic request before any user prompt or durable
  // lifecycle claim is minted. They never rewrite the admitted arguments.
  const hookCtx = withToolMetadata(ctx, tool);
  // Code-owned policy hooks are an immutable floor. They run outside the user
  // population, so an order=0 hook cannot run first or mutate their registry /
  // metadata context.
  const mandatoryPre = await runPreToolUse({
    hooks: /** @type {any} */ (DEFAULT_HOOKS),
    toolName: call.name, args, ctx: hookCtx,
  });
  hookOutcomes.push(...mandatoryPre.outcomes);
  if (!mandatoryPre.allowed) {
    ctx.audit({
      type: 'tool_blocked', details: {
        tool: call.name, gate: 'mandatory-pre-tool-use-hook', reason: mandatoryPre.reason,
      },
    }).catch(() => {});
    return {
      ok: false,
      error: `hook_blocked:mandatory-pre-tool-use:${mandatoryPre.reason}`,
      meta: /** @type {DispatchMeta} */ ({
        toolName: call.name,
        primitive: tool.primitive, dispatch: tool.dispatch,
        gates: gateResults,
        hooks: hookOutcomes,
        durationMs: 0,
      }),
    };
  }
  const pre = await runPreToolUse({
    hooks: userHooks, toolName: call.name, args,
    ctx: /** @type {any} */ (userHookContext(ctx, tool)),
  });
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
  if (ctx.abortSignal?.aborted) return abortedResult('after_pre_tool_hook');

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
  // why: memory tools and site_client_write run their OWN always-on
  // confirmation inside execute(), security surfaces that can't be toggled
  // off and that render the actual diff/dossier. The site-client tool performs
  // its final live-origin authorization BEFORE that prompt, which a generic
  // dispatcher confirmation cannot do. Skip the ordinary generic prompt for
  // both so the user is neither asked twice nor prompted for an origin the
  // actor no longer owns. The rare repeat-after-unknown prompt still runs here:
  // lifecycle tracking must receive that authority before execute(), then the
  // tool's detailed proposal remains the final consent surface. Plan mode was
  // already enforced by the persona gate above.
  const selfConfirms = tool.primitive === 'memory' || tool.name === 'site_client_write';
  const permMode = normalizeMode(ctx.permission?.mode);
  const permConfirm = ctx.permission?.confirmActions ?? DEFAULT_CONFIRM_ACTIONS;
  const verdict = decideAction({ mode: permMode, confirmActions: permConfirm, tool });
  if (ctx.abortSignal?.aborted) return abortedResult('before_confirmation');

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
  // An unresolved matching D/E intent is a special forced-confirm case. Only
  // a user-initiated turn may open this prompt. Synthetic continuations stay
  // nonmodal and are refused by beginTracking after the hooks run.
  const preHookLifecycleTarget = lifecycleTarget(tool, args, ctx);
  const lifecycleRepeatCandidate = verdict.allowed
    && ctx.lifecycleUserInitiated === true
    ? await Promise.resolve(ctx.lifecycle?.requiresIntentConfirmation?.({
      tool,
      sessionId: ctx.session?.sessionId ?? undefined,
      ownerSessionId: ctx.lifecycleOwnerSessionId ?? undefined,
      target: preHookLifecycleTarget,
      args,
      userInitiated: true,
    })).catch(() => false)
    : false;
  const lifecycleRepeatConfirm = lifecycleRepeatCandidate
    && typeof lifecycleRepeatCandidate === 'object'
    && lifecycleRepeatCandidate.required === true
    ? lifecycleRepeatCandidate
    : false;
  if (ctx.abortSignal?.aborted) return abortedResult('before_confirmation');

  // Whether the USER approved this exact dispatch via a confirm round-trip
  // — the lifecycle tracker turns it into a durable single-use proof.
  let userApprovedThisDispatch = false;
  const needsDispatcherConfirmation = lifecycleRepeatConfirm
    || (!ctx.authorityOwnsLifecycle && !selfConfirms && (verdict.confirm || ugcRuleId));
  if (ctx.authorityOwnsLifecycle && tool.sideEffect !== 'read') {
    const confirmEntry = gateResults.find((g) => g.name === 'confirmation');
    if (confirmEntry) confirmEntry.reason = 'exact authority verifies final arguments';
  }
  if (verdict.allowed && needsDispatcherConfirmation) {
    const confirmEntry = gateResults.find((g) => g.name === 'confirmation');
    /** @type {import('/shared/tool-types.js').ConfirmAnswer | undefined} */
    let answer = 'no';
    try {
      // why: the SW's confirm coordinator accepts a richer prompt than the
      // ConfirmPrompt typedef (it adds `tool`/`summary`/`sessionId` for the
      // side-panel card). Cast the call so the dispatcher keeps building the
      // shape the coordinator actually consumes without widening the contract.
      const confirm = /** @type {((p: Record<string, unknown>, signal?: AbortSignal) => Promise<import('/shared/tool-types.js').ConfirmAnswer>) | undefined} */ (ctx.confirm);
      answer = await confirm?.({
        tool: call.name,
        sideEffect: tool.sideEffect,
        actionClass: verdict.actionClass,
        // Confirmation already names the action. Keep mutable tab origins out
        // of this pre-dispatch UI payload so a later policy stop stays URL-free.
        origins: [],
        summary: summarizeCall(call.name, args),
        // The repeat approval is bound to this immutable lifecycle claim, not
        // the tab's mutable live URL. Show the exact value the tracker will
        // consume so the user can verify what they are authorizing.
        lifecycleTarget: lifecycleRepeatConfirm
          ? lifecycleRepeatConfirm.target
          : undefined,
        // Unknown-outcome recovery is an approval of this exact repeat, not a
        // reusable tool grant. The SW independently bypasses and refuses to
        // create session grants when this flag is present.
        oneShot: lifecycleRepeatConfirm ? true : undefined,
        // why the note and not a longer summary: summarizeCall truncates every
        // string arg to 40 chars, so the card can't show the payload anyway —
        // what it CAN do is tell the user the one fact they can't see, which is
        // that this page is attacker-authorable. Absent on an ordinary confirm,
        // so the card is unchanged for the common case.
        note: ugcRuleId
          ? UGC_CONFIRM_NOTE
          : (lifecycleRepeatConfirm
            ? ('overflow' in lifecycleRepeatConfirm && lifecycleRepeatConfirm.overflow === true
              ? 'Stored unresolved-action evidence exceeded its local bound. Peerd cannot prove this action is new. Verify the exact target before approving.'
              : (ctx.session?.kind === 'actor' || ctx.session?.kind === 'spawned'
                ? 'An actor in this chat wants to repeat an action whose earlier outcome is unknown. Verify the target before approving.'
                : 'A matching earlier action has an unknown outcome. Verify the target before approving this repeat.'))
            : undefined),
        sessionId: ctx.session?.sessionId ?? null,
        dispatchId: call.id ?? null,
      }, ctx.abortSignal);
    } catch {
      answer = 'no';  // fail closed — a broken confirm channel blocks the action
    }
    if (ctx.abortSignal?.aborted) return abortedResult('after_confirmation');
    const approved = answer === 'yes_once' || answer === 'yes_session';
    userApprovedThisDispatch = approved;
    if (confirmEntry) {
      confirmEntry.allowed = approved;
      // why the ruleId rides in the reason: the lineage chip in the transcript
      // renders `${gate}: ${reason}` as its tooltip (sidepanel/components/
      // message-list.js), so attributing the zone here surfaces WHICH rule
      // forced the prompt with no new UI and no new plumbing.
      const how = ugcRuleId
        ? ` [ugc zone: ${ugcRuleId}]`
        : (lifecycleRepeatConfirm ? ' [repeat after unknown outcome]' : '');
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
  if (ctx.abortSignal?.aborted) return abortedResult('after_confirmation');

  // ---- Lifecycle tracking (the recovery contract) ------------------------
  // why HERE: every gate/confirm/hook has passed, so what follows is a real
  // dispatch — the durable operation record must exist BEFORE execute() so
  // an SW eviction mid-effect leaves evidence (interrupted vs
  // outcome_unknown) instead of silence. beginTracking may also REFUSE the
  // call outright: the auto-resume path re-drives pending tool calls with
  // their original tool_use ids, and re-running a non-idempotent action
  // whose first dispatch has no proven outcome is the unsafe replay the
  // contract forbids. Absent ctx.lifecycle (tests, Firefox pre-init), the
  // dispatch is byte-for-byte unchanged.
  let tracking = null;
  if (!ctx.authorityOwnsLifecycle && ctx.lifecycle?.beginTracking) {
    const begun = await ctx.lifecycle.beginTracking({
      callId: call.id,
      tool,
      sessionId: ctx.session?.sessionId ?? undefined,
      ownerSessionId: ctx.lifecycleOwnerSessionId ?? undefined,
      actorId: /** @type {{ actorInstanceId?: string }} */ (ctx).actorInstanceId,
      target: lifecycleTarget(tool, args, ctx),
      // The user's approval, if a confirm round-trip ran above — the
      // tracker mints + consumes the single-use, generation-bound proof
      // and persists it on the durable record (§8.3).
      confirmed: userApprovedThisDispatch,
      confirmedIntent: lifecycleRepeatConfirm,
      // Post-hook args: Class C/D records derive their deterministic
      // idempotency key from these.
      args,
      turnId: ctx.lifecycleTurnId,
      userInitiated: ctx.lifecycleUserInitiated,
    }).catch((error) => {
      // beginTracking is a TOTAL function (see its wrapper) — reaching this
      // catch means something violated that contract. The old behavior here
      // was `() => null`, i.e. "run untracked", which for a non-idempotent
      // action is the one degradation the contract cannot allow: no record
      // means a later interruption is unreportable AND unguarded.
      //
      // So this is an INDEPENDENT fail-closed decision, deliberately not
      // routed through the tracker that just failed: classify the tool
      // directly and refuse D/E/F. A/B/C keep the historical degradation.
      // duplicate reads are invisible and idempotent writes are safe to
      // repeat, so a broken tracker must not take the read surface down
      // with it.
      const retryClass = (() => {
        try { return retryClassForTool(tool); }
        catch { return RETRY_CLASSES.SIDE_EFFECT; } // classification threw: assume the worst
      })();
      if (retryClass !== RETRY_CLASSES.SIDE_EFFECT
          && retryClass !== RETRY_CLASSES.CONDITIONAL_ACTION
          && retryClass !== RETRY_CLASSES.RESOURCE) return null;
      const detail = error instanceof Error ? error.message : String(error);
      const risk = retryClass === RETRY_CLASSES.RESOURCE
        ? 'a long-lived resource must not run untracked: an interruption could '
          + 'then never be reported or guarded against, and could leave an orphan'
        : 'a non-idempotent action must not run untracked: an interruption could '
          + 'then never be reported or guarded against';
      return {
        refuse: {
          error: `failed: ${call.name} was NOT executed — lifecycle tracking `
            + `failed unexpectedly (${detail}) and ${risk}.`,
          recovery: {
            category: 'security_degradation',
            state: 'failed',
            autoRetry: false,
            retryRequires: ['lifecycle-storage'],
            verificationRequired: false,
            keepIdempotencyKey: false,
            reason: `tracking rejected unexpectedly: ${detail}`,
          },
        },
      };
    });
    if (begun && 'refuse' in begun && begun.refuse) {
      ctx.audit({
        type: 'tool_blocked',
        details: { tool: call.name, gate: 'lifecycle-replay-guard', reason: begun.refuse.error },
      }).catch(() => {});
      return {
        ok: false,
        error: begun.refuse.error,
        meta: /** @type {DispatchMeta} */ ({
          toolName: call.name,
          primitive: tool.primitive, dispatch: tool.dispatch,
          gates: gateResults,
          hooks: hookOutcomes,
          durationMs: 0,
          recovery: begun.refuse.recovery,
        }),
      };
    }
    tracking = begun && 'handle' in begun ? begun.handle : null;
  }
  if (ctx.abortSignal?.aborted) {
    if (tracking && ctx.lifecycle?.settleTracking) {
      await ctx.lifecycle.settleTracking(tracking, {
        ok: false, error: 'aborted before execution', aborted: true,
      }).catch(() => null);
    }
    return abortedResult('before_execution');
  }

  // Confirmation, hooks, and lifecycle persistence all yield. Recheck at the
  // last possible point so a redirect during any of them cannot reach execute.
  const finalLandingRefusal = await refuseInvalidLanding();
  if (finalLandingRefusal) {
    if (tracking && ctx.lifecycle?.settleTracking) {
      await ctx.lifecycle.settleTracking(tracking, {
        ok: false,
        error: 'error' in finalLandingRefusal
          ? finalLandingRefusal.error
          : 'landing refused before execution',
        aborted: true,
      }).catch(() => null);
    }
    return finalLandingRefusal;
  }

  // ---- Execute -----------------------------------------------------------
  // why: thread the call's tool_use_id into ctx so tools that stream
  // intermediate state back to the UI (currently vm_boot) can key their
  // outbound messages by it. The UI maps each in-flight tool_use card
  // to its own stream entry; without an id the chunks have no anchor
  // and the renderer drops them.
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
      Promise.resolve(activity.begin(
        activityTabId,
        phrase,
        displayOrigin(ctx.activeTab?.origin),
        { denylist: ctx.denylist },
      )).catch(() => {});
    }
  }

  const start = performance.now();
  const consumeBrowserChildPolicyNotice = typeof ctx.consumeBrowserChildPolicyNotice === 'function'
    ? ctx.consumeBrowserChildPolicyNotice
    : null;
  const childPolicyEligible = (tool.primitive === 'tab' || call.name === 'page_code')
    && tool.sideEffect !== 'read'
    && typeof activityTabId === 'number'
    && consumeBrowserChildPolicyNotice != null;
  const childCapable = ['click', 'type', 'page_code']
    .includes(call.name);
  const quarantineCapable = ['navigate', 'click', 'type']
    .includes(call.name)
    && typeof activityTabId === 'number';
  /** @type {Array<{ reason: string, outcome: string, child: string, retryable: boolean }>} */
  let browserAsyncPolicyNotices = [];
  if (childPolicyEligible && consumeBrowserChildPolicyNotice) {
    const detached = normalizeBrowserChildPolicyNotices(
      consumeBrowserChildPolicyNotice(activityTabId),
    );
    browserAsyncPolicyNotices = detached;
    if (detached.length > 0) {
      void ctx.audit({
        type: 'browser_child_policy_detached',
        details: { count: detached.length },
      }).catch(() => {});
    }
  }
  let preExecutionResult = null;
  let preExecutionError = null;
  let preExecutionFailed = false;
  let browserChildQuarantineArmedTabId;
  try {
    if (quarantineCapable && (ctx.browserChildQuarantineRequired
        || typeof ctx.armBrowserChildQuarantine === 'function')) {
      const armed = typeof ctx.armBrowserChildQuarantine === 'function'
        ? await ctx.armBrowserChildQuarantine(activityTabId)
        : null;
      if (armed?.ok === true) {
        browserChildQuarantineArmedTabId = activityTabId;
      } else preExecutionResult = {
        ok: /** @type {const} */ (false),
        error: armed?.error ?? 'browser_child_quarantine_unavailable',
        code: armed?.code ?? 'browser-child-quarantine-unavailable',
        outcomeKnown: true,
        outcomeKind: /** @type {const} */ ('pre-effect-failure'), retryable: true,
      };
    }
  } catch (error) {
    preExecutionError = error;
    preExecutionFailed = true;
  }
  return {
    prepared: true,
    call, ctx, tool, args, hooks, hookOutcomes, gateResults,
    tracking, activityTabId, start, childPolicyEligible, childCapable,
    browserAsyncPolicyNotices,
    browserChildQuarantineArmedTabId,
    preExecutionResult, preExecutionError, preExecutionFailed,
  };
};

/** @param {Record<string, any>} prepared */
const withExecutionContext = (prepared) => {
  const { call, ctx } = prepared;
  const executeConfirm = /** @type {((prompt: Record<string, any>, signal?: AbortSignal) => Promise<import('/shared/tool-types.js').ConfirmAnswer>) | undefined} */ (
    ctx.confirm
  );
  return {
    ...prepared,
    execCtx: {
      ...ctx,
      toolUseId: call.id,
      ...(executeConfirm ? {
        /** @param {Record<string, any>} prompt @param {AbortSignal} [signal] */
        confirm: (prompt, signal) => executeConfirm({
          ...prompt,
          sessionId: prompt?.sessionId ?? ctx.session?.sessionId ?? null,
          dispatchId: call.id ?? null,
        }, signal),
      } : {}),
      ...(typeof prepared.browserChildQuarantineArmedTabId === 'number'
        ? { browserChildQuarantineArmedTabId: prepared.browserChildQuarantineArmedTabId }
        : {}),
    },
  };
};

/**
 * @param {Record<string, any>} prepared
 * @param {(prepared:Record<string, any>)=>Promise<any>|any} [execute]
 */
export const executePreparedToolCall = async (prepared, execute = undefined) => {
  if (typeof execute !== 'function') return {
    result: {
      ok: false,
      error: `tool_implementation_unavailable:${prepared.tool.name}`,
      code: 'tool-implementation-unavailable',
      outcomeKnown: true,
      outcomeKind: /** @type {const} */ ('pre-effect-failure'),
      retryable: true,
    },
  };
  if (prepared.preExecutionFailed) return { error: prepared.preExecutionError };
  if (prepared.preExecutionResult) return { result: prepared.preExecutionResult };
  try { return { result: await execute(withExecutionContext(prepared)) }; }
  catch (error) { return { error }; }
};

/**
 * @param {Record<string, any>} prepared
 * @param {{result?:any,error?:unknown}} execution
 * @returns {Promise<ToolResult>}
 */
export const settleToolCall = async (prepared, execution) => {
  const {
    call, ctx, tool, args, hooks, hookOutcomes, gateResults,
    tracking, activityTabId, start, childPolicyEligible, childCapable,
    browserAsyncPolicyNotices,
  } = prepared;
  const userHooks = /** @type {import('./hooks/runner.js').Hook[]} */ (hooks)
    .filter((hook) => !DEFAULT_HOOKS.includes(hook));
  const activity = tool.primitive === 'tab' ? ctx.onToolActivity : null;
  const consumeBrowserChildPolicyNotice = typeof ctx.consumeBrowserChildPolicyNotice === 'function'
    ? ctx.consumeBrowserChildPolicyNotice
    : null;
  /** @type {Array<{ reason: string, outcome: string, child: string, retryable: boolean }>} */
  let browserChildPolicyNotices = [];
  try {
    if (Object.hasOwn(execution, 'error')) throw execution.error;
    let result = execution.result;
    if (childPolicyEligible && consumeBrowserChildPolicyNotice) {
      const embedded = normalizeBrowserChildPolicyNotices(
        /** @type {any} */ (result).browserChildPolicyNotices,
      );
      let notices = normalizeBrowserChildPolicyNotices(
        consumeBrowserChildPolicyNotice(activityTabId),
      );
      if (notices.length === 0 && embedded.length === 0) {
        // One task lets tabs/webNavigation report a child raised by a fast
        // scripting action.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (childCapable && typeof ctx.waitForBrowserChildPolicyNotice === 'function') {
          // Browser child events can land after the scripting reply. Wait on the
          // exact source's outcome channel so the current tool result, not some
          // later action, carries the receipt. Only page actions that can create
          // a child pay this bounded model-side grace period.
          await ctx.waitForBrowserChildPolicyNotice(activityTabId, 175);
        } else if (ctx.hasPendingBrowserChildPolicy?.(activityTabId)) {
          await ctx.waitForBrowserChildPolicyNotice?.(activityTabId, 100);
        }
        notices = normalizeBrowserChildPolicyNotices(
          consumeBrowserChildPolicyNotice(activityTabId),
        );
        if (notices.length === 0 && ctx.hasPendingBrowserChildPolicy?.(activityTabId)) {
          await ctx.waitForBrowserChildPolicyNotice?.(activityTabId, 5_000, true);
          notices = normalizeBrowserChildPolicyNotices(
            consumeBrowserChildPolicyNotice(activityTabId),
          );
        }
      }
      const { browserChildPolicyNotices: _hostOnlyNotices, ...visibleResult } = /** @type {any} */ (result);
      notices = [...embedded, ...notices];
      browserChildPolicyNotices = notices;
      result = withBrowserChildPolicyNotices(
        visibleResult,
        notices,
      );
    }
    result = withAsyncBrowserChildPolicyNotices(result, browserAsyncPolicyNotices);
    const durationMs = Math.round(performance.now() - start);
    if (activity && typeof activityTabId === 'number') {
      Promise.resolve(activity.end(activityTabId)).catch(() => {});
    }
    const browserPolicy = browserPolicyAuditDetails(result);
    // why: most tools signal failure by returning { ok: false }, not by
    // throwing — only one tool file throws. Auditing the whole non-throw
    // path as tool_executed made the audit log report ≈zero failures while
    // the transcript's is_error flag showed them. Branch on result.ok so a
    // returned failure lands in the SAME tool_failed bucket as a throw.
    ctx.audit(result?.ok === false
      ? {
        type: 'tool_failed',
        details: {
          tool: call.name, primitive: tool.primitive, dispatch: tool.dispatch,
          durationMs, error: result.error,
          ...(browserPolicy ? { browserPolicy } : {}),
        },
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
    const post = await runPostToolUse({
      hooks: userHooks,
      toolName: call.name,
      args,
      result,
      ctx: /** @type {any} */ (userHookContext(ctx, tool)),
    });
    hookOutcomes.push(...post.outcomes);
    // Settle the lifecycle record from the tool's own outcome. A returned
    // failure whose error is an ambiguous transport loss is REWRITTEN to
    // the semantic state (interrupted / outcome_unknown) — §16.2: the agent
    // never sees a bare timeout on a tracked side effect.
    /** @type {{ error: string, recovery: Record<string, unknown> } | null} */
    let recoveryRewrite = null;
    if (tracking && ctx.lifecycle?.settleTracking) {
      recoveryRewrite = await ctx.lifecycle.settleTracking(tracking, {
        ok: result?.ok !== false,
        error: result?.ok === false ? String(result.error ?? '') : undefined,
        aborted: result?.actorAborted === true,
        // A typed failure outcome a tool stamped on its result — the
        // deterministic path (lifecycle/failure-taxonomy.js).
        outcomeKind: /** @type {{ outcomeKind?: any }} */ (result)?.outcomeKind,
      }).catch(() => null);
    }
    // A rewrite replaces the model-facing failure shape, but custody metadata
    // is not presentation. An awaited actor reply may already exist and its
    // mailbox row cannot be acknowledged unless these host-only ids reach the
    // durable tool-result block.
    const actorDeliveryId = typeof result?.actorDeliveryId === 'string'
      ? result.actorDeliveryId : undefined;
    const actorDeliveryIds = Array.isArray(result?.actorDeliveryIds)
      ? [...new Set(result.actorDeliveryIds.filter(
        (/** @type {unknown} */ id) => typeof id === 'string' && id.length > 0))]
      : [];
    const hasActorHostState = typeof result?.actorCorrelationId === 'string'
      || typeof result?.actorTerminal === 'boolean'
      || typeof result?.actorOutcomeKnown === 'boolean'
      || typeof result?.actorPerformed === 'boolean'
      || typeof result?.actorAborted === 'boolean';
    let actorHostState = {
      ...(typeof result?.actorCorrelationId === 'string'
        ? { actorCorrelationId: result.actorCorrelationId } : {}),
      ...(typeof result?.actorTerminal === 'boolean'
        ? { actorTerminal: result.actorTerminal } : {}),
      ...(typeof result?.actorOutcomeKnown === 'boolean'
        ? { actorOutcomeKnown: result.actorOutcomeKnown } : {}),
      ...(typeof result?.actorPerformed === 'boolean'
        ? { actorPerformed: result.actorPerformed } : {}),
      ...(result?.actorAborted === true ? { actorAborted: true } : {}),
    };
    // The outer lifecycle owns the final custody verdict. An actor can report a
    // locally-known policy stop while the message_actor dispatch itself loses
    // durable proof; in that case the outer outcome_unknown must replace, not
    // sit beside, the stale inner certainty/cancellation flags.
    if (recoveryRewrite && hasActorHostState) {
      const state = recoveryRewrite.recovery?.state;
      if (state === 'outcome_unknown') {
        actorHostState = {
          ...actorHostState,
          actorTerminal: true,
          actorOutcomeKnown: false,
          actorPerformed: true,
          actorAborted: false,
        };
      } else if (state === 'interrupted') {
        actorHostState = {
          ...actorHostState,
          actorTerminal: true,
          actorOutcomeKnown: true,
          actorPerformed: false,
          actorAborted: false,
        };
      } else if (state === 'cancelled') {
        actorHostState = {
          ...actorHostState,
          actorTerminal: true,
          actorOutcomeKnown: true,
          actorPerformed: false,
          actorAborted: true,
        };
      }
    }
    const recoveryState = recoveryRewrite?.recovery?.state;
    const resultCustody = /** @type {{code?:unknown,outcomeKind?:unknown,outcomeKnown?:unknown,retryable?:unknown}} */ (result);
    const resultCode = typeof resultCustody?.code === 'string' && TOOL_RESULT_CODE.test(resultCustody.code)
      ? resultCustody.code : null;
    const resultOutcomeKind = FAILURE_OUTCOME_VALUES.has(/** @type {any} */ (resultCustody?.outcomeKind))
      ? /** @type {'transport-lost'|'host-lost'|'pre-effect-failure'|'effect-completed'} */ (resultCustody.outcomeKind)
      : null;
    // A lifecycle rewrite replaces presentation, not custody. Preserve a
    // bounded machine code and the typed host/transport-loss verdict so UI,
    // audit, and model orchestration cannot mistake an ambiguous Git/App
    // mutation for a normal retryable failure.
    const recoveryCustody = recoveryRewrite ? {
      ...(resultCode ? { code: resultCode } : {}),
      ...(resultOutcomeKind ? { outcomeKind: resultOutcomeKind } : {}),
      ...(recoveryState === 'outcome_unknown'
        ? { outcomeKnown: false, retryable: false }
        : {
            ...(typeof resultCustody?.outcomeKnown === 'boolean'
              ? { outcomeKnown: resultCustody.outcomeKnown } : {}),
            ...(typeof resultCustody?.retryable === 'boolean'
              ? { retryable: resultCustody.retryable } : {}),
          }),
    } : {};
    /** @type {ToolResult} */
    const settled = recoveryRewrite
      ? {
        ok: false,
        error: recoveryRewrite.error,
        ...recoveryCustody,
        ...actorHostState,
        ...(actorDeliveryId ? { actorDeliveryId } : {}),
        ...(actorDeliveryIds.length > 0 ? { actorDeliveryIds } : {}),
      }
      : result;
    /** @type {ToolResult} */
    const enriched = {
      ...settled,
      meta: /** @type {DispatchMeta} */ ({
        toolName: call.name,
        primitive: tool.primitive, dispatch: tool.dispatch,
        // why: sideEffect + origins complete the lineage spine on EXECUTED
        // results — the two fields lineage compaction reads to decide what to
        // compact (sideEffect class) and to render where it touched (origins).
        // Captured here, on the final post-hook args. Both stay off the wire.
        sideEffect: tool.sideEffect,
        origins: browserPolicy ? [] : safeOrigins(tool, args, ctx),
        gates: gateResults,
        hooks: hookOutcomes,
        durationMs,
        ...(recoveryRewrite ? { recovery: recoveryRewrite.recovery } : {}),
        ...(browserChildPolicyNotices.length > 0
          ? { browserPolicies: browserChildPolicyNotices }
          : {}),
        ...(browserAsyncPolicyNotices.length > 0
          ? { browserAsyncPolicies: browserAsyncPolicyNotices }
          : {}),
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
    const exposedError = projectExposedToolError(e);
    const semanticCustody = projectSemanticFailureCustody(e);
    const endTurn = /** @type {{ endTurn?: boolean }} */ (e)?.endTurn === true;
    const endingContent = /** @type {{ content?: unknown }} */ (e)?.content;
    const browserPolicy = browserPolicyAuditDetails(exposedError);
    ctx.audit({
      type: 'tool_failed',
      // why: same rich shape as the returned-{ok:false} failure above so
      // BOTH failure sources are uniform — audit mining can group throws and
      // returned failures by the same primitive/dispatch keys.
      details: {
        tool: call.name, primitive: tool.primitive, dispatch: tool.dispatch,
        error: exposedError?.error ?? message, durationMs,
        ...(browserPolicy ? { browserPolicy } : {}),
      },
    }).catch(() => {});
    // why: post-hooks still observe a FAILED execution — a failure is an
    // observable event (e.g. an audit/metrics hook wants to count it).
    const post = await runPostToolUse({
      hooks: userHooks,
      toolName: call.name,
      args,
      result: { ok: false, error: message },
      ctx: /** @type {any} */ (userHookContext(ctx, tool)),
    });
    hookOutcomes.push(...post.outcomes);
    // A THROW after dispatch is the most ambiguous shape of all — settle
    // the lifecycle record and adopt the semantic error where it applies.
    /** @type {{ error: string, recovery: Record<string, unknown> } | null} */
    let recoveryRewrite = null;
    if (tracking && ctx.lifecycle?.settleTracking) {
      recoveryRewrite = await ctx.lifecycle.settleTracking(tracking, {
        ok: false,
        error: message,
        aborted: /** @type {{ name?: string }} */ (e)?.name === 'AbortError',
        // A typed outcome stamped on the thrown error (survives relay
        // boundaries as a plain field — see lifecycle/failure-taxonomy.js).
        outcomeKind: /** @type {{ outcomeKind?: any }} */ (e)?.outcomeKind,
      }).catch(() => null);
    }
    /** @type {ToolResult} */
    let failedResult = {
      ok: false,
      error: recoveryRewrite?.error ?? exposedError?.error ?? message,
      ...(exposedError && !recoveryRewrite ? exposedError : {}),
      ...(recoveryRewrite?.recovery?.state === 'outcome_unknown'
        ? { ...semanticCustody, outcomeKnown: false, retryable: false }
        : semanticCustody),
      ...(endTurn ? {
        content: typeof endingContent === 'string'
          ? endingContent
          : 'peerd stopped this helper because its authority state could not be saved safely.',
        endTurn: true,
      } : {}),
      meta: /** @type {DispatchMeta} */ ({
        toolName: call.name,
        primitive: tool.primitive, dispatch: tool.dispatch,
        // Same spine fields on the FAILED path — an errored result still has a
        // body and a lineage (the spine renders "… · error · N chars").
        sideEffect: tool.sideEffect,
        origins: browserPolicy ? [] : safeOrigins(tool, args, ctx),
        gates: gateResults,
        hooks: hookOutcomes,
        durationMs,
        ...(recoveryRewrite ? { recovery: recoveryRewrite.recovery } : {}),
      }),
    };
    if (childPolicyEligible && consumeBrowserChildPolicyNotice) {
      let notices = normalizeBrowserChildPolicyNotices(
        consumeBrowserChildPolicyNotice(activityTabId),
      );
      if (notices.length === 0 && childCapable
          && typeof ctx.waitForBrowserChildPolicyNotice === 'function') {
        await ctx.waitForBrowserChildPolicyNotice(activityTabId, 175);
        notices = normalizeBrowserChildPolicyNotices(
          consumeBrowserChildPolicyNotice(activityTabId),
        );
      }
      if (notices.length === 0 && ctx.hasPendingBrowserChildPolicy?.(activityTabId)) {
        await ctx.waitForBrowserChildPolicyNotice?.(activityTabId, 5_000, true);
        notices = normalizeBrowserChildPolicyNotices(
          consumeBrowserChildPolicyNotice(activityTabId),
        );
      }
      browserChildPolicyNotices = notices;
      failedResult = withBrowserChildPolicyNotices(failedResult, browserChildPolicyNotices);
      failedResult.meta = /** @type {DispatchMeta} */ ({
        ...failedResult.meta,
        browserPolicies: browserChildPolicyNotices,
      });
    }
    failedResult = withAsyncBrowserChildPolicyNotices(
      failedResult, browserAsyncPolicyNotices,
    );
    if (browserAsyncPolicyNotices.length > 0) {
      failedResult.meta = /** @type {DispatchMeta} */ ({
        ...failedResult.meta,
        browserAsyncPolicies: browserAsyncPolicyNotices,
      });
    }
    return failedResult;
  }
};
