// The chokepoint's one live look at the target document — issues 267 and 276.
//
// 267: before this, `snapshot` was the ONLY tool that observed the password
// field, so an actor that perceived with `read_page` stayed unlearned forever.
// Which tool gets called is the attacker's choice, so the classifier's growth
// must not depend on it.
//
// 276: everything above the probe judges `tab.url` — a record frozen before the
// call. These pin that a document reporting a DIFFERENT origin is re-judged on
// both rules (denylist and landing), and that a probe which cannot run leaves
// the earlier verdict untouched rather than refusing.

import { describe, test, expect } from 'bun:test';
import { resolveTargetTab } from '../../../extension/peerd-runtime/tools/defs/dom-helpers.js';

const tabsApi = (byId: Record<number, any>) => ({
  get: async (id: number) => { if (!byId[id]) throw new Error('no tab'); return byId[id]; },
  query: async () => Object.values(byId),
});

/** A scripting stub whose injected probe answers with a fixed document. */
const scriptingSaying = (result: unknown, opts: { calls?: number[] } = {}) => ({
  executeScript: async (o: any) => { opts.calls?.push(o?.target?.tabId); return [{ result }]; },
});

const baseCtx = (over: Record<string, unknown> = {}) => ({
  activeTab: { id: 1, url: 'https://example.com/', origin: 'https://example.com' },
  tabs: tabsApi({ 1: { id: 1, url: 'https://example.com/' } }),
  ...over,
});

describe('issue 267 — every DOM tool teaches the classifier, not just snapshot', () => {
  test('a password field seen at the chokepoint is learned', async () => {
    const learned: Array<[string, string]> = [];
    const ctx: any = baseCtx({
      scripting: scriptingSaying({ has: true, origin: 'https://example.com', href: 'https://example.com/login' }),
      noteLearnedOrigin: (o: string, r: string) => learned.push([o, r]),
    });
    expect((await resolveTargetTab({}, ctx))?.id).toBe(1);
    expect(learned).toEqual([['https://example.com', 'password-field']]);
  });

  test('no password field teaches nothing', async () => {
    const learned: string[] = [];
    const ctx: any = baseCtx({
      scripting: scriptingSaying({ has: false, origin: 'https://example.com', href: 'https://example.com/' }),
      noteLearnedOrigin: (o: string) => learned.push(o),
    });
    await resolveTargetTab({}, ctx);
    expect(learned).toEqual([]);
  });

  test('the signal is credited to the origin that REPORTED it, not to the tab record', async () => {
    // The #278 rule, held here by construction: we never pass tab.url's origin.
    const learned: string[] = [];
    const ctx: any = baseCtx({
      scripting: scriptingSaying({ has: true, origin: 'https://elsewhere.test', href: 'https://elsewhere.test/login' }),
      noteLearnedOrigin: (o: string) => learned.push(o),
    });
    await resolveTargetTab({}, ctx);
    expect(learned).toEqual(['https://elsewhere.test']);
  });

  test('an unreadable origin (opaque document) is not learned as anything', async () => {
    const learned: string[] = [];
    const ctx: any = baseCtx({
      scripting: scriptingSaying({ has: true, origin: null, href: null }),
      noteLearnedOrigin: (o: string) => learned.push(o),
    });
    await resolveTargetTab({}, ctx);
    expect(learned).toEqual([]);
  });
});

