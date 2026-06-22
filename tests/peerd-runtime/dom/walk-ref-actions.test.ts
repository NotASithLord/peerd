// Walk refs (DOM-walk pseudo-snapshot — Firefox / advanced automation off)
// must flow through the SAME snapshot → ref → click/type contract as CDP
// refs: snapshot registers them, click/type resolve them page-side via
// scripting instead of via backendDOMNodeId. These tests pin the dispatch
// plumbing; the injected functions run against real DOM in the in-browser
// suite (extension/tests/unit/peerd-runtime/dom-walk.test.js).

import { describe, test, expect } from 'bun:test';
import { snapshotTool } from '../../../extension/peerd-runtime/tools/defs/snapshot.js';
import { clickTool } from '../../../extension/peerd-runtime/tools/defs/click.js';
import { typeTool } from '../../../extension/peerd-runtime/tools/defs/type.js';
import { createRefRegistry } from '../../../extension/peerd-runtime/dom/ref-registry.js';

const WALK_RESULT = {
  ok: true,
  nodes: [
    { nodeId: 'w0', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['w1', 'w2'], properties: [], backendDOMNodeId: null },
    { nodeId: 'w1', parentId: 'w0', role: { value: 'button' }, name: { value: 'Send' }, childIds: [], properties: [], backendDOMNodeId: null, walkId: 1 },
    { nodeId: 'w2', parentId: 'w0', role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: '' }, childIds: [], properties: [], backendDOMNodeId: null, walkId: 2 },
  ],
};

const makeCtx = (scriptImpl: (req: any) => any) => {
  const injections: any[] = [];
  const ctx: any = {
    activeTab: { id: 7, url: 'https://example.com/', origin: 'https://example.com' },
    tabs: {
      get: async (id: number) => ({ id, url: 'https://example.com/' }),
      query: async () => [{ id: 7, url: 'https://example.com/' }],
    },
    scripting: {
      executeScript: async (req: any) => { injections.push(req); return scriptImpl(req); },
    },
    domRefs: createRefRegistry(),
    // No debuggerPool — the advanced-automation-off / Firefox shape.
  };
  return { ctx, injections };
};

describe('snapshot tool — DOM-walk fallback', () => {
  test('no pool → pseudo-a11y snapshot with refs registered for later actions', async () => {
    const { ctx } = makeCtx(() => [{ result: WALK_RESULT }]);
    const r = await snapshotTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok result'); // narrow for TS — expect() does not
    // Result metadata SAYS it's the fallback channel.
    expect(r.content).toContain('pseudo-a11y');
    expect(r.content).toContain('2 interactable refs');
    expect(r.content).toContain('@e1 button "Send"');
    // Refs landed in the registry, carrying walk identity.
    expect(ctx.domRefs.resolve(7, '@e1')).toMatchObject({ walkId: 1, backendDOMNodeId: null });
    expect(ctx.domRefs.resolve(7, '@e2')).toMatchObject({ walkId: 2 });
  });

  test('walk failure → honest error, no fake snapshot', async () => {
    const { ctx } = makeCtx(() => { throw new Error('Cannot access contents of the page'); });
    const r = await snapshotTool.execute({}, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected error result');
    expect(r.error).toContain('dom_walk_failed');
  });
});

describe('click/type — walk-ref dispatch', () => {
  test('click {ref} resolves a walk ref via scripting with the walkId', async () => {
    const { ctx, injections } = makeCtx((req: any) =>
      req.args && req.args[2] != null
        ? [{ result: { ok: true, clicked: 'walk:1', nth: 0, matchedCount: 1, tag: 'button', text: 'Send' } }]
        : [{ result: WALK_RESULT }]);
    await snapshotTool.execute({}, ctx);
    const r = await clickTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok result');
    expect(r.content).toContain('"via": "dom-walk"');
    // The click injection carried [selector=null, nth=0, walkId=1].
    expect(injections[1].args).toEqual([null, 0, 1]);
  });

  test('type {ref} resolves a walk ref via scripting with the walkId', async () => {
    const { ctx, injections } = makeCtx((req: any) =>
      req.args && req.args[3] != null
        ? [{ result: { ok: true, typed: 'hi', submitted: false, tag: 'input' } }]
        : [{ result: WALK_RESULT }]);
    await snapshotTool.execute({}, ctx);
    const r = await typeTool.execute({ ref: '@e2', text: 'hi' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok result');
    expect(r.content).toContain('"via": "dom-walk"');
    // [selector=null, text, submit, walkId=2]
    expect(injections[1].args).toEqual([null, 'hi', false, 2]);
  });

  test('page-side stale walk ref surfaces as stale_ref', async () => {
    const { ctx } = makeCtx((req: any) =>
      req.args && req.args[2] != null
        ? [{ result: { ok: false, error: 'stale_ref: element no longer in the page — re-run snapshot on this tab first' } }]
        : [{ result: WALK_RESULT }]);
    await snapshotTool.execute({}, ctx);
    const r = await clickTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected error result');
    expect(r.error).toContain('stale_ref');
  });

  test('CDP-sourced ref with the pool gone steers to a fresh snapshot', async () => {
    const { ctx } = makeCtx(() => [{ result: WALK_RESULT }]);
    // Simulate a ref taken while advanced automation was ON.
    ctx.domRefs.setSnapshot(7, [{ ref: '@e1', backendDOMNodeId: 99, role: 'button', name: 'Send' }]);
    const r = await clickTool.execute({ ref: '@e1' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected error result');
    expect(r.error).toContain('debugger_unavailable');
    expect(r.error).toContain('Re-run snapshot');
  });
});
