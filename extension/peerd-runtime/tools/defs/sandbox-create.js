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

import { executeByKind, kindEnum } from './kind-dispatch.js';
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

/** @type {import('/shared/tool-types.js').Tool} */
export const sandboxCreateTool = {
  name: 'sandbox_create',
  primitive: 'engine',
  // why the per-kind HOW-TO isn't here: the description is the every-turn
  // routing surface — enough to PICK a kind, no more. The deep operating lore
  // (charts, iframe runtime, file-by-file growth) rides each kind's
  // create-RESULT note (NOTEBOOK_NOTE / APP_RUNTIME_NOTE) and the owning
  // actor's prompt, disclosed once when the agent actually commits to that kind.
  description: [
    'Create a SANDBOX — an isolated execution instance in its own background',
    'tab — and get back its id. Pick `kind` by the job:',
    '"webvm" = a full Linux VM (bash, persistent disk, POSIX tools — compilers,',
    'python, git); heavyweight, boots in seconds.',
    '"notebook" = a fresh-run JS IDE (file tree, sealed realm, OPFS scratch);',
    'lightweight. ✅ JSON/parsing/numerical work and DATA ANALYSIS with charts +',
    'tables — a chart or explained analysis wants a notebook, NOT an app.',
    '"app" = a user-facing multi-file HTML app in a sandboxed iframe (full DOM,',
    'no extension access, NO ambient network; bundle every dependency). ✅ "build',
    'a TODO app / calculator / snapshot dashboard"; live web/API work belongs to',
    'the web actor. A dwapp:true App gets only the consent-gated dweb bridge.',
    'Apps currently run only on Chrome; on Firefox the artifact is saved but cannot',
    'open, so tell the user to open peerd in Chrome to run it.',
    'REQUIRES `name` plus `files` (or `html` shorthand). For a MULTIPLAYER dwapp',
    'that talks to peers, pass dwapp:true.',
    'The new instance becomes the chat\'s current of its kind; when its host opens,',
    'a "go there" card lands in chat. Then DELEGATE the work: message_actor(<id>, goal) — the',
    'instance\'s actor holds all its file/run tools and gets the how-to in the',
    'create result. (For quick headless compute with no tab and no instance,',
    'script is simpler.)',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: kindEnum(SANDBOX_KIND_HANDLERS),
        description: 'Which sandbox to create.',
      },
      name: { type: 'string', description: 'Human-friendly label (tab strip + actor_list).' },
      files: {
        type: 'object',
        description: 'app only: path → content map. Must include the entry (default index.html). '
          + 'Text files use strings. Binary assets such as .wasm, images, audio, and fonts use '
          + '{ "base64": "..." } and are available through window.peerd.assets.',
        additionalProperties: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: { base64: { type: 'string' } },
              required: ['base64'],
              additionalProperties: false,
            },
          ],
        },
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
  // why the wrapper around executeByKind: refuse (not ignore) app-only args on
  // other kinds — a notebook create that silently drops `files` looks seeded
  // when it isn't; the model would delegate "run parse.js" to an actor staring
  // at an empty OPFS. Fail loud at the seam with the recovery path.
  execute: (() => {
    const dispatch = executeByKind('sandbox_create', SANDBOX_KIND_HANDLERS);
    return /** @type {(args: any, ctx: ToolContext) => Promise<ToolResult>} */ (async (args, ctx) => {
      const kind = args?.kind;
      if (typeof kind === 'string' && kind !== 'app' && kind in SANDBOX_KIND_HANDLERS) {
        const appOnly = ['files', 'html', 'entryFile', 'tags', 'dwapp'].filter((k) => args?.[k] !== undefined);
        if (appOnly.length) {
          return { ok: false, error: `sandbox_create: ${appOnly.join(', ')} ${appOnly.length === 1 ? 'is' : 'are'} app-only — a ${kind} starts empty; seed its files by messaging its actor after create.` };
        }
      }
      return dispatch(args, ctx);
    });
  })(),
};
