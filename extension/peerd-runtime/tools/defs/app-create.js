// @ts-check
// app_create — author a new App for the user.
//
// Apps are multi-file. Pass `files` as a path → content map; the
// agent's HTML body lives at index.html (default entry). If you only
// have one file, pass `html` for back-compat.

import { CODE_STYLE_NOTE } from './code-style-note.js';
import { RESIDENT_TAB_AGENTS } from '/shared/flags.js';

const MAX_TOTAL_CHARS = 2_000_000;

// App-specific runtime note, disclosed in the create RESULT. why: the sandboxed
// opaque-origin iframe can't load a Worker by path, but composeApp transparently
// rewrites `new Worker('worker.js')` to a blob: worker (peerd-engine/app-compose
// inlineWorkerFiles + the manifest sandbox CSP's worker-src blob:). The agent
// burned several turns hand-rolling workers on a Mandelbrot app — tell it the
// working pattern (a plain file Worker) up front.
const APP_RUNTIME_NOTE = [
  '<app-runtime>',
  'The App runs in a sandboxed, opaque-origin iframe with NO file server, so your',
  'page scripts CANNOT use cross-file ES modules: import/export BETWEEN your files',
  "won't resolve (there's no URL to fetch ./other.js from) and the app silently",
  'fails to start. Put your JS in classic <script> tags (multiple tags share ONE',
  'global scope — define in one, use in the next) OR a single self-contained',
  '<script type="module"> with no relative imports. Same for CSS: inline <style> or',
  'tag-relative <link href="./x.css"> (peerd inlines those).',
  'For heavy compute, put the work in its own file and use new Worker(\'worker.js\')',
  "— it runs automatically (wired to a blob worker). Keep the worker self-contained:",
  "a blob worker can't import other app files. Or tile work across",
  'requestAnimationFrame frames; for pure no-UI compute, js_create/js_run are simpler.',
  '</app-runtime>',
].join('\n');

/** @type {import('/shared/tool-types.js').Tool} */
export const appCreateTool = {
  name: 'app_create',
  primitive: 'app',
  description: [
    'Create a user-facing App (multi-file HTML in a sandboxed iframe —',
    'full DOM, no extension/parent access) and open it in its own tab.',
    '✅ "build a TODO app / calculator / interactive dashboard". ❌ a DATA CHART',
    'or explained analysis — that\'s a Notebook (js_create; peerd:std chart renders',
    'SVG bar/line/scatter with NO DOM). ❌ headless compute (js_create). ❌ POSIX',
    '(a WebVM). Call this IMMEDIATELY',
    'with a minimal index.html shell, then grow it file-by-file with',
    'app_write_file while the user watches. Pass `files` as a path→content',
    'map (entry defaults to index.html; tag-relative <link>/<script> are',
    'inlined). `html` shorthand = { "index.html": html }. For a MULTIPLAYER /',
    'shared app that talks to peers over the dweb, pass dwapp:true (attaches',
    'the dweb bridge) and follow dweb_guide for the client. Returns the app',
    'id and entry path.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Display name (≤80 chars).' },
      files: {
        type: 'object',
        description: 'path → content map. Must include the entry (default index.html).',
        additionalProperties: { type: 'string' },
      },
      html: { type: 'string', description: 'Shorthand for files:{index.html: html}.' },
      entryFile: { type: 'string', description: 'Entry filename (default index.html).' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags (improves search).',
      },
      dwapp: {
        type: 'boolean',
        description: 'Build a MULTIPLAYER / shared dwapp: marks the app so the '
          + 'app-tab attaches the dweb BRIDGE — only then can the app call '
          + "dweb('join'/'publish'/'subscribe'/'dm-send'/…). REQUIRED for any app "
          + "that talks to peers: without it there is no bridge and the app's "
          + 'hello() never answers ("no dweb bridge"). Pair with dweb_guide.',
      },
    },
    required: ['name'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.name !== 'string' || !args.name.trim()) {
      return { ok: false, error: 'name_required' };
    }
    /** @type {Record<string, unknown> | null} */
    const files = (args.files && typeof args.files === 'object')
      ? args.files
      : (typeof args.html === 'string' ? { 'index.html': args.html } : null);
    if (!files || !Object.keys(files).length) {
      return { ok: false, error: 'files_or_html_required' };
    }
    const totalChars = Object.values(files).reduce(
      /** @param {number} n @param {unknown} c */
      (n, c) => n + (typeof c === 'string' ? c.length : 0), 0,
    );
    if (totalChars > MAX_TOTAL_CHARS) {
      return { ok: false, error: `app_too_large: ${totalChars} > ${MAX_TOTAL_CHARS}` };
    }
    // why: appClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the two methods this tool calls.
    const appClient = /** @type {{ create?: (opts: Record<string, any>) => Promise<{ id: string, name: string, entryFile: string }>, open?: (opts: { appId: string, sessionId?: string, focus?: boolean }) => Promise<unknown> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    if (!appClient?.create) return { ok: false, error: 'app_not_available' };
    // A MULTIPLAYER dwapp needs the dweb metadata SLOT, which is what the app-tab
    // checks before attaching the bridge (app-registry: "its presence is what
    // unlocks the app-tab dweb bridge"; app-tab.js attachDwebBridge gates on
    // appMeta.dweb). Gated on ctx.dweb so the flag is INERT when the dweb is off
    // (store / dweb-off) — a stray dwapp:true there can't mark an app as a dwapp
    // it could never be. local:true distinguishes a self-authored dwapp from an
    // installed one (uri/publisher/hash) or the commons seed.
    // why: dweb rides the opaque ctx contract (not on ToolContext) — its mere
    // presence gates the dwapp metadata slot; read it as the erased contract.
    const makeDwapp = args?.dwapp === true && !!(/** @type {any} */ (ctx).dweb);
    const tags = makeDwapp
      ? [...new Set([...(Array.isArray(args.tags) ? args.tags : []), 'dweb'])]
      : args.tags;
    try {
      const record = await appClient.create({
        name: args.name,
        files,
        tags,
        entryFile: args.entryFile,
        sessionId: ctx.session?.sessionId,
        ...(makeDwapp ? { dweb: { uri: null, publisher: null, hash: null, local: true } } : {}),
      });
      // focus:false — open in the BACKGROUND + drop a "go there" card in the chat
      // instead of yanking the user to the new tab (DESIGN-12). They click to go.
      try { await appClient.open?.({ appId: record.id, sessionId: ctx.session?.sessionId, focus: false }); }
      catch (e) { console.debug('[app_create] open failed', e); }
      const summary = JSON.stringify({
        id: record.id,
        name: record.name,
        entryFile: record.entryFile,
        fileCount: Object.keys(files).length,
        opened: true,
      }, null, 2);
      // Flag ON: the App RESIDENT writes the files, so the code-style guidance
      // rides ITS prompt (system-prompt.js residentBlock), not this orchestrator
      // create-result. Flag OFF: the main agent writes → keep the note here.
      const styleNote = RESIDENT_TAB_AGENTS ? '' : `${CODE_STYLE_NOTE}\n\n`;
      return {
        ok: true,
        content: `${summary}\n\n${styleNote}${APP_RUNTIME_NOTE}`,
      };
    } catch (e) {
      return { ok: false, error: `app_create_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
};
