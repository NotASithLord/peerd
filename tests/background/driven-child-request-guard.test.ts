import { describe, expect, test } from 'bun:test';
import {
  classifyDrivenChildRequestTarget,
  FIREFOX_DRIVEN_CHILD_MARKERS_KEY,
  FirefoxChildRequestGuardUnavailableError,
  makeFirefoxDrivenChildMarkerStore,
  makeDrivenChildRequestGuard,
  registerFirefoxDrivenChildRequestGuard,
} from '../../extension/background/driven-child-request-guard.js';

describe('driven child request guard', () => {
  const createGuard = () => makeDrivenChildRequestGuard({
    isDrivenSource: (tabId) => tabId === 7,
    classifyTarget: (url) => ({ allowed: !url.startsWith('http://127.0.0.1') }),
  });

  test('synchronously blocks a private request only for an exact driven child', () => {
    const guard = createGuard();
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });

    expect(guard.onBeforeRequest({ tabId: 8, url: 'http://127.0.0.1/private' }))
      .toEqual({ cancel: true });
    expect(guard.onBeforeRequest({ tabId: 8, url: 'https://public.example/' })).toEqual({});
    expect(guard.onBeforeRequest({ tabId: 9, url: 'http://127.0.0.1/private' })).toEqual({});
  });

  test('the request classifier covers private HTTP and WebSocket schemes', () => {
    for (const target of [
      'http://127.0.0.1/private',
      'https://169.254.169.254/metadata',
      'ws://127.0.0.1/socket',
      'wss://[::1]/socket',
    ]) {
      expect(classifyDrivenChildRequestTarget(target).allowed).toBe(false);
    }
    expect(classifyDrivenChildRequestTarget('wss://public.example/socket').allowed).toBe(true);
    expect(classifyDrivenChildRequestTarget(
      'https://vault.example/account',
      (hostname) => hostname === 'vault.example',
    )).toEqual({ allowed: false, reason: 'sensitive_site' });
    expect(classifyDrivenChildRequestTarget(
      'https://public.example/',
      () => false,
      false,
    )).toEqual({ allowed: false, reason: 'policy_loading' });
  });

  test('a cold policy holds only an exact driven child until policy hydration', () => {
    let policyReady = false;
    const guard = makeDrivenChildRequestGuard({
      isDrivenSource: (tabId) => tabId === 7,
      classifyTarget: (url) => classifyDrivenChildRequestTarget(url, () => false, policyReady),
    });
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
    guard.onNavigationTarget({ tabId: 9, sourceTabId: 6 });

    expect(guard.onBeforeRequest({ tabId: 8, url: 'https://public.example/' }))
      .toEqual({ cancel: true });
    expect(guard.onBeforeRequest({ tabId: 9, url: 'https://public.example/' })).toEqual({});

    policyReady = true;
    expect(guard.onBeforeRequest({ tabId: 8, url: 'https://public.example/' })).toEqual({});
  });

  test('quarantines one cold child until durable source custody resolves', () => {
    let sourcesReady = false;
    const guard = makeDrivenChildRequestGuard({
      isSourceReady: () => sourcesReady,
      isDrivenSource: (tabId) => tabId === 7,
      classifyTarget: (url) => ({ allowed: !url.includes('127.0.0.1') }),
    });
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 6 });
    expect(guard.has(8)).toBe(true);
    expect(guard.onBeforeRequest({ tabId: 8, url: 'http://127.0.0.1/private' }))
      .toEqual({ cancel: true });

    sourcesReady = true;
    guard.reconcile([{ id: 6 }, { id: 8, openerTabId: 6 }]);
    expect(guard.has(8)).toBe(false);
    guard.onNavigationTarget({ tabId: 9, sourceTabId: 7 });
    guard.resolveNavigationTarget({ tabId: 9, sourceTabId: 7 });
    expect(guard.has(9)).toBe(true);
  });

  test('reports one blocked subrequest and releases after DNR handoff', () => {
    const blocked: any[] = [];
    const guard = makeDrivenChildRequestGuard({
      isDrivenSource: (tabId) => tabId === 7,
      onBlocked: (event) => { blocked.push(event); },
    });
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
    expect(guard.onBeforeRequest({
      tabId: 8, url: 'ws://127.0.0.1/socket', type: 'websocket',
    })).toEqual({ cancel: true });
    expect(guard.onBeforeRequest({
      tabId: 8, url: 'http://127.0.0.1/private', type: 'xmlhttprequest',
    })).toEqual({ cancel: true });
    expect(blocked).toEqual([{ sourceTabId: 7, tabId: 8, reason: 'private_network' }]);

    guard.release(8);
    expect(guard.onBeforeRequest({
      tabId: 8, url: 'http://127.0.0.1/private', type: 'xmlhttprequest',
    })).toEqual({});
  });

  test('a throwing receipt observer cannot reopen the protected request', () => {
    const guard = makeDrivenChildRequestGuard({
      isDrivenSource: (tabId) => tabId === 7,
      onBlocked: () => { throw new Error('audit unavailable'); },
    });
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
    expect(guard.onBeforeRequest({
      tabId: 8, url: 'http://127.0.0.1/private', type: 'xmlhttprequest',
    })).toEqual({ cancel: true });
  });

  test('does not adopt an ordinary user child and forgets a removed child', () => {
    const guard = createGuard();
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 6 });
    expect(guard.has(8)).toBe(false);

    guard.onNavigationTarget({ tabId: 9, sourceTabId: 7 });
    expect(guard.has(9)).toBe(true);
    guard.release(9);
    expect(guard.onBeforeRequest({ tabId: 9, url: 'http://127.0.0.1/private' })).toEqual({});
  });

  test('restores exact child custody synchronously after a Firefox event-page recycle', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage;
    const markers = makeFirefoxDrivenChildMarkerStore(storage);
    const first = makeDrivenChildRequestGuard({
      isDrivenSource: (tabId) => tabId === 7,
      classifyTarget: (url) => ({ allowed: !url.includes('127.0.0.1') }),
      markers,
    });
    first.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
    expect(JSON.parse(values.get(FIREFOX_DRIVEN_CHILD_MARKERS_KEY)!)).toEqual([
      { tabId: 8, sourceTabId: 7 },
    ]);

    const recycled = makeDrivenChildRequestGuard({
      // The driven-source registry is intentionally not hydrated yet. The
      // browser-issued durable relation remains authoritative for this child.
      isDrivenSource: () => false,
      classifyTarget: (url) => ({ allowed: !url.includes('127.0.0.1') }),
      markers,
    });
    expect(recycled.onBeforeRequest({
      tabId: 8, url: 'http://127.0.0.1/private', type: 'xmlhttprequest',
    })).toEqual({ cancel: true });
    expect(recycled.onBeforeRequest({
      tabId: 9, url: 'http://127.0.0.1/private', type: 'xmlhttprequest',
    })).toEqual({});
    recycled.release(8);
    expect(values.has(FIREFOX_DRIVEN_CHILD_MARKERS_KEY)).toBe(false);
  });

  test('fails closed on marker corruption and clears only browser-disproved leftovers', () => {
    let raw: string | null = '{broken';
    const storage = {
      getItem: () => raw,
      setItem: (_key: string, value: string) => { raw = value; },
      removeItem: () => { raw = null; },
    } as unknown as Storage;
    const markers = makeFirefoxDrivenChildMarkerStore(storage);
    const corrupt = makeDrivenChildRequestGuard({ isDrivenSource: () => false, markers });
    expect(corrupt.ready()).toBe(false);
    expect(corrupt.onBeforeRequest({ tabId: 30, url: 'https://public.example/' }))
      .toEqual({ cancel: true });
    expect(corrupt.reconcile([])).toBe(true);
    expect(raw).toBeNull();

    markers.write([{ tabId: 8, sourceTabId: 7 }]);
    const stale = makeDrivenChildRequestGuard({ isDrivenSource: () => false, markers });
    expect(stale.reconcile([{ id: 8, openerTabId: 99 }, { id: 7 }])).toBe(true);
    expect(stale.has(8)).toBe(false);
    expect(raw).toBeNull();
  });

  test('holds requests after a synchronous marker write failure', () => {
    const guard = makeDrivenChildRequestGuard({
      isDrivenSource: () => true,
      markers: {
        read: () => [],
        write: () => { throw new Error('disk unavailable'); },
      },
    });
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
    expect(guard.ready()).toBe(false);
    expect(guard.onBeforeRequest({ tabId: 99, url: 'https://public.example/' }))
      .toEqual({ cancel: true });
  });

  test('fails closed instead of evicting exact custody on marker overflow', () => {
    const guard = makeDrivenChildRequestGuard({
      isDrivenSource: () => true, maxChildren: 2,
    });
    guard.onNavigationTarget({ tabId: 1, sourceTabId: 10 });
    guard.onNavigationTarget({ tabId: 2, sourceTabId: 10 });
    guard.onNavigationTarget({ tabId: 3, sourceTabId: 10 });
    expect(guard.ready()).toBe(false);
    expect(guard.has(1)).toBe(true);
    expect(guard.has(3)).toBe(true);
    expect(guard.onBeforeRequest({ tabId: 99, url: 'https://public.example/' }))
      .toEqual({ cancel: true });
    guard.release(3);
    expect(guard.reconcile([
      { id: 10 }, { id: 1, openerTabId: 10 }, { id: 2, openerTabId: 10 },
    ])).toBe(true);
  });

  test('registers only on Firefox and fails honestly when blocking is unavailable', () => {
    const calls: any[] = [];
    const event = { addListener: (...args: any[]) => { calls.push(args); } };
    const listener = () => ({});
    expect(registerFirefoxDrivenChildRequestGuard({ isFirefox: false, event, listener })).toBe(false);
    expect(calls).toEqual([]);
    expect(registerFirefoxDrivenChildRequestGuard({ isFirefox: true, event, listener })).toBe(true);
    expect(calls[0][1]).toEqual({ urls: ['<all_urls>'] });
    expect(calls[0][2]).toEqual(['blocking']);
    expect(() => registerFirefoxDrivenChildRequestGuard({
      isFirefox: true, event: null, listener,
    })).toThrow(FirefoxChildRequestGuardUnavailableError);
    expect(() => registerFirefoxDrivenChildRequestGuard({
      isFirefox: true,
      event: { addListener: () => { throw new Error('permission missing'); } },
      listener,
    })).toThrow(FirefoxChildRequestGuardUnavailableError);
    expect(() => makeFirefoxDrivenChildMarkerStore(null as any))
      .toThrow(FirefoxChildRequestGuardUnavailableError);
  });
});
