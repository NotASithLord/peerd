import { describe, expect, test } from 'bun:test';
import { createKernelDwebReseedOwner } from '../../extension/background/kernel-dweb-reseed-owner.js';

const app = {
  id: 'app-1', name: 'App', entryFile: 'index.html', shared: true,
  dweb: { local: true, slug: 'app', manifest_created: 1, hash: 'hash', seq: 2 },
};

const owner = (over: Record<string, any> = {}) => {
  const messages: any[] = [];
  const value = createKernelDwebReseedOwner({
    active: () => true,
    locked: () => false,
    appRegistry: { list: async () => [app], get: async () => app },
    withDwebPublication: async (operation: any) => operation(() => true),
    withAppLifecycle: async (_id: string, operation: any) => operation(),
    repositories: {},
    sendMessage: async (message: any) => { messages.push(message); return { ok: true }; },
    log: { warn: () => {}, debug: () => {} },
    ...over,
  });
  return { value, messages };
};

describe('kernel dweb reseed owner', () => {
  test('re-reads inside the App lane and never resurrects a deleted share', async () => {
    const h = owner({
      appRegistry: { list: async () => [app], get: async () => null },
    });
    expect(await h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0001', meshGeneration: 1,
    })).toEqual({ ok: true, seeded: 0 });
    expect(h.messages).toEqual([]);
  });

  test('publishes once per exact host generation and coalesces duplicate notices', async () => {
    const h = owner();
    expect(await h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0001', meshGeneration: 1,
    })).toEqual({ ok: true, seeded: 1 });
    expect(await h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0001', meshGeneration: 1,
    })).toEqual({ ok: true, seeded: 0, coalesced: true });
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({
      type: 'dweb/base-host/share-app', appId: 'app-1', expectedHash: 'hash', reseed: true,
    });
  });

  test('reconstructs the exact signed release snapshot', async () => {
    const oid = 'a'.repeat(40);
    const released = {
      ...app,
      dweb: {
        ...app.dweb, git_oid: oid, source_git_oid: oid,
        release_entry_file: 'index.html',
        release_file_kinds: { 'index.html': 'text' },
      },
    };
    const h = owner({
      appRegistry: { list: async () => [released], get: async () => released },
      repositories: { snapshot: async () => ({
        'index.html': new TextEncoder().encode('released'),
      }) },
    });
    await h.value.onHostGeneration({ hostEpoch: 'host-epoch-0002', meshGeneration: 2 });
    expect(h.messages[0]).toMatchObject({
      release: { gitCommitOid: oid },
      releaseSnapshot: { oid, totalBytes: 8, record: { entryFile: 'index.html' } },
    });
  });

  test('does not retire a generation whose publication failed', async () => {
    let attempts = 0;
    const h = owner({
      sendMessage: async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, error: 'host-not-ready' } : { ok: true };
      },
    });
    const generation = { hostEpoch: 'host-epoch-0003', meshGeneration: 3 };
    expect(await h.value.onHostGeneration(generation)).toEqual({
      ok: false, seeded: 0, failed: 1, error: 'dweb-reseed-partial',
    });
    expect(await h.value.onHostGeneration(generation)).toEqual({ ok: true, seeded: 1 });
    expect(attempts).toBe(2);
  });

  test('serializes distinct generations and coalesces a duplicate while queued', async () => {
    const starts: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let noteFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { noteFirstStarted = resolve; });
    let calls = 0;
    const h = owner({
      sendMessage: async (message: any) => {
        calls += 1;
        starts.push(`${message.appId}:${calls}`);
        if (calls === 1) { noteFirstStarted(); await first; }
        return { ok: true };
      },
    });
    const generationOne = h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0004', meshGeneration: 1,
    });
    await firstStarted;
    const generationTwo = h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0004', meshGeneration: 2,
    });
    const generationTwoAgain = h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0004', meshGeneration: 2,
    });
    expect(starts).toEqual(['app-1:1']);
    expect(generationTwoAgain).toBe(generationTwo);
    releaseFirst();
    expect(await generationOne).toEqual({ ok: true, seeded: 1 });
    expect(await generationTwo).toEqual({ ok: true, seeded: 1 });
    expect(calls).toBe(2);
    expect(await h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0004', meshGeneration: 2,
    })).toEqual({ ok: true, seeded: 0, coalesced: true });
  });
});
