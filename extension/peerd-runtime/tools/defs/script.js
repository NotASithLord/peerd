// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// script — run JS HEADLESS (no tab).
//
// The headless sibling of js_notebook: the SAME sealed worker (realm seal +
// peerd.* surface — notebook-tab/worker-source.js), hosted in the offscreen
// document with NO UI. The cheap, invisible path for the agent's OWN quick
// compute — math, a transform, CODE MODE (orchestrate fetches/compute in one
// script, return the result) — and now ORCHESTRATION: the `actors` client
// delegates goals to the agent's own actors from code. EACH CALL is a FRESH
// worker with an EPHEMERAL OPFS scratch that is nuked after; for durable files
// or a visible editor/output, use a Notebook. Own-code threat model — NOT for
// untrusted code (that needs a real origin boundary: the opaque-origin App
// iframe, peerd-engine).

import {
  moduleImportPolicyMessage,
  REMOTE_MODULE_CAPABILITY_BLOCKED_MESSAGE,
  REMOTE_MODULE_RESTRICTED_CODE,
} from '/peerd-engine/errors.js';
import { JS_PITFALLS_NOTE, SCRIPT_BUILTINS_NOTE } from './code-style-note.js';
import { oncePerSession } from './once-per-session.js';
import { pushValueBlock, serializeValue } from './value-block.js';
import { SPILL_PAGE_CHARS as RESULT_PAGE_CHARS } from '../web/spill.js';
import { MAX_SPILL_TEXT_CHARS } from '../result-store-policy.js';
import { wrapUntrusted } from '../prompt-wrap.js';
import {
  renderTraceLines, traceGoalLines, traceErrorDetails,
} from '../../actor/actors-api.js';
import { renderCodeOpTrace } from '../../actor/capability-manifest.js';

// A DELEGATING run awaits real actor turns, so its wall-clock comes from the
// timeout TOWER in actors-api.js (job > bridge guard > per-call cap, all
// derived from one ceiling) — never a literal here that could drift below the
// bridge and kill the worker mid-ask.

