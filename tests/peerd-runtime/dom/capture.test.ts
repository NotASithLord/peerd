import { describe, test, expect } from 'bun:test';
import { captureSnapshot, describeSource } from '../../../extension/peerd-runtime/dom/capture.js';
import { domWalkInjected } from '../../../extension/peerd-runtime/dom/walk-injected.js';

// One snapshot contract, two channels: CDP when the pool is wired, the
// chrome.scripting DOM-walk otherwise. These tests pin the channel
// selection + error surfaces; the injected walk itself runs against real
// DOM in the in-browser suite (extension/tests/unit/peerd-runtime/dom-walk.test.js).

const TAB = { id: 7 };

const CDP_NODES = {
  nodes: [
    { nodeId: '1', role: { value: 'WebArea' }, childIds: ['2'] },
    { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Send' }, backendDOMNodeId: 22, childIds: [] },
  ],
};

// What walk-injected returns: same CDP node shape, but identity is walkId
// (backendDOMNodeId stays null — there is no CDP node behind it).
const WALK_RESULT = {
  ok: true,
  nodes: [
    { nodeId: 'w0', role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['w1'], properties: [], backendDOMNodeId: null },
    { nodeId: 'w1', parentId: 'w0', role: { value: 'button' }, name: { value: 'Send' }, childIds: [], properties: [], backendDOMNodeId: null, walkId: 1 },
  ],
};

describe('captureSnapshot — channel selection', () => {
  test('CDP pool present → cdp source, backend ids on refs', async () => {
    const ctx = { debuggerPool: { getAxTree: async () => CDP_NODES } };
    const cap = await captureSnapshot(TAB, ctx);
    expect(cap.ok).toBe(true);
    if (!cap.ok) throw new Error('expected ok capture'); // narrow for TS — expect() does not
    expect(cap.source).toBe('cdp');
    expect(cap.refs[0]).toMatchObject({ ref: '@e1', backendDOMNodeId: 22, walkId: null });
  });

  test('no pool → DOM-walk via scripting, walk ids on refs', async () => {
    let injected: any = null;
    const ctx = {
      scripting: {
        executeScript: async (req: any) => { injected = req; return [{ result: WALK_RESULT }]; },
      },
    };
    const cap = await captureSnapshot(TAB, ctx);
    expect(cap.ok).toBe(true);
    if (!cap.ok) throw new Error('expected ok capture');
    expect(cap.source).toBe('dom-walk');
    expect(cap.refs[0]).toMatchObject({ ref: '@e1', backendDOMNodeId: null, walkId: 1, name: 'Send' });
    // The injected function is the self-contained walk, aimed at the tab.
    expect(injected.target).toEqual({ tabId: 7 });
    expect(injected.func).toBe(domWalkInjected);
  });

  test('CDP errors do NOT fall back to the walk — they surface', async () => {
    const ctx = {
      debuggerPool: { getAxTree: async () => { throw new Error('cdp gone'); } },
      scripting: { executeScript: async () => [{ result: WALK_RESULT }] },
    };
    const cap = await captureSnapshot(TAB, ctx);
    expect(cap.ok).toBe(false);
    if (cap.ok) throw new Error('expected error capture');
    expect(cap.source).toBe('cdp');
    expect(cap.error).toContain('axtree_failed');
  });

  test('neither channel → honest unavailable error', async () => {
    const cap = await captureSnapshot(TAB, {});
    expect(cap.ok).toBe(false);
    if (cap.ok) throw new Error('expected error capture');
    expect(cap.source).toBe('none');
    expect(cap.error).toContain('snapshot_unavailable');
  });

  test('injection refusal (chrome:// etc.) surfaces as dom_walk_failed', async () => {
    const ctx = {
      scripting: { executeScript: async () => { throw new Error('Cannot access a chrome:// URL'); } },
    };
    const cap = await captureSnapshot(TAB, ctx);
    expect(cap.ok).toBe(false);
    if (cap.ok) throw new Error('expected error capture');
    expect(cap.source).toBe('dom-walk');
    expect(cap.error).toContain('dom_walk_failed');
  });

  test('walk-side failure result surfaces its message', async () => {
    const ctx = {
      scripting: { executeScript: async () => [{ result: { ok: false, error: 'no body' } }] },
    };
    const cap = await captureSnapshot(TAB, ctx);
    expect(cap.ok).toBe(false);
    if (cap.ok) throw new Error('expected error capture');
    expect(cap.error).toBe('dom_walk_failed: no body');
  });
});

describe('describeSource', () => {
  test('the fallback label says it is a fallback; CDP stays the plain label', () => {
    expect(describeSource('dom-walk')).toContain('pseudo-a11y');
    expect(describeSource('dom-walk')).toContain('fallback');
    expect(describeSource('cdp')).toBe('a11y snapshot');
  });
});
