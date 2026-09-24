import { describe, expect, test } from 'bun:test';
import { createLocalModelGenerationAuthority } from '../../extension/background/local-model-generation-authority.js';

describe('local model Stop wiring', () => {
  test.each(['lease startup', 'host discovery'])('Stop during %s settles before dispatch', async (phase) => {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const offers: unknown[] = [];
    const client = {
      url: 'chrome-extension://fixture/offscreen/offscreen.html',
      postMessage: (offer: unknown) => { offers.push(offer); },
    };
    const waitForStartup = async () => {
      entered.resolve();
      await release.promise;
    };
    const authority = createLocalModelGenerationAuthority({
      featureHost: {
        runtime: {
          runWithLease: async (_scope: string, operation: (lease: any) => Promise<any>) => {
            try {
              if (phase === 'lease startup') await waitForStartup();
              return await operation({ scope: 'model-host', leaseId: 'lease-1234' });
            } finally { settled.resolve(); }
          },
        },
      },
      offscreenUrl: client.url,
      clientsApi: { matchAll: async () => {
        if (phase === 'host discovery') await waitForStartup();
        return [client];
      } },
    });
    const opening = authority.open({
      messages: [{ role: 'user', content: 'hello' }],
      system: '', tools: [], model: 'gemma-4-e2b', maxTokens: 32,
    }, {}, controller.signal);

    await entered.promise;
    controller.abort();
    // The caller settles even while host startup is still blocked.
    await expect(opening).rejects.toMatchObject({
      code: 'local-model-generation-aborted', outcomeKnown: true,
    });
    expect(authority.activeStreams()).toBe(0);
    expect(offers).toEqual([]);

    release.resolve();
    await settled.promise;
    expect(offers).toEqual([]);
    expect(authority.activeStreams()).toBe(0);
  });
});
