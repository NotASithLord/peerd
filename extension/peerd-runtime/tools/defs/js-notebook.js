// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
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
import {
  moduleImportPolicyMessage,
  REMOTE_MODULE_CAPABILITY_BLOCKED_MESSAGE,
  REMOTE_MODULE_RESTRICTED_CODE,
} from '/peerd-engine/errors.js';
import { wrapUntrusted } from '../prompt-wrap.js';
import { pushValueBlock } from './value-block.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * @typedef {Object} EvalResult
 * @property {number} durationMs
 * @property {string} [error]
 * @property {string} [errorCode]
 * @property {Array<{ level: string, text: string }>} [consoleOutput]
 * @property {unknown} [value]
 * @property {boolean} [usedRemoteModules]
 * @property {boolean} [stopped]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const jsNotebookTool = composeTool("js_notebook", {

  execute: async (args, ctx) => {
    if (typeof args?.code !== 'string' || args.code.length === 0) {
      return { ok: false, error: 'code_required' };
    }
    const authority = /** @type {{ readNotebook?: (id:string)=>Promise<unknown>, listNotebooks?: ()=>Promise<Array<{id:string,name:string}>>, setDefaultNotebook?: (id:string)=>Promise<unknown>, runNotebook?: (code:string,timeoutMs:number,notebookId?:string)=>Promise<EvalResult> }} */ (
      /** @type {any} */ (ctx).notebookAuthority);
    if (!authority?.runNotebook) return { ok: false, error: 'js_not_available' };
    if (ctx.abortSignal?.aborted) {
      return { ok: true, content: '[STOPPED] Notebook run was stopped. Do not retry automatically.' };
    }
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);

    let targetNotebookId;
    if (typeof args.notebook === 'string' && args.notebook.trim().length > 0) {
      const want = args.notebook.trim();
      if (!authority.readNotebook || !authority.listNotebooks || !authority.setDefaultNotebook) {
        return { ok: false, error: 'js_registry_unavailable' };
      }
      if (want.startsWith('notebook-')) {
        const rec = await authority.readNotebook(want);
        if (!rec) return { ok: false, error: `notebook_not_found: ${want}` };
        targetNotebookId = want;
      } else {
        const all = await authority.listNotebooks();
        const lower = want.toLowerCase();
        const found = all.find((s) => s.name.toLowerCase() === lower);
        if (!found) return { ok: false, error: `notebook_not_found: ${want}` };
        targetNotebookId = found.id;
      }
      try { await authority.setDefaultNotebook(targetNotebookId); }
      catch (e) { console.debug('[js_notebook] MRU bump failed', e); }
    }
    try {
      const result = await authority.runNotebook(args.code, timeoutMs, targetNotebookId);
      if (result.stopped) {
        return { ok: true, content: '[STOPPED] Notebook run was stopped. Do not retry automatically.' };
      }
      if (result.errorCode === 'notebook_run_busy') {
        return {
          ok: true,
          content: '[BUSY] This Notebook already has a run in progress. The requested code was not run. Do not retry automatically.',
        };
      }
      if (result.errorCode === 'notebook_run_timeout') {
        return {
          ok: true,
          content: '[TIMEOUT] Notebook run did not finish before its deadline. Reduce the work or increase timeoutMs before retrying. Do not retry the same request automatically.',
        };
      }
      const importPolicyMessage = moduleImportPolicyMessage(result.errorCode);
      if (importPolicyMessage) {
        return {
          ok: false,
          error: `${result.errorCode}: ${importPolicyMessage}`,
        };
      }
      // evalError: the eval infrastructure succeeded but the CODE crashed —
      // ok:true (the [ERROR] text IS the result) with the marker the one-shot
      // latch reads, so an actor delegation gets its recovery turn.
      return { ok: true, content: formatEvalResult(args.code, result), ...(result.error ? { evalError: true } : {}) };
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: `js_notebook_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    }
  },
});

/**
 * @param {string} code
 * @param {EvalResult} r
 * @returns {string}
 */
export const formatEvalResult = (code, r) => {
  const lines = [];
  const oneLineCode = code.length > 200 ? `${code.slice(0, 200)}…` : code;
  lines.push(`> ${oneLineCode.replace(/\n/g, '\n  ')}`);
  lines.push(`[${r.durationMs}ms]`);
  const body = [];
  if (r.error) body.push('[ERROR]', r.error);
  if (r.consoleOutput && r.consoleOutput.length) {
    body.push('[CONSOLE]');
    for (const { level, text } of r.consoleOutput) {
      body.push(`  ${level === 'info' ? '' : `[${level}] `}${text}`);
    }
  }
  pushValueBlock(body, r.value);
  if (r.usedRemoteModules && body.length) {
    lines.push(wrapUntrusted({
      origin: 'notebook (remote modules)',
      tool: 'js_notebook',
      body: body.join('\n'),
    }));
  } else {
    lines.push(...body);
  }
  if (r.usedRemoteModules) {
    lines.push(`[${REMOTE_MODULE_RESTRICTED_CODE}] ${REMOTE_MODULE_CAPABILITY_BLOCKED_MESSAGE}`);
  }
  return lines.join('\n');
};
