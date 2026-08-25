// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// a2a_run — the dweb actor's CODE surface for agent-to-agent over the mesh.
//
// The #119 lesson applied to p2p: the model talks to other agents by WRITING JS
// against a `mesh` client, not by firing one gated tool per message. The code
// runs in the SAME sealed headless worker as script (realm seal, no key, no
// chrome.*), with ONE extra capability — the `mesh` bridge — so a mesh call
// leaves the sealed realm as an a2a-request the host relays to the SW a2a/call
// route (consent + audited mesh op). dweb-only + dweb-flagged: the main agent
// never holds it (mesh work is message_actor("dweb", …)); the store build prunes
// it. Owner = THIS dweb-actor session, attached to every relay from trusted job
// params so the worker can't spoof which identity it acts as.
//
// The mesh client the code drives (see worker-source.js a2a bridge):
//   await mesh.peers()                     // [{ did, name }] — who's present
//   await mesh.card(did)                   // a peer's Agent Card, or null
//   await mesh.call(did, "…", { timeoutMs })// send + await ONE reply (needs consent)
//   await mesh.cast(did, "…")              // fire-and-forget (needs consent)
//   await mesh.publishCard({ name, … })    // advertise MY card (needs consent)
//   await mesh.inbox()                     // drain DMs received during this run
//   await mesh.converse(did, "…", {timeoutMs}) // open a STANDING conversation:
//                                          // like ask, but returns { convId } so a
//                                          // LATER peer message continues the thread
//   await mesh.say(convId, "…", {timeoutMs})   // send the next turn on a convId

import { clamp } from '/shared/util.js';
import { pushValueBlock } from './value-block.js';
import { wrapUntrusted } from '../prompt-wrap.js';
import { renderCodeOpTrace } from '../../actor/capability-manifest.js';

// why 135s: the job wall-clock is the OUTERMOST timer above the SW call cap
// (a2a-api.js). The generated mesh bridge now shares this outer deadline, so a
// local bridge timeout can never orphan a consent/signing operation.
const DEFAULT_TIMEOUT_MS = 135_000;
const MAX_TIMEOUT_MS = 180_000;

/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'dweb', dweb: boolean, execute: (args: any, ctx: ToolContext) => Promise<import('/shared/tool-types.js').ToolResult | { ok: false, error: string }> }} DwebTool */

/** @type {DwebTool} */
export const a2aRunTool = composeTool("a2a_run", {

  execute: async (args, ctx) => {
    if (typeof args?.code !== 'string' || !args.code.trim()) return { ok: false, error: 'code_required' };
    const c = /** @type {{ jsOffscreenClient?: { execHeadless?: (code: string, opts: object) => Promise<any>, abortHeadless?: (runId: string, ownerSessionId?: string) => Promise<void> }, scriptRuns?: { mintRunId: (owner: string) => string, register: (runId: string, signal: any, owner: string, caps: Record<string, boolean>) => void, release: (runId: string) => void }, abortSignal?: { aborted: boolean, addEventListener: Function, removeEventListener?: Function } }} */ (
      /** @type {unknown} */ (ctx));
    const jsOffscreenClient = c.jsOffscreenClient;
    if (!jsOffscreenClient?.execHeadless) return { ok: false, error: 'a2a_unavailable' };
    const ownerSessionId = ctx.session?.sessionId;
    if (!ownerSessionId) return { ok: false, error: 'a2a: no owner session' };
    if (!c.scriptRuns) return { ok: false, error: 'a2a_run_registry_unavailable' };
    // A turn that is ALREADY stopped must not launch a worker at all — the
    // 'abort' event never re-fires on an aborted signal, so a run started now
    // would hold a shared headless slot for its full 135s wall-clock (#153).
    if (c.abortSignal?.aborted) {
      return { ok: false, error: 'a2a_aborted: the turn was stopped before the run started' };
    }
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    // Stop plumbing (#153, mirrors the script tool): a runId-carrying job is
    // registered by the offscreen runner, so aborting the dweb-actor turn
    // terminates the worker promptly instead of orphaning it to its timeout.
    const runId = c.scriptRuns.mintRunId(ownerSessionId);
    c.scriptRuns.register(runId, c.abortSignal, ownerSessionId, { a2a: true });
    /** @type {(() => void) | undefined} */
    let onAbort;
    if (c.abortSignal && jsOffscreenClient.abortHeadless) {
      onAbort = () => { jsOffscreenClient.abortHeadless?.(runId, ownerSessionId); };
      if (c.abortSignal.aborted) onAbort();
      else c.abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const result = await jsOffscreenClient.execHeadless(args.code, {
        timeoutMs, a2a: true, ownerSessionId, runId, signal: c.abortSignal,
      });
      return { ok: true, content: formatA2AResult(args.code, result) };
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: `a2a_run_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    } finally {
      c.scriptRuns.release(runId);
      if (onAbort && c.abortSignal) {
        try { c.abortSignal.removeEventListener?.('abort', onAbort); } catch { /* stub signal in tests */ }
      }
    }
  },
});

/**
 * The run's output carries PEER-supplied bytes (replies, cards) — always fence
 * it (unlike script, which fences only egress runs). A mesh run is untrusted by
 * construction: every value came from another agent.
 * @param {string} code @param {{ value?: unknown, consoleOutput?: {level:string,text:string}[], durationMs?: number, error?: string|null, codeTrace?: Array<{seq:number,bridge:string,method:string,outcome:string,ms:number}> }} r
 */
const formatA2AResult = (code, r) => {
  const lines = [];
  const oneLineCode = code.length > 200 ? `${code.slice(0, 200)}…` : code;
  lines.push(`> ${oneLineCode.replace(/\n/g, '\n  ')} (mesh)`);
  lines.push(`[${r.durationMs ?? 0}ms]`);
  if (r.codeTrace?.length) lines.push('[CODE OPS]', ...renderCodeOpTrace(r.codeTrace));
  const body = [];
  if (r.error) body.push('[ERROR]', r.error);
  if (r.consoleOutput && r.consoleOutput.length) {
    body.push('[CONSOLE]');
    for (const { level, text } of r.consoleOutput) body.push(`  ${level === 'info' ? '' : `[${level}] `}${text}`);
  }
  pushValueBlock(body, r.value);
  lines.push(wrapUntrusted({ origin: 'mesh (peer agents)', tool: 'a2a_run', body: body.join('\n') }));
  return lines.join('\n');
};
