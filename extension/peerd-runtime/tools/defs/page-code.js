// @ts-check
// page_code — the web actor's CODE-REPL action surface (PR #119).
//
// The Aside-style A/B arm: instead of emitting discrete click/type/navigate
// tool calls, the code-mode web actor WRITES a script that drives its owned tab
// through a Playwright-shaped `page` object. The script runs in the SAME sealed
// headless worker as js_run, but under a hard capability profile: `page` + pure
// compute ONLY — no egress.fetch, no subagents, no OPFS. why: the web actor
// ingests untrusted page text, so its code hand must hold nothing beyond what
// the tool-call actor already holds (the exclusion IS the boundary,
// exposure.js) — every page.* call maps onto the SAME gated tool (navigate /
// click / type / snapshot / read_page) via the SW 'page/call' route, so the
// denylist, confirm gates, and audit apply unchanged. This tool is a
// vocabulary/shape change, not new capability.
//
// The owner identity is taken from ctx.session (the actor's own session) HERE,
// on the trusted side — the worker can never name a session or a tab; the SW
// route re-derives the owned tab from its own bindings per call.

import { clamp } from '/shared/util.js';
import { formatRunResult } from './script.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;

// The code-REPL worker's capability profile — fixed, never caller-supplied.
export const PAGE_CODE_CAPS = Object.freeze({
  page: true, egress: false, subagent: false, opfs: false,
});

/** @type {import('/shared/tool-types.js').Tool} */
export const pageCodeTool = {
  name: 'page_code',
  primitive: 'web',
  description: [
    'Drive YOUR tab by writing JavaScript. Async function body in a sealed',
    'worker with a Playwright-shaped `page` object:',
    'await page.goto(url) — navigate your tab (opens it on first use);',
    "await page.click(selector, {nth}) — click; the selector must match EXACTLY one",
    'element or the call rejects (pass nth to pick among several, 0-based);',
    "await page.fill(selector, text) — replace a field's value (single-match strict);",
    'await page.snapshot() — the a11y snapshot (your perception — re-read after acting);',
    "await page.content() — the page's readable text.",
    'Each call rejects on failure (denylist, no match, count mismatch) — wrap in',
    'try/catch to handle. `return <value>` returns your result; console output is',
    'captured. The worker has NO network fetch, NO files, NO subagents — page.*',
    'and pure computation only. Keep scripts SHORT (a few actions), then look at',
    'a fresh snapshot before the next step: pages change under you.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'JS code to run. Async function body — top-level await + `return <value>` work.' },
      timeoutMs: { type: 'integer', description: `Wall-clock cap in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).` },
    },
    required: ['code'],
  },
  sideEffect: 'write',
  // The script's page.* calls carry their own origins through the gated dispatch
  // of each mapped tool (the 'page/call' route); the tool itself names none.
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.code !== 'string' || args.code.length === 0) {
      return { ok: false, error: 'code_required' };
    }
    // why: jsOffscreenClient rides the opaque ctx contract (not on ToolContext);
    // narrow to the one method this tool calls.
    const jsOffscreenClient = /** @type {{ execHeadless?: (code: string, opts: object) => Promise<import('./script.js').RunResult> } | undefined} */ (
      /** @type {any} */ (ctx).jsOffscreenClient);
    if (!jsOffscreenClient || typeof jsOffscreenClient.execHeadless !== 'function') {
      return { ok: false, error: 'page_code_unavailable' };
    }
    // The actor's own session — the trusted owner identity the page bridge rides
    // on. Absent (a non-session ctx) → fail closed; the SW route ALSO verifies
    // the session is a tab-backed web actor before any dispatch.
    const ownerSessionId = ctx.session?.sessionId;
    if (typeof ownerSessionId !== 'string' || !ownerSessionId) {
      return { ok: false, error: 'page_code_requires_actor_session' };
    }
    const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    try {
      const result = await jsOffscreenClient.execHeadless(args.code, {
        timeoutMs, caps: PAGE_CODE_CAPS, ownerSessionId,
      });
      return { ok: true, content: formatRunResult(args.code, result) };
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: `page_code_failed: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    }
  },
};