/**
 * @typedef {Object} RunResult
 * @property {number} durationMs
 * @property {string} [error]
 * @property {string} [errorCode]
 * @property {boolean} [endTurn]
 * @property {string} [endTurnContent]
 * @property {string} [endTurnOutcomeKind]
 * @property {Array<{ level: string, text: string }>} [consoleOutput]
 * @property {unknown} [value]
 * @property {boolean} [usedEgress]   the run called peerd.egress.fetch (job-runner)
 * @property {boolean} [usedRemoteModules] the resolved graph included remote code
 * @property {boolean} [usedActors]   the run delegated via the actors client
 * @property {string[]} [actorDeliveryIds] durable mailbox correlations for
 *   actor replies consumed by this run; host-only, never part of formatted output
 * @property {boolean} [usedPage]     the run consumed page/DOM/pixel data through page.*
 * @property {boolean} [usedApp]      the run consumed App-defined runtime data through app.*
 * @property {Array<{ data: string, mediaType: string }>} [images] host-captured page images (bounded by job-runner)
 * @property {Array<{ reason: string, outcome: string, child: string, retryable: boolean }>} [browserPolicies]
 *   host-captured child-navigation receipts from page calls; never user-code output
 * @property {boolean} [usedWorkspace]   the job was workspace-mounted (host-set, never inferred from ops)
 * @property {boolean} [workspaceOverBudget]   the workspace exceeded its size budget — writes were refused
 * @property {Array<{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string, settled?: boolean, actorFailed?: boolean, cancelled?: boolean }>} [actorsTrace]
 * @property {Array<{ seq: number, bridge: string, method: string, outcome: string, ms: number }>} [codeTrace]
 * @property {boolean} [usedProvider]   the run sub-called the model (peerd.provider.call, design 5)
 * @property {number} [providerCalls]   host-counted sub-call attempts
 * @property {number} [providerTokens]  host-summed tokens (input + output) across them
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const scriptTool = composeTool("script", {

  execute: async (args, ctx) => {
    if (typeof args?.code !== 'string' || args.code.length === 0) {
      return { ok: false, error: 'code_required' };
    }
    const authority = /** @type {any} */ (ctx).executionAuthority;
    if (!authority?.runHeadlessScript) {
      return { ok: false, error: 'headless_js_unavailable' };
    }
    const sid = ctx.session?.sessionId ?? '';
    const actorsOn = /\bactors\b/.test(args.code);
    const providerOn = /\bpeerd\s*\.\s*provider\b/.test(args.code);
    const workspaceOn = args.workspace === true;
    const run = await authority.runHeadlessScript({
      code: args.code, actors: actorsOn, provider: providerOn,
      workspace: workspaceOn, timeoutMs: args.timeoutMs ?? null,
    });
    const custody = Array.isArray(run?.actorDeliveryIds) && run.actorDeliveryIds.length
      ? { actorDeliveryIds: run.actorDeliveryIds } : {};
    if (!run?.ok) {
      const unknown = run?.outcomeKnown === false
        ? {
            outcomeKnown: false,
            outcomeKind: run?.outcomeKind === 'host-lost'
              ? 'host-lost' : 'transport-lost',
            retryable: false,
          }
        : {};
      const mirrored = Array.isArray(run?.mirrored) ? run.mirrored : [];
      const dispatched = mirrored.length
        ? `\n[DELEGATIONS dispatched before the failure]\n${renderTraceLines(mirrored).join('\n')}`
        : '';
      if (run?.actors) {
        const unsafeDetails = [
          '[TRANSPORT ERROR]', `${run.errorName}: ${run.errorMessage}`,
          ...traceGoalLines(mirrored), ...traceErrorDetails(mirrored),
        ];
        const fenced = wrapUntrusted({
          origin: 'script (actor replies)', tool: 'script', body: unsafeDetails.join('\n'),
        });
        return {
          ok: false,
          error: `script_failed: actor orchestration transport failed${dispatched}\n${fenced}`,
          ...unknown, ...custody,
        };
      }
      return {
        ok: false,
        error: run?.error ?? `script_failed: ${run?.errorName}: ${run?.errorMessage}`,
        ...unknown, ...custody,
      };
    }
    const result = run.result;
      const importPolicyMessage = moduleImportPolicyMessage(result.errorCode);
      if (importPolicyMessage) {
        return {
          ok: false,
          error: `${result.errorCode}: ${importPolicyMessage}`,
          ...custody,
        };
      }
      // Value spill (run cache): when the serialized [VALUE] overflows its cap,
      // store the FULL text keyed by this run/tool-use, stamped with the owning
      // session and the run's FENCE state: read_result re-applies exactly
      // that fencing when paging it back. Best-effort: a failed spill leaves
      // the truncation note alone (today's behavior).
      /** @type {{ key: string, total: number } | undefined} */
      let valueSpill;
      const sv = serializeValue(result.value);
      if (sv?.truncated && authority.spillScriptValue && sid) {
        try {
          const originLabel = runOriginLabel(result);
          const key = await authority.spillScriptValue({
            fenced: runIsFenced(result), originLabel, text: sv.text,
          });
          // The store caps what it keeps (result-store.js MAX_SPILL_TEXT_CHARS) :
          // report the STORED length so the footer never advertises pages that
          // don't exist.
          valueSpill = { key, total: Math.min(sv.text.length, MAX_SPILL_TEXT_CHARS) };
        } catch { /* spill failed — the capped [VALUE] still ships */ }
      }
      let content = formatRunResult(args.code, result, valueSpill, sv);
      // why once per session: script is the agent's OWN quick-compute path (the
      // precision / off-by-one bug class lands here), so the correctness note +
      // the peerd:std/peerd:wasi builtins reference matter most here — but script
      // is called repeatedly, so disclose them on the FIRST run and stay silent
      // after, paying the tokens once. (oncePerSession re-arms on SW restart.)
      if (oncePerSession(
        sid, 'js-pitfalls', ctx.session?.messages, 'script', JS_PITFALLS_NOTE,
      )) {
        content += `\n\n${JS_PITFALLS_NOTE}\n\n${SCRIPT_BUILTINS_NOTE}`;
      }
      // why: the ordinary 8k tool-result cap can cut off the trusted paging
      // footer that follows the bounded [VALUE] preview. Raise only results that
      // actually reached the session-owned spill store; an ordinary large result
      // still receives the conservative cap.
      return { ok: true, content, ...(valueSpill ? { paged: true } : {}), ...custody };
  },
});

/**
 * Does this run's output need the untrusted fence? A run that touched the web
 * (egress), delegated (actor replies), or ran against the WORKSPACE — whose
 * files an earlier run may have filled with fetched bytes, so nothing read
 * (or imported) from it is reliably agent-authored. UNCONDITIONAL for
 * workspace runs by design: fencing only on observed OPFS reads would make
 * the security property depend on classifying every relay op forever.
 * @param {RunResult} r
 */
export const runIsFenced = (r) => !!(
  r.usedEgress || r.usedRemoteModules || r.usedActors || r.usedPage || r.usedApp || r.usedWorkspace
);

/**
 * The fence origin label for a run — names every untrusted source the run
 * touched, joined when several apply.
 * @param {RunResult} r
 */
export const runOriginLabel = (r) => {
  const parts = [
    ...(r.usedEgress ? ['fetched web content'] : []),
    ...(r.usedRemoteModules ? ['remote modules'] : []),
    ...(r.usedActors ? ['actor replies'] : []),
    ...(r.usedPage ? ['page content'] : []),
    ...(r.usedApp ? ['App runtime state'] : []),
    ...(r.usedWorkspace ? ['workspace files'] : []),
  ];
  return parts.length ? `script (${parts.join(' + ')})` : 'script';
};

