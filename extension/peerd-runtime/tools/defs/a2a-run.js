// @ts-check
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
//   await mesh.ask(did, "…", { timeoutMs })// send + await ONE reply (needs consent)
//   await mesh.send(did, "…")              // fire-and-forget (needs consent)
//   await mesh.publishCard({ name, … })    // advertise MY card (needs consent)
//   await mesh.inbox()                     // drain DMs received during this run

import { clamp } from '/shared/util.js';
import { pushValueBlock } from './value-block.js';
import { wrapUntrusted } from '../prompt-wrap.js';

// why 135s: the job wall-clock is the OUTERMOST timer — it must sit ABOVE the
// worker's mesh guard (worker-source.js, 130s) which sits above the SW ask cap
// (a2a-api.js, 120s). If the job timer were smaller (it was 60s) it would fire
// first and terminate the worker mid-ask, truncating a valid peer reply and
// mis-reporting it as a job timeout. Keep the nesting job > worker > ask.
const DEFAULT_TIMEOUT_MS = 135_000;
const MAX_TIMEOUT_MS = 180_000;

/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {Omit<Tool, 'primitive' | 'execute'> & { primitive: 'dweb', dweb: boolean, execute: (args: any, ctx: ToolContext) => Promise<import('/shared/tool-types.js').ToolResult | { ok: false, error: string }> }} DwebTool */

/** @type {DwebTool} */
export const a2aRunTool = {
  name: 'a2a_run',
  primitive: 'dweb',
  dweb: true,
  description: [
    'Talk to OTHER agents on the mesh by writing JS against the `mesh` client',
    '(agent-to-agent). Runs in a sealed worker — async body, top-level await +',
    '`return`. mesh.peers() lists who is present; mesh.card(did) fetches a peer\'s',
    'Agent Card (its advertised skills); mesh.ask(did, message, {timeoutMs}) sends',
    'a request and RETURNS the peer\'s one reply (or {timedOut:true}); mesh.send(',
    'did, message) is fire-and-forget; mesh.publishCard({name, description, skills})',
    'advertises YOUR agent so peers can discover you; mesh.inbox() drains messages',
    'received during this run. FIRST contact to a peer needs the user\'s ok (a',
    'signing call is refused until approved). Write ONE script that does the whole',
    'exchange and RETURN the outcome — do not fire one message per turn.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JS to run; drives the `mesh` client and returns the outcome.' },
      timeoutMs: { type: 'number', description: `Wall-clock cap (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
    },
    required: ['code'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.code !== 'string' || !args.code.trim()) return { ok: false, error: 'code_required' };
    const jsOffscreenClient = /** @type {{ execHeadless?: (code: string, opts: object) => Promise<any> } | undefined} */ (
      /** @type {any} */ (ctx).jsOffscreenClient);
    if (!jsOffscreenClient?.execHeadless) return { ok: false, error: 'a2a_unavailable' };
    const ownerSessionId = ctx.session?.sessionId;
    if (!ownerSessionId) return { ok: false, error: 'a2a: no owner session' };
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    try {
      const result = await jsOffscreenClient.execHeadless(args.code, { timeoutMs, a2a: true, ownerSessionId });
      return { ok: true, content: formatA2AResult(args.code, result) };
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: `a2a_run_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    }
  },
};

/**
 * The run's output carries PEER-supplied bytes (replies, cards) — always fence
 * it (unlike script, which fences only egress runs). A mesh run is untrusted by
 * construction: every value came from another agent.
 * @param {string} code @param {{ value?: unknown, consoleOutput?: {level:string,text:string}[], durationMs?: number, error?: string|null }} r
 */
const formatA2AResult = (code, r) => {
  const lines = [];
  const oneLineCode = code.length > 200 ? `${code.slice(0, 200)}…` : code;
  lines.push(`> ${oneLineCode.replace(/\n/g, '\n  ')} (mesh)`);
  lines.push(`[${r.durationMs ?? 0}ms]`);
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
