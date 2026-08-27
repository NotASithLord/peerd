import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  connectOffscreenController,
  selectExactControllerHost,
} from '../../extension/background/offscreen-controller-client.js';
import {
  bindControllerChannel,
  makeControllerOfferHandler,
  makeSealedControllerLoader,
} from '../../extension/offscreen/controller-shell.js';
import {
  CONTROLLER_CHANNEL_PROTOCOL,
  CONTROLLER_REALM_FACT_KEYS,
  controllerPayloadBytes,
  isControllerBuildDigest,
  isControllerChannelMessage,
  parseControllerAuthority,
  parseControllerCaps,
  payloadFitsControllerCap,
} from '../../extension/shared/structured-clone-size.js';
import { createController } from '../../extension/offscreen/controller-runtime.js';
import { createControllerKernelQuota } from '../../extension/shared/controller-kernel-quota.js';

const SEALED_REALM = Object.fromEntries(CONTROLLER_REALM_FACT_KEYS.map((key) => [key, false]));
const BUILD_DIGEST = 'a'.repeat(64);
const AUTHORITY = Object.freeze({
  ownerId: 'root:test', sessionId: 'session:test', instanceId: null,
  origin: null, target: null, replayClass: 'E',
});
const KERNEL_IDENTITY = Object.freeze({
  schema: 1 as const,
  buildId: `0.7.0:${BUILD_DIGEST}`,
  bootId: 'boot-controller-a',
  kernelEpoch: 'kernel-controller-a',
});
const controllerLease = (identity: Record<string, any>, generation: number) => ({
  ...identity,
  scope: 'controller',
  leaseId: `controller-lease-${String(generation).padStart(8, '0')}`,
  hostEpoch: 'controller-host-epoch',
  generation,
});
const connectController = (deps: Omit<Parameters<typeof connectOffscreenController>[0],
  'buildDigest' | 'authorizeCall'>) => {
  const kernelIdentity = deps.kernelIdentity ?? KERNEL_IDENTITY;
  return connectOffscreenController({
    lease: deps.lease ?? controllerLease(kernelIdentity, 1),
    ...deps, kernelIdentity,
    buildDigest: BUILD_DIGEST,
    authorizeCall: () => AUTHORITY,
  });
};

const ids = (...values: string[]) => {
  const queue = [...values];
  return () => queue.shift() ?? crypto.randomUUID();
};
const replaySafeQuota = () => ({
  pendingCap: 1,
  admit: () => ({ ok: true, outcomeKnown: true }),
  observe: () => ({ ok: true, outcomeKnown: true }),
  pendingLoss: () => ({ outcomeKnown: true, retryable: true }),
  custody: () => ({ outcomeKnown: true, retryable: true }),
});

