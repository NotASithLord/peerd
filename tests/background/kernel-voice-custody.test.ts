import { describe, expect, test } from 'bun:test';
import { createKernelVoiceCustody } from '../../extension/background/kernel-voice-custody.js';

const lease = {
  schema: 1, scope: 'media-host', leaseId: 'lease-media-0001', generation: 1,
  buildId: 'build-voice-0001', bootId: 'boot-voice-0001',
  kernelEpoch: 'kernel-voice-0001', hostEpoch: 'host-voice-0001',
};

const chromeHarness = (
  reply: any = { ok: true },
  options: { acquire?: () => Promise<void>; timeoutMs?: number } = {},
) => {
  let active = false;
  const calls: string[] = [];
  const featureHost = {
    runtime: {
      snapshot: () => ({ leases: { 'media-host': { status: active ? 'active' : 'idle' } } }),
      acquire: async () => {
        calls.push('acquire');
        await options.acquire?.();
        active = true;
        return { ok: true, lease };
      },
      revoke: async () => { calls.push('revoke'); active = false; return { ok: true }; },
    },
  };
  const client = {
    url: 'chrome-extension://id/offscreen/offscreen.html',
    postMessage: (offer: any, ports: MessagePort[]) => {
      calls.push(`host:${offer.command.type}`);
      const result = typeof reply === 'function' ? reply(offer) : reply;
      if (result !== undefined) ports[0].postMessage({
        type: 'voice/result', protocol: 1, requestId: offer.requestId, result,
      });
    },
  };
  const custody = createKernelVoiceCustody({
    featureHost,
    offscreenUrl: client.url,
    firefox: false,
    emit: () => {},
    listWindowClients: async () => [client],
    timeoutMs: options.timeoutMs,
  });
  return { custody, calls, active: () => active };
};

