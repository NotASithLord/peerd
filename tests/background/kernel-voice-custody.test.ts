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
});
