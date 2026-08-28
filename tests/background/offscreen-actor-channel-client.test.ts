import { describe, expect, test } from 'bun:test';
import {
  isKnownActorStartupFailure, makeOffscreenActorChannelClient, selectExactActorHostClient,
} from '../../extension/background/offscreen-actor-channel-client.js';
import { bindActorChannel } from '../../extension/offscreen/actor-channel-host.js';
import {
  ACTOR_RELAY_ROUTES, actorRelayRouteClass,
} from '../../extension/shared/actor-channel-protocol.js';

const actorLease = Object.freeze({ scope: 'controller', leaseId: 'actor-lease-one' });

describe('targeted offscreen actor MessageChannel', () => {
  test('classifies only explicit known not-started outcomes as retryable', () => {
    expect(isKnownActorStartupFailure({
      started: false, phase: 'startup', outcomeKnown: true,
    })).toBe(true);
    expect(isKnownActorStartupFailure({
      started: true, phase: 'run', outcomeKnown: false,
    })).toBe(false);
    expect(isKnownActorStartupFailure({
      started: false, phase: 'startup', outcomeKnown: false,
    })).toBe(false);
  });

  test('selects one exact offscreen recipient and refuses ambiguity', () => {
    const expected = 'chrome-extension://example/offscreen/offscreen.html';
    const target = { url: expected };
    expect(selectExactActorHostClient([target], expected)).toBe(target);
    expect(selectExactActorHostClient([], expected)).toBeNull();
    expect(selectExactActorHostClient([
      target, { url: expected },
    ], expected)).toBeNull();
    expect(selectExactActorHostClient([
      { url: `${expected}?sibling=1` }, { url: `${expected}#sibling` },
    ], expected)).toBeNull();
  });

  test('accepts only the finite actor transport vocabulary by exact equality', () => {
    expect(new Set(ACTOR_RELAY_ROUTES).size).toBe(ACTOR_RELAY_ROUTES.length);
    expect(actorRelayRouteClass('actor/model-read-inference-chunk')).toBe('model');
    expect(actorRelayRouteClass('actor/model-read-inference')).toBeNull();
    expect(actorRelayRouteClass('actor/model-read-inference-chunk/spoof')).toBeNull();
    expect(actorRelayRouteClass('invented/effect')).toBeNull();
  });

  test('runs over the exact leased channel without exposing the relay grant', async () => {
    const offered: any[] = [];
    const relayed: any[] = [];
    const client = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {},
      findOffscreenClient: async () => ({
        postMessage: (message: any, transfer: Transferable[]) => {
          offered.push(message);
          bindActorChannel({
            port: transfer[0] as MessagePort,
            channelId: message.channelId,
            workerUrl: '/offscreen/actor-worker.js',
            abort: () => {},
            run: async (job, { sendToSW }) => {
              expect(job.relayToken).toBeUndefined();
              const reply = await sendToSW('actor/model-open-inference', {
                providerId: 'anthropic', modelId: 'model', nativeBody: {},
              });
              expect(reply).toEqual({ ok: true, value: { streamId: 'stream' } });
              return { ok: true, started: true, finalText: 'done' };
            },
          });
        },
      }),
      newChannelId: () => 'channel-one',
    });
    const result = await client.run(
      { runId: 'run-one', message: 'private job' },
      {
        lease: actorLease,
        relay: async (type, payload) => {
          relayed.push({ type, payload });
          return { ok: true, value: { streamId: 'stream' } };
        },
      },
    );
    expect(result).toEqual({ ok: true, started: true, finalText: 'done' });
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({
      type: 'peerd/actor-channel', protocol: 1, channelId: 'channel-one', lease: actorLease,
    });
    expect(JSON.stringify(offered)).not.toContain('private job');
    expect(relayed).toEqual([{
      type: 'actor/model-open-inference',
      payload: { providerId: 'anthropic', modelId: 'model', nativeBody: {} },
    }]);
  });

  test('Stop before the host accepts never sends or commits the job', async () => {
    let transferred: MessagePort | null = null;
    const abort = new AbortController();
    const client = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {},
      findOffscreenClient: async () => ({
        postMessage: (_message: any, transfer: Transferable[]) => {
          transferred = transfer[0] as MessagePort;
          abort.abort();
        },
      }),
      newChannelId: () => 'channel-abort',
    });
    const messages: any[] = [];
    const result = await client.run({}, {
      signal: abort.signal, lease: actorLease, relay: async () => ({}),
    });
    expect(result).toMatchObject({ started: false, aborted: true, outcomeKnown: true });
    expect(transferred).not.toBeNull();
    const port = transferred as unknown as MessagePort;
    port.onmessage = (event) => messages.push(event.data);
    port.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.some((message) => message.type === 'actor/open'
      || message.type === 'actor/commit')).toBe(false);
    port.close();
  });

  test('missing exact offscreen client is a structured not-started failure', async () => {
    const client = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {}, findOffscreenClient: async () => null,
    });
    await expect(client.run({}, { lease: actorLease, relay: async () => ({}) }))
      .resolves.toMatchObject({
      ok: false, started: false, code: 'actor_host_not_ready', outcomeKnown: true,
    });
  });

  test('a host that never becomes ready is a structured not-started failure', async () => {
    const client = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {}, handshakeTimeoutMs: 5,
      findOffscreenClient: async () => ({ postMessage: () => {} }),
    });
    await expect(client.run({}, { lease: actorLease, relay: async () => ({}) }))
      .resolves.toMatchObject({
      ok: false, started: false, phase: 'startup',
      code: 'actor_channel_ready_timeout', outcomeKnown: true,
    });
  });

  test('a committed run that exceeds its channel budget settles unknown and aborts the host', async () => {
    let aborted = 0;
    const client = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {}, runTimeoutMsFor: () => 5,
      findOffscreenClient: async () => ({
        postMessage: (message: any, transfer: Transferable[]) => bindActorChannel({
          port: transfer[0] as MessagePort,
          channelId: message.channelId,
          workerUrl: '/offscreen/actor-worker.js',
          abort: () => { aborted += 1; },
          run: async () => new Promise(() => {}),
        }),
      }),
    });
    await expect(client.run({ runId: 'wedged-run' }, {
      lease: actorLease, relay: async () => ({}),
    }))
      .resolves.toMatchObject({
        ok: false, started: true, phase: 'run',
        code: 'actor_channel_run_timeout', outcomeKnown: false,
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(1);
  });

  test('bounds an event burst, evicts event ids, and retains effect dedupe', async () => {
    const eventCount = 20;
    let eventForwards = 0;
    let toolDispatches = 0;
    let eventReplies = 0;
    let excessCode = '';
    const client = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {},
      maxLoopEventsPerRun: 3,
      maxEffectRelaysPerRun: 1,
      newChannelId: () => 'channel-event-burst',
      findOffscreenClient: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => {
          const port = transfer[0] as MessagePort;
          let phase = 'events';
          const common = { protocol: 1, channelId: offer.channelId };
          const sendTool = () => port.postMessage({
            ...common, type: 'actor/relay', requestId: `relay-${eventCount + 1}`,
            relayType: 'vm/read', payload: {
              operation: 'turn.vm.read', callId: 'call-1', effectId: 'call-1:1',
              effectSequence: 1,
            },
          });
          port.onmessage = (event) => {
            const message = event.data;
            if (message.type === 'actor/open') {
              port.postMessage({ ...common, type: 'actor/accepted' });
            } else if (message.type === 'actor/commit') {
              for (let index = 0; index < eventCount; index += 1) {
                port.postMessage({
                  ...common, type: 'actor/relay', requestId: `relay-${index + 1}`,
                  relayType: 'actor/loop-event', payload: { event: { type: 'delta', index } },
                });
              }
            } else if (message.type === 'actor/relay-response' && phase === 'events') {
              eventReplies += 1;
              if (eventReplies === eventCount) { phase = 'tool-one'; sendTool(); }
            } else if (message.type === 'actor/relay-response' && phase === 'tool-one') {
              phase = 'tool-two';
              sendTool();
            } else if (message.type === 'actor/relay-response' && phase === 'tool-two') {
              phase = 'tool-excess';
              port.postMessage({
                ...common, type: 'actor/relay', requestId: `relay-${eventCount + 2}`,
                relayType: 'vm/read', payload: {
                  operation: 'turn.vm.read', callId: 'call-2', effectId: 'call-2:1',
                  effectSequence: 1,
                },
              });
            } else if (message.type === 'actor/relay-response' && phase === 'tool-excess') {
              phase = 'done';
              excessCode = message.result?.code ?? '';
              port.postMessage({
                ...common, type: 'actor/result',
                result: { ok: true, started: true, finalText: 'done' },
              });
            }
          };
          port.start();
          port.postMessage({ ...common, type: 'channel/ready' });
        },
      }),
    });
    const result = await client.run({}, {
      lease: actorLease,
      relay: async (type) => {
        if (type === 'actor/loop-event') eventForwards += 1;
        if (type === 'vm/read') toolDispatches += 1;
        return { ok: true };
      },
    });
    expect(result).toEqual({ ok: true, started: true, finalText: 'done' });
    expect({ eventForwards, eventReplies, toolDispatches }).toEqual({
      eventForwards: 3, eventReplies: eventCount, toolDispatches: 1,
    });
    expect(excessCode).toBe('actor_effect_relay_limit');
  });

  test('model and completion chatter cannot exhaust the exact-effect budget', async () => {
    const dispatched: string[] = [];
    const client = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {},
      maxEffectRelaysPerRun: 1,
      maxModelProtocolRelaysPerRun: 4,
      maxControlRelaysPerRun: 4,
      newChannelId: () => 'channel-class-budgets',
      findOffscreenClient: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => {
          const port = transfer[0] as MessagePort;
          const common = { protocol: 1, channelId: offer.channelId };
          const requests = [
            ['relay-1', 'actor/model-read-context', {}],
            ['relay-2', 'actor/model-read-inference-chunk', {}],
            ['relay-3', 'actor/loop-event', {}],
            ['relay-4', 'actor/call-complete', {}],
            ['relay-5', 'vm/read', {
              operation: 'turn.vm.read', callId: 'one', effectId: 'one:1', effectSequence: 1,
            }],
            ['relay-6', 'vm/read', {
              operation: 'turn.vm.read', callId: 'two', effectId: 'two:1', effectSequence: 1,
            }],
          ];
          let replies = 0;
          port.onmessage = (event) => {
            const message = event.data;
            if (message.type === 'actor/open') port.postMessage({ ...common, type: 'actor/accepted' });
            else if (message.type === 'actor/commit') {
              for (const [requestId, relayType, payload] of requests) {
                port.postMessage({
                  ...common, type: 'actor/relay', requestId, relayType, payload,
                });
              }
            } else if (message.type === 'actor/relay-response') {
              replies += 1;
              if (replies === requests.length) {
                expect(message.requestId).toBe('relay-6');
                expect(message.result).toMatchObject({ code: 'actor_effect_relay_limit' });
                port.postMessage({
                  ...common, type: 'actor/result', result: { ok: true, started: true },
                });
              }
            }
          };
          port.start();
          port.postMessage({ ...common, type: 'channel/ready' });
        },
      }),
    });
    const result = await client.run({}, {
      lease: actorLease,
      relay: async (type) => { dispatched.push(type); return { ok: true }; },
    });
    expect(result).toMatchObject({ ok: true, started: true });
    expect(dispatched).toEqual([
      'actor/model-read-context', 'actor/model-read-inference-chunk',
      'actor/loop-event', 'actor/call-complete', 'vm/read',
    ]);
  });

  test('bounds settled model replay retention across a fragmented stream', async () => {
    const fragments = 96;
    let dispatches = 0;
    let expiredReplayCode = '';
    const client = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {},
      maxSettledTransientRelays: 8,
      maxModelProtocolRelaysPerRun: fragments + 2,
      newChannelId: () => 'channel-fragmented-stream',
      findOffscreenClient: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => {
          const port = transfer[0] as MessagePort;
          const common = { protocol: 1, channelId: offer.channelId };
          let index = 0;
          let phase = 'stream';
          const send = (requestId: string) => port.postMessage({
            ...common, type: 'actor/relay', requestId,
            relayType: 'actor/model-read-inference-chunk', payload: { streamId: 'stream-1' },
          });
          port.onmessage = (event) => {
            const message = event.data;
            if (message.type === 'actor/open') port.postMessage({ ...common, type: 'actor/accepted' });
            else if (message.type === 'actor/commit') send(`relay-${index + 1}`);
            else if (message.type === 'actor/relay-response' && phase === 'stream') {
              index += 1;
              if (index < fragments) send(`relay-${index + 1}`);
              else {
                phase = 'evicted-replay';
                send('relay-1');
              }
            } else if (message.type === 'actor/relay-response' && phase === 'evicted-replay') {
              expiredReplayCode = message.result?.code ?? '';
              phase = 'retained-replay';
              send(`relay-${fragments}`);
            } else if (message.type === 'actor/relay-response' && phase === 'retained-replay') {
              port.postMessage({
                ...common, type: 'actor/result',
                result: { ok: true, started: true, finalText: 'streamed' },
              });
            }
          };
          port.start();
          port.postMessage({ ...common, type: 'channel/ready' });
        },
      }),
    });
    const result = await client.run({ maxSteps: 1 }, {
      lease: actorLease,
      relay: async () => {
        dispatches += 1;
        return { ok: true, value: { done: false, bytes: new Uint8Array([1]) } };
      },
    });
    expect(result).toMatchObject({ ok: true, finalText: 'streamed' });
    // The watermark rejects an evicted old id without advancing the stream;
    // the newest id remains in the bounded replay window and reuses its reply.
    expect({ dispatches, expiredReplayCode }).toEqual({
      dispatches: fragments, expiredReplayCode: 'actor_relay_replay_expired',
    });
  });

  test('retires large exact replies when their semantic call completes', async () => {
    const calls = 4;
    let effectDispatches = 0;
    let completionDispatches = 0;
    let expiredReplayCode = '';
    const client = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {},
      newChannelId: () => 'channel-exact-retirement',
      findOffscreenClient: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => {
          const port = transfer[0] as MessagePort;
          const common = { protocol: 1, channelId: offer.channelId };
          let call = 1;
          let phase: 'effect' | 'complete' | 'replay' = 'effect';
          const sendEffect = () => port.postMessage({
            ...common, type: 'actor/relay', requestId: `relay-${call * 2 - 1}`,
            relayType: 'resource/read-result', payload: {
              operation: 'turn.resource.read-result', callId: `call-${call}`,
              effectId: `call-${call}:1`, effectSequence: 1,
            },
          });
          const sendComplete = () => port.postMessage({
            ...common, type: 'actor/relay', requestId: `relay-${call * 2}`,
            relayType: 'actor/call-complete', payload: {
              callId: `call-${call}`, result: { ok: true },
            },
          });
          port.onmessage = (event) => {
            const message = event.data;
            if (message.type === 'actor/open') port.postMessage({ ...common, type: 'actor/accepted' });
            else if (message.type === 'actor/commit') sendEffect();
            else if (message.type === 'actor/relay-response' && phase === 'effect') {
              phase = 'complete';
              sendComplete();
            } else if (message.type === 'actor/relay-response' && phase === 'complete') {
              if (call < calls) {
                call += 1;
                phase = 'effect';
                sendEffect();
              } else {
                phase = 'replay';
                port.postMessage({
                  ...common, type: 'actor/relay', requestId: 'relay-1',
                  relayType: 'resource/read-result', payload: {
                    operation: 'turn.resource.read-result', callId: 'call-1',
                    effectId: 'call-1:1', effectSequence: 1,
                  },
                });
              }
            } else if (message.type === 'actor/relay-response' && phase === 'replay') {
              expiredReplayCode = message.result?.code ?? '';
              port.postMessage({
                ...common, type: 'actor/result', result: { ok: true, started: true },
              });
            }
          };
          port.start();
          port.postMessage({ ...common, type: 'channel/ready' });
        },
      }),
    });
    const largeRead = 'x'.repeat(512 * 1024);
    const result = await client.run({ maxSteps: calls }, {
      lease: actorLease,
      relay: async (type) => {
        if (type === 'actor/call-complete') {
          completionDispatches += 1;
          return { ok: true };
        }
        effectDispatches += 1;
        return { ok: true, value: largeRead };
      },
    });
    expect(result).toMatchObject({ ok: true, started: true });
    expect({ effectDispatches, completionDispatches, expiredReplayCode }).toEqual({
      effectDispatches: calls,
      completionDispatches: calls,
      expiredReplayCode: 'actor_relay_replay_expired',
    });
  });

});
