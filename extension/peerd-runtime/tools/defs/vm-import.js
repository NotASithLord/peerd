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

/** @type {import('/shared/tool-types.js').Tool} */
export const vmImportTool = composeTool("vm_import", {

  execute: async (args, ctx) => {
    if (typeof args?.url !== 'string') return { ok: false, error: 'url_required' };
    if (typeof args?.path !== 'string' || !args.path.startsWith('/')) {
      return { ok: false, error: 'path_required_absolute' };
    }
    const authority = /** @type {{ importFile?: (url:string,path:string,maxBytes:number)=>Promise<{bytes:number,status:number,contentType:string}> }} */ (
      /** @type {any} */ (ctx).vmAuthority);
    if (!authority?.importFile) return { ok: false, error: 'vm_not_available' };
    try {
      const result = await authority.importFile(args.url, args.path, MAX_BYTES);
      return {
        ok: true,
        content: JSON.stringify({
          url: args.url, path: args.path, bytes: result.bytes,
          status: result.status, contentType: result.contentType,
        }, null, 2),
      };
    } catch (e) {
      const err = /** @type {{ name?: string, message?: string }} */ (e);
      return { ok: false, error: err?.message ?? String(e) };
    }
  },
});
