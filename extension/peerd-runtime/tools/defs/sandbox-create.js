// @ts-check
// sandbox_create — the single create tool for all three sandbox kinds.
//
// why one tool, not three: vm_create / js_create / app_create were three
// near-identical bootstrap tools (create a record, open a background tab, set
// the chat's current, return the id) whose separate descriptions repeated the
// same which-kind-do-I-want routing guidance. Collapsed into one
// kind-discriminated create — the same shape as `inspect({kind})` and the
// actor_list fold — so the taxonomy is laid out ONCE, side by side, where the
// model actually picks. The per-kind handlers live in their original files
// (vm-create.js / js-create.js / app-create.js), unchanged in behavior.
//
// primitive is 'engine' (cross-kind, like edit_file is cross-kind for files);
// the durable-handle harvest (loop/instance-handle.js) reads the `kind` field
// each handler stamps into its result JSON, so compaction/trim still carry
// "which kind of instance this id is" after the merge.

import { createWebVmSandbox } from './vm-create.js';
import { createNotebookSandbox } from './js-create.js';
import { createAppSandbox } from './app-create.js';

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult} ToolResult */

// kind → handler. Exported so tests can enumerate the kinds.
export const SANDBOX_KIND_HANDLERS = Object.freeze({
  webvm: createWebVmSandbox,
  notebook: createNotebookSandbox,
  app: createAppSandbox,
});

const SANDBOX_KINDS = Object.freeze(Object.keys(SANDBOX_KIND_HANDLERS));

/** @type {import('/shared/tool-types.js').Tool} */
export const sandboxCreateTool = {
  name: 'sandbox_create',
  primitive: 'engine',
  description: [
    'Create a SANDBOX — an isolated execution instance in its own background',
    'tab — and get back its id. Pick `kind` by the job:',
    '"webvm" = a full Linux VM with bash, a persistent disk, and POSIX tools',
    '(compilers, python, git) — heavyweight, boots in seconds.',
    '"notebook" = a fresh-run JS IDE with a file tree, sealed realm, and OPFS',
    'scratch — lightweight (~hundreds of ms). ✅ JSON processing, parsers,',
    'numerical work, and DATA ANALYSIS with charts + tables (peerd:std renders',
    'bar/line/scatter/heatmap as SVG, no DOM needed) — a data chart or explained',
    'analysis wants a notebook, NOT an app.',
    '"app" = a user-facing multi-file HTML app in a sandboxed iframe (full DOM,',
    'no extension access). ✅ "build a TODO app / calculator / interactive',
    'dashboard". For an app, pass `files` (path → content; entry defaults to',
    'index.html) or `html` shorthand — start with a minimal shell immediately,',
    'then grow it file by file through the app\'s actor. For a MULTIPLAYER app',
    'that talks to peers over the dweb, pass dwapp:true and follow dweb_guide.',
    'The new instance becomes the chat\'s current of its kind and a "go there"',
    'card lands in chat. Then DELEGATE the work: message_actor(<id>, goal) —',
    'the instance\'s actor holds all its file/run tools. (For quick headless',
    'compute with no tab and no instance, js_run is simpler.)',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...SANDBOX_KINDS],
        description: 'Which sandbox to create.',
      },
      name: { type: 'string', description: 'Human-friendly label (tab strip + actor_list).' },
      files: {
        type: 'object',
        description: 'app only: path → content map. Must include the entry (default index.html).',
        additionalProperties: { type: 'string' },
      },
      html: { type: 'string', description: 'app only: shorthand for files:{index.html: html}.' },
      entryFile: { type: 'string', description: 'app only: entry filename (default index.html).' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'app only: optional tags (improves search).',
      },
      dwapp: {
        type: 'boolean',
        description: 'app only: build a MULTIPLAYER / shared dwapp — marks the app so the '
          + 'app-tab attaches the dweb BRIDGE; only then can the app call '
          + "dweb('join'/'publish'/'subscribe'/'dm-send'/…). REQUIRED for any app "
          + 'that talks to peers. Pair with dweb_guide.',
      },
    },
    required: ['kind'],
  },
  sideEffect: 'write',
  origins: () => [],
  execute: async (args, ctx) => {
    const kind = args?.kind;
    const handler = typeof kind === 'string'
      ? /** @type {Record<string, (a: any, c: ToolContext) => Promise<ToolResult>>} */ (SANDBOX_KIND_HANDLERS)[kind]
      : undefined;
    if (!handler) {
      return { ok: false, error: `sandbox_create: unknown kind ${JSON.stringify(kind)} — expected one of ${SANDBOX_KINDS.join(', ')}.` };
    }
    return handler(args, ctx);
  },
};
