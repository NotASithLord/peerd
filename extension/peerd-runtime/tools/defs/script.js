// @ts-check
// script — run JS HEADLESS (no tab).
//
// The headless sibling of js_notebook (DECISIONS #25, "runJob"): the SAME sealed
// worker (realm seal + peerd.* surface), hosted in the offscreen document with
// NO UI. The cheap, invisible path for the agent's OWN quick compute — math, a
// transform, or CODE MODE (orchestrate fetches/compute in one script, return the
// result) — when the user needn't watch a tab. EACH CALL is a FRESH worker with
// an EPHEMERAL OPFS scratch that is nuked after; for durable files or a visible
// editor/output, use a Notebook (sandbox_create kind:'notebook' / js_notebook). Own-code threat model — NOT
// for untrusted code (that needs an opaque-origin iframe, DESIGN.md §8.5).

import { clamp } from '/shared/util.js';
import { JS_PITFALLS_NOTE } from './code-style-note.js';
import { pushValueBlock } from './value-block.js';
import { wrapUntrusted } from '../prompt-wrap.js';
import { renderTraceLines, traceErrorDetails } from '../../subagent/actors-api.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
// An actors-enabled run awaits real ACTOR TURNS, so its wall-clock sits ABOVE
// the worker's actors-bridge guard (250s, worker-source.js) which sits above
// the per-ask cap (240s, actors-api.js) — the same job > bridge > ask nesting
// a2a-run.js documents; a smaller job timer would kill the worker mid-ask and
// mis-report a live delegation as a job timeout.
const ACTORS_DEFAULT_TIMEOUT_MS = 270_000;
const ACTORS_MAX_TIMEOUT_MS = 300_000;

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
    'Run JS HEADLESS — a fast sealed Web Worker with NO tab (the cheap, invisible',
    'sibling of js_notebook). Use when you just need a RESULT and the user need not',
    'watch: math, parsing/transforms, or CODE MODE — orchestrate many audited',
    'fetches/compute in one script and RETURN the result instead of many separate',
    'tool calls. Async function body — top-level await + `return <value>` work.',
    'Inside: peerd.egress.fetch(url, { method, headers, body }) (audited HTTP),',
    'the peerd:std math/data helpers (import { mean, stdev, quantile, sum, groupBy,',
    'countBy, range, chunk, gcd, divmod, parseJsonl, toJsonl, dedupeBy } from',
    '\'peerd:std\' — same stdlib as a Notebook; parseJsonl/toJsonl/dedupeBy round-trip',
    'and idempotently merge JSONL record files; table/chart are display-only, so',
    'they need a Notebook to render).',
    'ORCHESTRATION: the `actors` client (when present) drives your OWN actors in',
    'code — await actors.ask(to, goal, {timeoutMs, oneShot}) delegates a goal and',
    'returns { reply, failed }; actors.send(to, goal) hands off without waiting',
    '(the reply lands in chat later); await actors.list() is the roster. Use it',
    'for FAN-OUT and PLUMBING: ask several actors in one script, pass one\'s',
    'output to the next as a variable (intermediate bytes never transit your',
    'context), retry/timeout in code. `to` is anything message_actor accepts;',
    'a failed ask returns failed:true (actor-level) or throws (a refusal or',
    'timeout — the message says why). Every delegation is individually gated +',
    'audited exactly like message_actor, and shows live in the chat.',
    'This is YOUR scratch compute; delegate subtasks with the spawn_subagent tool.',
    'EACH CALL is a',
    'FRESH worker with an EPHEMERAL OPFS',
    'scratch (nuked after) — for durable files or a visible editor/output use a',
    'Notebook (sandbox_create kind:"notebook"). Returns the return value, console',
    'output, any error, and a [DELEGATIONS] trace of every actors op.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JS code to evaluate. Async function body.' },
      timeoutMs: { type: 'integer', description: 'Wall-clock cap in ms (default 30000, max 120000; an actors-delegating run defaults to 270000, max 300000).' },
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
    const c = /** @type {{ jsOffscreenClient?: { execHeadless?: (code: string, opts: object) => Promise<RunResult>, abortHeadless?: (runId: string) => Promise<void> }, scriptRuns?: { mintRunId: (sid: string) => string, register: (runId: string, signal?: any) => void, abort: (runId: string) => void, release: (runId: string) => void }, messageActor?: unknown, abortSignal?: { aborted: boolean, addEventListener: Function, removeEventListener?: Function }, toolUseId?: string }} */ (
      /** @type {unknown} */ (ctx));
    const jsOffscreenClient = c.jsOffscreenClient;
    if (!jsOffscreenClient || typeof jsOffscreenClient.execHeadless !== 'function') {
      return { ok: false, error: 'headless_js_unavailable' };
    }
    const sid = ctx.session?.sessionId ?? '';
    // The actors surface is minted ONLY where delegation is already legal:
    // the ctx carries the messageActor capability (a chat's main turn — an
    // actor's keyless narrowing strips it, a narrowed child without the
    // message_actor grant loses the closure) AND the run registry is wired.
    // The SW actors/call route re-verifies the owner per op regardless.
    const actorsOn = typeof c.messageActor === 'function' && !!c.scriptRuns && !!sid;
    const timeoutMs = actorsOn
      ? clamp(args.timeoutMs ?? ACTORS_DEFAULT_TIMEOUT_MS, 1000, ACTORS_MAX_TIMEOUT_MS)
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
      return { ok: false, error: `script_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    } finally {
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
  const opErrors = traceErrorDetails(trace);
  if (opErrors.length) {
    // Failed-op DETAILS can carry actor/web-derived bytes → fenced body only.
    body.push('[DELEGATION ERRORS]', ...opErrors);
  }
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
