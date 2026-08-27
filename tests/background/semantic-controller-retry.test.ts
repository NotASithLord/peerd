import { describe, expect, test } from 'bun:test';
import { makeSemanticControllerClient } from '../../extension/background/offscreen-controller-client.js';
import { makeControllerOfferHandler } from '../../extension/offscreen/controller-shell.js';
import { CONTROLLER_BUILD_DIGEST } from '../../extension/shared/structured-clone-size.js';
import { STARTUP_UNAVAILABLE_USER_FAILURE } from '../../extension/shared/bounded-module-load.js';
import {
  TEST_CONTROLLER_KERNEL_IDENTITY,
  withTestControllerLease,
} from './controller-test-identity.ts';

const makeLane = (controllerCall: () => Promise<any> | any) => {
  const workerUrl = 'chrome-extension://test/background/service-worker.js';
  const offscreenUrl = 'chrome-extension://test/offscreen/offscreen.html';
  const offerHandler = makeControllerOfferHandler({
    expectedWorkerUrl: workerUrl,
    expectedBuildDigest: CONTROLLER_BUILD_DIGEST,
    supportedCaps: ['prompt.render'],
    loadController: async () => ({ call: controllerCall }),
  });
  const host = {
    url: offscreenUrl,
    postMessage: (data: unknown, transfer: Transferable[]) => {
      offerHandler({
        isTrusted: true,
        source: { scriptURL: workerUrl },
        data,
        ports: transfer,
      } as unknown as MessageEvent);
    },
  };
  let ensures = 0;
  const semantic = makeSemanticControllerClient({
    browser: { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } },
    ensureOffscreen: async () => { ensures += 1; },
    offscreenUrl: 'offscreen/offscreen.html',
    firefoxDirect: false,
    dwebEnabled: false,
    kernelIdentity: TEST_CONTROLLER_KERNEL_IDENTITY,
    withControllerLease: withTestControllerLease,
    fetchFn: (async () => new Response('template', { status: 200 })) as unknown as typeof fetch,
    listWindowClients: async () => [host],
  });
  return { semantic, ensures: () => ensures };
};

describe('semantic controller unavailable/retry behavior', () => {
  test('a pure prompt call retires a lost generation and succeeds once on replacement', async () => {
    let calls = 0;
    const lane = makeLane(() => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, code: 'controller-worker-lost', outcomeKnown: false };
      }
      return { ok: true, prompt: 'recovered prompt', outcomeKnown: true };
    });

    await expect(lane.semantic.renderSystemPrompt({ actorType: 'orchestrator' }))
      .resolves.toBe('recovered prompt');
    expect(calls).toBe(2);
    expect(lane.ensures()).toBe(3);
    lane.semantic.close();
  });

  test('repeated controller loss stops after the one replay-safe retry', async () => {
    let calls = 0;
    const lane = makeLane(() => {
      calls += 1;
      return { ok: false, code: 'controller-worker-lost', outcomeKnown: false };
    });

    await expect(lane.semantic.renderSystemPrompt({ actorType: 'orchestrator' }))
      .rejects.toThrow(STARTUP_UNAVAILABLE_USER_FAILURE);
    expect(calls).toBe(2);
    expect(lane.ensures()).toBe(3);
    lane.semantic.close();
  });
});
