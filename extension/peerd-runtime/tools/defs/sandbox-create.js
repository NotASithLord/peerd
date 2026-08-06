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
    'Create an isolated SANDBOX in a background tab; returns its id. Pick `kind`:',
    '"webvm" = full Linux (bash, disk, POSIX, compilers, python, git); heavyweight.',
    '"notebook" = lightweight fresh-run JS IDE (files, sealed realm, OPFS);',
    'gitUrl clones without Linux. Use for JSON, numerical work, analysis, charts, tables.',
    '"app" = user-facing multi-file HTML in a sandboxed iframe (DOM, no extension',
    'access, NO ambient network; bundle dependencies). Live APIs belong to the web actor;',
    'dwapp:true grants only the consent-gated dweb bridge.',
    'Apps currently run only on Chrome; on Firefox the artifact is saved but cannot',
    'open, so tell the user to open peerd in Chrome to run it.',
    'Create from `name` + `files`/`html`, or gitUrl when peerd.json declares the',
    'entry and bound App contract. Use dwapp:true for peer communication.',
    'It becomes the chat\'s current instance and returns a go-there card. Delegate with',
    'message_actor(<id>, goal); use script for quick headless compute.',
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
      gitUrl: { type: 'string', description: 'app/notebook: HTTPS remote to clone.' },
      gitRef: { type: 'string', description: 'app/notebook: branch.' },
      gitDepth: { type: 'integer', description: 'app/notebook: depth, 1–500.' },
    },
    required: ['kind'],
  },
  sideEffect: 'write',
  origins: (args) => {
    if (typeof args?.gitUrl !== 'string') return [];
    try { return [new URL(args.gitUrl).origin]; } catch { return []; }
  },
  // why the wrapper around executeByKind: refuse (not ignore) app-only args on
  // other kinds — a notebook create that silently drops `files` looks seeded
  // when it isn't; the model would delegate "run parse.js" to an actor staring
  // at an empty OPFS. Fail loud at the seam with the recovery path.
  execute: (() => {
    const dispatch = executeByKind('sandbox_create', SANDBOX_KIND_HANDLERS);
    return /** @type {(args: any, ctx: ToolContext) => Promise<ToolResult>} */ (async (args, ctx) => {
      const kind = args?.kind;
      if (kind === 'app' && typeof args?.gitUrl === 'string') {
        const conflicting = ['files', 'html', 'entryFile', 'tags', 'dwapp'].filter((key) => args?.[key] !== undefined);
        if (conflicting.length) {
          return { ok: false, error: `sandbox_create: ${conflicting.join(', ')} cannot accompany gitUrl — the cloned peerd.json alone declares the App entry and capabilities.` };
        }
      }
      if (typeof kind === 'string' && kind !== 'app' && kind in SANDBOX_KIND_HANDLERS) {
        const appOnly = ['files', 'html', 'entryFile', 'tags', 'dwapp'].filter((k) => args?.[k] !== undefined);
        if (appOnly.length) {
          return { ok: false, error: `sandbox_create: ${appOnly.join(', ')} ${appOnly.length === 1 ? 'is' : 'are'} app-only — a ${kind} starts empty; seed its files by messaging its actor after create.` };
        }
      }
      if (typeof kind === 'string' && kind !== 'notebook' && kind !== 'app' && kind in SANDBOX_KIND_HANDLERS) {
        const notebookOnly = ['gitUrl', 'gitRef', 'gitDepth'].filter((k) => args?.[k] !== undefined);
        if (notebookOnly.length) {
          return { ok: false, error: `sandbox_create: ${notebookOnly.join(', ')} ${notebookOnly.length === 1 ? 'is' : 'are'} notebook-only — use kind:'notebook' for a lightweight Git clone or kind:'webvm' for a full Linux checkout.` };
        }
      }
      return dispatch(args, ctx);
    });
  })(),
};
