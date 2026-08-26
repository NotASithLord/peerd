import { describe, expect, test } from 'bun:test';
import { createNotebookToolAuthority } from '../../extension/background/notebook-tool-authority.js';
import { executeControllerNotebookTool } from '../../extension/peerd-runtime/controller-notebook-tools.js';

const signal = new AbortController().signal;
const context = (overrides: Record<string, any> = {}) => ({
  session: { sessionId: 'session-1' },
  jsClient: {
    eval: async () => ({ durationMs: 2, value: 42 }),
    writeFile: async () => undefined,
    readFile: async () => 'hello',
  },
  jsRegistry: {
    get: async (id: string) => ({ id, name: 'work', pinned: false }),
    list: async () => [{ id: 'notebook-1', name: 'work' }],
    setDefaultForSession: async () => undefined,
    delete: async () => undefined,
  },
  jsTabTracker: { closeTab: async () => undefined },
  repositories: {
    coordinate: async (_ref: unknown, operation: () => Promise<unknown>) => operation(),
    destroy: async () => undefined,
  },
  ...overrides,
});

describe('exact Notebook authority', () => {
  test('runs semantic formatting against an admitted worker execution', async () => {
    const call = { name: 'js_notebook', args: { code: 'return 42', notebook: 'work' } };
    const authority = createNotebookToolAuthority({ call, ctx: context(), signal });
    const result = await executeControllerNotebookTool(
      'js_notebook', call.args, authority, { signal },
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.content).toContain('[VALUE]');
  });

  test('refuses a changed file target after admission', async () => {
    const authority = createNotebookToolAuthority({
      call: { name: 'js_write_file', args: { path: 'safe.js', content: 'safe' } },
      ctx: context(), signal,
    });
    let failure: any;
    try { await authority.writeFile('other.js', 'safe', undefined); }
    catch (cause) { failure = cause; }
    expect(failure).toMatchObject({
      message: 'Notebook authority mismatch', outcomeKnown: true,
    });
  });

  test('keeps file contents fenced in controller result shaping', async () => {
    const call = { name: 'js_read_file', args: { path: 'data.txt' } };
    const authority = createNotebookToolAuthority({
      call, ctx: context({ jsClient: { readFile: async () => 'untrusted text' } }), signal,
    });
    const result = await executeControllerNotebookTool(
      'js_read_file', call.args, authority, { signal },
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.content).toContain('<untrusted_web_content');
    expect(result.content).toContain('untrusted text');
  });

  test('rechecks pin state under repository coordination before destruction', async () => {
    let reads = 0;
    let destroyed = false;
    const authority = createNotebookToolAuthority({
      call: { name: 'js_delete', args: { notebookId: 'notebook-1' } },
      ctx: context({
        jsRegistry: {
          get: async () => ({
            id: 'notebook-1', name: 'work', pinned: reads++ > 0,
          }),
          delete: async () => { destroyed = true; },
        },
      }),
      signal,
    });
    const result = await executeControllerNotebookTool(
      'js_delete', { notebookId: 'notebook-1' }, authority, { signal },
    );
    expect(result).toMatchObject({ ok: false });
    expect(destroyed).toBe(false);
  });
});
