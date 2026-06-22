// @ts-check
// js_run — run JS HEADLESS (no tab).
//
// The headless sibling of js_notebook (DECISIONS #25, "runJob"): the SAME sealed
// worker (realm seal + peerd.* surface), hosted in the offscreen document with
// NO UI. The cheap, invisible path for the agent's OWN quick compute — math, a
// transform, or CODE MODE (orchestrate fetches/compute in one script, return the
// result) — when the user needn't watch a tab. EACH CALL is a FRESH worker with
// an EPHEMERAL OPFS scratch that is nuked after; for durable files or a visible
// editor/output, use a Notebook (js_create/js_notebook). Own-code threat model — NOT
// for untrusted code (that needs an opaque-origin iframe, DESIGN.md §8.5).

import { clamp } from '/shared/util.js';
import { JS_PITFALLS_NOTE } from './code-style-note.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

// why once per session: js_run is the agent's OWN quick-compute path (the
// precision / off-by-one class of bug lands here, e.g. large-integer math), so
// the correctness note matters most here — but js_run is called repeatedly, so
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
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const jsRunTool = {
  name: 'js_run',
  primitive: 'notebook',
  description: [
    'Run JS HEADLESS — a fast sealed Web Worker with NO tab (the cheap, invisible',
    'sibling of js_notebook). Use when you just need a RESULT and the user need not',
    'watch: math, parsing/transforms, or CODE MODE — orchestrate many audited',
    'fetches/compute in one script and RETURN the result instead of many separate',
    'tool calls. Async function body — top-level await + `return <value>` work.',
    'Inside: peerd.egress.fetch(url, { method, headers, body }) (audited HTTP),',
    'the peerd:std math/data helpers (import { mean, stdev, quantile, sum, groupBy,',
    'countBy, range, chunk, gcd, divmod } from \'peerd:std\' — same stdlib as a',
    'Notebook; table/chart are display-only, so they need a Notebook to render).',
    'This is YOUR scratch compute; delegate subtasks with the spawn_subagent tool.',
    'EACH CALL is a',
    'FRESH worker with an EPHEMERAL OPFS',
    'scratch (nuked after) — for durable files or a visible editor/output use a',
    'Notebook (js_create). Returns the return value, console output, and any error.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JS code to evaluate. Async function body.' },
      timeoutMs: { type: 'integer', description: 'Wall-clock cap in ms (default 30000, max 120000).' },
    },
    required: ['code'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.code !== 'string' || args.code.length === 0) {
      return { ok: false, error: 'code_required' };
    }
    // why: jsOffscreenClient rides the opaque ctx contract (not on ToolContext);
    // narrow to the one method this tool calls.
    const jsOffscreenClient = /** @type {{ execHeadless?: (code: string, opts: { timeoutMs: number }) => Promise<RunResult> } | undefined} */ (
      /** @type {any} */ (ctx).jsOffscreenClient);
    if (!jsOffscreenClient || typeof jsOffscreenClient.execHeadless !== 'function') {
      return { ok: false, error: 'headless_js_unavailable' };
    }
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    try {
      const result = await jsOffscreenClient.execHeadless(args.code, { timeoutMs });
      let content = formatRunResult(args.code, result);
      const sid = ctx.session?.sessionId ?? '';
      if (!pitfallsDisclosed.has(sid)) {
        pitfallsDisclosed.add(sid);
        content += `\n\n${JS_PITFALLS_NOTE}`;
      }
      return { ok: true, content };
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: `js_run_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
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
