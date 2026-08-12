import { describe, test, expect } from 'bun:test';
import {
  createDwebRollbackGuard, DWEB_HIGH_WATER_KEY,
} from '../../extension/background/dweb-rollback-guard.js';

const memoryKv = () => {
  const values = new Map<string, any>();
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
  };
};

const id = (char: string) => char.repeat(64);
const release = (over: any = {}) => ({
  dwappId: id('a'),
  publisher: 'did:key:zPublisher',
  seq: 9,
  versionId: id('b'),
  ...over,
});

describe('durable dweb rollback guard', () => {
  test('survives a service-worker generation and permits only current replay or a newer amendment', async () => {
    const kv = memoryKv();
    const first = createDwebRollbackGuard({ kv });
    expect(await first.admit(release())).toMatchObject({ ok: true, accepted: true, replay: false });

    // A new factory models a restarted service worker: only kv state survives.
    const restarted = createDwebRollbackGuard({ kv });
    expect(await restarted.admit(release({ seq: 8, versionId: id('c') })))
      .toEqual({ ok: true, accepted: false, error: 'dweb-version-rollback' });
    expect(await restarted.admit(release()))
      .toEqual({ ok: true, accepted: true, replay: true });
    expect(await restarted.admit(release({ versionId: id('c') })))
      .toEqual({ ok: true, accepted: false, error: 'dweb-version-equivocation' });
    expect(await restarted.admit(release({ seq: 10, versionId: id('d') })))
      .toMatchObject({ ok: true, accepted: true, replay: false });

    expect(kv.values.get(DWEB_HIGH_WATER_KEY).entries[id('a')])
      .toEqual({ publisher: 'did:key:zPublisher', seq: 10, versionId: id('d') });
  });

  test('never evicts security history when capacity is reached', async () => {
    const kv = memoryKv();
    const guard = createDwebRollbackGuard({ kv, cap: 1 });
    expect((await guard.admit(release())).accepted).toBe(true);
    expect(await guard.admit(release({ dwappId: id('e') })))
      .toEqual({ ok: true, accepted: false, error: 'dweb-version-capacity' });

    const restarted = createDwebRollbackGuard({ kv, cap: 1 });
    expect(await restarted.admit(release({ seq: 1, versionId: id('f') })))
      .toEqual({ ok: true, accepted: false, error: 'dweb-version-rollback' });
  });

  test('fails closed on malformed durable state', async () => {
    const kv = memoryKv();
    kv.values.set(DWEB_HIGH_WATER_KEY, { schema: 999, entries: {} });
    expect(await createDwebRollbackGuard({ kv }).admit(release()))
      .toEqual({ ok: false, accepted: false, error: 'dweb-version-state-corrupt' });
  });
});