describe('issue 276 — the live origin is re-judged when the document moved', () => {
  test('a document that navigated onto the denylist is refused', async () => {
    const ctx: any = baseCtx({
      denylist: ['chase.com', '*.chase.com'],
      scripting: scriptingSaying({ has: false, origin: 'https://chase.com', href: 'https://chase.com/transfer' }),
    });
    expect(await resolveTargetTab({}, ctx)).toBeNull();
  });

  test('a document that navigated somewhere the landing rule stops is refused', async () => {
    const judged: string[] = [];
    const ctx: any = baseCtx({
      scripting: scriptingSaying({ has: false, origin: 'https://evil.test', href: 'https://evil.test/x' }),
      judgeLanding: async (url: string) => {
        judged.push(url);
        return url.startsWith('https://evil.test') ? { action: 'end' } : { action: 'continue' };
      },
    });
    expect(await resolveTargetTab({}, ctx)).toBeNull();
    // Judged tab.url first (passed), then the live href (refused) — the second
    // ask is the whole point: the first one was about a document that is gone.
    expect(judged).toEqual(['https://example.com/', 'https://evil.test/x']);
  });

  test('the live judge is asked about the full href, not a bare origin', async () => {
    // A path-scoped rule handed "https://x.test" would silently see "/" and let
    // through what it exists to stop.
    const judged: string[] = [];
    const ctx: any = baseCtx({
      scripting: scriptingSaying({ has: false, origin: 'https://x.test', href: 'https://x.test/u/settings' }),
      judgeLanding: async (url: string) => { judged.push(url); return { action: 'continue' }; },
    });
    await resolveTargetTab({}, ctx);
    expect(judged[1]).toBe('https://x.test/u/settings');
  });

  test('a document still on the judged origin is NOT re-judged (no second ask)', async () => {
    const judged: string[] = [];
    const ctx: any = baseCtx({
      scripting: scriptingSaying({ has: false, origin: 'https://example.com', href: 'https://example.com/deep/path' }),
      judgeLanding: async (url: string) => { judged.push(url); return { action: 'continue' }; },
    });
    expect((await resolveTargetTab({}, ctx))?.id).toBe(1);
    expect(judged).toEqual(['https://example.com/']);
  });
});

describe('the probe fails OPEN — it can only ever add a refusal, never remove one', () => {
  test('a context with no scripting API resolves exactly as before', async () => {
    const ctx: any = baseCtx();
    expect((await resolveTargetTab({}, ctx))?.id).toBe(1);
  });

  test('an injection the browser refuses (chrome:// and friends) does not refuse the tool', async () => {
    const ctx: any = baseCtx({
      scripting: { executeScript: async () => { throw new Error('Cannot access a chrome:// URL'); } },
    });
    expect((await resolveTargetTab({}, ctx))?.id).toBe(1);
  });

  test('a probe that answers with nothing usable is treated as "could not look"', async () => {
    const learned: string[] = [];
    const ctx: any = baseCtx({
      scripting: { executeScript: async () => [] },
      noteLearnedOrigin: (o: string) => learned.push(o),
    });
    expect((await resolveTargetTab({}, ctx))?.id).toBe(1);
    expect(learned).toEqual([]);
  });

  test('a denylisted tab is still refused BEFORE the probe ever runs', async () => {
    // The probe must not become a way to touch a denylisted renderer at all.
    const calls: number[] = [];
    const ctx: any = {
      denylist: ['chase.com'],
      activeTab: { id: 9, url: 'https://chase.com/', origin: 'https://chase.com' },
      tabs: tabsApi({ 9: { id: 9, url: 'https://chase.com/' } }),
      scripting: scriptingSaying({ has: true, origin: 'https://chase.com', href: 'https://chase.com/' }, { calls }),
    };
    expect(await resolveTargetTab({}, ctx)).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a landing verdict of "end" refuses before the probe runs', async () => {
    const calls: number[] = [];
    const ctx: any = baseCtx({
      judgeLanding: async () => ({ action: 'end' }),
      scripting: scriptingSaying({ has: true, origin: 'https://example.com', href: 'https://example.com/' }, { calls }),
    });
    expect(await resolveTargetTab({}, ctx)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('the probe cannot hang a tool call', () => {
  test('a renderer that never answers resolves the tab anyway (timeout, fail open)', async () => {
    const ctx: any = baseCtx({
      scripting: { executeScript: () => new Promise(() => { /* wedged main thread */ }) },
    });
    const started = performance.now();
    expect((await resolveTargetTab({}, ctx))?.id).toBe(1);
    // The timeout is the point; the exact value lives in the source. Just pin
    // that it returned on the timer rather than waiting on the renderer.
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
