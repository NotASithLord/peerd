import { describe, test, expect } from 'bun:test';
import { createAppSandbox } from '../../extension/peerd-runtime/tools/defs/app-create.js';
import { executionToolContext } from '../helpers/execution-tool.js';

// The bug this guards: a self-authored multiplayer app got NO dweb bridge because
// app_create never set the dweb metadata SLOT (app-tab.js attachDwebBridge gates
// on appMeta.dweb). dwapp:true now sets it — but only when the dweb is on.
// (app_create merged into sandbox_create; this exercises its app arm directly.)
const makeCtx = (dwebOn: boolean) => {
  const calls: any[] = [];
  const raw = {
    dweb: dwebOn ? {} : null,
    session: { sessionId: 's1' },
    appClient: {
      create: async (opts: any) => { calls.push(opts); return { id: 'a1', name: opts.name, entryFile: opts.entryFile ?? 'index.html' }; },
      open: async () => {},
    },
  };
  return { ctx: executionToolContext(raw), raw, calls };
};

describe('sandbox_create app arm — dwapp:true attaches the bridge-unlocking dweb slot', () => {
  test('dwapp:true (dweb on) → app is created WITH a dweb slot + the dweb tag', async () => {
    const { ctx, calls } = makeCtx(true);
    const r = await createAppSandbox({ name: 'pong', html: '<h1>pong</h1>', dwapp: true }, ctx as any);
    expect(r.ok).toBe(true);
    expect(calls[0].dweb).toEqual({ uri: null, publisher: null, hash: null, local: true });
    expect(calls[0].tags).toContain('dweb');           // surfaces as dweb-capable in the Library
  });

  test('no dwapp flag → a normal app (no dweb slot, so no bridge — the default)', async () => {
    const { ctx, calls } = makeCtx(true);
    await createAppSandbox({ name: 'todo', html: '<h1>todo</h1>' }, ctx as any);
    expect(calls[0].dweb).toBeUndefined();
  });

  test('dwapp:true is INERT when the dweb is off (store / dweb-off) — no slot', async () => {
    const { ctx, calls } = makeCtx(false);
    await createAppSandbox({ name: 'pong', html: '<h1>pong</h1>', dwapp: true }, ctx as any);
    expect(calls[0].dweb).toBeUndefined();
  });

  test('dwapp:true merges (not clobbers) existing tags', async () => {
    const { ctx, calls } = makeCtx(true);
    await createAppSandbox({ name: 'pong', html: '<h1>x</h1>', dwapp: true, tags: ['game'] }, ctx as any);
    expect(calls[0].tags).toEqual(expect.arrayContaining(['game', 'dweb']));
  });

  test('reports a durable App honestly when its isolated host cannot open', async () => {
    const { ctx, raw } = makeCtx(true);
    raw.appClient.open = async () => { throw new Error('Apps are not available in Firefox yet.'); };
    const result = await createAppSandbox({ name: 'todo', html: '<h1>todo</h1>' }, ctx as any);
    expect(result.ok).toBe(true);
    const summary = JSON.parse(String(result.content).split('\n\n')[0]);
    expect(summary.opened).toBe(false);
    expect(summary.openError).toContain('not available in Firefox');
  });
});
