// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// app_write_file — write a single file inside an App's OPFS subtree.

import { isBinaryAssetPath, MAX_MODEL_APP_FILE_BYTES } from '/peerd-engine/app-assets.js';
import { base64ByteLength } from '/shared/bundle/bytes.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const appWriteFileTool = composeTool("app_write_file", {

  execute: async (args, ctx) => {
    if (typeof args?.path !== 'string' || !args.path) {
      return { ok: false, error: 'path_required' };
    }
    const hasText = typeof args?.content === 'string';
    const hasBinary = typeof args?.contentBase64 === 'string';
    if (hasText === hasBinary) {
      return { ok: false, error: 'provide exactly one of content or contentBase64' };
    }
    if (isBinaryAssetPath(args.path) && hasText) {
      return { ok: false, error: 'binary_asset_requires_contentBase64' };
    }
    let size;
    try {
      size = hasBinary
        ? base64ByteLength(args.contentBase64)
        : new TextEncoder().encode(args.content).byteLength;
    } catch {
      return { ok: false, error: 'contentBase64_invalid' };
    }
    if (size > MAX_MODEL_APP_FILE_BYTES) {
      return { ok: false, error: `content_too_large: ${size} > ${MAX_MODEL_APP_FILE_BYTES} bytes` };
    }
    // why: appClient rides the opaque ctx contract (not on ToolContext); narrow
    // to the one method this tool calls.
    const appClient = /** @type {{ writeFile?: (opts: { appId?: string, path: string, content: unknown, sessionId?: string }) => Promise<{ bytesWritten?: number }> } | undefined} */ (
      /** @type {any} */ (ctx).appClient);
    if (!appClient?.writeFile) return { ok: false, error: 'app_not_available' };
    try {
      const written = await appClient.writeFile({
        appId: args.appId,
        path: args.path,
        content: hasBinary ? { base64: args.contentBase64 } : args.content,
        sessionId: ctx.session?.sessionId,
      });
      return {
        ok: true,
        content: JSON.stringify({
          path: args.path,
          bytes: written.bytesWritten ?? size,
          binary: hasBinary,
        }, null, 2),
      };
    } catch (e) {
      return { ok: false, error: `app_write_file_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
  },
});
