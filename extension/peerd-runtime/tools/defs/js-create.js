// @ts-check
// js_create — spin up a fresh Notebook.
//
// Creates a Notebook record + spawns its tab in the background. The new
// Notebook becomes this chat's current — subsequent js_notebook calls
// without an explicit `notebook` arg route here.

import { JS_TAB_GROUP_TITLE } from '/background/notebook-client.js';

// why a Notebook-specific note (the shared CODE_STYLE_NOTE rides the Notebook
// resident's own prompt now): the
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
  'peerd.self.display() the result. chart spec: { type: bar|line|scatter, data,',
  'x, y, title }.',
  'CODE MODE: for multi-step work, write ONE script that orchestrates it and',
  'return just the result — loop/filter/transform in code instead of many',
  'separate tool calls. peerd.egress.fetch(url, { method, headers, body }) is',
  'audited HTTP (denylist + SSRF + audit, same as fetch_url). peerd.runtime.',
  'runAgent({ task }) embeds an agent inside a Notebook you BUILD FOR THE USER',
  '(e.g. a chat box that reasons); for your own work use the spawn_subagent tool.',
  'Keep approval-needing / money-spending actions as discrete tools, not buried',
  'in a script.',
  '</notebook>',
].join('\n');

/** @type {import('/shared/tool-types.js').Tool} */
export const jsCreateTool = {
  name: 'js_create',
  primitive: 'notebook',
  description: [
    'Create a fresh Notebook: a CodeMirror JS IDE with a file tree, its own',
    'sealed realm, and an OPFS scratch directory. Lightweight (~hundreds of ms',
    'to boot) compared to a WebVM. Use when vanilla JS is enough — JSON',
    'processing, parsers, numerical work, library exercising, and DATA ANALYSIS',
    'WITH CHARTS + TABLES: `import { chart, table, mean } from \'peerd:std\'`',
    'renders bar/line/scatter as SVG and tables from row objects — no DOM, so a',
    'Notebook (NOT an App) is the right tool to explain + visualize data; or',
    'CODE MODE —',
    'orchestrate many audited fetches/compute in one script and return just the',
    'result, instead of many separate tool calls. Each run is a FRESH realm (no',
    'kernel state); split code across multiple .js files and keep cross-run state',
    'in OPFS. The new Notebook becomes the chat\'s current. Optional name labels',
    'the tab.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Human-friendly name (≤40 chars).' },
    },
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
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
      isCurrent: !!sessionId,
    }, null, 2);
    // The Notebook RESIDENT writes + runs the code, so the style + correctness
    // guidance rides ITS prompt (residentBlock), not this orchestrator create-result.
    return {
      ok: true,
      content: `${summary}\n\n${NOTEBOOK_NOTE}`,
    };
  },
};