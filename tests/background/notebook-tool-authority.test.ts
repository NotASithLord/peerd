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
  test('Stop during the coordinated destroy probe prevents every physical edge', async () => {
    let releaseProbe!: () => void;
    let probeStarted!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    const controller = new AbortController();
    const shared: any = {};
    let reads = 0;
    let closes = 0;
    let destroys = 0;
    let deletes = 0;
    const ctx = context({
      actorType: 'notebook', actorInstanceId: 'notebook-1',
      jsRegistry: {
        get: async () => {
          reads += 1;
          if (reads === 2) {
            probeStarted();
            await probeGate;
          }
          return { id: 'notebook-1', name: 'work', pinned: false };
        },
        delete: async () => { deletes += 1; },
      },
      jsTabTracker: { closeTab: async () => { closes += 1; } },
      repositories: {
        coordinate: async (_ref: unknown, operation: () => Promise<unknown>) => operation(),
        destroy: async () => { destroys += 1; },
      },
    });
    const read = createNotebookToolAuthority({
      binding: { operation: 'turn.notebook.read', args: { notebookId: 'notebook-1' } },
      ctx, signal: controller.signal, shared,
    });
    await read.readNotebook('notebook-1');
    const destroy = createNotebookToolAuthority({
      binding: { operation: 'turn.notebook.destroy', args: { notebookId: 'notebook-1' } },
      ctx, signal: controller.signal, shared,
    });
    const pending = destroy.destroyNotebook('notebook-1');
    await started;
    controller.abort();
    releaseProbe();
    await expect(pending).rejects.toMatchObject({
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
    });
    expect(closes).toBe(0);
    expect(destroys).toBe(0);
    expect(deletes).toBe(0);
  });

  test('runs semantic formatting against an admitted worker execution', async () => {
    const call = { name: 'js_notebook', args: { code: 'return 42', notebook: 'work' } };
    const authority = {
      readNotebook: async () => ({ id: 'notebook-1', name: 'work', pinned: false }),
      listNotebooks: async () => [{ id: 'notebook-1', name: 'work' }],
      setDefaultNotebook: async () => undefined,
      runNotebook: async () => ({ durationMs: 2, value: 42 }),
    };
    const result = await executeControllerNotebookTool(
      'js_notebook', call.args, authority, { signal },
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.content).toContain('[VALUE]');
  });

  test('refuses a changed file target after admission', async () => {
    const authority = createNotebookToolAuthority({
      binding: {
        operation: 'turn.notebook.write-file',
        args: { path: 'safe.js', content: 'safe', notebookId: undefined },
      },
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
    const authority = { readFile: async () => 'untrusted text' };
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
    const ctx = context({
        jsRegistry: {
          get: async () => ({
            id: 'notebook-1', name: 'work', pinned: reads++ > 0,
          }),
          delete: async () => { destroyed = true; },
        },
      });
    const shared: any = {};
    const read = createNotebookToolAuthority({
      binding: { operation: 'turn.notebook.read', args: { notebookId: 'notebook-1' } },
      ctx, signal, shared,
    });
    await read.readNotebook('notebook-1');
    const destroy = createNotebookToolAuthority({
      binding: { operation: 'turn.notebook.destroy', args: { notebookId: 'notebook-1' } },
      ctx, signal, shared,
    });
    await expect(destroy.destroyNotebook('notebook-1')).rejects
      .toThrow('Notebook authority mismatch');
    expect(destroyed).toBe(false);
  });
});