/**
 * Format a headless run result for the model. Shared with page_code (the web
 * actor's code-REPL tool, PR #119) — same worker substrate, same result shape.
 * `valueSpill` (script-only) names an already-stored result record; its
 * footer is TOOL-AUTHORED (caller-computed values only) and rides OUTSIDE the
 * fence, like the web spill's paging note. `serializedValue` (script-only) is
 * the caller's precomputed serializeValue(r.value) — thread it so the spill
 * check and the [VALUE] block share ONE stringify pass over what can be a
 * multi-MB value.
 * @param {string} code
 * @param {RunResult} r
 * @param {{ key: string, total: number }} [valueSpill]
 * @param {{ text: string, truncated: boolean }} [serializedValue]
 * @returns {string}
 */
export const formatRunResult = (code, r, valueSpill, serializedValue) => {
  const lines = [];
  const oneLineCode = code.length > 200 ? `${code.slice(0, 200)}…` : code;
  lines.push(`> ${oneLineCode.replace(/\n/g, '\n  ')} (headless)`);
  lines.push(`[${r.durationMs}ms]`);
  // The DELEGATIONS trace — fence-SAFE by construction (host-recorded method/
  // fixed target label/outcome/timing; never actor bytes). Dynamic targets and
  // the model's own goal previews ride in the fenced details below.
  // It sits OUTSIDE the fence on purpose: this is the chain-of-events the
  // orchestrator debugs from even when the script failed mid-fan.
  const trace = Array.isArray(r.actorsTrace) ? r.actorsTrace : [];
  if (trace.length) {
    lines.push('[DELEGATIONS]');
    lines.push(...renderTraceLines(trace));
  }
  const codeTrace = Array.isArray(r.codeTrace) ? r.codeTrace : [];
  if (codeTrace.length) {
    lines.push('[CODE OPS]');
    lines.push(...renderCodeOpTrace(codeTrace));
  }
  // The sub-model meter (design 5) — fence-safe by construction (host-counted
  // numbers, never realm bytes) and unconditional whenever the lane was used:
  // the orchestrator and the user reading the transcript must always see that
  // money moved, even when the script swallowed every result.
  if (r.usedProvider) {
    lines.push(`[MODEL CALLS ${r.providerCalls ?? 0} | tokens ${r.providerTokens ?? 0}]`);
  }
  // The run's OUTPUT (error text, console, value) — the parts user code shapes.
  const body = [];
  if (r.error) body.push('[ERROR]', r.error);
  // Goal previews + failed-op details are RUNTIME-shaped (a chained goal can
  // carry a prior actor's reply or fetched bytes) → fenced body only. The
  // fence-safe lines above carry method/target/outcome/timing.
  const opGoals = traceGoalLines(trace);
  if (opGoals.length) body.push('[DELEGATION GOALS]', ...opGoals);
  const opErrors = traceErrorDetails(trace);
  if (opErrors.length) body.push('[DELEGATION ERRORS]', ...opErrors);
  if (r.consoleOutput && r.consoleOutput.length) {
    body.push('[CONSOLE]');
    for (const { level, text } of r.consoleOutput) {
      body.push(`  ${level === 'info' ? '' : `[${level}] `}${text}`);
    }
  }
  pushValueBlock(body, r.value, serializedValue);
  // Own-code threat model: a pure-compute run's output is the agent's own and
  // stays raw. But a run that touched the web (peerd.egress.fetch), delegated
  // to actors, OR mounted the workspace can carry untrusted bytes (fetched
  // content / actor replies / workspace files) in its value/console/error —
  // fence THOSE runs so foreign content can't launder into the caller's
  // trusted context through scratch compute.
  if (runIsFenced(r) && body.length) {
    lines.push(wrapUntrusted({ origin: runOriginLabel(r), tool: 'script', body: body.join('\n') }));
  } else {
    lines.push(...body);
  }
  // Tool-authored status lines — OUTSIDE the fence by design (run output must
  // never be able to forge or suppress them; caller-computed values only).
  if (r.workspaceOverBudget) {
    lines.push('[WORKSPACE OVER BUDGET — writes were refused this run; delete files (await peerd.self.deleteFile(path) in a workspace run) to get back under the budget]');
  }
  if (r.usedRemoteModules) {
    lines.push(`[${REMOTE_MODULE_RESTRICTED_CODE}] ${REMOTE_MODULE_CAPABILITY_BLOCKED_MESSAGE}`);
  }
  if (valueSpill) {
    lines.push([
      `[paging] The [VALUE] (${valueSpill.total} chars) is stored locally.`,
      `Read more with read_result { "key": "${valueSpill.key}", "offset": <char offset>, "limit": <chars, max ${RESULT_PAGE_CHARS}> }. On future runs, return a compact value when possible.`,
    ].join('\n'));
  }
  return lines.join('\n');
};
