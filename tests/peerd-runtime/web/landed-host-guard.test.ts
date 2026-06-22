// Web-fetch escalation must re-validate the host a tab LANDED on. A real
// background tab natively follows redirects (HTTP 3xx / meta-refresh / JS) that
// the dispatcher's origin gate never saw — so the host the tab ends up on can
// differ from the gate-checked one, and must face the denylist + private-
// network guards before any of its content is read back into the agent.
//
// Fixtures are deliberately abstract (a generic denylisted.example), not a
// recognizable real site.

import { describe, it, expect } from 'bun:test';
import { landedHostDenial } from '/peerd-runtime/tools/web/primitives.js';
import { readArticleTool } from '/peerd-runtime/tools/web/read.js';
import { webSearchTool } from '/peerd-runtime/tools/web/search.js';

const baseCtx = (over: Record<string, any> = {}) => ({
  session: { sessionId: 't' },
  activeTab: { id: 1, url: 'https://example.com/', origin: 'https://example.com' },
  audit: async () => {},
  confirm: async () => 'yes_once' as const,
  webFetch: async () => { throw new Error('webFetch not mocked'); },
  tabs: {}, scripting: {}, settings: {}, dom: {}, vm: {},
  getSecret: async () => null, kv: {}, idb: {},
  denylist: [] as string[],
  provider: { name: 'm', model: 'm', hasKey: false },
  vault: { isLocked: false },
  ...over,
});

// A tabs mock that lands on `finalUrl`, recording create / remove and firing
// the load-complete event so waitForLoad resolves immediately.
const tabsThatLandOn = (finalUrl: string, calls: any) => ({
  create: async ({ url }: any) => { calls.createdUrl = url; return { id: 42 }; },
  get: async (id: number) => ({ id, url: finalUrl }),
  remove: async (id: number) => { calls.removed = id; },
  onUpdated: {
    addListener: (l: any) => { setTimeout(() => l(42, { status: 'complete' }), 0); },
    removeListener: () => {},
  },
});
const scriptingThatReads = (calls: any) => ({
  executeScript: async () => { calls.executed = true; return [{ result: { url: 'x', title: 't', text: 'PAGE TEXT' } }]; },
});

describe('landedHostDenial (pure)', () => {
  it('denies an exact denylisted landed host', () => {
    expect(landedHostDenial('https://denylisted.example/x', { denylist: ['denylisted.example'] } as any))
      .toMatchObject({ host: 'denylisted.example', reason: 'denylist:denylisted.example' });
  });
  it('denies a denylisted subdomain landing via a wildcard pattern', () => {
    expect(landedHostDenial('https://sub.denylisted.example/x', { denylist: ['*.denylisted.example'] } as any)?.reason)
      .toBe('denylist:*.denylisted.example');
  });
  it('denies a private / loopback landed host', () => {
    expect(landedHostDenial('http://127.0.0.1/x', { denylist: [] } as any)?.reason).toBe('private_network');
    expect(landedHostDenial('http://192.168.1.1/', { denylist: [] } as any)?.reason).toBe('private_network');
  });
  it('allows an ordinary public host', () => {
    expect(landedHostDenial('https://example.com/x', { denylist: ['denylisted.example'] } as any)).toBe(null);
  });
});

describe('read_article re-validates the landed host', () => {
  it('does NOT escalate a webFetch redirect refusal (terminal — no tab opened)', async () => {
    const calls: any = {};
    const ctx = baseCtx({
      webFetch: async () => { const e: any = new Error('blocked'); e.reason = 'redirect_blocked'; throw e; },
      tabs: tabsThatLandOn('https://denylisted.example/', calls),
      scripting: scriptingThatReads(calls),
      denylist: ['denylisted.example'],
    });
    const r: any = await readArticleTool.execute({ url: 'https://redirector.example/x' }, ctx);
    expect(r.ok).toBe(false);
    expect(calls.createdUrl).toBeUndefined(); // no tab opened
    expect(calls.executed).toBeUndefined();   // no content read
  });

  it('opens a tab on a transient failure but REFUSES a denylisted landing (no read)', async () => {
    const calls: any = {};
    const ctx = baseCtx({
      webFetch: async () => { throw new Error('network down'); }, // transient → escalate
      tabs: tabsThatLandOn('https://denylisted.example/account', calls),
      scripting: scriptingThatReads(calls),
      denylist: ['denylisted.example'],
    });
    const r: any = await readArticleTool.execute({ url: 'https://redirector.example/x' }, ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('egress_denied');
    expect(calls.createdUrl).toBe('https://redirector.example/x'); // tab WAS opened
    expect(calls.executed).toBeUndefined();                        // but content NEVER read
    expect(calls.removed).toBe(42);                                // tab closed
  });

  it('reads normally when the landing is an allowed public host', async () => {
    const calls: any = {};
    const ctx = baseCtx({
      webFetch: async () => { throw new Error('network down'); },
      tabs: tabsThatLandOn('https://example.com/article', calls),
      scripting: scriptingThatReads(calls),
      denylist: ['denylisted.example'],
    });
    const r: any = await readArticleTool.execute({ url: 'https://example.com/x' }, ctx);
    expect(r.ok).toBe(true);
    expect(calls.executed).toBe(true); // content read
  });
});

describe('web_search re-validates the landed host (defense-in-depth)', () => {
  it('refuses a denylisted landing without reading it', async () => {
    const calls: any = {};
    const ctx = baseCtx({
      tabs: tabsThatLandOn('https://denylisted.example/', calls),
      scripting: scriptingThatReads(calls),
      denylist: ['denylisted.example'],
    });
    const r: any = await webSearchTool.execute({ query: 'hi' }, ctx);
    expect(r.ok).toBe(false);
    expect(calls.executed).toBeUndefined();
  });
});
