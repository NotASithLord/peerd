// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// vm_import — download a URL and drop it into the VM rootfs.
//
// Bridges the agent's web access (denylist + audit) with the VM
// sandbox. The bytes flow: webFetch (SW) → response.arrayBuffer →
// vm.writeFile (offscreen). They never round-trip through the model,
// so a 50MB tarball is the same prompt cost as a 1KB script.
//
// This is the canonical way to seed the VM with artifacts the agent
// then runs. Pattern: vm_import(zip_url, /tmp/repo.zip) →
// vm_boot("cd /tmp && unzip -q repo.zip && cd repo-* && pip install .").

const MAX_BYTES = 50 * 1024 * 1024;  // 50MB cap per fetch

/**
 * The vm writeFile() surface vm_import exercises (offscreen VM client).
 * @typedef {Object} VmWriter
 * @property {(path: string, bytes: Uint8Array, opts: { sessionId?: string }) => Promise<unknown>} writeFile
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const vmImportTool = composeTool("vm_import", {

  execute: async (args, ctx) => {
    if (typeof args?.url !== 'string') return { ok: false, error: 'url_required' };
    if (typeof args?.path !== 'string' || !args.path.startsWith('/')) {
      return { ok: false, error: 'path_required_absolute' };
    }
    // why: ctx.vm is the opaque `Object` contract slot; narrow it to the
    // writeFile() surface this tool exercises.
    const vm = /** @type {VmWriter | undefined} */ (ctx.vm);
    if (!vm || typeof vm.writeFile !== 'function') {
      return { ok: false, error: 'vm_not_available' };
    }
    if (typeof ctx.webFetch !== 'function') {
      return { ok: false, error: 'web_fetch_not_available' };
    }
    /** @type {Uint8Array} */
    let bytes;
    /** @type {number} */
    let status;
    let contentType;
    try {
      const res = await ctx.webFetch(args.url);
      status = res.status;
      contentType = res.headers.get('content-type') ?? '';
      if (!res.ok) {
        return { ok: false, error: `fetch_failed: HTTP ${res.status}` };
      }
      const ab = await res.arrayBuffer();
      if (ab.byteLength > MAX_BYTES) {
        return { ok: false, error: `payload_too_large: ${ab.byteLength}B > ${MAX_BYTES}B` };
      }
      bytes = new Uint8Array(ab);
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: `fetch_threw: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    }
    try {
      await vm.writeFile(args.path, bytes, {
        sessionId: ctx.session?.sessionId,
      });
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: `write_threw: ${err?.name ?? 'Error'}: ${err?.message ?? String(e)}` };
    }
    return {
      ok: true,
      content: JSON.stringify({
        url: args.url, path: args.path,
        bytes: bytes.byteLength, status, contentType,
      }, null, 2),
    };
  },
});
