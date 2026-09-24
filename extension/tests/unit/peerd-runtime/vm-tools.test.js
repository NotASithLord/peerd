// @ts-check
// vm_boot / vm_import / vm_write_file — outer tool surfaces.
//
// The actual VmHost lives in the offscreen doc and the SW client
// proxies via runtime.sendMessage. Here we test the tools themselves
// with an injected ctx.vm stub.

import { describe, it, expect } from '../../framework.js';
import { vmBootTool } from '/peerd-runtime/tools/defs/vm-boot.js';
import { vmImportTool } from '/peerd-runtime/tools/defs/vm-import.js';
import { vmWriteFileTool } from '/peerd-runtime/tools/defs/vm-write-file.js';
import { CONTROLLER_VM_TOOL_NAMES } from '/peerd-runtime/controller-vm-tools.js';

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @param {import('/shared/tool-types.js').ToolResult} r @returns {any} */
const okContent = (r) => /** @type {import('/shared/tool-types.js').ToolResultOk} */ (r).content;
/** @param {import('/shared/tool-types.js').ToolResult} r @returns {string} */
const errOf = (r) => /** @type {import('/shared/tool-types.js').ToolResultErr} */ (r).error;

/**
 * @param {Record<string, any>} [overrides]
 * @returns {ToolContext}
 */
const mockCtx = (overrides = {}) => /** @type {ToolContext} */ (/** @type {unknown} */ ({
  session: { sessionId: 's1' },
  vmAuthority: {
    runVm: async () => ({ stdout: 'hi\n', stderr: '', exitCode: 0, durationMs: 12 }),
    importFile: async () => ({ bytes: 9, status: 200, contentType: 'application/zip' }),
    writeTextFile: async () => {},
  },
  ...overrides,
}));

describe('vm_boot', () => {
  it('rejects missing cmd', async () => {
    const r = await vmBootTool.execute({}, mockCtx());
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('cmd_required');
  });

  it('rejects empty cmd', async () => {
    const r = await vmBootTool.execute({ cmd: '' }, mockCtx());
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('cmd_required');
  });

  it('reports vm_not_available when VM authority is missing', async () => {
    const r = await vmBootTool.execute({ cmd: 'ls' }, mockCtx({ vmAuthority: undefined }));
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('vm_not_available');
  });

  it('formats stdout/stderr/exit into the content body', async () => {
    const r = await vmBootTool.execute({ cmd: 'echo hi' }, mockCtx({
      vmAuthority: {
        runVm: async () => ({ stdout: 'hi\n', stderr: 'warn\n', exitCode: 2, durationMs: 87 }),
      },
    }));
    expect(r.ok).toBe(true);
    expect(okContent(r).includes('$ echo hi')).toBe(true);
    expect(okContent(r).includes('[exit 2 in 87ms]')).toBe(true);
    expect(okContent(r).includes('[STDOUT]')).toBe(true);
    expect(okContent(r).includes('hi')).toBe(true);
    expect(okContent(r).includes('[STDERR]')).toBe(true);
    expect(okContent(r).includes('warn')).toBe(true);
  });

  it('clamps timeoutMs into the [1000, 300000] range', async () => {
    /** @type {number | undefined} */
    let captured;
    const ctx = mockCtx({
      vmAuthority: { runVm: async (/** @type {string} */ cmd, /** @type {number} */ timeoutMs) => { captured = timeoutMs; return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 }; } },
    });
    await vmBootTool.execute({ cmd: 'x', timeoutMs: 5 }, ctx);
    expect(captured).toBe(1000);
    await vmBootTool.execute({ cmd: 'x', timeoutMs: 999_999 }, ctx);
    expect(captured).toBe(300_000);
  });

  it('surfaces typed errors from ctx.vm.run', async () => {
    const ctx = mockCtx({
      vmAuthority: {
        runVm: async () => { const e = new Error('boom'); e.name = 'VMRunTimeoutError'; throw e; },
      },
    });
    const r = await vmBootTool.execute({ cmd: 'sleep 9999' }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('VMRunTimeoutError')).toBe(true);
    expect(errOf(r).includes('boom')).toBe(true);
  });
});

