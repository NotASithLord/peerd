// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// sandbox_create: the single create tool for all tab-hosted sandbox kinds.
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

import { executeByKind } from './kind-dispatch.js';
import { createWebVmSandbox } from './vm-create.js';
import { createNotebookSandbox } from './js-create.js';
import { createAppSandbox } from './app-create.js';
import { createPodSandbox } from './pod-create.js';

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').ToolResult} ToolResult */

// kind → handler. Exported so tests can enumerate the kinds.
export const SANDBOX_KIND_HANDLERS = Object.freeze({
  webvm: createWebVmSandbox,
  notebook: createNotebookSandbox,
  pod: createPodSandbox,
  app: createAppSandbox,
});

/** @type {import('/shared/tool-types.js').Tool} */
export const sandboxCreateTool = composeTool("sandbox_create", {
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
          return { ok: false, error: `sandbox_create: ${conflicting.join(', ')} cannot accompany gitUrl: the cloned peerd.json alone declares the App entry and capabilities.` };
        }
      }
      if (typeof kind === 'string' && kind !== 'app' && kind in SANDBOX_KIND_HANDLERS) {
        const appOnly = ['files', 'html', 'entryFile', 'tags', 'dwapp'].filter((k) => args?.[k] !== undefined);
        if (appOnly.length) {
          return { ok: false, error: `sandbox_create: ${appOnly.join(', ')} ${appOnly.length === 1 ? 'is' : 'are'} app-only — a ${kind} starts empty; seed its files by messaging its actor after create.` };
        }
      }
      if (typeof kind === 'string' && kind !== 'pod' && args?.persistent !== undefined && kind in SANDBOX_KIND_HANDLERS) {
        return { ok: false, error: `sandbox_create: persistent is pod-only: ${kind} has its existing lifecycle semantics.` };
      }
      if (typeof kind === 'string' && kind !== 'notebook' && kind !== 'pod' && kind !== 'app' && kind in SANDBOX_KIND_HANDLERS) {
        const notebookOnly = ['gitUrl', 'gitRef', 'gitDepth'].filter((k) => args?.[k] !== undefined);
        if (notebookOnly.length) {
          return { ok: false, error: `sandbox_create: ${notebookOnly.join(', ')} ${notebookOnly.length === 1 ? 'is' : 'are'} available only on notebook/pod/app: use kind:'webvm' for a full Linux checkout.` };
        }
      }
      return dispatch(args, ctx);
    });
  })(),
});
