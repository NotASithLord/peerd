// @ts-check
// edit_file — the PRIMARY write path for agent file edits.
//
// Instead of re-emitting a whole file (app_write_file with full content),
// the agent emits Aider-style SEARCH/REPLACE blocks and we apply them as
// anchored patches. Benefits: fewer tokens, no silent clobber of files
// the agent didn't re-read, and a hard failure when the search text isn't
// a unique anchor (rather than a corrupting "first match wins").
//
// Targets either an App file (kind 'app', via appClient) or a Notebook
// file (kind 'notebook', via jsClient). The post-turn snapshot in the SW
// captures whichever workspace this touched, so /undo can roll it back.
//
// Writes route through feature 03's permission policy via the adapter
// (resolveCanWrite). Until 03 is wired, that defaults to allow.

import { applyEdit } from '../../edit/search-replace.js';
import {
  EditParseError, SearchNotFoundError, SearchAmbiguousError,
} from '../../edit/errors.js';
import { resolveCanWrite } from '../../edit/permissions-adapter.js';

const MAX_CONTENT_CHARS = 500_000;

/**
 * The App workspace client surface edit_file exercises (background).
 * @typedef {Object} AppClient
 * @property {(opts: { appId?: string, path: string, sessionId?: string }) => Promise<string | null | undefined>} readFile
 * @property {(opts: { appId?: string, path: string, content: string, sessionId?: string }) => Promise<unknown>} writeFile
 */

/**
 * The Notebook workspace client surface edit_file exercises (background).
 * @typedef {Object} JsClient
 * @property {(path: string, opts: { notebookId?: string, sessionId?: string }) => Promise<string | null | undefined>} readFile
 * @property {(path: string, content: string, opts: { notebookId?: string, sessionId?: string }) => Promise<unknown>} writeFile
 */

