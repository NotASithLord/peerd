// @ts-check
// The notebook arm of sandbox_create — spin up a fresh Notebook.
// (Was the standalone js_create tool; merged into sandbox_create({kind:'notebook'})
// 2026-07-05 — one create tool, three kinds.)
//
// Creates a Notebook record + spawns its tab in the background. The new
// Notebook becomes this chat's current — subsequent js_notebook calls
// without an explicit `notebook` arg route here.

import { JS_TAB_GROUP_TITLE } from '/background/notebook-client.js';

// why a Notebook-specific note (the shared CODE_STYLE_NOTE rides the Notebook
// actor's own prompt now): the
// fresh-realm + file-tree + OPFS-state guidance holds for Notebooks, not Apps.
// Every run is a clean realm, so durable state must be explicit — an OPFS file,
// never a module global — which keeps Notebook code pure and functional.
const NOTEBOOK_NOTE = [
  '<notebook>',
  'A Notebook is a fresh-run JS IDE with a file tree — every run starts a clean',
  'realm, so runs are REPRODUCIBLE from the code + files alone (this is the',
  'point; nothing in memory carries to the next run). Keep functions pure, split',
  'reusable helpers into their own .js files and import them, and keep cross-run',
  'state in OPFS via peerd.self.writeFile / readFile — never a module global.',
  'OUTPUT: RETURN a value to display it (an array of flat objects renders as a',
  'table; objects/arrays as JSON). For tables + charts + data helpers import the',
  'stdlib — import { table, chart, mean } from \'peerd:std\' — then RETURN or',
  'peerd.self.display() the result. chart spec: { type: bar|line|scatter|heatmap,',
  'data, x, y, title } (heatmap: rows of { x, y, v } bins, shaded by v). These',
  'FOUR types are the ONLY charts that render — a hand-rolled Vega/Vega-Lite/',
  'plotly spec is NOT understood and dumps as raw JSON, so never return one.',
  'CODE MODE: for multi-step work, write ONE script that orchestrates it and',
  'return just the result — loop/filter/transform in code instead of many',
  'separate tool calls. peerd.egress.fetch(url, { method, headers, body }) is',
  'audited HTTP (denylist + SSRF + audit, same as fetch_url). peerd:wasi runs a',
  'compiled wasm32-wasi binary over an in-memory FS (import { runWasi } from',
  '\'peerd:wasi\'; runWasi(bytes, { args, stdin, files }) → { exitCode, stdout,',
  'files }; the module gets no network; demoModule() from the same import is',
  'a known-good smoke-test module). peerd.runtime.',
  'runAgent({ task }) embeds an agent inside a Notebook you BUILD FOR THE USER',
  '(e.g. a chat box that reasons); for your own work use the actor_create tool.',
  'Keep approval-needing / money-spending actions as discrete tools, not buried',
  'in a script.',
  '</notebook>',
].join('\n');

/**
 * Create a Notebook record + its background tab; returns { id, name, kind,
 * isCurrent } plus the Notebook runtime note.
 * @param {any} args @param {import('/shared/tool-types.js').ToolContext} ctx
 * @returns {Promise<import('/shared/tool-types.js').ToolResult>}
 */
export const createNotebookSandbox = async (args, ctx) => {
    // why: the Notebook registry + tab tracker ride the opaque ctx contract
    // (not on the ToolContext typedef); narrow to the surface this tool uses.
    const jsRegistry = /** @type {{ create: (opts: { name?: string, ownerSessionId: string | null }) => Promise<{ id: string, name: string }>, setDefaultForSession: (sessionId: string, id: string) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).jsRegistry);
    const jsTabTracker = /** @type {{ ensureTab: (id: string, opts: { active?: boolean, groupTitle?: string }) => Promise<unknown>, getTabId?: (id: string) => number | null | undefined } | undefined} */ (
      /** @type {any} */ (ctx).jsTabTracker);
    if (!jsRegistry || !jsTabTracker) {
      return { ok: false, error: 'js_registry_unavailable' };
    }
    const sessionId = ctx.session?.sessionId;
    let name = typeof args?.name === 'string' ? args.name.trim().slice(0, 40) : '';
    if (!name) name = undefined;
    const record = await jsRegistry.create({
      name,
      ownerSessionId: sessionId ?? null,
    });
    // why background: a Notebook tab no longer steals focus (DESIGN-12, owner
    // 2026-06-18) — it opens quietly and the tab tracker drops a "go there" card
    // in the chat; the user clicks to open it. A background tab can miss the
    // readiness timeout but it WAS created + announced — only fail if it truly
    // didn't open.
    try {
      await jsTabTracker.ensureTab(record.id, {
        active: false,
        groupTitle: JS_TAB_GROUP_TITLE,
      });
    } catch (e) {
      if (jsTabTracker.getTabId?.(record.id) == null) {
        return { ok: false, error: `notebook_spawn_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
      }
    }
    if (sessionId) {
      await jsRegistry.setDefaultForSession(sessionId, record.id);
    }
    const summary = JSON.stringify({
      id: record.id,
      name: record.name,
      // why kind: the merged sandbox_create result is the durable-handle
      // carrier — instance-handle.js reads it to label the harvested id.
      kind: 'notebook',
      isCurrent: !!sessionId,
    }, null, 2);
    // The Notebook ACTOR writes + runs the code, so the style + correctness
    // guidance rides ITS prompt (actorBlock), not this orchestrator create-result.
    return {
      ok: true,
      content: `${summary}\n\n${NOTEBOOK_NOTE}`,
    };
  };
