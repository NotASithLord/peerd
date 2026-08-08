import { describe, expect, test } from 'bun:test';
import {
  classifyDrivenChildRequestTarget,
  FirefoxChildRequestGuardUnavailableError,
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
  });
});
