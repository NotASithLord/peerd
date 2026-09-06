import { describe, expect, test } from 'bun:test';
import {
  classifyDrivenChildRequestTarget,
  FIREFOX_DRIVEN_CHILD_IDS_KEY,
  FIREFOX_DRIVEN_CHILD_MARKERS_KEY,
  FirefoxChildRequestGuardUnavailableError,
  makeFirefoxDrivenChildMarkerStore,
  makeDrivenChildRequestGuard,
  registerFirefoxDrivenChildRequestGuard,
} from '../../extension/background/driven-child-request-guard.js';
import { createKernelFirefoxGuard } from '../../extension/background/kernel-firefox-addon.js';

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

  test('the Firefox addon waits for policy before main-frame classification', async () => {
    for (const [url, expected] of [
      ['https://public.example/', {}],
      ['https://vault.example/', { cancel: true }],
    ] as const) {
      let policyReady = false;
      let settlePolicy!: (ready: boolean) => void;
      const policy = new Promise<boolean>((resolve) => { settlePolicy = resolve; });
      const blocked: any[] = [];
      const guard = createKernelFirefoxGuard({
        isSourceReady: () => true,
        isDrivenSource: () => true,
        isSensitiveHost: (hostname: string) => hostname === 'vault.example',
        isPolicyReady: () => policyReady,
        waitForPolicyReady: () => policy,
        onBlocked: (event: any) => { blocked.push(event); },
        turnSlots: () => null,
        closeTab: () => {},
        noteUnavailable: () => {},
        storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      });
      guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
      const decision = guard.onBeforeRequest({ tabId: 8, url, type: 'main_frame' });
      let settled = false;
      void Promise.resolve(decision).then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      policyReady = true;
      settlePolicy(true);
      await expect(decision).resolves.toEqual(expected);
      expect(blocked).toEqual('cancel' in expected
        ? [{ sourceTabId: 7, tabId: 8, reason: 'sensitive_site' }] : []);
    }
  });

  test('denylist seed failure and timeout emit a retryable exact-child outcome', async () => {
    for (const waitForPolicyReady of [
      () => { throw new Error('seed unavailable'); },
      () => Promise.reject(new Error('seed unavailable')),
      () => new Promise<boolean>(() => {}),
    ]) {
      const blocked: any[] = [];
      const failures: any[] = [];
      const guard = makeDrivenChildRequestGuard({
        isDrivenSource: () => true,
        classifyTarget: (url) => classifyDrivenChildRequestTarget(url, () => false, false),
        waitForPolicyReady,
        policyTimeoutMs: 0,
        onBlocked: (event) => { blocked.push(event); },
        onUnavailable: (failure) => { failures.push(failure); },
      });
      guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
      await expect(guard.onBeforeRequest({
        tabId: 8, url: 'https://public.example/', type: 'main_frame',
      })).resolves.toEqual({ cancel: true });
      expect(blocked).toEqual([{
        sourceTabId: 7, tabId: 8, reason: 'policy_unavailable',
      }]);
      expect(failures).toEqual([{
        ok: false, code: 'firefox-child-policy-unavailable', outcomeKnown: true,
        retryable: true, affectedTabIds: [8], sourceTabIds: [7],
        confirmedTabIds: [], closeTabIds: [],
      }]);
    }
  });

  test('a Firefox child policy failure stops only its web actor turn', async () => {
    const stopped: string[] = [];
    const notes: any[] = [];
    const guard = createKernelFirefoxGuard({
      isSourceReady: () => true,
      isDrivenSource: () => true,
      isSensitiveHost: () => false,
      isPolicyReady: () => false,
      waitForPolicyReady: async () => false,
      webActorSessionForTab: (tabId: number) => tabId === 7 ? 'web-turn' : null,
      turnSlots: () => ({
        busySessionIds: () => ['main-turn', 'web-turn'],
        stop: (sessionId: string) => { stopped.push(sessionId); },
      }),
      closeTab: () => {},
      noteUnavailable: (...args: any[]) => { notes.push(args); },
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
    await expect(guard.onBeforeRequest({
      tabId: 8, url: 'https://public.example/', type: 'main_frame',
    })).resolves.toEqual({ cancel: true });
    expect(stopped).toEqual(['web-turn']);
    expect(notes).toEqual([['Web automation paused. Retry.', null, 'web-turn']]);
  });

  test('cold ordinary popup waits before DNS and proceeds after authoritative false', async () => {
    let settleAuthority!: (driven: boolean) => void;
    const authority = new Promise<boolean>((resolve) => { settleAuthority = resolve; });
    const failures: any[] = [];
    const guard = makeDrivenChildRequestGuard({
      isSourceReady: () => false,
      isDrivenSource: () => false,
      waitForSourceAuthority: () => authority,
      classificationTimeoutMs: 50,
      classifyTarget: (url) => ({ allowed: !url.includes('127.0.0.1') }),
      onUnavailable: (failure) => { failures.push(failure); },
    });
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 6 });
    expect(guard.has(8)).toBe(true);
    expect(guard.ready()).toBe(false);
    const decision = guard.onBeforeRequest({ tabId: 8, url: 'https://public.example/' });
    expect(decision).toBeInstanceOf(Promise);
    settleAuthority(false);
    await expect(decision).resolves.toEqual({});
    expect(failures).toEqual([]);
    expect(guard.has(8)).toBe(false);
    expect(guard.onBeforeRequest({ tabId: 8, url: 'https://public.example/' })).toEqual({});
  });

  test('negative DNR evidence cannot release a tracker-owned child', async () => {
    let settleAuthority!: (driven: boolean) => void;
    const authority = new Promise<boolean>((resolve) => { settleAuthority = resolve; });
    const guard = makeDrivenChildRequestGuard({
      isSourceReady: () => false,
      isDrivenSource: () => false,
      waitForSourceEvidence: async () => false,
      waitForSourceAuthority: () => authority,
      classificationTimeoutMs: 50,
    });
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
    const decision = guard.onBeforeRequest({
      tabId: 8, url: 'http://127.0.0.1/', type: 'main_frame',
    });
    let settled = false;
    void Promise.resolve(decision).then(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(guard.has(8)).toBe(true);
    settleAuthority(true);
    await expect(decision).resolves.toEqual({ cancel: true });
    expect(guard.has(8)).toBe(true);
  });

  test('gated compact rule evidence keeps driven private and sensitive requests blocked', async () => {
    for (const target of ['http://127.0.0.1/', 'https://vault.example/']) {
      let settleEvidence!: (positive: boolean) => void;
      const evidence = new Promise<boolean>((resolve) => { settleEvidence = resolve; });
      const guard = makeDrivenChildRequestGuard({
        isSourceReady: () => false,
        isDrivenSource: () => false,
        waitForSourceEvidence: () => evidence,
        waitForSourceAuthority: () => evidence.then(() => true),
        classificationTimeoutMs: 50,
        classifyTarget: (url) => ({
          allowed: !url.includes('127.0.0.1') && !url.includes('vault.example'),
        }),
      });
      guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
      const decision = guard.onBeforeRequest({ tabId: 8, url: target });
      expect(decision).toBeInstanceOf(Promise);
      settleEvidence(true);
      await expect(decision).resolves.toEqual({ cancel: true });
      expect(guard.ready()).toBe(true);
      expect(guard.has(8)).toBe(true);
      expect(guard.onBeforeRequest({ tabId: 8, url: 'https://public.example/' })).toEqual({});
    }
  });

  test('bare DNR evidence stays held until tracker authority rejects numeric reuse', async () => {
    let settleEvidence!: (positive: boolean) => void;
    let settleProjection!: (driven: boolean) => void;
    const evidence = new Promise<boolean>((resolve) => { settleEvidence = resolve; });
    const projection = new Promise<boolean>((resolve) => { settleProjection = resolve; });
    const guard = makeDrivenChildRequestGuard({
      isSourceReady: () => false,
      isDrivenSource: () => false,
      waitForSourceEvidence: () => evidence,
      waitForSourceAuthority: () => projection,
      classificationTimeoutMs: 50,
    });
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
    const decision = guard.onBeforeRequest({ tabId: 8, url: 'https://public.example/' });
    let settled = false;
    void Promise.resolve(decision).then(() => { settled = true; });
    settleEvidence(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(guard.has(8)).toBe(true);
    settleProjection(false);
    await expect(decision).resolves.toEqual({});
    expect(guard.has(8)).toBe(false);
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

  test('recycled exact markers await authority and preserve exact request policy', async () => {
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
    expect(JSON.parse(values.get(FIREFOX_DRIVEN_CHILD_IDS_KEY)!)).toEqual([8]);

    let ordinaryDemands = 0;
    const recycled = makeDrivenChildRequestGuard({
      isSourceReady: () => false,
      isDrivenSource: () => false,
      ensureSourceAuthority: () => {
        ordinaryDemands += 1;
        return Promise.resolve(false);
      },
      classifyTarget: (url) => ({ allowed: !url.includes('127.0.0.1') }),
      markers,
    });
    const ordinary = recycled.onBeforeRequest({
      tabId: 8, url: 'https://public.example/', type: 'xmlhttprequest',
    });
    expect(ordinary).toEqual({});
    expect(ordinaryDemands).toBe(0);
    await expect(recycled.onBeforeRequest({
      tabId: 8, url: 'http://127.0.0.1/private', type: 'xmlhttprequest',
    })).resolves.toEqual({});
    expect(ordinaryDemands).toBe(1);
    expect(recycled.has(8)).toBe(false);
    expect(recycled.ready()).toBe(true);
    expect(recycled.onBeforeRequest({
      tabId: 9, url: 'http://127.0.0.1/private', type: 'xmlhttprequest',
    })).toEqual({});
    expect(values.has(FIREFOX_DRIVEN_CHILD_MARKERS_KEY)).toBe(false);
    expect(values.has(FIREFOX_DRIVEN_CHILD_IDS_KEY)).toBe(false);

    const blocked: any[] = [];
    let drivenDemands = 0;
    markers.write([{ tabId: 8, sourceTabId: 7 }]);
    const driven = makeDrivenChildRequestGuard({
      isSourceReady: () => false,
      isDrivenSource: () => false,
      ensureSourceAuthority: () => {
        drivenDemands += 1;
        return Promise.resolve(true);
      },
      classifyTarget: (target) => ({ allowed: !target.includes('127.0.0.1') }),
      onBlocked: (event) => { blocked.push(event); },
      markers,
    });
    expect(driven.onBeforeRequest({
      tabId: 8, url: 'https://public.example/', type: 'main_frame',
    })).toEqual({});
    expect(drivenDemands).toBe(0);
    await expect(driven.onBeforeRequest({
      tabId: 8, url: 'http://127.0.0.1/private', type: 'main_frame',
    })).resolves.toEqual({ cancel: true });
    expect(drivenDemands).toBe(1);
    expect(driven.has(8)).toBe(true);
    expect(driven.ready()).toBe(true);
    expect(blocked).toEqual([{
      sourceTabId: 7, tabId: 8, reason: 'private_network',
    }]);
    driven.release(8);

    markers.write([{ tabId: 8, sourceTabId: 7 }]);
    const failures: any[] = [];
    const rejected = makeDrivenChildRequestGuard({
      isSourceReady: () => false,
      isDrivenSource: () => false,
      waitForSourceEvidence: () => Promise.reject(new Error('dnr unavailable')),
      ensureSourceAuthority: () => Promise.reject(new Error('projection unavailable')),
      classificationTimeoutMs: 0,
      onUnavailable: (failure) => { failures.push(failure); },
      markers,
    });
    await expect(rejected.onBeforeRequest({
      tabId: 8, url: 'http://127.0.0.1/private', type: 'main_frame',
    })).resolves.toEqual({ cancel: true });
    expect(failures.at(-1)).toMatchObject({
      retryable: true, affectedTabIds: [8], closeTabIds: [],
    });
    rejected.release(8);
  });

  test('corrupt hydration blocks only ledger-pinned children and reports retryable custody', () => {
    const values = new Map<string, string>([
      [FIREFOX_DRIVEN_CHILD_MARKERS_KEY, '{broken'],
      [FIREFOX_DRIVEN_CHILD_IDS_KEY, '[30]'],
    ]);
    const failures: any[] = [];
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as unknown as Storage;
    const markers = makeFirefoxDrivenChildMarkerStore(storage);
    const corrupt = makeDrivenChildRequestGuard({
      isDrivenSource: () => false, markers,
      onUnavailable: (failure) => { failures.push(failure); },
    });
    expect(corrupt.ready()).toBe(false);
    expect(corrupt.onBeforeRequest({ tabId: 30, url: 'https://public.example/' }))
      .toEqual({ cancel: true });
    expect(corrupt.onBeforeRequest({ tabId: 31, url: 'https://public.example/' }))
      .toEqual({});
    expect(corrupt.status()).toEqual({
      ok: false, code: 'firefox-child-custody-unavailable', outcomeKnown: true,
      retryable: true, affectedTabIds: [30],
    });
    expect(failures.at(-1)).toMatchObject({
      code: 'firefox-child-custody-unavailable',
      affectedTabIds: [30], confirmedTabIds: [], closeTabIds: [],
    });
    expect(corrupt.reconcile([])).toBe(true);
    expect(values.size).toBe(0);

    markers.write([{ tabId: 8, sourceTabId: 7 }]);
    const stale = makeDrivenChildRequestGuard({ isDrivenSource: () => false, markers });
    expect(stale.reconcile([{ id: 8, openerTabId: 99 }, { id: 7 }])).toBe(true);
    expect(stale.has(8)).toBe(false);
    expect(values.size).toBe(0);
  });

  test('total storage loss refuses custody without blocking ordinary tabs', () => {
    const failures: any[] = [];
    const guard = makeDrivenChildRequestGuard({
      isDrivenSource: () => false,
      markers: {
        read: () => { throw new Error('storage lost'); },
        readExactIds: () => { throw new Error('storage lost'); },
        write: () => { throw new Error('storage lost'); },
      },
      onUnavailable: (failure) => { failures.push(failure); },
    });
    expect(guard.ready()).toBe(false);
    expect(guard.onBeforeRequest({ tabId: 99, url: 'https://public.example/' }))
      .toEqual({});
    expect(failures).toEqual([{
      ok: false, code: 'firefox-child-custody-unavailable', outcomeKnown: true,
      retryable: true, affectedTabIds: [], sourceTabIds: [],
      confirmedTabIds: [], closeTabIds: [],
    }]);
  });

  test('holds requests after a synchronous marker write failure', () => {
    const failures: any[] = [];
    const guard = makeDrivenChildRequestGuard({
      isDrivenSource: () => true,
      markers: {
        read: () => [],
        write: () => { throw new Error('disk unavailable'); },
      },
      onUnavailable: (failure) => { failures.push(failure); },
    });
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
    expect(guard.ready()).toBe(false);
    expect(guard.onBeforeRequest({ tabId: 8, url: 'https://public.example/' }))
      .toEqual({ cancel: true });
    expect(guard.onBeforeRequest({ tabId: 99, url: 'https://public.example/' }))
      .toEqual({});
    expect(failures.at(-1)).toMatchObject({ affectedTabIds: [8], retryable: true });
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
    expect(guard.onBeforeRequest({ tabId: 1, url: 'https://public.example/' }))
      .toEqual({ cancel: true });
    expect(guard.onBeforeRequest({ tabId: 99, url: 'https://public.example/' }))
      .toEqual({});
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

  test('the Firefox addon never closes a corrupt ledger id that is an ordinary live tab', () => {
    const values = new Map<string, string>([
      [FIREFOX_DRIVEN_CHILD_MARKERS_KEY, '{broken'],
      [FIREFOX_DRIVEN_CHILD_IDS_KEY, '[30]'],
    ]);
    const closed: number[] = [];
    const stopped: string[] = [];
    const guard = createKernelFirefoxGuard({
      isSourceReady: () => true,
      isDrivenSource: () => false,
      isSensitiveHost: () => false,
      turnSlots: () => ({
        busySessionIds: () => ['live'],
        stop: (sessionId: string) => { stopped.push(sessionId); },
      }),
      closeTab: (tabId: number) => { closed.push(tabId); },
      noteUnavailable: () => {},
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      },
    });

    expect(stopped).toEqual([]);
    expect(closed).toEqual([]);
    expect(guard.reconcile([{ id: 6 }, { id: 30, openerTabId: 6 }])).toBe(true);
    expect(closed).toEqual([]);
    expect(guard.has(30)).toBe(false);
  });

  test('timeout keeps an ambiguous child alive for late authoritative release', async () => {
    const failures: any[] = [];
    let settleAuthority!: (driven: boolean) => void;
    const authority = new Promise<boolean>((resolve) => { settleAuthority = resolve; });
    const guard = makeDrivenChildRequestGuard({
      isSourceReady: () => false,
      isDrivenSource: () => false,
      waitForSourceAuthority: () => authority,
      classificationTimeoutMs: 0,
      onUnavailable: (failure) => { failures.push(failure); },
    });
    guard.onNavigationTarget({ tabId: 8, sourceTabId: 7 });
    const decision = guard.onBeforeRequest({ tabId: 8, url: 'https://public.example/' });
    expect(decision).toBeInstanceOf(Promise);
    expect(guard.onBeforeRequest({ tabId: 9, url: 'https://public.example/' })).toEqual({});
    await expect(decision).resolves.toEqual({ cancel: true });
    expect(failures.at(-1)).toEqual({
      ok: false, code: 'firefox-child-custody-unavailable', outcomeKnown: true,
      retryable: true, affectedTabIds: [8], sourceTabIds: [7],
      confirmedTabIds: [], closeTabIds: [],
    });
    expect(guard.has(8)).toBe(true);
    settleAuthority(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(guard.has(8)).toBe(false);
    expect(guard.onBeforeRequest({ tabId: 8, url: 'https://public.example/' })).toEqual({});
    expect(guard.ready()).toBe(true);
  });

  test('settles a restored marker when cold source projection becomes ready', () => {
    let ready = false;
    const values = new Map<string, string>([
      [FIREFOX_DRIVEN_CHILD_MARKERS_KEY, JSON.stringify([{ tabId: 8, sourceTabId: 7 }])],
      [FIREFOX_DRIVEN_CHILD_IDS_KEY, '[8]'],
    ]);
    const guard = makeDrivenChildRequestGuard({
      isSourceReady: () => ready,
      isDrivenSource: (tabId) => tabId === 7,
      markers: {
        read: () => JSON.parse(values.get(FIREFOX_DRIVEN_CHILD_MARKERS_KEY) ?? '[]'),
        readExactIds: () => JSON.parse(values.get(FIREFOX_DRIVEN_CHILD_IDS_KEY) ?? '[]'),
        write: (markers) => {
          values.set(FIREFOX_DRIVEN_CHILD_MARKERS_KEY, JSON.stringify(markers));
          values.set(FIREFOX_DRIVEN_CHILD_IDS_KEY, JSON.stringify(
            markers.map(({ tabId }) => tabId),
          ));
        },
      },
    });
    expect(guard.ready()).toBe(false);
    ready = true;
    expect(guard.ready()).toBe(true);
    expect(guard.status()).toEqual({ ok: true });
    expect(guard.onBeforeRequest({
      tabId: 8, url: 'http://127.0.0.1/private', type: 'xmlhttprequest',
    })).toEqual({ cancel: true });
  });
});
