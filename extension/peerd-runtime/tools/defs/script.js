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

import { clamp } from '/shared/util.js';
import {
  moduleImportPolicyMessage,
  REMOTE_MODULE_CAPABILITY_BLOCKED_MESSAGE,
  REMOTE_MODULE_RESTRICTED_CODE,
} from '/peerd-engine/background.js';
import { JS_PITFALLS_NOTE, SCRIPT_BUILTINS_NOTE } from './code-style-note.js';
import { oncePerSession } from './once-per-session.js';
import { pushValueBlock, serializeValue } from './value-block.js';
import { SPILL_PAGE_CHARS as RUN_CACHE_SLICE_CHARS } from '../web/spill.js';
import { MAX_SPILL_TEXT_CHARS } from '../run-cache.js';
import { wrapUntrusted } from '../prompt-wrap.js';
import {
  renderTraceLines, traceGoalLines, traceErrorDetails,
  ACTORS_JOB_DEFAULT_TIMEOUT_MS, ACTORS_JOB_MAX_TIMEOUT_MS,
  ACTORS_TRACE_ERROR_MAX_CHARS,
} from '../../actor/actors-api.js';
import { renderCodeOpTrace } from '../../actor/capability-manifest.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
// A DELEGATING run awaits real actor turns, so its wall-clock comes from the
// timeout TOWER in actors-api.js (job > bridge guard > per-ask cap, all
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
    // why: jsOffscreenClient/scriptRuns/messageActor ride the opaque ctx
    // contract (not on ToolContext); narrow to what this tool touches.
    const c = /** @type {{ jsOffscreenClient?: { execHeadless?: (code: string, opts: object) => Promise<RunResult>, abortHeadless?: (runId: string, ownerSessionId?: string) => Promise<void> }, scriptRuns?: { mintRunId: (sid: string) => string, register: (runId: string, signal?: any, owner?: string, capabilities?: { actors?: boolean, provider?: boolean, egress?: boolean }) => void, abort: (runId: string) => void, release: (runId: string) => void, opsFor?: (runId: string) => Array<any> }, runCache?: { put?: (record: object) => Promise<void> }, messageActor?: unknown, toolAllow?: Set<string> | null, inbound?: boolean, abortSignal?: AbortSignal, toolUseId?: string }} */ (
      /** @type {unknown} */ (ctx));
    const jsOffscreenClient = c.jsOffscreenClient;
    if (!jsOffscreenClient || typeof jsOffscreenClient.execHeadless !== 'function') {
      return { ok: false, error: 'headless_js_unavailable' };
    }
    const sid = ctx.session?.sessionId ?? '';
    // The actors surface is minted ONLY where delegation is legal AND the code
    // actually wants it:
    //   • the ctx carries the messageActor capability + the run registry (a
    //     chat's main turn — an actor's keyless narrowing strips it, a child
    //     without the message_actor grant loses the closure);
    //   • a bound environment actor is refused (its authority stays pinned to
    //     one environment), while a spawned actor gets parity with its existing
    //     direct message_actor grant — no grant, no closure, no client;
    //   • a chat manifest that removed message_actor cannot recover it through
    //     script (spawned grants are already manifest-intersected);
    //   • the CODE references `actors` at all (any use requires the
    //     identifier, aliasing included) — a pure-compute script must keep the
    //     30s compute wall-clock, not inherit the ~5-minute delegation one.
    // The SW actors/call route re-verifies the owner per op regardless.
    const sessionKind = /** @type {{ kind?: string } | undefined} */ (ctx.session)?.kind;
    // why ctx.inbound !== true: an inbound (untrusted-origin) turn — a synthetic
    // async-actor reintegration wake or the dweb agent's trickle-up, both fenced
    // attacker-derived bytes — is refused a DIRECT message_actor by the sender
    // gate's Wall 1 (mayMessageActor: inbound === true → false). The script tool's
    // actors.call reaches the SAME messageActor through the actors/call relay,
    // so minting that surface on an inbound turn would be a SECOND, ungated door
    // through the inbound wall (the relay never carried the flag). Fail closed at
    // the mint — no surface advertised — and thread the flag to the SW route below
    // (defense-in-depth: the route re-checks, consistent with "SW re-verifies
    // every op"). Direct message_actor already gates on c.inbound the same way.
    const inbound = c.inbound === true;
    const messageActorAllowed = !(c.toolAllow instanceof Set) || c.toolAllow.has('message_actor');
    const actorsOn = typeof c.messageActor === 'function' && !!c.scriptRuns && !!sid
      && sessionKind !== 'actor'
      && messageActorAllowed
      && !inbound
      && /\bactors\b/.test(args.code);
    // The durable workspace is a CHAT-SESSION surface: a spawned/actor child's
    // session is ephemeral and never archived (archive is the only teardown
    // event), so a child workspace would leak its OPFS subtree forever —
    // refuse the mount for non-chat kinds, same gate as actorsOn.
    const workspaceOn = args.workspace === true && !!sid
      && sessionKind !== 'spawned' && sessionKind !== 'actor';
    // The sub-model lane (design 5) — the actorsOn mint mirrored: legal only
    // for a top-level chat's own turn (the SW script/model-call route refuses
    // actor/spawned owners regardless), and minted only when the code actually
    // REFERENCES peerd.provider — a non-using run keeps the short compute
    // wall-clock and never carries a spend-capable cap it doesn't need. A
    // destructured alias won't mint (the in-realm surface then reports the
    // no-provider profile — rewrite with the literal reference).
    const providerOn = !!c.scriptRuns && !!sid
      && sessionKind !== 'spawned' && sessionKind !== 'actor'
      && /\bpeerd\s*\.\s*provider\b/.test(args.code);
    // A turn that is ALREADY stopped must not launch a worker at all — the
    // 'abort' event will never re-fire on an aborted signal, so a run started
    // now would be unkillable until its wall-clock.
    if (c.abortSignal?.aborted) {
      return { ok: false, error: 'script_aborted: the turn was stopped before the run started' };
    }
    // why providerOn shares the delegation-sized wall-clock: a sub-calling run
    // awaits real model turns, exactly like an actors fan-out — the compute cap
    // would kill the worker mid-generation (design 5).
    const timeoutMs = (actorsOn || providerOn)
      ? clamp(args.timeoutMs ?? ACTORS_JOB_DEFAULT_TIMEOUT_MS, 1000, ACTORS_JOB_MAX_TIMEOUT_MS)
      : clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    /** @type {string | undefined} */
    let runId;
    // A script can consume several actor replies. Custody follows the complete
    // set into the one outer ToolResult that will be committed to history.
    // Keep a host-owned union with the SW mirror so an offscreen transport loss
    // after an actor reply cannot orphan its acknowledgement.
    /** @type {Set<string>} */
    const actorDeliveryIds = new Set();
    const addActorDeliveryIds = (/** @type {unknown} */ ids) => {
      if (!Array.isArray(ids)) return;
      for (const id of ids) if (typeof id === 'string' && id) actorDeliveryIds.add(id);
    };
    const custody = () => actorDeliveryIds.size > 0
      ? { actorDeliveryIds: [...actorDeliveryIds] }
      : {};
    const mirroredOps = () => runId && c.scriptRuns && 'opsFor' in c.scriptRuns
      ? /** @type {{ opsFor: (id: string) => Array<any> }} */ (/** @type {unknown} */ (c.scriptRuns)).opsFor(runId)
      : [];
    /** @type {(() => void) | undefined} */
    let onAbort;
    try {
      /** @type {{ timeoutMs: number, toolbox: boolean, actors?: boolean, ownerSessionId?: string, ownerToolUseId?: string, runId?: string, workspaceSessionId?: string, caps?: { provider?: boolean, subagent?: boolean }, signal?: AbortSignal }} */
      // toolbox: the script lane resolves peerd:toolbox modules (design 06) —
      // a trusted job param, not a worker choice; the other headless lanes
      // (a2a/site-client/page_code) never set it.
      // `script` is compute/orchestration, never a hidden second actor_create.
      // The default worker also supports embedded artifacts that call
      // peerd.runtime.runAgent, but here that would bypass the session manifest
      // and the caller's narrowed grant. Explicit actor_create remains the only
      // subtask authority; Notebook/App runtimes keep their separate profile.
      const opts = { timeoutMs, toolbox: true, caps: { subagent: false }, signal: c.abortSignal };
      // The durable workspace mount — the SESSION id rides as a TRUSTED job
      // param (invariant: the worker never names its own root; the SW-side tool
      // is the only place the owning session is resolved).
      if (workspaceOn) opts.workspaceSessionId = sid;
      if (sid && c.scriptRuns) {
        runId = c.scriptRuns.mintRunId(sid);
        // Stop plumbing: register the run under the dispatch abort signal so a
        // Stop (a) aborts every pending actors.call AND in-flight sub-model
        // fetches (both race the run's signal SW-side) and (b) terminates the
        // worker instead of letting compute, egress, or workspace writes run to
        // their cap. Every session-owned lane registers; the capability flags
        // still decide what its run id may redeem at a relay. The owner binds
        // the runId to this session for those checks.
        c.scriptRuns.register(runId, c.abortSignal, sid, {
          actors: actorsOn,
          provider: providerOn,
          egress: true,
        });
        if (c.abortSignal && jsOffscreenClient.abortHeadless) {
          const rid = runId;
          onAbort = () => { jsOffscreenClient.abortHeadless?.(rid, sid); };
          if (c.abortSignal.aborted) onAbort();
          else c.abortSignal.addEventListener('abort', onAbort, { once: true });
        }
        // Every registered run can redeem the egress capability, so the owner
        // stamp must ride every job — not only jobs whose source also mentions
        // actors/provider. The offscreen relay cannot infer this trusted value,
        // and the SW route correctly refuses an ownerless run.
        Object.assign(opts, { runId, ownerSessionId: sid });
        if (actorsOn) Object.assign(opts, { actors: true, ownerToolUseId: c.toolUseId });
        // The caps flag rides as a trusted job param; the job-runner relay and
        // the SW route both refuse without it (two walls + the quota).
        // ownerSessionId above binds the run to this session for every relay;
        // this branch only adds the provider-specific capability bit.
        if (providerOn) Object.assign(opts, {
          caps: { ...(opts.caps ?? {}), provider: true },
        });
      }
      const result = await jsOffscreenClient.execHeadless(args.code, opts);
      addActorDeliveryIds(result.actorDeliveryIds);
      addActorDeliveryIds(mirroredOps().map((op) => op?.actorDeliveryId));
      const importPolicyMessage = moduleImportPolicyMessage(result.errorCode);
      if (importPolicyMessage) {
        return {
          ok: false,
          error: `${result.errorCode}: ${importPolicyMessage}`,
          ...custody(),
        };
      }
      // Value spill (run cache): when the serialized [VALUE] overflows its cap,
      // store the FULL text keyed by this run/tool-use, stamped with the owning
      // session and the run's FENCE state — read_run_cache re-applies exactly
      // that fencing when paging it back. Best-effort: a failed spill leaves
      // the truncation note alone (today's behavior).
      /** @type {{ key: string, total: number } | undefined} */
      let valueSpill;
      const sv = serializeValue(result.value);
      if (sv?.truncated && c.runCache?.put && sid && (runId || c.toolUseId)) {
        const key = `run:${runId ?? c.toolUseId}`;
        try {
          await c.runCache.put({
            key, ownerSessionId: sid,
            fenced: runIsFenced(result), originLabel: runOriginLabel(result),
            text: sv.text,
          });
          // The store caps what it keeps (run-cache.js MAX_SPILL_TEXT_CHARS) —
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
      if (oncePerSession(sid, 'js-pitfalls')) {
        content += `\n\n${JS_PITFALLS_NOTE}\n\n${SCRIPT_BUILTINS_NOTE}`;
      }
      return { ok: true, content, ...custody() };
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      // The offscreen heap died mid-run (doc evicted / channel death) — the
      // worker-held trace died with it, but the SW-side mirror survived:
      // report which delegations were already dispatched so the orchestrator
      // doesn't blind-re-send goals actors may have already acted on.
      const mirrored = mirroredOps();
      addActorDeliveryIds(mirrored.map((op) => op?.actorDeliveryId));
      const dispatched = mirrored.length
        ? `\n[DELEGATIONS dispatched before the failure]\n${renderTraceLines(mirrored).join('\n')}`
        : '';
      if (actorsOn) {
        // The thrown bridge error can repeat a runtime-derived target or actor
        // reply. Keep only a host-authored failure class and the redacted trace
        // outside the fence; all thrown text and dynamic trace details stay in it.
        const errorName = String(err?.name ?? 'Error').slice(0, 80);
        const errorMessage = String(err?.message ?? e).slice(0, ACTORS_TRACE_ERROR_MAX_CHARS);
        const unsafeDetails = [
          '[TRANSPORT ERROR]', `${errorName}: ${errorMessage}`,
          ...traceGoalLines(mirrored), ...traceErrorDetails(mirrored),
        ];
        const fenced = wrapUntrusted({
          origin: 'script (actor replies)', tool: 'script', body: unsafeDetails.join('\n'),
        });
        return {
          ok: false,
          error: `script_failed: actor orchestration transport failed${dispatched}\n${fenced}`,
          ...custody(),
        };
      }
      return {
        ok: false,
        error: `script_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}`,
        ...custody(),
      };
    } finally {
      // Release ABORTS first (script-runs.js): any ask still pending SW-side
      // is an orphan whose actor turn dies with the run — the non-Stop exits
      // (job timeout, worker crash, throw) reach here without the Stop signal
      // ever firing, and this is what unwinds them.
      if (runId && c.scriptRuns) c.scriptRuns.release(runId);
      if (onAbort && c.abortSignal) {
        try { c.abortSignal.removeEventListener?.('abort', onAbort); } catch { /* stub signal */ }
      }
    }
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
 * `valueSpill` (script-only) names an already-stored run-cache record; its
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
      `Read more with read_run_cache { "key": "${valueSpill.key}", "offset": <char offset>, "limit": <chars, max ${RUN_CACHE_SLICE_CHARS}> } — but prefer re-running with a more compact return value.`,
    ].join('\n'));
  }
  return lines.join('\n');
};