describe('Chrome lazy controller private channel prototype', () => {
  test('selects exactly one host and refuses duplicate exact documents', () => {
    const url = 'chrome-extension://id/offscreen/offscreen.html';
    const exact = { url };
    expect(selectExactControllerHost([exact], url)).toBe(exact);
    expect(selectExactControllerHost([], url)).toBeNull();
    expect(selectExactControllerHost([exact, { url }], url)).toBeNull();
  });

  test('outer offer carries no request payload and work starts only after commit', async () => {
    const offers: any[] = [];
    const phases: string[] = [];
    const controller = await connectController({
      ensureOffscreen: async () => {},
      capabilities: ['state.read'],
      newId: ids('channel-one', 'request-one'),
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => {
          offers.push(offer);
          bindControllerChannel({
            port: transfer[0] as MessagePort,
            channelId: offer.channelId,
            buildDigest: offer.buildDigest,
            kernelEpoch: offer.kernelEpoch,
            hostEpoch: 'host-epoch-one',
            offeredCaps: offer.capabilities,
            supportedCaps: ['state.read'],
            loadController: async () => {
              phases.push('loaded');
              return {
                call: async (_capability, payload) => {
                  phases.push('called');
                  return { ok: true, payload };
                },
              };
            },
          });
        },
      }),
    });
    expect(phases).toEqual([]);
    expect(offers).toEqual([{
      type: 'peerd/controller-channel',
      protocol: 2,
      channelId: 'channel-one',
      buildDigest: BUILD_DIGEST,
      kernelEpoch: KERNEL_IDENTITY.kernelEpoch,
      kernelIdentity: KERNEL_IDENTITY,
      lease: controllerLease(KERNEL_IDENTITY, 1),
      capabilities: ['state.read'],
    }]);
    expect(JSON.stringify(offers)).not.toContain('private-value');
    expect(await controller.call('state.read', { secret: 'private-value' }))
      .toMatchObject({ ok: true, payload: { secret: 'private-value' }, outcomeKnown: true });
    expect(phases).toEqual(['loaded', 'called']);
    controller.close();
  });

  test('uses one injected kernel identity and never mints an adapter epoch', async () => {
    const generated: string[] = [];
    const offers: any[] = [];
    const controller = await connectController({
      ensureOffscreen: async () => {},
      capabilities: ['state.read'],
      kernelIdentity: KERNEL_IDENTITY,
      newId: () => {
        const value = `adapter-id-${generated.length + 1}`;
        generated.push(value);
        return value;
      },
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => {
          offers.push(offer);
          bindControllerChannel({
            port: transfer[0] as MessagePort,
            channelId: offer.channelId,
            buildDigest: offer.buildDigest,
            kernelEpoch: offer.kernelEpoch,
            kernelIdentity: offer.kernelIdentity,
            hostEpoch: 'host-controller-injected',
            offeredCaps: offer.capabilities,
            supportedCaps: ['state.read'],
            loadController: async () => ({ call: async () => ({ ok: true }) }),
          });
        },
      }),
    });
    expect(offers[0]).toMatchObject({
      kernelEpoch: KERNEL_IDENTITY.kernelEpoch,
      kernelIdentity: KERNEL_IDENTITY,
      channelId: 'adapter-id-1',
    });
    expect(generated).toEqual(['adapter-id-1']);
    expect(controller.kernelIdentity).toEqual(KERNEL_IDENTITY);
    controller.close();
  });

  test('kernel refuses unoffered caps without dispatching to the host', async () => {
    let calls = 0;
    const controller = await connectController({
      ensureOffscreen: async () => {}, capabilities: ['state.read'],
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
          port: transfer[0] as MessagePort, channelId: offer.channelId,
          buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'host-epoch-refuse',
          offeredCaps: offer.capabilities, supportedCaps: ['state.read'],
          loadController: async () => ({ call: async () => { calls += 1; return { ok: true }; } }),
        }),
      }),
    });
    expect(await controller.call('repo.write', {})).toMatchObject({
      ok: false, code: 'controller-capability-denied', outcomeKnown: true,
    });
    expect(calls).toBe(0);
    controller.close();
  });

  test('pre-commit cancellation is known-safe and never sends commit', async () => {
    const abort = new AbortController();
    const messages: string[] = [];
    const controller = await connectController({
      ensureOffscreen: async () => {}, capabilities: ['state.read'],
      newId: ids('channel-cancel', 'epoch-cancel', 'request-cancel'),
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => {
          const port = transfer[0] as MessagePort;
          port.onmessage = (event) => {
            messages.push(event.data.type);
            if (event.data.type === 'kernel/open') abort.abort();
          };
          port.start();
          port.postMessage({
            protocol: 2, channelId: offer.channelId,
            buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
            hostEpoch: 'host-epoch-cancel', sequence: 1,
            type: 'controller/ready', capabilities: ['state.read'],
          });
        },
      }),
    });
    expect(await controller.call('state.read', {}, { signal: abort.signal }))
      .toMatchObject({ ok: false, code: 'controller-call-aborted', outcomeKnown: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).not.toContain('kernel/commit');
    controller.close();
  });

  test('timeout after commit is unknown and aborts the sealed controller call', async () => {
    let aborted = false;
    const controller = await connectController({
      ensureOffscreen: async () => {}, capabilities: ['repo.write'], callTimeoutMs: 5,
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
          port: transfer[0] as MessagePort, channelId: offer.channelId,
          buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'host-epoch-timeout',
          offeredCaps: offer.capabilities, supportedCaps: ['repo.write'],
          loadController: async () => ({
            call: async (_capability, _payload, { signal }) => new Promise((resolve) => {
              signal.addEventListener('abort', () => {
                aborted = true;
                setTimeout(() => resolve({ ok: false, outcomeKnown: false }), 10);
              }, { once: true });
            }),
          }),
        }),
      }),
    });
    const timedOut = await controller.call('repo.write', {});
    expect(timedOut).toMatchObject({ ok: false, outcomeKnown: false });
    // Kernel and host own independent fuses for the same deadline. Either can
    // win the race, but post-commit custody must be unknown in both cases.
    expect(['controller-call-timeout', 'controller-deadline-expired'])
      .toContain(timedOut.code);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(true);
    controller.close();
  });

  test('post-commit Stop waits for the host cancellation result', async () => {
    const abort = new AbortController();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    let observedAbort = false;
    const controller = await connectController({
      ensureOffscreen: async () => {}, capabilities: ['repo.write'],
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
          port: transfer[0] as MessagePort, channelId: offer.channelId,
          buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'host-epoch-stop',
          offeredCaps: offer.capabilities, supportedCaps: ['repo.write'],
          loadController: async () => ({
            call: async (_capability, _payload, { signal }) => {
              started();
              await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
              observedAbort = true;
              return { ok: true, aborted: true, outcomeKnown: true };
            },
          }),
        }),
      }),
    });
    const pending = controller.call('repo.write', {}, { signal: abort.signal });
    await running;
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort();
    await expect(pending).resolves.toMatchObject({
      ok: true, aborted: true, outcomeKnown: true, phase: 'settled',
    });
    expect(observedAbort).toBe(true);
    controller.close();
  });

  test('an exact quota-admitted reverse call renews both kernel and host idle fuses', async () => {
    const controller = await connectController({
      ensureOffscreen: async () => {},
      capabilities: ['turn.run'],
      callTimeoutMs: 15,
      handleKernelCall: async (operation) => operation === 'turn.session.get'
        ? { ok: true, value: JSON.stringify({ sessionId: 'session:test' }), outcomeKnown: true }
        : { ok: false, code: 'unexpected-operation', outcomeKnown: true },
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
          port: transfer[0] as MessagePort,
          channelId: offer.channelId,
          buildDigest: offer.buildDigest,
          kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'host-epoch-renew',
          offeredCaps: offer.capabilities,
          supportedCaps: ['turn.run'],
          loadController: async () => ({
            call: async (_capability, _payload, { kernelCall }) => {
              if (typeof kernelCall !== 'function') throw new Error('kernelCall missing');
              const progress = await kernelCall('turn.session.get', {
                runId: 'renew-run', value: { sessionId: 'session:test' },
              });
              expect(progress).toMatchObject({ ok: true, outcomeKnown: true });
              // Longer than the original outer deadline. Success proves both
              // independently-owned timers accepted the exact-grant renewal.
              await new Promise((resolve) => setTimeout(resolve, 35));
              return { ok: true, outcomeKnown: true, progress: 'settled' };
            },
          }),
        }),
      }),
    });
    expect(await controller.call('turn.run', { maxSteps: 1 }))
      .toMatchObject({ ok: true, progress: 'settled', outcomeKnown: true });
    controller.close();
  });

  test('a denied reverse call cannot renew controller custody', async () => {
    const controller = await connectController({
      ensureOffscreen: async () => {},
      capabilities: ['turn.run'],
      callTimeoutMs: 15,
      handleKernelCall: async () => {
        throw new Error('denied operation must not reach the authority kernel');
      },
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
          port: transfer[0] as MessagePort,
          channelId: offer.channelId,
          buildDigest: offer.buildDigest,
          kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'host-epoch-no-renew',
          offeredCaps: offer.capabilities,
          supportedCaps: ['turn.run'],
          loadController: async () => ({
            call: async (_capability, _payload, { kernelCall }) => {
              if (typeof kernelCall !== 'function') throw new Error('kernelCall missing');
              const denied = await kernelCall('turn.not-granted', {
                runId: 'denied-renew-run', value: {},
              });
              expect(denied).toMatchObject({ ok: false, outcomeKnown: true });
              await new Promise((resolve) => setTimeout(resolve, 35));
              return { ok: true, outcomeKnown: true };
            },
          }),
        }),
      }),
    });
    const result = await controller.call('turn.run', { maxSteps: 1 });
    expect(result).toMatchObject({ ok: false, outcomeKnown: false });
    expect(['controller-call-timeout', 'controller-deadline-expired']).toContain(result.code);
    controller.close();
  });

  test('post-commit Stop keeps its cancel fuse during cleanup', async () => {
    const abort = new AbortController();
    let renewals = 0;
    const kernelCalls: string[] = [];
    const controller = await connectController({
      ensureOffscreen: async () => {},
      capabilities: ['turn.run'],
      cancelSettleTimeoutMs: 5,
      callTimeoutMs: 10_000,
      handleKernelCall: (operation) => {
        kernelCalls.push(operation);
        return new Promise(() => {});
      },
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => {
          const port = transfer[0] as MessagePort;
          let sequence = 0;
          const common = {
            protocol: 2, channelId: offer.channelId,
            buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
            hostEpoch: 'host-epoch-cancel-fuse',
          };
          port.onmessage = (event) => {
            if (event.data.type === 'kernel/open') {
              port.postMessage({
                ...common, sequence: ++sequence, type: 'controller/accepted',
                requestId: event.data.requestId, grantId: event.data.grantId,
              });
            } else if (event.data.type === 'kernel/commit') {
              port.postMessage({
                ...common, sequence: ++sequence, type: 'controller/committed',
                requestId: event.data.requestId, grantId: event.data.grantId,
              });
            } else if (event.data.type === 'kernel/cancel') {
              port.postMessage({
                ...common, sequence: ++sequence, type: 'controller/kernel-call',
                requestId: event.data.requestId, grantId: event.data.grantId,
                rpcId: 'forged-rpc', operation: 'turn.session.append',
                payload: { runId: 'cancel-run', value: {} },
              });
              port.postMessage({
                ...common, sequence: ++sequence, type: 'controller/kernel-call',
                requestId: event.data.requestId, grantId: event.data.grantId,
                rpcId: 'cleanup-rpc', operation: 'turn.abort.finalize',
                payload: { runId: 'cancel-run', value: {} },
              });
            } else if (event.data.type === 'kernel/renew') renewals += 1;
          };
          port.start();
          port.postMessage({
            ...common, sequence: ++sequence, type: 'controller/ready',
            capabilities: ['turn.run'],
          });
        },
      }),
    });
    const pending = controller.call('turn.run', { maxSteps: 1 }, { signal: abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    abort.abort();
    expect(await pending).toMatchObject({
      code: 'controller-call-aborted', outcomeKnown: false,
    });
    expect(kernelCalls).toEqual(['turn.abort.finalize']);
    expect(renewals).toBe(0);
    controller.close();
  });

  test('channel loss after commit send but before acknowledgement is unknown', async () => {
    const controller = await connectController({
      ensureOffscreen: async () => {}, capabilities: ['repo.write'],
      newId: ids('channel-race', 'epoch-race', 'request-race'),
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => {
          const port = transfer[0] as MessagePort;
          port.onmessage = (event) => {
            const common = {
              protocol: 2, channelId: offer.channelId,
              buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
              hostEpoch: 'host-epoch-race',
            };
            if (event.data.type === 'kernel/open') {
              port.postMessage({
                ...common, sequence: 2, type: 'controller/accepted',
                requestId: event.data.requestId, grantId: event.data.grantId,
              });
            } else if (event.data.type === 'kernel/commit') {
              port.close();
            }
          };
          port.start();
          port.postMessage({
            protocol: 2, channelId: offer.channelId,
            buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
            hostEpoch: 'host-epoch-race', sequence: 1,
            type: 'controller/ready', capabilities: ['repo.write'],
          });
        },
      }),
    });
    expect(await controller.call('repo.write', {}, { timeoutMs: 20 })).toMatchObject({
      ok: false, code: 'controller-channel-closed', outcomeKnown: false, phase: 'run',
    });
  });

  test('post-dispatch handler failure defaults unknown unless explicitly known-safe', async () => {
    const results = [
      { ok: false, error: 'handler-threw-after-effect' },
      { ok: false, code: 'validated-before-effect', outcomeKnown: true },
    ];
    const controller = await connectController({
      ensureOffscreen: async () => {}, capabilities: ['repo.write'],
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
          port: transfer[0] as MessagePort, channelId: offer.channelId,
          buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'host-epoch-failure',
          offeredCaps: offer.capabilities, supportedCaps: ['repo.write'],
          loadController: async () => ({ call: async () => results.shift() }),
        }),
      }),
    });
    expect(await controller.call('repo.write', {})).toMatchObject({
      ok: false, outcomeKnown: false,
    });
    expect(await controller.call('repo.write', {})).toMatchObject({
      ok: false, outcomeKnown: true,
    });
    controller.close();
  });

  test('reverse kernel RPC is parent-bound and unknown custody cannot be laundered', async () => {
    let kernelContext: any = null;
    const controller = await connectController({
      ensureOffscreen: async () => {}, capabilities: ['turn.run'],
      handleKernelCall: async (operation, payload, context) => {
        expect(operation).toBe('turn.session.append');
        expect(payload).toEqual({ value: {
          sessionId: 'session:test', messageJson: '{"role":"user","content":"x"}',
        } });
        kernelContext = context;
        return { ok: false, code: 'response-lost-after-send', outcomeKnown: false };
      },
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
          port: transfer[0] as MessagePort, channelId: offer.channelId,
          buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'host-epoch-kernel-rpc',
          offeredCaps: offer.capabilities, supportedCaps: ['turn.run'],
          loadController: async () => ({
            call: async (_capability, _payload, options) => {
              const nested = await options.kernelCall?.(
                'turn.session.append', {
                  value: {
                    sessionId: 'session:test',
                    messageJson: '{"role":"user","content":"x"}',
                  },
                },
              );
              expect(nested).toMatchObject({ outcomeKnown: false });
              // A controller may catch or ignore the nested failure, but the
              // kernel retains custody independently of this success claim.
              return { ok: true, outcomeKnown: true };
            },
          }),
        }),
      }),
    });
    expect(await controller.call('turn.run', {
      runId: 'run-12345678', sessionId: 'session:test',
      ctx: { maxSteps: 1 }, tools: [], classifications: {},
    })).toMatchObject({
      ok: true, outcomeKnown: false,
    });
    expect(kernelContext).toMatchObject({
      capability: 'turn.run', authority: AUTHORITY,
    });
    expect(kernelContext.signal).toBeInstanceOf(AbortSignal);
    controller.close();
  });

  test('turn success cannot strand an unawaited reverse effect', async () => {
    let called!: () => void;
    const dispatched = new Promise<void>((resolve) => { called = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const observed = { signal: null as AbortSignal | null };
    const controller = await connectController({
      ensureOffscreen: async () => {}, capabilities: ['turn.run'], callTimeoutMs: 1_000,
      handleKernelCall: (_operation, _payload, context) => {
        void context;
        entered();
        return new Promise((resolve) => setTimeout(
          () => resolve({ ok: true, outcomeKnown: true }), 100,
        ));
      },
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
          port: transfer[0] as MessagePort, channelId: offer.channelId,
          buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'host-pending-turn-effect', offeredCaps: offer.capabilities,
          supportedCaps: ['turn.run'],
          loadController: async () => ({
            call: async (_capability, _payload, options) => {
              called();
              observed.signal = options.signal;
              void options.kernelCall?.('turn.session.get', {
                runId: 'pending-turn-effect', value: { sessionId: 'session:test' },
              });
              return { ok: true, outcomeKnown: true };
            },
          }),
        }),
      }),
    });
    const result = controller.call('turn.run', {
      runId: 'pending-turn-effect', sessionId: 'session:test',
      ctx: { maxSteps: 1 }, tools: [], classifications: {},
    });
    await dispatched;
    await started;
    await expect(result).resolves.toMatchObject({
      ok: false, code: 'controller-pending-kernel-effect', outcomeKnown: false,
    });
    expect(observed.signal?.aborted).toBe(true);
    controller.close();
  });

  test('an unawaited replay-safe effect remains known and retryable', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const controller = await connectController({
      ensureOffscreen: async () => {}, capabilities: ['turn.run'], callTimeoutMs: 1_000,
      createQuota: replaySafeQuota,
      handleKernelCall: async () => {
        entered();
        return new Promise((resolve) => setTimeout(
          () => resolve({ ok: true, outcomeKnown: true }), 100,
        ));
      },
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
          port: transfer[0] as MessagePort, channelId: offer.channelId,
          buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'host-pending-read-effect', offeredCaps: offer.capabilities,
          supportedCaps: ['turn.run'],
          createQuota: replaySafeQuota,
          loadController: async () => ({
            call: async (_capability, _payload, options) => {
              void options.kernelCall?.('state.read', {});
              return { ok: true, outcomeKnown: true };
            },
          }),
        }),
      }),
    });
    const result = controller.call('turn.run', { maxSteps: 1 });
    await started;
    await expect(result).resolves.toMatchObject({
      ok: false, code: 'controller-pending-kernel-effect',
      outcomeKnown: true, retryable: true,
    });
    controller.close();
  });

  test('a replay-safe pending effect stays known across timeout and channel loss', async () => {
    for (const mode of ['timeout', 'close'] as const) {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const controller = await connectController({
        ensureOffscreen: async () => {}, capabilities: ['repo.write'], callTimeoutMs: 20,
        createQuota: replaySafeQuota,
        handleKernelCall: async () => {
          entered();
          return new Promise((resolve) => setTimeout(
            () => resolve({ ok: true, outcomeKnown: true }), 100,
          ));
        },
        findHost: async () => ({
          postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
            port: transfer[0] as MessagePort, channelId: offer.channelId,
            buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
            hostEpoch: `host-read-${mode}`, offeredCaps: offer.capabilities,
            supportedCaps: ['repo.write'], createQuota: replaySafeQuota,
            loadController: async () => ({
              call: async (_capability, _payload, options) =>
                options.kernelCall?.('state.read', {}),
            }),
          }),
        }),
      });
      const running = controller.call('repo.write', {}, { timeoutMs: 20 });
      await started;
      if (mode === 'close') controller.close();
      await expect(running).resolves.toMatchObject({
        ok: false, outcomeKnown: true, retryable: true,
      });
      controller.close();
    }
  });

  test('turn lifetime loss aborts a pending reverse effect and stays unknown', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const observed = { signal: null as AbortSignal | null };
    const controller = await connectController({
      ensureOffscreen: async () => {}, capabilities: ['turn.run'],
      handleKernelCall: (_operation, _payload, context) => {
        observed.signal = context.signal;
        entered();
        return new Promise(() => {});
      },
      findHost: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => bindControllerChannel({
          port: transfer[0] as MessagePort, channelId: offer.channelId,
          buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
          hostEpoch: 'host-lost-turn-effect', offeredCaps: offer.capabilities,
          supportedCaps: ['turn.run'],
          loadController: async () => ({
            call: async (_capability, _payload, options) => options.kernelCall?.(
              'turn.session.get', {
                runId: 'lost-turn-effect', value: { sessionId: 'session:test' },
              },
            ),
          }),
        }),
      }),
    });
    const pending = controller.call('turn.run', { maxSteps: 1 });
    await started;
    controller.close();
    await expect(pending).resolves.toMatchObject({ outcomeKnown: false });
    expect(observed.signal?.aborted).toBe(true);
  });

  test('offscreen supervisor boots the sealed Worker lazily over a second private port', async () => {
    let workerCreated = 0;
    const loader = makeSealedControllerLoader({
      workerUrl: '/offscreen/controller-worker.js',
      newId: ids('worker-request'),
      createWorker: (_url, options) => {
        expect(options).toMatchObject({ type: 'module', name: 'peerd-controller' });
        workerCreated += 1;
        return {
          postMessage: (_message: any, transfer: Transferable[]) => {
            const port = transfer[0] as MessagePort;
            port.onmessage = (event) => {
              if (event.data.type === 'controller-worker/call') {
                port.postMessage({
                  type: 'controller-worker/result', requestId: event.data.requestId,
                  result: { ok: true, value: event.data.payload },
                });
              }
            };
            port.start();
            port.postMessage({ type: 'controller-worker/ready', realm: SEALED_REALM });
          },
          terminate: () => {},
        } as unknown as Worker;
      },
    });
    expect(workerCreated).toBe(0);
    const sealed = await loader();
    expect(workerCreated).toBe(1);
    const abort = new AbortController();
    expect(await sealed.call('state.read', { value: 7 }, { signal: abort.signal }))
      .toEqual({ ok: true, value: { value: 7 } });
    expect(await loader()).toBe(sealed);
    expect(workerCreated).toBe(1);
    sealed.close();
  });

  test('failed sealed Worker startup is retryable and kernel retirement terminates the live generation', async () => {
    let created = 0;
    let terminated = 0;
    const loader = makeSealedControllerLoader({
      workerUrl: '/offscreen/controller-worker.js',
      createWorker: () => {
        created += 1;
        const generation = created;
        return {
          postMessage: (_message: any, transfer: Transferable[]) => {
            const port = transfer[0] as MessagePort;
            port.start();
            if (generation === 1) {
              port.postMessage({ type: 'controller-worker/error', error: 'bad first load' });
            } else {
              port.postMessage({ type: 'controller-worker/ready', realm: SEALED_REALM });
            }
          },
          terminate: () => { terminated += 1; },
          addEventListener: () => {},
        } as unknown as Worker;
      },
    });
    await expect(loader()).rejects.toThrow('bad first load');
    const controller = await loader();
    expect(created).toBe(2);
    loader.close();
    expect(terminated).toBe(2);
    expect(await controller.call('health.ping', {}, { signal: new AbortController().signal }))
      .toMatchObject({ ok: false, outcomeKnown: false });
  });

  test('a Worker crash after readiness is not cached as the next generation', async () => {
    let created = 0;
    let crash = () => {};
    const loader = makeSealedControllerLoader({
      workerUrl: '/offscreen/controller-worker.js',
      createWorker: () => {
        created += 1;
        const generation = created;
        return {
          postMessage: (_message: any, transfer: Transferable[]) => {
            const port = transfer[0] as MessagePort;
            port.onmessage = (event) => {
              if (event.data.type === 'controller-worker/call') {
                port.postMessage({
                  type: 'controller-worker/result', requestId: event.data.requestId,
                  result: { ok: true, generation, outcomeKnown: true },
                });
              }
            };
            port.start();
            port.postMessage({ type: 'controller-worker/ready', realm: SEALED_REALM });
          },
          terminate: () => {},
          addEventListener: (type: string, listener: () => void) => {
            if (type === 'error') crash = listener;
          },
        } as unknown as Worker;
      },
    });
    const first = await loader();
    expect(await first.call('health.ping', {}, { signal: new AbortController().signal }))
      .toMatchObject({ ok: true, generation: 1 });
    crash();
    const second = await loader();
    expect(second).not.toBe(first);
    expect(await second.call('health.ping', {}, { signal: new AbortController().signal }))
      .toMatchObject({ ok: true, generation: 2 });
    loader.close();
  });

  test('the host enforces its absolute deadline after commit without a kernel cancel', async () => {
    const channel = new MessageChannel();
    const binding = bindControllerChannel({
      port: channel.port2,
      channelId: 'host-deadline-channel',
      buildDigest: BUILD_DIGEST,
      kernelEpoch: 'host-deadline-kernel',
      hostEpoch: 'host-deadline-host',
      offeredCaps: ['repo.write'],
      supportedCaps: ['repo.write'],
      loadController: async () => ({
        call: async (_capability, _payload, { signal }) => new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({
            ok: false, code: 'worker-observed-abort', outcomeKnown: false,
          }), { once: true });
        }),
      }),
    });
    const common = {
      protocol: 2, channelId: 'host-deadline-channel', buildDigest: BUILD_DIGEST,
      kernelEpoch: 'host-deadline-kernel', hostEpoch: 'host-deadline-host',
    };
    const settled = new Promise<any>((resolve) => {
      let sequence = 0;
      channel.port1.onmessage = (event) => {
        if (event.data.type === 'controller/ready') {
          channel.port1.postMessage({
            ...common, sequence: ++sequence, type: 'kernel/open', requestId: 'deadline-request',
            grantId: 'deadline-grant', deadlineAt: Date.now() + 20,
            capability: 'repo.write', authority: AUTHORITY, payload: {},
          });
        } else if (event.data.type === 'controller/accepted') {
          channel.port1.postMessage({
            ...common, sequence: ++sequence, type: 'kernel/commit',
            requestId: 'deadline-request', grantId: 'deadline-grant',
          });
        } else if (event.data.type === 'controller/settled') resolve(event.data.result);
      };
      channel.port1.start();
    });
    expect(await settled).toMatchObject({
      ok: false, code: 'controller-deadline-expired', outcomeKnown: false,
    });
    binding.close();
    channel.port1.close();
  });

  test('an invalid renewal deadline retires the exact host channel', async () => {
    const channel = new MessageChannel();
    let closed = 0;
    const binding = bindControllerChannel({
      port: channel.port2,
      channelId: 'invalid-renew-channel',
      buildDigest: BUILD_DIGEST,
      kernelEpoch: 'invalid-renew-kernel',
      hostEpoch: 'invalid-renew-host',
      offeredCaps: ['turn.run'],
      supportedCaps: ['turn.run'],
      onClose: () => { closed += 1; },
      loadController: async () => ({
        call: async (_capability, _payload, { signal }) => new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({
            ok: false, outcomeKnown: false,
          }), { once: true });
        }),
      }),
    });
    const common = {
      protocol: 2,
      channelId: 'invalid-renew-channel',
      buildDigest: BUILD_DIGEST,
      kernelEpoch: 'invalid-renew-kernel',
      hostEpoch: 'invalid-renew-host',
    };
    let sequence = 0;
    channel.port1.onmessage = (event) => {
      if (event.data.type === 'controller/ready') {
        channel.port1.postMessage({
          ...common, sequence: ++sequence,
          type: 'kernel/open', requestId: 'invalid-renew-request',
          grantId: 'invalid-renew-grant', deadlineAt: Date.now() + 10_000,
          capability: 'turn.run', authority: AUTHORITY, payload: { maxSteps: 1 },
        });
      } else if (event.data.type === 'controller/accepted') {
        channel.port1.postMessage({
          ...common, sequence: ++sequence,
          type: 'kernel/commit', requestId: 'invalid-renew-request',
          grantId: 'invalid-renew-grant',
        });
      } else if (event.data.type === 'controller/committed') {
        channel.port1.postMessage({
          ...common, sequence: ++sequence,
          type: 'kernel/renew', requestId: 'invalid-renew-request',
          grantId: 'invalid-renew-grant',
          // More than the fixed 30-minute idle cap plus clock-skew allowance.
          deadlineAt: Date.now() + 31 * 60_000,
        });
      }
    };
    channel.port1.start();
    for (let attempt = 0; attempt < 20 && closed === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(closed).toBe(1);
    binding.close();
    channel.port1.close();
  });

  test('the host refuses renewal after cancellation', async () => {
    const channel = new MessageChannel();
    let closed = 0;
    const binding = bindControllerChannel({
      port: channel.port2,
      channelId: 'cancel-renew-channel',
      buildDigest: BUILD_DIGEST,
      kernelEpoch: 'cancel-renew-kernel',
      hostEpoch: 'cancel-renew-host',
      offeredCaps: ['turn.run'],
      supportedCaps: ['turn.run'],
      onClose: () => { closed += 1; },
      loadController: async () => ({ call: async () => new Promise(() => {}) }),
    });
    const common = {
      protocol: 2, channelId: 'cancel-renew-channel', buildDigest: BUILD_DIGEST,
      kernelEpoch: 'cancel-renew-kernel', hostEpoch: 'cancel-renew-host',
    };
    let sequence = 0;
    channel.port1.onmessage = (event) => {
      if (event.data.type === 'controller/ready') {
        channel.port1.postMessage({
          ...common, sequence: ++sequence, type: 'kernel/open',
          requestId: 'cancel-renew-request', grantId: 'cancel-renew-grant',
          deadlineAt: Date.now() + 10_000, capability: 'turn.run',
          authority: AUTHORITY, payload: { maxSteps: 1 },
        });
      } else if (event.data.type === 'controller/accepted') {
        channel.port1.postMessage({
          ...common, sequence: ++sequence, type: 'kernel/commit',
          requestId: 'cancel-renew-request', grantId: 'cancel-renew-grant',
        });
      } else if (event.data.type === 'controller/committed') {
        channel.port1.postMessage({
          ...common, sequence: ++sequence, type: 'kernel/cancel',
          requestId: 'cancel-renew-request', grantId: 'cancel-renew-grant',
        });
        channel.port1.postMessage({
          ...common, sequence: ++sequence, type: 'kernel/renew',
          requestId: 'cancel-renew-request', grantId: 'cancel-renew-grant',
          deadlineAt: Date.now() + 10_000,
        });
      }
    };
    channel.port1.start();
    for (let attempt = 0; attempt < 20 && closed === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(closed).toBe(1);
    binding.close();
    channel.port1.close();
  });

  test('closing a kernel channel tears down its owned controller realm', () => {
    const channel = new MessageChannel();
    let closed = 0;
    const loadController = Object.assign(
      async () => ({ call: async () => ({ ok: true }) }),
      { close: () => { closed += 1; } },
    );
    const binding = bindControllerChannel({
      port: channel.port2,
      channelId: 'channel-close',
      buildDigest: BUILD_DIGEST,
      kernelEpoch: 'epoch-close',
      hostEpoch: 'host-epoch-close',
      offeredCaps: ['health.ping'],
      supportedCaps: ['health.ping'],
      loadController,
    });
    binding.close();
    expect(closed).toBe(1);
    channel.port1.close();
  });

  test('offer adoption refuses the identity-free legacy path', () => {
    const expectedWorkerUrl = 'chrome-extension://id/background/kernel.js';
    const handler = makeControllerOfferHandler({
      expectedWorkerUrl,
      expectedBuildDigest: BUILD_DIGEST,
      supportedCaps: ['state.read'],
      loadController: async () => ({ call: async () => ({ ok: true }) }),
    });
    const channel = new MessageChannel();
    expect(handler({
      isTrusted: true,
      source: { scriptURL: expectedWorkerUrl },
      data: {
        type: 'peerd/controller-channel', protocol: 2,
        buildDigest: BUILD_DIGEST,
        kernelEpoch: 'legacy-kernel-epoch', channelId: 'legacy-channel',
        capabilities: ['state.read'],
      },
      ports: [channel.port2],
    } as unknown as MessageEvent)).toBe(false);
    channel.port1.close();
    handler.close();
  });

  test('offer adoption rejects a new epoch minted under the old boot identity', () => {
    const expectedWorkerUrl = 'chrome-extension://id/background/kernel.js';
    const handler = makeControllerOfferHandler({
      expectedWorkerUrl,
      expectedBuildDigest: BUILD_DIGEST,
      supportedCaps: ['state.read'],
      newId: ids('host-strict-a', 'host-strict-b'),
      loadController: async () => ({ call: async () => ({ ok: true }) }),
    });
    const offer = (identity: Record<string, any>, channelId: string) => {
      const channel = new MessageChannel();
      const accepted = handler({
        isTrusted: true,
        source: { scriptURL: expectedWorkerUrl },
        data: {
          type: 'peerd/controller-channel', protocol: 2,
          buildDigest: BUILD_DIGEST, channelId, capabilities: ['state.read'],
          kernelEpoch: identity.kernelEpoch, kernelIdentity: identity,
          lease: controllerLease(identity, 1),
        },
        ports: [channel.port2],
      } as unknown as MessageEvent);
      channel.port1.close();
      return accepted;
    };
    expect(offer(KERNEL_IDENTITY, 'strict-channel-a')).toBe(true);
    expect(offer({
      ...KERNEL_IDENTITY, kernelEpoch: 'kernel-controller-b',
    }, 'strict-channel-forged')).toBe(false);
    expect(offer({
      ...KERNEL_IDENTITY,
      bootId: 'boot-controller-b', kernelEpoch: 'kernel-controller-b',
    }, 'strict-channel-b')).toBe(true);
    handler.close();
  });

  test('fresh leases may reacquire one kernel epoch without reopening a retired lease', () => {
    const expectedWorkerUrl = 'chrome-extension://id/background/kernel.js';
    const handler = makeControllerOfferHandler({
      expectedWorkerUrl,
      expectedBuildDigest: BUILD_DIGEST,
      supportedCaps: ['state.read'],
      loadController: async () => ({ call: async () => ({ ok: true }) }),
    });
    const offer = (generation: number, lease = controllerLease(KERNEL_IDENTITY, generation)) => {
      const channel = new MessageChannel();
      const accepted = handler({
        isTrusted: true,
        source: { scriptURL: expectedWorkerUrl },
        data: {
          type: 'peerd/controller-channel', protocol: 2,
          buildDigest: BUILD_DIGEST,
          channelId: `controller-channel-${String(generation).padStart(8, '0')}`,
          capabilities: ['state.read'],
          kernelEpoch: KERNEL_IDENTITY.kernelEpoch,
          kernelIdentity: KERNEL_IDENTITY,
          lease,
        },
        ports: [channel.port2],
      } as unknown as MessageEvent);
      channel.port1.close();
      return accepted;
    };

    for (let generation = 1; generation <= 256; generation += 1) {
      expect(offer(generation)).toBe(true);
      handler.close();
    }
    expect(offer(1)).toBe(false);
    expect(offer(257, { ...controllerLease(KERNEL_IDENTITY, 257), hostEpoch: '' }))
      .toBe(false);
  });

  test('sealed Worker disables ambient network/storage before dynamic import', () => {
    const source = readFileSync(join(process.cwd(), 'extension/offscreen/controller-worker.js'), 'utf8');
    const sealAt = source.indexOf("for (const name of [");
    const importAt = source.indexOf('await import(CONTROLLER_RUNTIME_URL)');
    expect(sealAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(sealAt);
    for (const name of [
      'fetch', 'fetchLater', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream',
      'WebTransport', 'RTCPeerConnection', 'RTCDataChannel', 'indexedDB',
      'caches', 'Worker', 'SharedWorker', 'BroadcastChannel', 'serviceWorker', 'locks',
    ]) expect(source).toContain(`'${name}'`);
  });
});

