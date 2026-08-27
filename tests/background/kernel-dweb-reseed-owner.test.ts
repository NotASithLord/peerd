import { describe, expect, test } from 'bun:test';
import { createKernelDwebReseedOwner } from '../../extension/background/kernel-dweb-reseed-owner.js';

const app = {
  id: 'app-1', name: 'App', entryFile: 'index.html', shared: true,
  dweb: { local: true, slug: 'app', manifest_created: 1, hash: 'hash', seq: 2 },
};

const owner = (over: Record<string, any> = {}) => {
  const messages: any[] = [];
  let currentEpoch = 'host-epoch-0001';
  const value = createKernelDwebReseedOwner({
    active: () => true,
    locked: () => false,
    appRegistry: { list: async () => [app], get: async () => app },
    withDwebPublication: async (operation: any) => operation(() => true),
    withAppLifecycle: async (_id: string, operation: any) => operation(),
    repositories: {},
    sendMessage: async (message: any) => { messages.push(message); return { ok: true }; },
    currentHostEpoch: () => currentEpoch,
    log: { warn: () => {}, debug: () => {} },
    ...over,
  });
  return {
    value: Object.freeze({
      onHostGeneration: (event: any) => {
        if (!over.currentHostEpoch) currentEpoch = event.hostEpoch;
        return value.onHostGeneration(event);
      },
    }),
    messages,
    setCurrentEpoch: (epoch: string) => { currentEpoch = epoch; },
  };
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
      expectedHostEpoch: 'host-epoch-0001', expectedMeshGeneration: 1,
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

  test('retires a hung predecessor when a newer mesh generation arrives', async () => {
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const h = owner({
      sendMessage: async (message: any) => {
        if (message.expectedMeshGeneration === 1) {
          firstStarted();
          return new Promise(() => {});
        }
        return { ok: true };
      },
      messageTimeoutMs: 5,
    });
    const generationOne = h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0004', meshGeneration: 1,
    });
    await started;
    const generationTwo = h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0004', meshGeneration: 2,
    });
    expect(await generationTwo).toEqual({ ok: true, seeded: 1 });
    expect(await generationOne).toMatchObject({
      ok: false, cancelled: true, error: 'dweb-generation-retired',
    });
    expect(await h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0004', meshGeneration: 1,
    })).toMatchObject({ ok: false, cancelled: true });
  });

  test('rejects a delayed generation from a replaced physical host before reading state', async () => {
    let lists = 0;
    const h = owner({
      currentHostEpoch: () => 'host-epoch-current',
      appRegistry: { list: async () => { lists += 1; return [app]; }, get: async () => app },
    });
    expect(await h.value.onHostGeneration({
      hostEpoch: 'host-epoch-retired', meshGeneration: 4,
    })).toMatchObject({ ok: false, cancelled: true, error: 'dweb-generation-retired' });
    expect(lists).toBe(0);
    expect(h.messages).toEqual([]);
  });
});
