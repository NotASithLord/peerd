// @ts-check
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
export const vmImportTool = {
  name: 'vm_import',
  primitive: 'webvm',
  description: [
    'Download a URL and write the bytes into a VM at `path`. The fetch',
    'runs IN PEERD (through peerd-egress: denylist + audit), NOT inside',
    'the VM. Use it to stage large or binary data, or anything apt / pip',
    'install / raw Python sockets would need (those have no network inside',
    'the VM). An error here is peerd-side (denylist, unreachable host, VM',
    'not booted) — read it verbatim; the VM never tried. Max 50MB.',
    'Returns the written path and byte count.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'http(s) URL to fetch.',
      },
      path: {
        type: 'string',
        description: 'Absolute path inside the VM where the bytes land (e.g. /tmp/repo.zip).',
      },
    },
    required: ['url', 'path'],
  },
  sideEffect: 'write',
  origins: (args) => {
    try { return [new URL(args.url).origin]; }
    catch { return []; }
  },

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
};