describe('kernel voice custody', () => {
  test('refuses the same malformed command before either browser host is touched', async () => {
    for (const firefox of [false, true]) {
      let touches = 0;
      const custody = createKernelVoiceCustody({
        featureHost: { runtime: {
          snapshot: () => ({ leases: {} }),
          acquire: async () => { touches += 1; return { ok: true, lease }; },
          revoke: async () => ({ ok: true }),
        } },
        offscreenUrl: 'chrome-extension://id/offscreen/offscreen.html',
        firefox,
        emit: () => {},
        listWindowClients: async () => { touches += 1; return []; },
        getFirefoxLifetime: () => ({
          createHandle: () => ({
            start: async () => { touches += 1; }, stop: async () => {},
          }),
        }),
        createFirefoxHost: () => { touches += 1; return { handle: async () => ({ ok: true }) }; },
      });
      await expect(custody.routes['voice/init']({
        type: 'voice/init', variant: 'base', engine: 'forged', extra: true,
      })).resolves.toEqual({
        ok: false, error: 'voice-command-invalid', outcomeKnown: true,
      });
      expect(touches).toBe(0);
    }
  });
  test('holds one durable Chrome media lease until exact teardown', async () => {
    const h = chromeHarness({ ok: true, engine: 'moonshine' });
    expect(await h.custody.routes['voice/init']({
      type: 'voice/init', variant: 'base', engine: 'moonshine',
    })).toEqual({ ok: true, engine: 'moonshine' });
    expect(h.active()).toBe(true);
    expect(await h.custody.routes['voice/teardown']({ type: 'voice/teardown' }))
      .toEqual({ ok: true, engine: 'moonshine' });
    expect(h.calls).toEqual([
      'acquire', 'host:voice/init', 'acquire', 'host:voice/teardown', 'revoke',
    ]);
    expect(h.active()).toBe(false);
  });

  test('a resolved failed Chrome start revokes the media lease', async () => {
    const h = chromeHarness({ ok: false, error: 'not-initialized' });
    expect(await h.custody.routes['voice/listen']({
      type: 'voice/listen', targetId: 'composer',
    })).toEqual({ ok: false, error: 'not-initialized' });
    expect(h.calls).toEqual(['acquire', 'host:voice/listen', 'revoke']);
    expect(h.active()).toBe(false);
  });

  test('queues teardown behind startup and releases the resulting lease', async () => {
    let release!: () => void;
    const acquire = new Promise<void>((resolve) => { release = resolve; });
    const h = chromeHarness({ ok: true }, { acquire: () => acquire });
    const initializing = h.custody.routes['voice/init']({
      type: 'voice/init', variant: 'base', engine: 'moonshine',
    });
    const tearingDown = h.custody.teardown();
    await Promise.resolve();
    expect(h.calls).toEqual(['acquire']);
    release();
    await expect(initializing).resolves.toEqual({ ok: true });
    await expect(tearingDown).resolves.toEqual({ ok: true });
    expect(h.calls).toEqual([
      'acquire', 'host:voice/init', 'acquire', 'host:voice/teardown', 'revoke',
    ]);
    expect(h.active()).toBe(false);
  });

  test('a timed-out channel revokes custody and a later start gets a clean host call', async () => {
    let starts = 0;
    const h = chromeHarness(
      (offer: any) => offer.command.type === 'voice/init' && starts++ === 0
        ? undefined : { ok: true },
      { timeoutMs: 5 },
    );
    await expect(h.custody.routes['voice/init']({
      type: 'voice/init', variant: 'base', engine: 'moonshine',
    })).rejects.toThrow('voice-host-timeout');
    expect(h.active()).toBe(false);
    await expect(h.custody.teardown()).resolves.toEqual({ ok: true, inactive: true });
    await expect(h.custody.routes['voice/init']({
      type: 'voice/init', variant: 'base', engine: 'moonshine',
    })).resolves.toEqual({ ok: true });
    expect(h.active()).toBe(true);
  });

  test('Firefox uses its exact background host and lifetime without offscreen acquisition', async () => {
    const calls: string[] = [];
    const custody = createKernelVoiceCustody({
      featureHost: { runtime: {
        snapshot: () => ({ leases: {} }),
        acquire: async () => { throw new Error('must not acquire offscreen'); },
      } },
      offscreenUrl: 'moz-extension://id/offscreen/offscreen.html',
      firefox: true,
      emit: () => {},
      getFirefoxLifetime: () => ({
        createHandle: () => ({
          start: async () => { calls.push('lifetime:start'); },
          stop: async () => { calls.push('lifetime:stop'); },
        }),
      }),
      createFirefoxHost: () => ({
        handle: async (command: any) => { calls.push(`host:${command.type}`); return { ok: true }; },
        teardown: async () => { calls.push('host:teardown'); },
      }),
    });
    await custody.routes['voice/init']({
      type: 'voice/init', variant: 'base', engine: 'moonshine',
    });
    await custody.routes['voice/teardown']({ type: 'voice/teardown' });
    expect(calls).toEqual([
      'lifetime:start', 'host:voice/init', 'host:voice/teardown',
      'lifetime:stop',
    ]);
  });

  test('Firefox lifetime loss tears down voice and reports a bounded UI error', async () => {
    const calls: string[] = [];
    const events: any[] = [];
    let lose!: () => void;
    const custody = createKernelVoiceCustody({
      featureHost: { runtime: {
        snapshot: () => ({ leases: {} }),
        acquire: async () => { throw new Error('must not acquire offscreen'); },
      } },
      offscreenUrl: 'moz-extension://id/offscreen/offscreen.html',
      firefox: true,
      emit: (event: any) => { events.push(event); },
      getFirefoxLifetime: () => ({
        createHandle: ({ onLost }: any) => {
          lose = () => onLost(new Error('heartbeat lost'));
          return {
            start: async () => { calls.push('lifetime:start'); },
            stop: async () => { calls.push('lifetime:stop'); },
          };
        },
      }),
      createFirefoxHost: () => ({
        handle: async () => ({ ok: true }),
        teardown: async () => { calls.push('host:teardown'); },
      }),
    });
    await custody.routes['voice/init']({
      type: 'voice/init', variant: 'base', engine: 'moonshine',
    });
    lose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(custody.active()).toBe(false);
    expect(calls).toEqual(['lifetime:start', 'host:teardown', 'lifetime:stop']);
    expect(events).toEqual([{
      type: 'voice/error',
      payload: {
        name: 'VoiceHostLifetimeError',
        message: 'Voice host stopped. Click the mic to try again.',
        targetId: null,
      },
    }]);
  });

  test('Firefox lifetime loss retires a hung active voice call before its deadline', async () => {
    let lose!: () => void;
    let noteListenStarted!: () => void;
    const listenStarted = new Promise<void>((resolve) => { noteListenStarted = resolve; });
    const events: any[] = [];
    const custody = createKernelVoiceCustody({
      featureHost: { runtime: {
        snapshot: () => ({ leases: {} }),
        acquire: async () => { throw new Error('must not acquire offscreen'); },
      } },
      offscreenUrl: 'moz-extension://id/offscreen/offscreen.html',
      firefox: true,
      emit: (event: any) => { events.push(event); },
      getFirefoxLifetime: () => ({
        createHandle: ({ onLost }: any) => {
          lose = () => onLost(new Error('heartbeat lost'));
          return { start: async () => {}, stop: async () => {} };
        },
      }),
      createFirefoxHost: () => ({
        handle: async (command: any) => {
          if (command.type === 'voice/listen') {
            noteListenStarted();
            return new Promise(() => {});
          }
          return { ok: true };
        },
        teardown: async () => {},
      }),
      timeoutMs: 100,
    });
    await custody.routes['voice/init']({
      type: 'voice/init', variant: 'base', engine: 'moonshine',
    });
    const listening = custody.routes['voice/listen']({ type: 'voice/listen', targetId: 'chat' });
    await listenStarted;
    lose();
    await expect(listening).rejects.toMatchObject({
      code: 'voice-firefox-lifetime-lost', outcomeKnown: true, retryable: true,
    });
    expect(custody.active()).toBe(false);
    expect(events).toHaveLength(1);
  });
});
