// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
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

import { parseEditBlocks, applyBlocks, isWholeFileCreate } from '../../edit/search-replace.js';
import {
  EditParseError, SearchNotFoundError, SearchAmbiguousError,
} from '../../edit/errors.js';
import { MAX_MODEL_APP_FILE_BYTES } from '/peerd-engine/app-assets.js';
import { MAX_NETWORK_BUNDLE_BYTES } from '/shared/bundle/bundle.js';

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
export const editFileTool = composeTool("edit_file", {

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string' || !args.path) {
      return { ok: false, error: 'path_required' };
    }
    if (typeof args?.edits !== 'string' || !args.edits) {
      return { ok: false, error: 'edits_required' };
    }
    const kind = args.kind === 'notebook' ? 'notebook' : 'app';

    const authority = /** @type {any} */ (ctx).editingAuthority;
    if (!authority?.readEditTarget || !authority?.writeEditTarget) {
      return { ok: false, error: `${kind}_not_available` };
    }

    // Parse up front: whether this is a whole-file create (a single empty
    // SEARCH) decides whether a not-found target is legitimate — 3a.
    let blocks;
    try {
      blocks = parseEditBlocks(args.edits);
    } catch (e) {
      if (e instanceof EditParseError) return { ok: false, error: e.message, code: 'edit_parse_error' };
      return { ok: false, error: `edit_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    const isCreate = isWholeFileCreate(blocks);

    // Read current content, distinguishing three outcomes (3a) so a typo'd
    // path is never silently laundered into a whole-file create:
    //   • found  → edit against the real bytes
    //   • absent → legitimate ONLY for a whole-file create (empty SEARCH)
    //   • failed → an OPFS/permission fault, surfaced, never a silent empty
    const target = {
      kind, targetId: typeof args.targetId === 'string' ? args.targetId : null,
      path: args.path,
    };
    const read = await authority.readEditTarget(target);
    if (!read?.ok) return read;
    const source = read.source;
    const fileExists = read.exists;

    if (!fileExists && !isCreate) {
      // An anchored edit against a path that doesn't exist is a typo, not a
      // moved anchor — say so precisely instead of a misleading not-found (3a).
      const listTool = kind === 'app' ? 'app_list_files' : 'js_read_file';
      return {
        ok: false,
        code: 'file_not_found',
        error: `file_not_found: no ${kind} file at "${args.path}" — check the path (${listTool}) or use an empty SEARCH block to create it`,
      };
    }

    let result;
    try {
      const applied = applyBlocks(source, blocks);
      result = { content: applied.text, blocks: blocks.length, alreadyApplied: applied.alreadyApplied };
    } catch (e) {
      // Map the typed errors to stable codes the model can react to.
      if (e instanceof SearchNotFoundError) return { ok: false, error: e.message, code: 'search_not_found', blockIndex: e.blockIndex, ...(e.whitespace ? { whitespace: true, line: e.line } : {}) };
      // why: locations[].preview holds untrusted file bytes — they ride the
      // STRUCTURED result only, and must never be concatenated into model-visible
      // text unfenced (the message stays line-numbers-only; agent-loop serializes
      // only .error). Fence the previews first if that ever changes.
      if (e instanceof SearchAmbiguousError) return { ok: false, error: e.message, code: 'search_ambiguous', blockIndex: e.blockIndex, count: e.count, locations: e.locations };
      if (e instanceof EditParseError) return { ok: false, error: e.message, code: 'edit_parse_error' };
      return { ok: false, error: `edit_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }

    const encoder = new TextEncoder();
    const contentBytes = encoder.encode(result.content).byteLength;
    const existingBytes = fileExists ? encoder.encode(source).byteLength : 0;
    // Imported/dweb Apps may legitimately contain a pre-built file larger than
    // the model-facing creation cap (Charon's self-contained bundle is one).
    // Anchored edits do not re-emit that file through the model, so retain it
    // and permit at most one normal file-cap of growth. New/small files keep
    // the strict authoring rail; the App client independently enforces 50 MB
    // across the complete workspace at the physical OPFS boundary.
    const contentLimit = kind === 'app'
      ? (existingBytes > MAX_MODEL_APP_FILE_BYTES
          ? Math.min(MAX_NETWORK_BUNDLE_BYTES, existingBytes + MAX_MODEL_APP_FILE_BYTES)
          : MAX_MODEL_APP_FILE_BYTES)
      : MAX_CONTENT_CHARS;
    const contentSize = kind === 'app' ? contentBytes : result.content.length;
    if (contentSize > contentLimit) {
      return { ok: false, error: `content_too_large: ${contentSize} > ${contentLimit}` };
    }

    try {
      await authority.writeEditTarget({ ...target, content: result.content });
    } catch (e) {
      return { ok: false, error: `write_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }

    return {
      ok: true,
      content: JSON.stringify({
        // echo the target path so a create's destination is visible in the
        // result (3a), not just assumed.
        path: args.path,
        kind,
        blocks: result.blocks,
        bytes: contentBytes,
        // 3b: an already-in-place edit succeeds and says so — with the 0-based
        // block indices, so a multi-block result isn't ambiguous about which
        // landed vs. was skipped — so the agent stops retrying instead of
        // reading a search_not_found.
        ...(result.alreadyApplied.length > 0
          ? { alreadyApplied: true, alreadyAppliedBlocks: result.alreadyApplied }
          : {}),
      }, null, 2),
    };
  },
});
