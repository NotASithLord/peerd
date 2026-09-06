// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// vm_write_file — write a string as a file in the VM.
//
// For inline content the agent generates (a Python script, a config
// file, a sample input). Strings travel through the model already, so
// there's no point base64-encoding bytes here — agents that need to
// drop binary in should use vm_import (URL-sourced bytes) instead.

const MAX_CONTENT_CHARS = 200_000;  // ~200KB of UTF-8 text

/** @type {import('/shared/tool-types.js').Tool} */
export const vmWriteFileTool = composeTool("vm_write_file", {

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string' || !args.path.startsWith('/')) {
      return { ok: false, error: 'path_required_absolute' };
    }
    if (typeof args?.content !== 'string') {
      return { ok: false, error: 'content_required' };
    }
    if (args.content.length > MAX_CONTENT_CHARS) {
      return { ok: false, error: `content_too_large: ${args.content.length} > ${MAX_CONTENT_CHARS}` };
    }
    const bytes = new TextEncoder().encode(args.content);
    const authority = /** @type {{ writeTextFile?: (path:string,content:string)=>Promise<unknown> }} */ (
      /** @type {any} */ (ctx).vmAuthority);
    if (!authority?.writeTextFile) return { ok: false, error: 'vm_not_available' };
    try {
      await authority.writeTextFile(args.path, args.content);
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: `write_threw: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    }
    return {
      ok: true,
      content: JSON.stringify({ path: args.path, bytes: bytes.byteLength }, null, 2),
    };
  },
});