describe('controller protocol pure validation', () => {
  test('the packaged sealed runtime is executable but grants only registered capabilities', async () => {
    const controller = await createController();
    const signal = new AbortController().signal;
    expect(await controller.call('health.ping', { value: 7 }, { signal }))
      .toEqual({ ok: true, outcomeKnown: true, payload: { value: 7 } });
    expect(await controller.call('repo.write', {}, { signal })).toEqual({
      ok: false, code: 'controller-capability-unimplemented', outcomeKnown: true,
    });
  });

  test('binds every message to exact protocol, channel, and epoch', () => {
    const binding = {
      channelId: 'channel', buildDigest: BUILD_DIGEST,
      kernelEpoch: 'epoch', hostEpoch: 'host-epoch',
    };
    expect(isControllerChannelMessage({
      protocol: CONTROLLER_CHANNEL_PROTOCOL, channelId: 'channel',
      buildDigest: BUILD_DIGEST, kernelEpoch: 'epoch', hostEpoch: 'host-epoch',
      sequence: 1, type: 'ready',
    }, binding)).toBe(true);
    expect(isControllerChannelMessage({
      protocol: CONTROLLER_CHANNEL_PROTOCOL, channelId: 'channel',
      buildDigest: BUILD_DIGEST, kernelEpoch: 'old', hostEpoch: 'host-epoch',
      sequence: 1, type: 'ready',
    }, binding)).toBe(false);
  });

  test('requires an exact build digest and kernel-stamped authority shape', () => {
    expect(isControllerBuildDigest(BUILD_DIGEST)).toBe(true);
    expect(isControllerBuildDigest('A'.repeat(64))).toBe(false);
    expect(parseControllerAuthority(AUTHORITY)).toEqual(AUTHORITY);
    expect(parseControllerAuthority({ ...AUTHORITY, replayClass: 'Z' })).toBeNull();
    expect(parseControllerAuthority({ ...AUTHORITY, providerKey: 'must-not-cross' })).toBeNull();
    expect(isControllerChannelMessage({
      protocol: CONTROLLER_CHANNEL_PROTOCOL, channelId: 'channel',
      buildDigest: 'b'.repeat(64), kernelEpoch: 'epoch', hostEpoch: 'host-epoch',
      sequence: 1, type: 'ready',
    }, {
      channelId: 'channel', buildDigest: BUILD_DIGEST,
      kernelEpoch: 'epoch', hostEpoch: 'host-epoch',
    })).toBe(false);
  });

  test('retires the host on a replayed or out-of-order kernel sequence', async () => {
    const channel = new MessageChannel();
    let closed = 0;
    const binding = bindControllerChannel({
      port: channel.port2,
      channelId: 'sequence-channel',
      buildDigest: BUILD_DIGEST,
      kernelEpoch: 'sequence-kernel',
      hostEpoch: 'sequence-host',
      offeredCaps: ['state.read'],
      supportedCaps: ['state.read'],
      loadController: async () => ({ call: async () => ({ ok: true }) }),
      onClose: () => { closed += 1; },
    });
    const common = {
      protocol: CONTROLLER_CHANNEL_PROTOCOL,
      channelId: 'sequence-channel', buildDigest: BUILD_DIGEST,
      kernelEpoch: 'sequence-kernel', hostEpoch: 'sequence-host',
    };
    channel.port1.postMessage({
      ...common, sequence: 2, type: 'kernel/open', requestId: 'request',
      grantId: 'grant', deadlineAt: Date.now() + 10_000,
      capability: 'state.read', authority: AUTHORITY, payload: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(1);
    binding.close();
    channel.port1.close();
  });

  test('cap manifests are bounded, unique, and canonical', () => {
    expect(parseControllerCaps(['state.read', 'repo.write'])).toEqual(['state.read', 'repo.write']);
    expect(parseControllerCaps(['state.read', 'state.read'])).toBeNull();
    expect(parseControllerCaps(['State.Read'])).toBeNull();
    expect(parseControllerCaps(Array.from({ length: 65 }, (_, i) => `cap.${i}`))).toBeNull();
  });

  test('structured-clone caps count binary bytes and reject cycles or accessors', () => {
    expect(payloadFitsControllerCap(new ArrayBuffer(100 * 1024 * 1024), 256 * 1024)).toBe(false);
    expect(payloadFitsControllerCap(new Uint8Array(128 * 1024), 256 * 1024)).toBe(true);
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(controllerPayloadBytes(cyclic)).toBe(Infinity);
    expect(controllerPayloadBytes(Object.defineProperty({}, 'secret', { get: () => 'x' })))
      .toBe(Infinity);
  });

  test('large plain transcripts stay byte-bounded through the packed session seam', () => {
    const quota = createControllerKernelQuota('turn.run', { maxSteps: 1 });
    const payload = { runId: 'run-packed-session', value: { sessionId: 'session-1' } };
    expect(quota.admit('turn.session.get', payload).ok).toBe(true);
    const messages = Array.from({ length: 2_000 }, (_, index) => ({
      id: `message-${index}`, role: index % 2 ? 'assistant' : 'user',
      content: `line ${index}`, createdAt: index,
    }));
    expect(controllerPayloadBytes({ ok: true, value: { messages } })).toBe(Infinity);
    const packed = { ok: true, value: JSON.stringify({ messages }), outcomeKnown: true };
    expect(controllerPayloadBytes(packed)).toBeLessThan(4 * 1024 * 1024);
    expect(quota.observe('turn.session.get', payload, packed)).toEqual({
      ok: true, outcomeKnown: true,
    });
  });

  test('large session mutations and structured tool results use the same byte seam', () => {
    const quota = createControllerKernelQuota('turn.run', { maxSteps: 1 });
    const toolResults = Array.from({ length: 2_000 }, (_, index) => ({
      tool_use_id: `tool-${index}`, content: `row ${index}`, is_error: false,
    }));
    const append = {
      runId: 'run-packed-append',
      value: {
        sessionId: 'session-1',
        messageJson: JSON.stringify({ id: 'message', role: 'user', toolResults }),
      },
    };
    expect(quota.admit('turn.session.append', append).ok).toBe(true);
    const update = {
      runId: 'run-packed-update',
      value: {
        sessionId: 'session-1', messageId: 'assistant-1',
        patchJson: JSON.stringify({ content: toolResults }),
      },
    };
    expect(quota.admit('turn.session.update-assistant', update).ok).toBe(true);
    const trim = {
      runId: 'run-packed-trim',
      value: {
        sessionId: 'session-1',
        stateJson: JSON.stringify({ summary: 'bounded', source: toolResults }),
      },
    };
    expect(quota.admit('turn.session.set-trim', trim).ok).toBe(true);

    expect(quota.admit('turn.tool.dispatch', { runId: 'deleted' })).toEqual({
      ok: false, code: 'kernel-operation-denied', outcomeKnown: true,
    });
    const result = {
      ok: true,
      value: JSON.stringify({
        ok: true,
        content: { rows: Array.from({ length: 5_000 }, (_, index) => ({ index })) },
      }),
      outcomeKnown: true,
    };
    expect(controllerPayloadBytes(result)).toBeLessThan(4 * 1024 * 1024);
  });

  test('more than 65,536 fragmented model chunks fit while the 8 MiB rail remains authoritative', () => {
    const quota = createControllerKernelQuota('turn.run', { maxSteps: 1 });
    const opened = { runId: 'fragmented-stream', value: {
      providerId: 'anthropic', modelId: 'fragmented-model', nativeBody: {},
    } };
    expect(quota.admit('turn.model.open-inference', opened).ok).toBe(true);
    expect(quota.observe('turn.model.open-inference', opened, {
      ok: true, value: { streamId: 'fragmented-model' }, outcomeKnown: true,
    }).ok).toBe(true);
    const next = { runId: 'fragmented-stream', value: { streamId: 'fragmented-model' } };
    const chunk = new Uint8Array([120]);
    let fragmentRefusal: any = null;
    for (let index = 0; index < 65_537; index += 1) {
      const admitted = quota.admit('turn.model.read-inference', next);
      if (admitted.ok !== true) { fragmentRefusal = { index, phase: 'admit', admitted }; break; }
      const observed = quota.observe('turn.model.read-inference', next, {
        ok: true,
        value: { done: false, chunk },
        outcomeKnown: true,
      });
      if (observed.ok !== true) { fragmentRefusal = { index, phase: 'observe', observed }; break; }
    }
    expect(fragmentRefusal).toBeNull();

    const byteQuota = createControllerKernelQuota('turn.run', { maxSteps: 1 });
    const byteOpen = { runId: 'byte-stream', value: {
      providerId: 'anthropic', modelId: 'byte-model', nativeBody: {},
    } };
    expect(byteQuota.admit('turn.model.open-inference', byteOpen).ok).toBe(true);
    expect(byteQuota.observe('turn.model.open-inference', byteOpen, {
      ok: true, value: { streamId: 'byte-model' }, outcomeKnown: true,
    }).ok).toBe(true);
    const byteNext = { runId: 'byte-stream', value: { streamId: 'byte-model' } };
    const largeChunk = new Uint8Array(128 * 1024);
    let refused: any = null;
    for (let index = 0; index < 70 && !refused; index += 1) {
      const admitted = byteQuota.admit('turn.model.read-inference', byteNext);
      if (admitted.ok !== true) { refused = admitted; break; }
      const observed = byteQuota.observe('turn.model.read-inference', byteNext, {
        ok: true,
        value: { done: false, chunk: largeChunk },
        outcomeKnown: true,
      });
      if (observed.ok !== true) refused = observed;
    }
    expect(refused).toMatchObject({
      ok: false, code: 'kernel-model-budget-exhausted',
    });
  }, 20_000);
});
