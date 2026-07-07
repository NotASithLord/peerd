// @ts-check
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
import { JS_PITFALLS_NOTE } from './code-style-note.js';
import { pushValueBlock } from './value-block.js';
import { wrapUntrusted } from '../prompt-wrap.js';
import {
  renderTraceLines, traceGoalLines, traceErrorDetails,
  ACTORS_JOB_DEFAULT_TIMEOUT_MS, ACTORS_JOB_MAX_TIMEOUT_MS,
} from '../../actor/actors-api.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
// A DELEGATING run awaits real actor turns, so its wall-clock comes from the
// timeout TOWER in actors-api.js (job > bridge guard > per-ask cap, all
// derived from one ceiling) — never a literal here that could drift below the
// bridge and kill the worker mid-ask.

// why once per session: script is the agent's OWN quick-compute path (the
// precision / off-by-one class of bug lands here, e.g. large-integer math), so
// the correctness note matters most here — but script is called repeatedly, so
// we disclose it on the FIRST run and stay silent after, paying the tokens once.
// Bounded by distinct sessions in one SW lifetime (tiny); an SW restart re-arms.
/** @type {Set<string>} */
const pitfallsDisclosed = new Set();

/**
 * @typedef {Object} RunResult
 * @property {number} durationMs
 * @property {string} [error]
 * @property {Array<{ level: string, text: string }>} [consoleOutput]
 * @property {unknown} [value]
 * @property {boolean} [usedEgress]   the run called peerd.egress.fetch (job-runner)
 * @property {boolean} [usedActors]   the run delegated via the actors client
 * @property {Array<{ seq: number, method: string, to?: string, goal?: string, ok: boolean, ms: number, error?: string }>} [actorsTrace]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const scriptTool = {
  name: 'script',
  primitive: 'notebook',
  description: [
    'Run JS HEADLESS — a fast sealed Web Worker, no tab. Async function body',
    '(top-level await + `return <value>`); each call is a FRESH worker with an',
    'EPHEMERAL OPFS scratch (for durable files or a visible editor use a',
    'Notebook). Use it for: (1) QUICK COMPUTE — math, parsing, transforms;',
    '(2) CODE MODE — orchestrate many audited peerd.egress.fetch(url, { method,',
    'headers, body }) calls + compute in one script and return just the result;',
    '(3) ORCHESTRATION — the `actors` client drives your OWN actors in code:',
    'await actors.ask(to, goal, {timeoutMs, oneShot}) delegates and returns',
    '{ reply, failed }; actors.send(to, goal) hands off without waiting (the',
    'reply lands in chat later); await actors.list() is the roster. Fan out to',
    'several actors, feed one\'s output to the next as a variable, retry/timeout',
    'in code. `to` is anything message_actor accepts; a failed ask returns',
    'failed:true (actor-level) or throws (refusal/timeout — the message says',
    'why); every delegation is individually gated + audited and shows live in',
    'chat. (Delegate ENVIRONMENT work to actors; actor_create stays the tool',
    'for a pure reasoning/research subtask.) peerd:std ships the math/data',
    'helpers (import { mean, stdev, quantile, sum, groupBy, countBy, range,',
    'chunk, parseJsonl, toJsonl, dedupeBy } from \'peerd:std\'; table/chart need',
    'a Notebook to render). peerd:wasi runs a compiled wasm32-wasi BINARY over',
    'an in-memory FS — import { runWasi } from \'peerd:wasi\'; await',
    'runWasi(bytes, { args, env, stdin, files }) → { exitCode, stdout, stderr,',
    'files } (bytes from peerd.egress.fetch(url).bytes; the module gets NO',
    'network and sees ONLY the files you pass). Returns the value, console',
    'output, any error, and a [DELEGATIONS] trace of every actors op.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JS code to evaluate. Async function body.' },
      timeoutMs: { type: 'integer', description: 'Wall-clock cap in ms (default 30000, max 120000 for compute; a run whose code uses `actors` gets a higher delegation-sized default/max automatically).' },
    },
    required: ['code'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.code !== 'string' || args.code.length === 0) {
      return { ok: false, error: 'code_required' };
    }
    // why: jsOffscreenClient/scriptRuns/messageActor ride the opaque ctx
    // contract (not on ToolContext); narrow to what this tool touches.
    const c = /** @type {{ jsOffscreenClient?: { execHeadless?: (code: string, opts: object) => Promise<RunResult>, abortHeadless?: (runId: string) => Promise<void> }, scriptRuns?: { mintRunId: (sid: string) => string, register: (runId: string, signal?: any) => void, abort: (runId: string) => void, release: (runId: string) => void, opsFor?: (runId: string) => Array<any> }, messageActor?: unknown, abortSignal?: { aborted: boolean, addEventListener: Function, removeEventListener?: Function }, toolUseId?: string }} */ (
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
    //   • the SESSION is a top-level chat (the actors/call route refuses
    //     actor/actor owners — minting the stub for them would advertise a
    //     surface every op then refuses);
    //   • the CODE references `actors` at all (any use requires the
    //     identifier, aliasing included) — a pure-compute script must keep the
    //     30s compute wall-clock, not inherit the ~5-minute delegation one.
    // The SW actors/call route re-verifies the owner per op regardless.
    const sessionKind = /** @type {{ kind?: string } | undefined} */ (ctx.session)?.kind;
    const actorsOn = typeof c.messageActor === 'function' && !!c.scriptRuns && !!sid
      && sessionKind !== 'spawned' && sessionKind !== 'actor'
      && /\bactors\b/.test(args.code);
    // A turn that is ALREADY stopped must not launch a worker at all — the
    // 'abort' event will never re-fire on an aborted signal, so a run started
    // now would be unkillable until its wall-clock.
    if (c.abortSignal?.aborted) {
      return { ok: false, error: 'script_aborted: the turn was stopped before the run started' };
    }
    const timeoutMs = actorsOn
      ? clamp(args.timeoutMs ?? ACTORS_JOB_DEFAULT_TIMEOUT_MS, 1000, ACTORS_JOB_MAX_TIMEOUT_MS)
      : clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    /** @type {string | undefined} */
    let runId;
    /** @type {(() => void) | undefined} */
    let onAbort;
    try {
      /** @type {{ timeoutMs: number, actors?: boolean, ownerSessionId?: string, ownerToolUseId?: string, runId?: string }} */
      const opts = { timeoutMs };
      if (actorsOn && c.scriptRuns) {
        runId = c.scriptRuns.mintRunId(sid);
        // Stop plumbing: register the run under the dispatch abort signal so a
        // Stop (a) aborts every pending actors.ask (freeing the actor turns)
        // and (b) terminates the worker instead of letting it run to its cap.
        c.scriptRuns.register(runId, c.abortSignal);
        if (c.abortSignal && jsOffscreenClient.abortHeadless) {
          const rid = runId;
          onAbort = () => { jsOffscreenClient.abortHeadless?.(rid); };
          if (c.abortSignal.aborted) onAbort();
          else c.abortSignal.addEventListener('abort', onAbort, { once: true });
        }
        Object.assign(opts, { actors: true, ownerSessionId: sid, ownerToolUseId: c.toolUseId, runId });
      }
      const result = await jsOffscreenClient.execHeadless(args.code, opts);
      let content = formatRunResult(args.code, result);
      if (!pitfallsDisclosed.has(sid)) {
        pitfallsDisclosed.add(sid);
        content += `\n\n${JS_PITFALLS_NOTE}`;
      }
      return { ok: true, content };
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      // The offscreen heap died mid-run (doc evicted / channel death) — the
      // worker-held trace died with it, but the SW-side mirror survived:
      // report which delegations were already dispatched so the orchestrator
      // doesn't blind-re-send goals actors may have already acted on.
      const mirrored = runId && c.scriptRuns && 'opsFor' in c.scriptRuns
        ? /** @type {{ opsFor: (id: string) => Array<any> }} */ (/** @type {unknown} */ (c.scriptRuns)).opsFor(runId)
        : [];
      const dispatched = mirrored.length
        ? `\n[DELEGATIONS dispatched before the failure]\n${renderTraceLines(mirrored).join('\n')}`
        : '';
      return { ok: false, error: `script_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}${dispatched}` };
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
};

/**
 * @param {string} code
 * @param {RunResult} r
 * @returns {string}
 */
const formatRunResult = (code, r) => {
  const lines = [];
  const oneLineCode = code.length > 200 ? `${code.slice(0, 200)}…` : code;
  lines.push(`> ${oneLineCode.replace(/\n/g, '\n  ')} (headless)`);
  lines.push(`[${r.durationMs}ms]`);
  // The DELEGATIONS trace — fence-SAFE by construction (host-recorded method/
  // target/outcome/timing + the model's own goal previews; never actor bytes).
  // It sits OUTSIDE the fence on purpose: this is the chain-of-events the
  // orchestrator debugs from even when the script failed mid-fan.
  const trace = Array.isArray(r.actorsTrace) ? r.actorsTrace : [];
  if (trace.length) {
    lines.push('[DELEGATIONS]');
    lines.push(...renderTraceLines(trace));
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
  pushValueBlock(body, r.value);
  // Own-code threat model: a pure-compute run's output is the agent's own and
  // stays raw. But a run that touched the web (peerd.egress.fetch) OR delegated
  // to actors can carry untrusted bytes (fetched content / actor replies) in
  // its value/console/error — fence THOSE runs so foreign content can't launder
  // into the caller's trusted context through scratch compute.
  if ((r.usedEgress || r.usedActors) && body.length) {
    const origin = r.usedActors && r.usedEgress ? 'script (fetched web content + actor replies)'
      : r.usedActors ? 'script (actor replies)' : 'script (fetched web content)';
    lines.push(wrapUntrusted({ origin, tool: 'script', body: body.join('\n') }));
  } else {
    lines.push(...body);
  }
  return lines.join('\n');
};
