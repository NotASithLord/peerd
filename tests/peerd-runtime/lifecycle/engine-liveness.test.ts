// The §9 engine-liveness ledger — the durable fact ("this instance was
// HOSTED when the lights went out") that lets a boot tell dormant catalog
// entries from freshly-orphaned processes.

import { describe, test, expect } from 'bun:test';
import {
  makeEngineLiveness, ENGINE_LIVENESS_KEY,
} from '../../../extension/peerd-runtime/lifecycle/engine-liveness.js';

const makeStorage = () => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (k: string) => structuredClone(map.get(k)),
    set: async (k: string, v: unknown) => { map.set(k, structuredClone(v)); },
  };
};

describe('adopt / drop / sweep', () => {
  test('the eviction story: hosted instances without surviving tabs are the lost set', async () => {
    const storage = makeStorage();
    const before = makeEngineLiveness({ storage, now: () => 1 });
    await before.adopt('vm', 'vm-1', 11);
    await before.adopt('notebook', 'nb-1', 12);
    await before.adopt('app', 'app-1', 13);
    await before.drop('app', 'app-1'); // clean close before the eviction

    // The eviction: fresh instance over the same storage; only the VM's
    // tab survived (the tracker re-adopted it at bootstrap).
    const after = makeEngineLiveness({ storage, now: () => 2 });
    const lost = await after.sweep({ surviving: ['vm:vm-1'] });
    expect(lost.map((l) => `${l.kind}:${l.id}`)).toEqual(['notebook:nb-1']);

    // The ledger now holds exactly the survivors — a second sweep is clean.
    expect(await after.sweep({ surviving: ['vm:vm-1'] })).toEqual([]);
  });

  test('adopt is idempotent and the ledger heals from corruption', async () => {
    const storage = makeStorage();
    storage.map.set(ENGINE_LIVENESS_KEY, 'torn-write-garbage');
    const liveness = makeEngineLiveness({ storage, now: () => 1 });
    await liveness.adopt('vm', 'vm-1', 11);
    await liveness.adopt('vm', 'vm-1', 11);
    const lost = await liveness.sweep({ surviving: [] });
    expect(lost.length).toBe(1);
    expect(typeof storage.map.get(ENGINE_LIVENESS_KEY)).toBe('object');
  });

  test('a cold worker resolves an App from its durable tab id', async () => {
    const storage = makeStorage();
    await makeEngineLiveness({ storage, now: () => 1 }).adopt('app', 'app-1', 41);
    const restarted = makeEngineLiveness({ storage, now: () => 2 });
    expect(await restarted.findByTab('app', 41)).toEqual({
      kind: 'app', id: 'app-1', tabId: 41, at: 1,
    });
    await restarted.drop('app', 'app-1');
    expect(await restarted.findByTab('app', 41)).toBe(null);
  });

  test('a failing storage layer never throws into the tracker hooks', async () => {
    const liveness = makeEngineLiveness({
      storage: {
        get: async () => { throw new Error('down'); },
        set: async () => { throw new Error('down'); },
      },
    });
    await liveness.adopt('vm', 'vm-1', 11); // must not reject
    await liveness.drop('vm', 'vm-1');
    // sweep still resolves (empty — nothing readable).
    expect(await liveness.sweep({ surviving: [] })).toEqual([]);
  });
});
