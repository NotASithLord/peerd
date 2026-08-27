import { describe, expect, test } from 'bun:test';
import { createAppSandbox } from '../../extension/peerd-runtime/tools/defs/app-create.js';
import { appWriteFileTool } from '../../extension/peerd-runtime/tools/defs/app-write-file.js';
import { executionToolContext } from '../helpers/execution-tool.js';

const writeContext = () => {
  const calls: any[] = [];
  return {
    calls,
    ctx: {
      appAuthority: {
        writeFile: async (appId: string | undefined, path: string, content: unknown) => {
          calls.push({ appId, path, content });
          return { bytesWritten: 3 };
        },
      },
    },
  };
};

describe('app_write_file binary contract', () => {
  test('requires exactly one content representation and accepts empty text', async () => {
    const { ctx } = writeContext();
    expect((await appWriteFileTool.execute({ path: 'x.txt' }, ctx as any)).ok).toBe(false);
    expect((await appWriteFileTool.execute({ path: 'x.txt', content: '', contentBase64: '' }, ctx as any)).ok).toBe(false);
    expect((await appWriteFileTool.execute({ path: 'x.txt', content: '' }, ctx as any)).ok).toBe(true);
  });

  test('rejects invalid base64 and text for a known binary suffix', async () => {
    const { ctx } = writeContext();
    expect((await appWriteFileTool.execute({ path: 'x.custom', contentBase64: '***' }, ctx as any) as any).error)
      .toBe('contentBase64_invalid');
    expect((await appWriteFileTool.execute({ path: 'x.wasm', content: 'text' }, ctx as any) as any).error)
      .toBe('binary_asset_requires_contentBase64');
  });

  test('accepts base64 for an unknown suffix and reports exact bytes', async () => {
    const { ctx, calls } = writeContext();
    const result = await appWriteFileTool.execute({ path: 'model.custom', contentBase64: 'AP8B' }, ctx as any);
    expect(result.ok).toBe(true);
    expect(calls[0].content).toEqual({ base64: 'AP8B' });
    expect(JSON.parse(String(result.content)).bytes).toBe(3);
  });

  test('measures the UTF-8 byte boundary, not UTF-16 length', async () => {
    const { ctx } = writeContext();
    const atLimit = '😀'.repeat(125_000);
    expect((await appWriteFileTool.execute({ path: 'x.txt', content: atLimit }, ctx as any)).ok).toBe(true);
    const over = await appWriteFileTool.execute({ path: 'x.txt', content: `${atLimit}a` }, ctx as any);
    expect(over.ok).toBe(false);
    expect((over as any).error).toContain('500001 > 500000 bytes');
  });
});

describe('sandbox_create App binary contract', () => {
  const context = () => {
    const calls: any[] = [];
    return {
      calls,
      ctx: executionToolContext({
        session: { sessionId: `s-create-${Math.random()}` },
        appClient: {
          create: async (args: any) => {
            calls.push(args);
            return { id: 'app-1', name: args.name, entryFile: args.entryFile ?? 'index.html' };
          },
          open: async () => {},
        },
      }),
    };
  };

  test('accepts unknown-suffix base64 and refuses known-binary text', async () => {
    const { ctx, calls } = context();
    const accepted = await createAppSandbox({
      name: 'typed',
      files: { 'index.html': '<h1>x</h1>', 'model.custom': { base64: 'QUJD' } },
    }, ctx as any);
    expect(accepted.ok).toBe(true);
    expect(calls[0].files['model.custom']).toEqual({ base64: 'QUJD' });
    const refused = await createAppSandbox({
      name: 'bad', files: { 'index.html': '<h1>x</h1>', 'engine.wasm': 'text' },
    }, ctx as any);
    expect((refused as any).error).toBe('binary_asset_requires_base64: engine.wasm');
  });

  test('applies the per-file UTF-8 byte cap', async () => {
    const { ctx } = context();
    const result = await createAppSandbox({
      name: 'large', files: { 'index.html': '😀'.repeat(125_001) },
    }, ctx as any);
    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('500004 > 500000 bytes');
  });
});

describe('sandbox_create App Git contract', () => {
  test('clones without an inline file map while preserving confirmation and repository metadata', async () => {
    const controller = new AbortController();
    const cloneCalls: any[] = [];
    const confirmations: any[] = [];
    const result = await createAppSandbox({
      gitUrl: 'https://github.com/example/browser-app',
      gitRef: 'release',
      gitDepth: 900,
    }, executionToolContext({
      session: { sessionId: 's-git-app' },
      abortSignal: controller.signal,
      confirm: async (prompt: any, signal: AbortSignal) => {
        confirmations.push({ prompt, signal });
        return 'yes_once';
      },
      appClient: {
        createFromGit: async (args: any) => {
          cloneCalls.push(args);
          return {
            record: { id: 'app-git', name: 'browser-app', entryFile: 'index.html' },
            repository: { branch: 'release', oid: 'abc123' },
            contract: { entryFile: 'index.html' },
          };
        },
        open: async () => {},
      },
    }) as any);

    expect(result.ok).toBe(true);
    expect(confirmations[0].signal).toBe(controller.signal);
    expect(confirmations[0].prompt.origins).toEqual(['https://github.com']);
    expect(cloneCalls[0]).toMatchObject({
      url: 'https://github.com/example/browser-app.git',
      ref: 'release',
      depth: 500,
      signal: controller.signal,
    });
    const summary = JSON.parse(String(result.content).split('\n\n', 1)[0]);
    expect(summary.fileCount).toBeUndefined();
    expect(summary.repository).toEqual({ branch: 'release', oid: 'abc123' });
    expect(summary.contract).toEqual({ entryFile: 'index.html' });
  });
});
