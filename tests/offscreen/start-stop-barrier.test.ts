import { describe, expect, test } from 'bun:test';
import {
  HostStopFailedError,
  HostSuspendedError,
  makeStartStopBarrier,
} from '../../extension/offscreen/start-stop-barrier.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('offscreen host start/stop barrier', () => {
  test('stop waits for and closes a candidate that finishes starting late', async () => {
    const created = deferred<{ id: string }>();
    let active: { id: string } | null = null;
    const closed: string[] = [];
    const barrier = makeStartStopBarrier({
      getActive: () => active,
      create: () => created.promise,
      activate: (candidate) => { active = candidate; },
      close: (candidate) => { closed.push(candidate.id); if (active === candidate) active = null; },
    });

    const starting = barrier.start();
    const stopping = barrier.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    created.resolve({ id: 'old-identity' });
    await expect(starting).rejects.toMatchObject({ name: 'HostStartCancelledError' });
    await stopping;
    expect(active).toBeNull();
    expect(closed).toEqual(['old-identity']);
  });

  test('a fresh start succeeds after an in-flight start was cancelled', async () => {
    const first = deferred<{ id: string }>();
    let next = 0;
    let active: { id: string } | null = null;
    const barrier = makeStartStopBarrier({
      getActive: () => active,
      create: () => next++ === 0 ? first.promise : Promise.resolve({ id: 'new-identity' }),
      activate: (candidate) => { active = candidate; },
      close: (candidate) => { if (active === candidate) active = null; },
    });
    const oldStart = barrier.start();
    const stop = barrier.stop();
    first.resolve({ id: 'old-identity' });
    await expect(oldStart).rejects.toMatchObject({ name: 'HostStartCancelledError' });
    await stop;
    expect(await barrier.start()).toEqual({ id: 'new-identity' });
  });

  test('a failed close rejects stop and preserves the active handle', async () => {
    const candidate = { id: 'old-identity' };
    let active: typeof candidate | null = candidate;
    const barrier = makeStartStopBarrier({
      getActive: () => active,
      create: async () => candidate,
      activate: (value) => { active = value; },
      close: () => { throw new Error('close failed'); },
    });

    await expect(barrier.stop()).rejects.toBeInstanceOf(HostStopFailedError);
    expect(active).toBe(candidate);
  });

  test('suspend rejects starts throughout the custody-write gap until resume', async () => {
    let creates = 0;
    let active: { id: string } | null = null;
    const barrier = makeStartStopBarrier({
      getActive: () => active,
      create: async () => ({ id: `identity-${++creates}` }),
      activate: (candidate) => { active = candidate; },
      close: (candidate) => { if (active === candidate) active = null; },
    });

    expect(await barrier.start()).toEqual({ id: 'identity-1' });
    await barrier.stop({ suspensionOwner: 'rotation-a' });
    await expect(barrier.start()).rejects.toBeInstanceOf(HostSuspendedError);
    expect(creates).toBe(1);

    // This models the complete interval after stop returns and before the
    // caller commits its new identity material.
    await Promise.resolve();
    await expect(barrier.start()).rejects.toBeInstanceOf(HostSuspendedError);
    expect(creates).toBe(1);

    expect(barrier.resume('unrelated-operation')).toBe(false);
    await expect(barrier.start()).rejects.toBeInstanceOf(HostSuspendedError);
    expect(barrier.resume('rotation-a')).toBe(true);
    expect(await barrier.start()).toEqual({ id: 'identity-2' });
  });

  test('a second owner cannot steal a live suspension lease', async () => {
    const barrier = makeStartStopBarrier({
      getActive: () => null,
      create: async () => ({ id: 'identity' }),
      activate: () => {},
      close: () => {},
    });
    await barrier.stop({ suspensionOwner: 'rotation-a' });
    await expect(barrier.stop({ suspensionOwner: 'rotation-b' }))
      .rejects.toBeInstanceOf(HostSuspendedError);
    expect(barrier.resume('rotation-b')).toBe(false);
    await expect(barrier.start()).rejects.toBeInstanceOf(HostSuspendedError);
  });

  test('normal stop rejects a retry that arrives while an old start settles', async () => {
    const first = deferred<{ id: string }>();
    let creates = 0;
    let active: { id: string } | null = null;
    const barrier = makeStartStopBarrier({
      getActive: () => active,
      create: () => ++creates === 1 ? first.promise : Promise.resolve({ id: 'retry' }),
      activate: (candidate) => { active = candidate; },
      close: (candidate) => { if (active === candidate) active = null; },
    });
    const oldStart = barrier.start();
    const retry = oldStart.catch(() => barrier.start());
    const stop = barrier.stop();
    first.resolve({ id: 'old' });

    await expect(retry).rejects.toBeInstanceOf(HostSuspendedError);
    await stop;
    expect(creates).toBe(1);
    expect(active).toBeNull();
  });
});
