import { describe, expect, test } from 'bun:test';
import { makeSiteCaptureManager } from '../../extension/background/site-capture-manager.js';

const makeHarness = ({ cdp = true } = {}) => {
  const calls: string[] = [];
  const attached = new Set<number>();
  const debuggerPool = {
    startNetworkCapture: async (tabId: number) => {
      calls.push(`cdp:start:${tabId}`);
      attached.add(tabId);
    },
    stopNetworkCapture: async (tabId: number) => {
      calls.push(`cdp:stop:${tabId}`);
      return [{ method: 'GET', url: 'https://example.com/api' }];
    },
    discardNetworkCapture: async (tabId: number) => { calls.push(`cdp:discard:${tabId}`); },
    isAttached: (tabId: number) => attached.has(tabId),
    detach: async (tabId: number) => {
      calls.push(`cdp:detach:${tabId}`);
      attached.delete(tabId);
    },
    releaseNetworkCapture: (tabId: number) => { calls.push(`cdp:release:${tabId}`); },
  };
  const scripting = {
    executeScript: async ({ func }: any) => {
      calls.push(func.name);
      return func.name === 'drainTap'
        ? [{ result: { events: [{ method: 'GET', url: 'https://example.com/api' }] } }]
        : [{ result: { ok: true } }];
    },
  };
  const installTap = function installTap() {};
  const drainTap = function drainTap() {};
  const manager = makeSiteCaptureManager({
    advancedAutomationOn: () => cdp,
    debuggerPool,
    scripting,
    installFetchTapInjected: installTap,
    drainFetchTapInjected: drainTap,
    digestCapture: (events, opts) => ({ events, ...opts }),
  });
  return { calls, manager, attached };
};

describe('site capture manager', () => {
  test('private-target cancellation disables CDP and discards without a digest', async () => {
    const { calls, manager } = makeHarness();
    await manager.start({ tabId: 7, origins: ['https://example.com'], documentId: 'doc-1' });
    await manager.cancel({ tabId: 7 });
    const stopped = await manager.stop({ tabId: 7, origins: ['https://other.example'] });

    expect(calls).toEqual(['cdp:start:7', 'cdp:discard:7', 'cdp:detach:7']);
    expect(stopped).toEqual({ cancelled: 'page_changed' });
  });

  test('injected cancellation never injects into the replacement document', async () => {
    const { calls, manager } = makeHarness({ cdp: false });
    await manager.start({ tabId: 7, origins: ['https://example.com'], documentId: 'doc-1' });
    await manager.cancel({ tabId: 7 });

    expect(calls).toEqual(['installTap']);
  });

  test('navigation cancellation is reported instead of returning an empty digest', async () => {
    const { manager } = makeHarness({ cdp: false });
    await manager.start({ tabId: 7, origins: ['https://example.com'], documentId: 'doc-1' });
    await manager.cancel({ tabId: 7, reason: 'page_changed' });

    expect(await manager.stop({ tabId: 7 })).toEqual({ cancelled: 'page_changed' });
  });

  test('navigation cancellation wins while a CDP stop is settling', async () => {
    let releaseStop = (_events: any[]) => {};
    const stopGate = new Promise<any[]>((resolve) => { releaseStop = resolve; });
    let digests = 0;
    const manager = makeSiteCaptureManager({
      advancedAutomationOn: () => true,
      debuggerPool: {
        startNetworkCapture: async () => {},
        stopNetworkCapture: async () => stopGate,
        discardNetworkCapture: async () => {},
        isAttached: () => false,
      },
      scripting: { executeScript: async () => [] },
      installFetchTapInjected: function installTap() {},
      drainFetchTapInjected: function drainTap() {},
      digestCapture: () => { digests += 1; return { endpoints: [] }; },
    });
    await manager.start({ tabId: 7, origins: ['https://example.com'], documentId: 'doc-1' });

    const stopping = manager.stop({ tabId: 7 });
    await Promise.resolve();
    expect(manager.has(7)).toBe(true);
    await manager.cancel({ tabId: 7, reason: 'page_changed' });
    releaseStop([{ method: 'GET', url: 'https://example.com/private' }]);

    expect(await stopping).toEqual({ cancelled: 'page_changed' });
    expect(digests).toBe(0);
  });

  test('cancel does not detach an unrelated debugger session', async () => {
    const { calls, manager, attached } = makeHarness();
    attached.add(7);

    expect(await manager.cancel({ tabId: 7 })).toEqual({ discarded: false, detached: false });
    expect(calls).toEqual([]);
    expect(attached.has(7)).toBe(true);
  });

  test('stop digests against the origin captured at start', async () => {
    const { manager } = makeHarness({ cdp: false });
    await manager.start({ tabId: 7, origins: ['https://example.com'], documentId: 'doc-1' });
    const result = await manager.stop({ tabId: 7, origins: ['https://redirect.example'] });

    expect(result.origins).toEqual(['https://example.com']);
    expect(result.deriver).toBe('capture-tap');
    expect(result.events).toHaveLength(1);
  });

  test('tab removal releases manager and debugger state', async () => {
    const { calls, manager } = makeHarness();
    await manager.start({ tabId: 7, origins: ['https://example.com'], documentId: 'doc-1' });
    manager.release(7);
    await manager.stop({ tabId: 7, origins: ['https://example.com'] });

    expect(calls).toEqual(['cdp:start:7', 'cdp:release:7']);
  });
});
