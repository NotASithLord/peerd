// @ts-check
// js_notebook — run JS in a Notebook.
//
// Code runs in the worker's JS realm as an `async () => { code }`
// body, so top-level `await` and `return` both work. Each call spawns a
// FRESH worker that's terminated when the eval settles (runEval in
// notebook-tab.js), so in-memory bindings — globalThis, peerd.*, anything
// `let`/`const` — do NOT carry to the next call. The DURABLE state is the
// Notebook's OPFS scratch: write with peerd.self.writeFile and read it
// back next call.

import { clamp } from '/shared/util.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * @typedef {Object} EvalResult
 * @property {number} durationMs
 * @property {string} [error]
 * @property {Array<{ level: string, text: string }>} [consoleOutput]
 * @property {unknown} [value]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const jsNotebookTool = {
  name: 'js_notebook',
  primitive: 'notebook',
  description: [
    'Run JS in a Notebook — a VISIBLE tab the user watches (CodeMirror editor +',
    'output pane + file tree), backed by a Web Worker + OPFS. Opens/focuses that',
    'tab. For a quick result with NO tab (headless, ephemeral), use js_run',
    'instead. The code is an async function body — top-level await works and',
    '`return <value>` sends the result back. ✅ parsing, transforms, numeric work,',
    'exercising a library. ❌ DOM (no document/window — use app_create) or',
    'npm/native modules. EACH CALL IS A FRESH WORKER — module state does NOT',
    'persist; write to OPFS via peerd.self.writeFile and read it back. Inside:',
    'peerd.egress.fetch (audited HTTP), peerd.self.readFile/writeFile/listFiles;',
    'relative static + dynamic imports work. No `notebook` arg → the chat\'s',
    'current Notebook. Returns the return value, console output, and any error.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'JS code to evaluate. Async function body.',
      },
      notebook: {
        type: 'string',
        description: 'Optional. Notebook id or name to target.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Wall-clock cap in ms (default 30000, max 120000).',
      },
    },
    required: ['code'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.code !== 'string' || args.code.length === 0) {
      return { ok: false, error: 'code_required' };
    }
    // why: jsClient / jsRegistry ride the opaque ctx contract (not on the
    // ToolContext typedef); narrow to the surface this tool touches.
    const jsClient = /** @type {{ eval?: (code: string, opts: { timeoutMs: number, sessionId?: string, notebookId?: string }) => Promise<EvalResult> } | undefined} */ (
      /** @type {any} */ (ctx).jsClient);
    const jsRegistry = /** @type {{ get: (id: string) => Promise<unknown>, list: () => Promise<Array<{ id: string, name: string }>>, setDefaultForSession: (sessionId: string, id: string) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).jsRegistry);
    if (!jsClient || typeof jsClient.eval !== 'function') {
      return { ok: false, error: 'js_not_available' };
    }
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);

    let targetNotebookId;
    if (typeof args.notebook === 'string' && args.notebook.trim().length > 0) {
      const want = args.notebook.trim();
      if (!jsRegistry) return { ok: false, error: 'js_registry_unavailable' };
      if (want.startsWith('notebook-')) {
        const rec = await jsRegistry.get(want);
        if (!rec) return { ok: false, error: `notebook_not_found: ${want}` };
        targetNotebookId = want;
      } else {
        const all = await jsRegistry.list();
        const lower = want.toLowerCase();
        const found = all.find((s) => s.name.toLowerCase() === lower);
        if (!found) return { ok: false, error: `notebook_not_found: ${want}` };
        targetNotebookId = found.id;
      }
      if (ctx.session?.sessionId) {
        try { await jsRegistry.setDefaultForSession(ctx.session.sessionId, targetNotebookId); }
        catch (e) { console.debug('[js_notebook] MRU bump failed', e); }
      }
    }
    try {
      const result = await jsClient.eval(args.code, {
        timeoutMs,
        sessionId: ctx.session?.sessionId,
        notebookId: targetNotebookId,
      });
      return { ok: true, content: formatEvalResult(args.code, result) };
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: `js_notebook_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    }
  },
};

/**
 * @param {string} code
 * @param {EvalResult} r
 * @returns {string}
 */
const formatEvalResult = (code, r) => {
  const lines = [];
  const oneLineCode = code.length > 200 ? `${code.slice(0, 200)}…` : code;
  lines.push(`> ${oneLineCode.replace(/\n/g, '\n  ')}`);
  lines.push(`[${r.durationMs}ms]`);
  if (r.error) lines.push('[ERROR]', r.error);
  if (r.consoleOutput && r.consoleOutput.length) {
    lines.push('[CONSOLE]');
    for (const { level, text } of r.consoleOutput) {
      lines.push(`  ${level === 'info' ? '' : `[${level}] `}${text}`);
    }
  }
  if (r.value !== undefined) {
    lines.push('[VALUE]');
    try { lines.push(JSON.stringify(r.value, null, 2)); }
    catch { lines.push(String(r.value)); }
  }
  return lines.join('\n');
};
