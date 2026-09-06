// @ts-check
// Real packaged realm proof for the shared Chrome/Firefox feature Worker.

import { describe, it, expect } from '../../framework.js';
import { CONTROLLER_REALM_FACT_KEYS } from '/shared/structured-clone-size.js';
import { renderSystemPromptFromAssets } from '/peerd-runtime/loop/system-prompt.js';

/**
 * @param {(context: { worker: Worker, port: MessagePort, ready: any }) => Promise<void>} run
 */
const withControllerWorker = async (run) => {
  const worker = new Worker('/offscreen/controller-worker.js', {
    type: 'module', name: 'peerd-controller-test',
  });
  const channel = new MessageChannel();
  try {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('controller Worker did not become ready')), 10_000);
      channel.port1.onmessage = (event) => {
        if (event.data?.type === 'controller-worker/error') {
          clearTimeout(timer);
          reject(new Error(String(event.data.error)));
        } else if (event.data?.type === 'controller-worker/ready') {
          clearTimeout(timer);
          resolve(event.data);
        }
      };
      channel.port1.start();
      worker.postMessage({ type: 'controller-worker/bootstrap' }, [channel.port2]);
    });
    await run({ worker, port: channel.port1, ready: await ready });
  } finally {
    channel.port1.close();
    worker.terminate();
  }
};

describe('sealed controller Worker (real browser realm)', () => {
  it('proves every ambient authority is absent before the runtime loads', async () => {
    await withControllerWorker(async ({ ready }) => {
      expect(Object.keys(ready.realm).sort()).toEqual([...CONTROLLER_REALM_FACT_KEYS].sort());
      for (const key of CONTROLLER_REALM_FACT_KEYS) expect(ready.realm[key]).toBe(false);
      expect(ready.prototypeFetchBlocked).toBe(true);
      expect(ready.prototypeStorageBlocked).toBe(true);
    });
  });

  it('executes only the registered capability over its private port', async () => {
    await withControllerWorker(async ({ port }) => {
      const result = new Promise((resolve) => {
        port.onmessage = (event) => {
          if (event.data?.type === 'controller-worker/result') resolve(event.data.result);
        };
      });
      port.postMessage({
        type: 'controller-worker/call', requestId: 'real-worker-ping',
        capability: 'health.ping', payload: { value: 7 },
        authority: {
          ownerId: 'test', sessionId: null, instanceId: null,
          origin: null, target: null, replayClass: 'A',
        },
        deadlineAt: Date.now() + 5_000,
      });
      expect(await result).toEqual({
        ok: true, outcomeKnown: true, payload: { value: 7 },
      });
    });
  });

  it('renders the exact pure prompt inside the sealed realm', async () => {
    await withControllerWorker(async ({ port }) => {
      const payload = {
        ctx: {
          actorType: 'app', actorSurface: /** @type {'code'} */ ('code'), instanceId: 'app-test',
        },
        template: 'BASE {{DWEB_BLOCK}}{{MEMORY_BLOCK}}{{TEMPORAL_BLOCK}}{{SKILLS_BLOCK}}{{WEB_TAB_POLICY}}',
        dwebBlock: '',
      };
      const result = new Promise((resolve) => {
        port.onmessage = (event) => {
          if (event.data?.type === 'controller-worker/result') resolve(event.data.result);
        };
      });
      port.postMessage({
        type: 'controller-worker/call', requestId: 'real-worker-prompt',
        capability: 'prompt.render', payload,
        authority: {
          ownerId: 'test', sessionId: null, instanceId: null,
          origin: null, target: 'system-prompt', replayClass: 'A',
        },
        deadlineAt: Date.now() + 5_000,
      });
      expect(await result).toEqual({
        ok: true,
        outcomeKnown: true,
        prompt: renderSystemPromptFromAssets(payload.ctx, payload),
      });
    });
  });
});
