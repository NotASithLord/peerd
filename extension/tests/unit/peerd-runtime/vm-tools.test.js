// @ts-check
// vm_boot / vm_import / vm_write_file — outer tool surfaces.
//
// The actual VmHost lives in the offscreen doc and the SW client
// proxies via runtime.sendMessage. Here we test the tools themselves
// with an injected ctx.vm stub.

import { describe, it, expect } from '../../framework.js';
import {
  vmBootTool, vmImportTool, vmWriteFileTool, BUILTIN_TOOLS,
} from '/peerd-runtime/tools/defs/index.js';

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
  vm: {
    run: async () => ({ stdout: 'hi\n', stderr: '', exitCode: 0, durationMs: 12 }),
    writeFile: async () => {},
    isReady: async () => true,
    reset: async () => {},
  },
  webFetch: async () => new Response('ZIP-BYTES', {
    status: 200, headers: { 'content-type': 'application/zip' },
  }),
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

  it('reports vm_not_available when ctx.vm missing', async () => {
    const r = await vmBootTool.execute({ cmd: 'ls' }, mockCtx({ vm: undefined }));
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('vm_not_available');
  });

  it('formats stdout/stderr/exit into the content body', async () => {
    const r = await vmBootTool.execute({ cmd: 'echo hi' }, mockCtx({
      vm: {
        run: async () => ({ stdout: 'hi\n', stderr: 'warn\n', exitCode: 2, durationMs: 87 }),
        writeFile: async () => {},
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
      vm: { run: async (/** @type {string} */ cmd, /** @type {{ timeoutMs: number }} */ opts) => { captured = opts.timeoutMs; return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 }; }, writeFile: async () => {} },
    });
    await vmBootTool.execute({ cmd: 'x', timeoutMs: 5 }, ctx);
    expect(captured).toBe(1000);
    await vmBootTool.execute({ cmd: 'x', timeoutMs: 999_999 }, ctx);
    expect(captured).toBe(300_000);
  });

  it('surfaces typed errors from ctx.vm.run', async () => {
    const ctx = mockCtx({
      vm: {
        run: async () => { const e = new Error('boom'); e.name = 'VMRunTimeoutError'; throw e; },
        writeFile: async () => {},
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

  it('routes through webFetch and writes bytes into vm.writeFile', async () => {
    /** @type {string | undefined} */
    let writtenPath;
    /** @type {Uint8Array | undefined} */
    let writtenBytes;
    const ctx = mockCtx({
      vm: {
        run: async () => ({}),
        writeFile: async (/** @type {string} */ path, /** @type {Uint8Array} */ bytes) => { writtenPath = path; writtenBytes = bytes; },
      },
    });
    const r = await vmImportTool.execute({
      url: 'https://example.com/repo.zip',
      path: '/tmp/repo.zip',
    }, ctx);
    expect(r.ok).toBe(true);
    expect(writtenPath).toBe('/tmp/repo.zip');
    expect(writtenBytes instanceof Uint8Array).toBe(true);
    expect((writtenBytes?.length ?? 0) > 0).toBe(true);
  });

  it('rejects payloads over 50MB', async () => {
    const big = new Uint8Array(51 * 1024 * 1024);
    const ctx = mockCtx({
      webFetch: async () => new Response(big, { status: 200 }),
    });
    const r = await vmImportTool.execute({
      url: 'https://example.com/huge', path: '/tmp/x',
    }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).includes('payload_too_large')).toBe(true);
  });

  it('surfaces non-2xx HTTP as fetch_failed', async () => {
    const ctx = mockCtx({
      webFetch: async () => new Response('not found', { status: 404 }),
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

  it('encodes content as UTF-8 bytes', async () => {
    /** @type {Uint8Array | undefined} */
    let captured;
    const ctx = mockCtx({
      vm: { run: async () => ({}), writeFile: async (/** @type {string} */ p, /** @type {Uint8Array} */ b) => { captured = b; } },
    });
    const r = await vmWriteFileTool.execute({
      path: '/tmp/hello.py', content: 'print("héllo")',
    }, ctx);
    expect(r.ok).toBe(true);
    expect(captured instanceof Uint8Array).toBe(true);
    // 'héllo' has a 2-byte é; total UTF-8 length is 15.
    expect(captured?.length).toBe(15);
  });
});

describe('VM tools — registration', () => {
  it('all three are in BUILTIN_TOOLS', () => {
    const names = BUILTIN_TOOLS.map(t => t.name);
    expect(names.includes('vm_boot')).toBe(true);
    expect(names.includes('vm_import')).toBe(true);
    expect(names.includes('vm_write_file')).toBe(true);
  });

  it('all carry the webvm primitive', () => {
    expect(vmBootTool.primitive).toBe('webvm');
    expect(vmImportTool.primitive).toBe('webvm');
    expect(vmWriteFileTool.primitive).toBe('webvm');
  });
});