/**
 * The registry surface edit_file consults for the "current instance" hint.
 * @typedef {Object} InstanceRegistry
 * @property {(sessionId: string) => Promise<string | null | undefined>} [getDefaultForSession]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const editFileTool = {
  name: 'edit_file',
  primitive: 'app',
  description: [
    'Edit an existing file with one or more Aider-style SEARCH/REPLACE',
    'blocks. PREFER THIS over rewriting a whole file. Format:',
    '',
    '<<<<<<< SEARCH',
    'exact text to find (must appear once)',
    '=======',
    'replacement text',
    '>>>>>>> REPLACE',
    '',
    'The SEARCH text must match the current file EXACTLY and UNIQUELY;',
    'if it is not unique, add surrounding lines until it is. An empty',
    'SEARCH block replaces the whole file (use to create one). `kind`',
    'is "app" (default) for App files or "notebook" for Notebook files.',
    'Without `targetId`, edits the chat\'s current App / Notebook.',
  ].join('\n'),
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace, e.g. app.js.' },
      edits: { type: 'string', description: 'One or more SEARCH/REPLACE blocks.' },
      kind: { type: 'string', enum: ['app', 'notebook'], description: 'Workspace kind (default app).' },
      targetId: { type: 'string', description: 'App id or notebook id (default: current).' },
    },
    required: ['path', 'edits'],
  },
  sideEffect: 'write',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string' || !args.path) {
      return { ok: false, error: 'path_required' };
    }
    if (typeof args?.edits !== 'string' || !args.edits) {
      return { ok: false, error: 'edits_required' };
    }
    const kind = args.kind === 'notebook' ? 'notebook' : 'app';

    // --- feature 03 seam: gate the write before doing any IO -----------
    const perm = await resolveCanWrite(ctx);
    if (!perm.allowed) {
      return { ok: false, error: `write_denied: ${perm.reason ?? 'plan mode'}` };
    }

    const sessionId = ctx.session?.sessionId;

    // why: appClient / jsClient are SW-injected context extras not on the
    // ToolContext contract slot; narrow to the workspace surfaces edit_file uses.
    const appClient = /** @type {AppClient | undefined} */ (
      /** @type {{ appClient?: unknown }} */ (ctx).appClient);
    const jsClient = /** @type {JsClient | undefined} */ (
      /** @type {{ jsClient?: unknown }} */ (ctx).jsClient);

    // Bind read/write to the chosen workspace kind. Both clients already
    // resolve "current" from sessionId when the id is omitted.
    /** @type {() => Promise<string | null | undefined>} */
    let readFile;
    /** @type {(content: string) => Promise<unknown>} */
    let writeFile;
    if (kind === 'app') {
      if (!appClient?.readFile || !appClient?.writeFile) {
        return { ok: false, error: 'app_not_available' };
      }
      readFile = () => appClient.readFile({ appId: args.targetId, path: args.path, sessionId });
      writeFile = (content) => appClient.writeFile({ appId: args.targetId, path: args.path, content, sessionId });
    } else {
      if (!jsClient?.readFile || !jsClient?.writeFile) {
        return { ok: false, error: 'notebook_not_available' };
      }
      readFile = () => jsClient.readFile(args.path, { notebookId: args.targetId, sessionId });
      writeFile = (content) => jsClient.writeFile(args.path, content, { notebookId: args.targetId, sessionId });
    }

    // Progressive-disclosure consistency: with no explicit targetId, edit_file
    // operates on the chat's CURRENT App/Notebook. If there isn't one, give the
    // same "create one first" hint the gated *_write_file ops give at the
    // dispatch gate — edit_file is cross-kind + always-on, so it isn't
    // instance-gated there, and the read-swallow below would otherwise surface
    // this as a confusing search_not_found. Only fires when the registry
    // CONFIRMS no current instance (skipped if the registry isn't wired, so no
    // false negatives).
    if (!args.targetId && sessionId) {
      // why: appRegistry / jsRegistry are SW-injected context extras not on the
      // ToolContext contract slot; narrow to the getDefaultForSession verb.
      const registry = /** @type {InstanceRegistry | undefined} */ (
        /** @type {{ appRegistry?: unknown, jsRegistry?: unknown }} */ (ctx)[
          kind === 'app' ? 'appRegistry' : 'jsRegistry']);
      if (registry?.getDefaultForSession) {
        const currentId = await registry.getDefaultForSession(sessionId).catch(() => null);
        if (!currentId) {
          const create = kind === 'app' ? 'app_create' : 'js_create or js_notebook';
          return {
            ok: false,
            code: 'no_current_instance',
            error: `edit_file needs a current ${kind} in this chat — create one first (${create})`,
          };
        }
      }
    }

    // Read current content. A missing file is fine ONLY for a whole-file
    // create (empty SEARCH); applyEdit enforces that distinction.
    let source = '';
    try {
      source = (await readFile()) ?? '';
    } catch {
      source = '';
    }

    let result;
    try {
      result = applyEdit(source, args.edits);
    } catch (e) {
      // Map the typed errors to stable codes the model can react to.
      if (e instanceof SearchNotFoundError) return { ok: false, error: e.message, code: 'search_not_found', blockIndex: e.blockIndex };
      if (e instanceof SearchAmbiguousError) return { ok: false, error: e.message, code: 'search_ambiguous', blockIndex: e.blockIndex, count: e.count };
      if (e instanceof EditParseError) return { ok: false, error: e.message, code: 'edit_parse_error' };
      return { ok: false, error: `edit_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }

    if (result.content.length > MAX_CONTENT_CHARS) {
      return { ok: false, error: `content_too_large: ${result.content.length} > ${MAX_CONTENT_CHARS}` };
    }

    try {
      await writeFile(result.content);
    } catch (e) {
      return { ok: false, error: `write_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }

    return {
      ok: true,
      content: JSON.stringify({
        path: args.path,
        kind,
        blocks: result.blocks,
        bytes: result.content.length,
      }, null, 2),
    };
  },
};
