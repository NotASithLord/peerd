import { describe, expect, test } from 'bun:test';
import {
  isKnownActorStartupFailure, makeOffscreenActorChannelClient, selectExactActorHostClient,
} from '../../extension/background/offscreen-actor-channel-client.js';
import { bindActorChannel } from '../../extension/offscreen/actor-channel-host.js';

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

  test('runs and relays over the transferred channel without a bearer grant', async () => {
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
              const reply = await sendToSW('actor/model-call', { args: { messages: [] } });
              expect(reply).toEqual({ ok: true, events: [] });
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
        relay: async (type, payload) => {
          relayed.push({ type, payload });
          return { ok: true, events: [] };
        },
      },
    );
    expect(result).toEqual({ ok: true, started: true, finalText: 'done' });
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({
      type: 'peerd/actor-channel', protocol: 1, channelId: 'channel-one',
    });
    expect(JSON.stringify(offered)).not.toContain('private job');
    expect(relayed).toEqual([{
      type: 'actor/model-call', payload: { args: { messages: [] } },
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
    const result = await client.run({}, { signal: abort.signal, relay: async () => ({}) });
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
    await expect(client.run({}, { relay: async () => ({}) })).resolves.toMatchObject({
      ok: false, started: false, code: 'actor_host_not_ready', outcomeKnown: true,
    });
  });

  test('a host that never becomes ready is a structured not-started failure', async () => {
    const client = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {}, handshakeTimeoutMs: 5,
      findOffscreenClient: async () => ({ postMessage: () => {} }),
    });
    await expect(client.run({}, { relay: async () => ({}) })).resolves.toMatchObject({
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
    await expect(client.run({ runId: 'wedged-run' }, { relay: async () => ({}) }))
      .resolves.toMatchObject({
        ok: false, started: true, phase: 'run',
        code: 'actor_channel_run_timeout', outcomeKnown: false,
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(1);
  });

  test('a duplicate relay request shares one privileged dispatch', async () => {
    let dispatches = 0;
    const client = makeOffscreenActorChannelClient({
      ensureOffscreen: async () => {}, newChannelId: () => 'channel-dedupe',
      findOffscreenClient: async () => ({
        postMessage: (offer: any, transfer: Transferable[]) => {
          const port = transfer[0] as MessagePort;
          port.onmessage = (event) => {
            const message = event.data;
            const common = { protocol: 1, channelId: offer.channelId };
            if (message.type === 'actor/open') {
              port.postMessage({ ...common, type: 'actor/accepted' });
            } else if (message.type === 'actor/commit') {
              const relay = {
                ...common, type: 'actor/relay', requestId: 'same-request',
                relayType: 'actor/tool-dispatch', payload: { call: { name: 'click' } },
              };
              port.postMessage(relay);
              port.postMessage(relay);
            } else if (message.type === 'actor/relay-response') {
              port.postMessage({
                ...common, type: 'actor/result', result: { ok: true, started: true },
              });
            }
          };
          port.start();
          port.postMessage({ protocol: 1, channelId: offer.channelId, type: 'channel/ready' });
        },
      }),
    });
    await client.run({}, {
      relay: async () => { dispatches += 1; return { ok: true }; },
    });
    expect(dispatches).toBe(1);
  });
});
