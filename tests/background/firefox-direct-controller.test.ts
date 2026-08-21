import { describe, expect, test } from 'bun:test';
import {
  connectDirectController,
  makeIdleDirectControllerLoader,
} from '../../extension/background/direct-controller-client.js';
import { CONTROLLER_REALM_FACT_KEYS } from '../../extension/shared/structured-clone-size.js';

const SEALED_REALM = Object.fromEntries(CONTROLLER_REALM_FACT_KEYS.map((key) => [key, false]));
const BUILD_DIGEST = 'b'.repeat(64);
const AUTHORITY = Object.freeze({
  ownerId: 'root:firefox', sessionId: 'session:firefox', instanceId: null,
  origin: null, target: null, replayClass: 'E',
});
const connectController = (deps: Omit<Parameters<typeof connectDirectController>[0],
  'buildDigest' | 'authorizeCall'>) =>
  connectDirectController({
    ...deps,
    buildDigest: BUILD_DIGEST,
    authorizeCall: () => AUTHORITY,
  });

const ids = (...values: string[]) => {
  const queue = [...values];
  return () => queue.shift() ?? crypto.randomUUID();
};

const makeWorker = (generation: number, terminated: number[]) => ({
  postMessage: (_message: any, transfer: Transferable[]) => {
    const port = transfer[0] as MessagePort;
    port.onmessage = (event) => {
      if (event.data.type === 'controller-worker/call') {
        port.postMessage({
          type: 'controller-worker/result',
          requestId: event.data.requestId,
          result: {
            ok: true,
            generation,
            capability: event.data.capability,
            payload: event.data.payload,
          },
        });
      }
    };
    port.start();
    port.postMessage({ type: 'controller-worker/ready', realm: SEALED_REALM });
  },
  terminate: () => { terminated.push(generation); },
}) as unknown as Worker;

describe('Firefox direct controller adapter', () => {
  test('uses the shared open/accept/commit/settle protocol and call surface', async () => {
    const phases: string[] = [];
    const controller = await connectController({
      capabilities: ['state.read'],
      supportedCapabilities: ['state.read'],
      newId: ids('channel-firefox', 'epoch-firefox', 'request-firefox'),
      loadController: async () => {
        phases.push('loaded');
        return {
          call: async (capability, payload) => {
            phases.push('called');
            return { ok: true, capability, payload };
          },
        };
      },
    });
    expect(phases).toEqual([]);
    await expect(controller.call('state.read', { value: 7 })).resolves.toMatchObject({
      ok: true,
      capability: 'state.read',
      payload: { value: 7 },
      outcomeKnown: true,
      phase: 'settled',
    });
    expect(phases).toEqual(['loaded', 'called']);
    expect(controller.channelId).toBe('channel-firefox');
    expect(controller.epoch).toBe('epoch-firefox');
    controller.close();
  });

  test('keeps capability refusal known-safe and never loads the feature', async () => {
    let loads = 0;
    const controller = await connectController({
      capabilities: ['state.read'],
      supportedCapabilities: ['state.read'],
      loadController: async () => {
        loads += 1;
        return { call: async () => ({ ok: true }) };
      },
    });
    await expect(controller.call('repo.write', {})).resolves.toMatchObject({
      ok: false,
      code: 'controller-capability-denied',
      outcomeKnown: true,
      phase: 'startup',
    });
    expect(loads).toBe(0);
    controller.close();
  });

  test('inherits the event-page kernel identity instead of minting an adapter epoch', async () => {
    const identity = Object.freeze({
      schema: 1 as const,
      buildId: `0.7.0:${BUILD_DIGEST}`,
      bootId: 'boot-firefox-aa',
      kernelEpoch: 'kernel-firefox-a',
    });
    const generated: string[] = [];
    const controller = await connectController({
      capabilities: ['state.read'],
      supportedCapabilities: ['state.read'],
      kernelIdentity: identity,
      newId: () => {
        const value = `direct-adapter-${generated.length + 1}`;
        generated.push(value);
        return value;
      },
      loadController: async () => ({ call: async () => ({ ok: true }) }),
    });
    expect(controller.epoch).toBe(identity.kernelEpoch);
    expect(controller.kernelIdentity).toEqual(identity);
    expect(generated).toEqual(['direct-adapter-1', 'direct-adapter-2']);
    controller.close();
  });

  test('discards an idle Worker and recreates a clean generation on demand', async () => {
    const created: number[] = [];
    const terminated: number[] = [];
    const loader = makeIdleDirectControllerLoader({
      workerUrl: 'moz-extension://id/offscreen/controller-worker.js',
      idleMs: 5,
      newId: ids('inner-one', 'inner-two'),
      createWorker: (url, options) => {
        expect(url).toBe('moz-extension://id/offscreen/controller-worker.js');
        expect(options).toMatchObject({ type: 'module', name: 'peerd-controller' });
        const generation = created.length + 1;
        created.push(generation);
        return makeWorker(generation, terminated);
      },
    });
    const controller = await connectController({
      capabilities: ['state.read'],
      supportedCapabilities: ['state.read'],
      loader,
    });
    await expect(controller.call('state.read', { sequence: 1 }))
      .resolves.toMatchObject({ ok: true, generation: 1 });
    expect(created).toEqual([1]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(terminated).toEqual([1]);
    await expect(controller.call('state.read', { sequence: 2 }))
      .resolves.toMatchObject({ ok: true, generation: 2 });
    expect(created).toEqual([1, 2]);
    controller.close();
    expect(terminated).toEqual([1, 2]);
  });

  test('a simulated event-page discard retires the old epoch and Worker', async () => {
    const terminated: number[] = [];
    const makeEventPage = async (generation: number) => connectController({
      capabilities: ['state.read'],
      supportedCapabilities: ['state.read'],
      newId: ids(`channel-${generation}`, `epoch-${generation}`, `host-epoch-${generation}`),
      loader: makeIdleDirectControllerLoader({
        workerUrl: 'moz-extension://id/offscreen/controller-worker.js',
        idleMs: 60_000,
        createWorker: () => makeWorker(generation, terminated),
      }),
    });
    const first = await makeEventPage(1);
    await expect(first.call('state.read', {})).resolves.toMatchObject({ generation: 1 });
    first.close();
    const second = await makeEventPage(2);
    await expect(second.call('state.read', {})).resolves.toMatchObject({ generation: 2 });
    expect(first.epoch).not.toBe(second.epoch);
    expect(terminated).toEqual([1]);
    second.close();
    expect(terminated).toEqual([1, 2]);
  });
});
