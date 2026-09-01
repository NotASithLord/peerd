import { describe, expect, test } from 'bun:test';
import {
  AppRoomAuthorityChangedError,
  createAppRoomAuthority,
} from '../../extension/offscreen/app-room-authority.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const storage = (values: Record<string, unknown> = {}) => ({ get: async () => values });

describe('offscreen App room authority', () => {
  test('rotation cancels a delayed stale join before its synchronous commit', async () => {
    const authority = createAppRoomAuthority(storage());
    const started = deferred();
    const release = deferred();
    let committed = false;
    let purged = false;
    const joining = authority.run('a1', 0, async (current) => {
      started.resolve();
      await release.promise;
      if (!current()) throw new AppRoomAuthorityChangedError();
      committed = true;
    });
    await started.promise;
    const rotating = authority.rotate('a1', 1, () => { purged = true; });
    expect(purged).toBe(false);
    release.resolve();
    await expect(joining).rejects.toBeInstanceOf(AppRoomAuthorityChangedError);
    await rotating;
    expect(committed).toBe(false);
    expect(purged).toBe(true);
  });

  test('rotation drains an admitted effect before its purge can finish', async () => {
    const authority = createAppRoomAuthority(storage());
    const started = deferred();
    const release = deferred();
    const order: string[] = [];
    const effect = authority.run('a1', 0, async () => {
      started.resolve();
      await release.promise;
      order.push('effect');
    });
    await started.promise;
    const rotating = authority.rotate('a1', 1, () => { order.push('purge'); });
    await Promise.resolve();
    expect(order).toEqual([]);
    release.resolve();
    await Promise.all([effect, rotating]);
    expect(order).toEqual(['effect', 'purge']);
  });

  test('durable and newer floors reject stale work and an older rotation', async () => {
    const authority = createAppRoomAuthority(storage({ 'app.dweb-generation.a1': 2 }));
    let called = false;
    await expect(authority.run('a1', 1, () => { called = true; }))
      .rejects.toBeInstanceOf(AppRoomAuthorityChangedError);
    let advanced = false;
    await authority.run('a1', 3, (_current, didAdvance) => { advanced = didAdvance; });
    expect(advanced).toBe(true);
    await expect(authority.rotate('a1', 2, () => { called = true; }))
      .rejects.toBeInstanceOf(AppRoomAuthorityChangedError);
    expect(called).toBe(false);
  });
});