describe('vm_import', () => {
  // why: vmImportTool.origins ignores ctx (it derives origin from args.url
  // only), but the Tool type declares the 2-arg signature. Narrow the
  // reference to its real 1-arg shape for the origin-derivation tests.
  const importOrigins = /** @type {(args: any) => string[]} */ (vmImportTool.origins);

  it('rejects missing url', async () => {
    const r = await vmImportTool.execute({ path: '/tmp/x' }, mockCtx());
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('url_required');
  });

  it('rejects relative path', async () => {
    const r = await vmImportTool.execute({ url: 'https://example.com/x', path: 'rel' }, mockCtx());
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('path_required_absolute');
  });

  it('passes the admitted URL and path to the exact import authority', async () => {
    /** @type {string | undefined} */
    let writtenPath;
    /** @type {string | undefined} */
    let fetchedUrl;
    const ctx = mockCtx({
      vmAuthority: {
        importFile: async (/** @type {string} */ url, /** @type {string} */ path) => {
          fetchedUrl = url; writtenPath = path;
          return { bytes: 9, status: 200, contentType: 'application/zip' };
        },
      },
    });
    const r = await vmImportTool.execute({
      url: 'https://example.com/repo.zip',
      path: '/tmp/repo.zip',
    }, ctx);
    expect(r.ok).toBe(true);
    expect(fetchedUrl).toBe('https://example.com/repo.zip');
    expect(writtenPath).toBe('/tmp/repo.zip');
  });

  it('rejects payloads over 50MB', async () => {
    const ctx = mockCtx({
      vmAuthority: { importFile: async () => { throw new Error('payload_too_large: 53477376B'); } },
    });
    const r = await vmImportTool.execute({
      url: 'https://example.com/huge', path: '/tmp/x',
    }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('payload_too_large')).toBe(true);
  });

  it('surfaces non-2xx HTTP as fetch_failed', async () => {
    const ctx = mockCtx({
      vmAuthority: { importFile: async () => { throw new Error('fetch_failed: HTTP 404'); } },
    });
    const r = await vmImportTool.execute({
      url: 'https://example.com/missing', path: '/tmp/x',
    }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('HTTP 404')).toBe(true);
  });

  it('exposes the URL origin for the egress gate', () => {
    const origins = importOrigins({ url: 'https://github.com/x/y/archive/main.zip' });
    expect(origins).toEqual(['https://github.com']);
  });

  it('returns no origin when url is missing/invalid', () => {
    expect(importOrigins({})).toEqual([]);
    expect(importOrigins({ url: 'not a url' })).toEqual([]);
  });
});

describe('vm_write_file', () => {
  it('rejects relative path', async () => {
    const r = await vmWriteFileTool.execute({
      path: 'rel.py', content: 'print(1)',
    }, mockCtx());
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('path_required_absolute');
  });

  it('rejects non-string content', async () => {
    const r = await vmWriteFileTool.execute({
      path: '/tmp/x', content: 42,
    }, mockCtx());
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('content_required');
  });

  it('rejects content over 200000 chars', async () => {
    const r = await vmWriteFileTool.execute({
      path: '/tmp/x', content: 'x'.repeat(200_001),
    }, mockCtx());
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('content_too_large')).toBe(true);
  });

  it('passes exact text to the VM authority and reports UTF-8 bytes', async () => {
    /** @type {string | undefined} */
    let captured;
    const ctx = mockCtx({
      vmAuthority: { writeTextFile: async (/** @type {string} */ p, /** @type {string} */ text) => { captured = text; } },
    });
    const r = await vmWriteFileTool.execute({
      path: '/tmp/hello.py', content: 'print("héllo")',
    }, ctx);
    expect(r.ok).toBe(true);
    expect(captured).toBe('print("héllo")');
    expect(okContent(r).includes('"bytes": 15')).toBe(true);
  });
});

describe('VM tools — registration', () => {
  it('all four belong to the controller VM domain', () => {
    expect(CONTROLLER_VM_TOOL_NAMES).toEqual([
      'vm_boot', 'vm_import', 'vm_write_file', 'vm_delete',
    ]);
  });

  it('all carry the webvm primitive', () => {
    expect(vmBootTool.primitive).toBe('webvm');
    expect(vmImportTool.primitive).toBe('webvm');
    expect(vmWriteFileTool.primitive).toBe('webvm');
  });
});
