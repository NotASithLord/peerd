// Walk refs (DOM-walk pseudo-snapshot — Firefox / advanced automation off)
// must flow through the SAME snapshot → ref → click/type contract as CDP
// refs: snapshot registers them, click/type resolve them page-side via
// scripting instead of via backendDOMNodeId. These tests pin the dispatch
// plumbing; the injected functions run against real DOM in the in-browser
// suite (extension/tests/unit/peerd-runtime/dom-walk.test.js).

import { describe, test, expect } from 'bun:test';
import { snapshotTool } from '../../../extension/peerd-runtime/tools/defs/snapshot.js';
import { clickTool, clickInjected } from '../../../extension/peerd-runtime/tools/defs/click.js';
import { typeTool, typeInjected } from '../../../extension/peerd-runtime/tools/defs/type.js';
import { createRefRegistry } from '../../../extension/peerd-runtime/dom/ref-registry.js';
import { hasPasswordFieldInjected } from '../../../extension/peerd-runtime/dom/walk-injected.js';

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
      // The chokepoint's live probe (issues 267/276) injects on every DOM tool
      // call. It is not part of the dispatch under test here, and counting it
      // would make these assertions about injection ORDER a proxy for an
      // unrelated feature — so it is recorded out.
      executeScript: async (req: any) => {
        if (req?.func !== hasPasswordFieldInjected) injections.push(req);
        return scriptImpl(req);
      },
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
    // matchedCount is part of the walk-ref success contract too (issue #36).
    expect(r.content).toContain('"matchedCount": 1');
    // The click injection carried [selector=null, nth=0, walkId=1,
    // expectedCount=null] — the guard slot is always forwarded.
    expect(injections[1].args).toEqual([null, 0, 1, null]);
  });

  test('type {ref} resolves a walk ref via scripting with the walkId', async () => {
    const { ctx, injections } = makeCtx((req: any) =>
      req.args && req.args[3] != null
        ? [{ result: { ok: true, typed: 'hi', submitted: false, tag: 'input', matchedCount: 1 } }]
        : [{ result: WALK_RESULT }]);
    await snapshotTool.execute({}, ctx);
    const r = await typeTool.execute({ ref: '@e2', text: 'hi' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok result');
    expect(r.content).toContain('"via": "dom-walk"');
    // matchedCount is part of the walk-ref success contract too (issue #36).
    expect(r.content).toContain('"matchedCount": 1');
    // [selector=null, text, submit, walkId=2, expectedCount=null] — the
    // guard slot is always forwarded.
    expect(injections[1].args).toEqual([null, 'hi', false, 2, null]);
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

  test('click {selector, expectedCount} forwards a pre-action cardinality guard', async () => {
    const { ctx, injections } = makeCtx((req: any) => [{ result: { ok: true, clicked: true, tag: 'button', text: 'Delete', matchedCount: 3, nth: 0 } }]);
    const r = await clickTool.execute({ selector: '.delete-row', expectedCount: 3 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok result');
    // [selector, nth, walkId=null, expectedCount]
    expect(injections[0].args).toEqual(['.delete-row', 0, null, 3]);
    expect(r.content).toContain('"matchedCount": 3');
  });

  test('CDP ref {expectedCount:2} is a mismatch (a resolved backend node is exactly one)', async () => {
    const { ctx } = makeCtx(() => [{ result: WALK_RESULT }]);
    ctx.debuggerPool = { clickBackendNode: async () => ({ ok: true, tag: 'button', text: 'Send' }) };
    ctx.domRefs.setSnapshot(7, [{ ref: '@e1', backendDOMNodeId: 99, role: 'button', name: 'Send' }]);
    const r = await clickTool.execute({ ref: '@e1', expectedCount: 2 }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected error result');
    expect(r.error).toBe('matched_count_mismatch');
    expect((r as any).matchedCount).toBe(1);
    expect((r as any).expectedCount).toBe(2);
  });

  test('CDP ref {expectedCount:1} passes and reports matchedCount:1', async () => {
    const { ctx } = makeCtx(() => [{ result: WALK_RESULT }]);
    ctx.debuggerPool = { clickBackendNode: async () => ({ ok: true, tag: 'button', text: 'Send' }) };
    ctx.domRefs.setSnapshot(7, [{ ref: '@e1', backendDOMNodeId: 99, role: 'button', name: 'Send' }]);
    const r = await clickTool.execute({ ref: '@e1', expectedCount: 1 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok result');
    expect(r.content).toContain('"matchedCount": 1');
  });

  test('type {selector, expectedCount} forwards a pre-action cardinality guard', async () => {
    const { ctx, injections } = makeCtx((req: any) => [{ result: { ok: true, typed: 'Ada', submitted: false, tag: 'input', matchedCount: 1 } }]);
    const r = await typeTool.execute({ selector: 'input[name="assignee"]', text: 'Ada', expectedCount: 1 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok result');
    // [selector, text, submit, walkId=null, expectedCount]
    expect(injections[0].args).toEqual(['input[name="assignee"]', 'Ada', false, null, 1]);
    expect(r.content).toContain('"matchedCount": 1');
  });

  test('click {ref, expectedCount} forwards the guard on the walk-ref injection', async () => {
    const { ctx, injections } = makeCtx((req: any) =>
      req.args && req.args[2] != null
        ? [{ result: { ok: true, clicked: 'walk:1', nth: 0, matchedCount: 1, tag: 'button', text: 'Send' } }]
        : [{ result: WALK_RESULT }]);
    await snapshotTool.execute({}, ctx);
    const r = await clickTool.execute({ ref: '@e1', expectedCount: 1 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok result');
    expect(r.content).toContain('"matchedCount": 1');
    // [selector=null, nth=0, walkId=1, expectedCount=1]
    expect(injections[1].args).toEqual([null, 0, 1, 1]);
  });

  test('type {ref, expectedCount} forwards the guard on the walk-ref injection', async () => {
    const { ctx, injections } = makeCtx((req: any) =>
      req.args && req.args[3] != null
        ? [{ result: { ok: true, typed: 'hi', submitted: false, tag: 'input', matchedCount: 1 } }]
        : [{ result: WALK_RESULT }]);
    await snapshotTool.execute({}, ctx);
    const r = await typeTool.execute({ ref: '@e2', text: 'hi', expectedCount: 1 }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok result');
    expect(r.content).toContain('"matchedCount": 1');
    // [selector=null, text, submit, walkId=2, expectedCount=1]
    expect(injections[1].args).toEqual([null, 'hi', false, 2, 1]);
  });

  test('page-side walk-ref count mismatch surfaces through the tool', async () => {
    // The mocked scriptResult mirrors EXACTLY what the real injected body
    // returns for this case (pinned by the real-body tests below).
    const { ctx } = makeCtx((req: any) =>
      req.args && req.args[2] != null
        ? [{ result: { ok: false, error: 'matched_count_mismatch: walk ref matched 1 element(s), expected 2', matchedCount: 1, expectedCount: 2 } }]
        : [{ result: WALK_RESULT }]);
    await snapshotTool.execute({}, ctx);
    const r = await clickTool.execute({ ref: '@e1', expectedCount: 2 }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected error result');
    expect(r.error).toContain('matched_count_mismatch');
  });
});

// The injected bodies themselves — the walk-ref cardinality guard runs
// BEFORE any DOM interaction, so it is exercisable here against the real
// functions (no mocked scriptResult that could hide an omission — the
// #103 review lesson). Success paths need real event dispatch and stay in
// the in-browser suite (extension/tests/unit/peerd-runtime/dom-walk.test.js).
describe('injected bodies — walk-ref cardinality guard (real functions)', () => {
  const walkGlobal = globalThis as any;
  const withRegistry = (entries: Array<[number, any]>, fn: () => void) => {
    const prior = walkGlobal.__peerdWalkEls;
    walkGlobal.__peerdWalkEls = new Map(entries);
    try { fn(); }
    finally { walkGlobal.__peerdWalkEls = prior; }
  };
  // A registered element the guard can see; the guard only reads isConnected.
  const liveEl = { isConnected: true };

  test('clickInjected: found walk ref vs expectedCount>1 → matched_count_mismatch with counts', () => {
    withRegistry([[1, liveEl]], () => {
      const r: any = clickInjected(null, 0, 1, 2);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('matched_count_mismatch');
      expect(r.error).toContain('matched 1 element(s), expected 2');
      expect(r.matchedCount).toBe(1);
      expect(r.expectedCount).toBe(2);
    });
  });

  test('clickInjected: stale walk ref with expectedCount → mismatch with matchedCount 0 and re-snapshot hint', () => {
    withRegistry([], () => {
      const r: any = clickInjected(null, 0, 99, 1);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('matched_count_mismatch');
      expect(r.error).toContain('re-run snapshot');
      expect(r.matchedCount).toBe(0);
      expect(r.expectedCount).toBe(1);
    });
  });

  test('clickInjected: stale walk ref WITHOUT expectedCount still fails as stale_ref', () => {
    withRegistry([], () => {
      const r: any = clickInjected(null, 0, 99, null);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('stale_ref');
    });
  });

  test('typeInjected: found walk ref vs expectedCount>1 → matched_count_mismatch with counts', () => {
    withRegistry([[2, liveEl]], () => {
      const r: any = typeInjected(null, 'hi', false, 2, 3);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('matched_count_mismatch');
      expect(r.error).toContain('matched 1 element(s), expected 3');
      expect(r.matchedCount).toBe(1);
      expect(r.expectedCount).toBe(3);
    });
  });

  test('typeInjected: stale walk ref with expectedCount → mismatch with matchedCount 0 and re-snapshot hint', () => {
    withRegistry([], () => {
      const r: any = typeInjected(null, 'hi', false, 99, 1);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('matched_count_mismatch');
      expect(r.error).toContain('re-run snapshot');
      expect(r.matchedCount).toBe(0);
      expect(r.expectedCount).toBe(1);
    });
  });

  test('typeInjected: stale walk ref WITHOUT expectedCount still fails as stale_ref', () => {
    withRegistry([], () => {
      const r: any = typeInjected(null, 'hi', false, 99, null);
      expect(r.ok).toBe(false);
      expect(r.error).toContain('stale_ref');
    });
  });
});
