import { describe, expect, test } from 'bun:test';
import {
  connectOffscreenController,
} from '../../extension/background/offscreen-controller-client.js';
import {
  bindControllerChannel,
  makeSealedControllerLoader,
} from '../../extension/offscreen/controller-shell.js';
import {
  normalizeControllerCustody,
} from '../../extension/shared/controller-kernel-quota.js';
import {
  CONTROLLER_REALM_FACT_KEYS,
} from '../../extension/shared/structured-clone-size.js';
import {
  makeLifecycleBoot,
} from '../../extension/peerd-runtime/lifecycle/boot.js';
import {
  OPERATION_STATES,
} from '../../extension/peerd-runtime/lifecycle/operation-state.js';

const BUILD_DIGEST = 'd'.repeat(64);
const SEALED_REALM = Object.fromEntries(
  CONTROLLER_REALM_FACT_KEYS.map((key) => [key, false]),
);
const AUTHORITY = Object.freeze({
  ownerId: 'root:worker-loss', sessionId: 'session:worker-loss',
  instanceId: null, origin: null, target: null, replayClass: 'E',
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('dedicated sealed-controller Worker loss', () => {
  test('a late reverse-RPC result is fenced to the dead Worker generation', async () => {
    const oldReverse = deferred<any>();
    const firstReverseEntered = deferred<void>();
    const secondCallEntered = deferred<void>();
    const secondCallRelease = deferred<void>();
    const workerPorts: MessagePort[] = [];
    let generation = 0;
    let replacementKernelResults = 0;

    const loader = makeSealedControllerLoader({
      workerUrl: '/offscreen/controller-worker.js',
      // Reusing the request id makes the generation boundary, rather than an
      // accidental unique id, carry the isolation proof.
      newId: () => 'reused-worker-request',
      createWorker: () => {
        generation += 1;
        const thisGeneration = generation;
        return {
          postMessage: (_message: unknown, transfer: Transferable[]) => {
            const port = transfer[0] as MessagePort;
            workerPorts.push(port);
            port.onmessage = (event) => {
              const message = event.data;
              if (message.type === 'controller-worker/kernel-result') {
                if (thisGeneration === 2) replacementKernelResults += 1;
                return;
              }
              if (message.type !== 'controller-worker/call') return;
              if (thisGeneration === 1) {
                port.postMessage({
                  type: 'controller-worker/kernel-call',
                  requestId: message.requestId,
                  rpcId: 'reused-reverse-rpc',
                  operation: 'turn.session.get',
                  payload: { runId: 'run-old', value: { sessionId: 'session:worker-loss' } },
                });
                return;
              }
              secondCallEntered.resolve();
              void secondCallRelease.promise.then(() => port.postMessage({
                type: 'controller-worker/result', requestId: message.requestId,
                result: { ok: true, generation: thisGeneration, outcomeKnown: true },
              }));
            };
            port.start();
            port.postMessage({ type: 'controller-worker/ready', realm: SEALED_REALM });
          },
          terminate: () => {},
          addEventListener: () => {},
        } as unknown as Worker;
      },
    });

    const first = await loader();
    const firstCall = first.call('turn.run', { maxSteps: 1 }, {
      signal: new AbortController().signal,
      kernelCall: async () => {
        firstReverseEntered.resolve();
        return oldReverse.promise;
      },
    });
    await firstReverseEntered.promise;
    workerPorts[0].close();
    await expect(firstCall).resolves.toMatchObject({
      ok: false, code: 'controller-worker-lost', outcomeKnown: false, retryable: false,
    });

    const second = await loader();
    const secondCall = second.call('turn.run', { maxSteps: 1 }, {
      signal: new AbortController().signal,
      kernelCall: async () => ({ ok: true, outcomeKnown: true }),
    });
    await secondCallEntered.promise;
    oldReverse.resolve({ ok: true, outcomeKnown: true, value: { stale: true } });
    await nextTask();
    expect(replacementKernelResults).toBe(0);
    secondCallRelease.resolve();
    await expect(secondCall).resolves.toMatchObject({
      ok: true, generation: 2, outcomeKnown: true,
    });
    loader.close();
  });

  test('post-commit loss before any assistant event is unknown even when Stop races it', async () => {
    const workerCallEntered = deferred<void>();
    const workerPorts: MessagePort[] = [];
    let workerGeneration = 0;
    let admittedCalls = 0;
    const loader = makeSealedControllerLoader({
      workerUrl: '/offscreen/controller-worker.js',
      createWorker: () => {
        workerGeneration += 1;
        const thisGeneration = workerGeneration;
        return {
          postMessage: (_message: unknown, transfer: Transferable[]) => {
            const port = transfer[0] as MessagePort;
            workerPorts.push(port);
            port.onmessage = (event) => {
              if (event.data.type !== 'controller-worker/call') return;
              admittedCalls += 1;
              if (thisGeneration === 1) {
                workerCallEntered.resolve();
                return;
              }
              port.postMessage({
                type: 'controller-worker/result', requestId: event.data.requestId,
                result: { ok: true, generation: thisGeneration, outcomeKnown: true },
              });
            };
            port.start();
            port.postMessage({ type: 'controller-worker/ready', realm: SEALED_REALM });
          },
          terminate: () => {},
          addEventListener: () => {},
        } as unknown as Worker;
      },
    });

    const controller = await connectOffscreenController({
      ensureOffscreen: async () => {},
      capabilities: ['turn.run'],
      buildDigest: BUILD_DIGEST,
      authorizeCall: () => AUTHORITY,
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
          port: transfer[0] as MessagePort,
          channelId: offer.channelId,
          buildDigest: offer.buildDigest,
          kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'host-worker-loss-adversarial',
          offeredCaps: offer.capabilities,
          supportedCaps: ['turn.run'],
          loadController: loader,
        }),
      }),
    });
    const stop = new AbortController();
    const firstCall = controller.call('turn.run', {
      maxSteps: 1, turnGeneration: 1, ctx: { maxSteps: 1 },
    }, { signal: stop.signal, timeoutMs: 2_000 });
    await workerCallEntered.promise;
    workerPorts[0].close();
    stop.abort('user-stop-raced-worker-loss');
    await expect(firstCall).resolves.toMatchObject({
      ok: false, outcomeKnown: false, retryable: false,
    });
    expect(admittedCalls).toBe(1);

    await expect(controller.call('turn.run', {
      maxSteps: 1, turnGeneration: 2, ctx: { maxSteps: 1 },
    }, { timeoutMs: 2_000 })).resolves.toMatchObject({
      ok: true, generation: 2, outcomeKnown: true,
    });
    expect(admittedCalls).toBe(2);
    controller.close();
    loader.close();
  });

  test('performed and missing receipts cannot make Worker loss replayable', () => {
    const lost = {
      ok: false, code: 'controller-worker-lost', outcomeKnown: false, retryable: false,
    };
    expect(normalizeControllerCustody(
      'turn.run', lost, { outcomeKnown: true, retryable: false }, false,
    )).toMatchObject({ outcomeKnown: false, retryable: false });
    expect(normalizeControllerCustody(
      'turn.run', { ok: true, outcomeKnown: true },
      { outcomeKnown: false, retryable: false }, true,
    )).toMatchObject({
      ok: false, code: 'controller-pending-kernel-effect',
      outcomeKnown: false, retryable: false,
    });
  });

  test('durable unknown survives reload and cannot be downgraded by Stop', async () => {
    const state = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => structuredClone(state.get(key)),
      set: async (key: string, value: unknown) => {
        state.set(key, structuredClone(value));
      },
    };
    let nonce = 0;
    const makeBoot = () => makeLifecycleBoot({
      storage, nonce: () => `worker-loss-${++nonce}-nonce`, now: () => nonce + 1,
    });
    const first = makeBoot();
    const { generation } = await first.init();
    await first.operationLog.begin({
      operationId: 'controller-effect', sessionId: 'session:worker-loss',
      toolName: 'turn.page.open-tab', retryClass: 'E', generationId: generation.id,
    });
    await first.operationLog.transition('controller-effect', OPERATION_STATES.RUNNING);
    await first.operationLog.markDispatched('controller-effect');

    const second = makeBoot();
    await second.init();
    expect((await second.operationLog.get('controller-effect'))?.state)
      .toBe(OPERATION_STATES.OUTCOME_UNKNOWN);
    await expect(second.operationLog.transition(
      'controller-effect', OPERATION_STATES.CANCELLED,
    )).rejects.toThrow('illegal operation-state transition');

    const third = makeBoot();
    const { plan } = await third.init();
    expect(plan.transitions).toHaveLength(0);
    expect((await third.operationLog.get('controller-effect'))?.state)
      .toBe(OPERATION_STATES.OUTCOME_UNKNOWN);
  });
});
