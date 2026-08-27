import { describe, expect, test } from 'bun:test';
import { createDwebPublicationFence } from '../../extension/background/dweb-publication-fence.js';
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
    withDwebReseedPublication: async (operation: any) => operation(() => true),
    withAppLifecycle: async (_id: string, operation: any) => operation(),
    repositories: {},
    sendMessage: async (message: any) => { messages.push(message); return { ok: true }; },
    currentHostEpoch: () => currentEpoch,
    newId: () => 'reseed-attempt-0001',
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
      reseedAttemptId: 'reseed-attempt-0001',
      expectedHostEpoch: 'host-epoch-0001', expectedMeshGeneration: 1,
    });
  });

  test('binds the write-ahead retirement fence to the exact reseed host epoch', async () => {
    let fencedHostEpoch = '';
    const h = owner({
      withDwebReseedPublication: async (operation: any, options: any) => {
        fencedHostEpoch = options.hostEpoch;
        return operation(() => true);
      },
    });
    await h.value.onHostGeneration({
      hostEpoch: 'host-epoch-exact', meshGeneration: 7,
    });
    expect(fencedHostEpoch).toBe('host-epoch-exact');
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

  test('marks a timed-out host message uncertain so production retires its realm', async () => {
    const retirements: string[] = [];
    const publicationFence = createDwebPublicationFence({
      retireReseedHost: async (reason) => { retirements.push(reason); },
    });
    const h = owner({
      sendMessage: async () => new Promise(() => {}),
      withDwebReseedPublication: publicationFence.runReseed,
      messageTimeoutMs: 5,
    });
    expect(await h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0007', meshGeneration: 1,
    })).toEqual({
      ok: false, seeded: 0, failed: 1, error: 'dweb-reseed-partial',
    });
    expect(retirements).toEqual(['dweb-reseed-outcome-unknown']);
  });

  test('retires the host when offscreen reports failed compensation', async () => {
    const retirements: string[] = [];
    const publicationFence = createDwebPublicationFence({
      retireReseedHost: async (reason) => { retirements.push(reason); },
    });
    const h = owner({
      sendMessage: async () => ({
        ok: false, error: 'dweb reseed compensation failed',
        code: 'dweb-reseed-compensation-failed', outcomeKnown: false,
      }),
      withDwebReseedPublication: publicationFence.runReseed,
    });
    expect(await h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0008', meshGeneration: 1,
    })).toEqual({
      ok: false, seeded: 0, failed: 1, error: 'dweb-reseed-partial',
    });
    expect(retirements).toEqual(['dweb-reseed-outcome-unknown']);
  });

  test('retires after a post-dispatch transport rejection or malformed receipt', async () => {
    for (const sendMessage of [
      async () => { throw new Error('receiving-end-disappeared'); },
      async () => ({}),
    ]) {
      const retirements: string[] = [];
      const publicationFence = createDwebPublicationFence({
        retireReseedHost: async (reason) => { retirements.push(reason); },
      });
      const h = owner({
        sendMessage,
        withDwebReseedPublication: publicationFence.runReseed,
      });
      await h.value.onHostGeneration({
        hostEpoch: 'host-epoch-0009', meshGeneration: 1,
      });
      expect(retirements).toEqual(['dweb-reseed-outcome-unknown']);
    }
  });

  test('the production publication and App fences release a hung predecessor', async () => {
    const publicationFence = createDwebPublicationFence();
    let appTail = Promise.resolve();
    const withAppLifecycle = (_id: string, operation: () => Promise<any>) => {
      const result = appTail.then(operation, operation);
      appTail = result.then(() => undefined, () => undefined);
      return result;
    };
    let reads = 0;
    let predecessorStarted!: () => void;
    const started = new Promise<void>((resolve) => { predecessorStarted = resolve; });
    const h = owner({
      appRegistry: {
        list: async () => [app],
        get: async () => {
          reads += 1;
          if (reads === 2) {
            predecessorStarted();
            return new Promise(() => {});
          }
          return app;
        },
      },
      withDwebReseedPublication: publicationFence.runReseed,
      withAppLifecycle,
      messageTimeoutMs: 5,
    });
    const predecessor = h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0005', meshGeneration: 1,
    });
    await started;
    const successor = h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0005', meshGeneration: 2,
    });
    expect(await successor).toEqual({ ok: true, seeded: 1 });
    expect(await predecessor).toMatchObject({
      ok: false, cancelled: true, error: 'dweb-generation-retired',
    });
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].expectedMeshGeneration).toBe(2);
  });

  test('repository preparation is bounded outside publication custody', async () => {
    const oid = 'b'.repeat(40);
    const released = {
      ...app,
      dweb: {
        ...app.dweb, git_oid: oid, source_git_oid: oid,
        release_entry_file: 'index.html', release_file_kinds: { 'index.html': 'text' },
      },
    };
    const publicationFence = createDwebPublicationFence();
    let snapshots = 0;
    let predecessorStarted!: () => void;
    const started = new Promise<void>((resolve) => { predecessorStarted = resolve; });
    const h = owner({
      appRegistry: { list: async () => [released], get: async () => released },
      repositories: { snapshot: async () => {
        snapshots += 1;
        if (snapshots === 1) {
          predecessorStarted();
          return new Promise(() => {});
        }
        return { 'index.html': new TextEncoder().encode('released') };
      } },
      withDwebReseedPublication: publicationFence.runReseed,
      messageTimeoutMs: 5,
    });
    const predecessor = h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0006', meshGeneration: 1,
    });
    await started;
    const successor = h.value.onHostGeneration({
      hostEpoch: 'host-epoch-0006', meshGeneration: 2,
    });
    expect(await successor).toEqual({ ok: true, seeded: 1 });
    expect(await predecessor).toMatchObject({
      ok: false, cancelled: true, error: 'dweb-generation-retired',
    });
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].expectedMeshGeneration).toBe(2);
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
