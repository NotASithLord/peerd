import { describe, expect, test } from 'bun:test';
import {
  createVaultPostureIndex,
  parseVaultPostureIndex,
  VAULT_POSTURE_INDEX_KEY,
} from '../../extension/background/vault-posture-index.js';

const makeKv = () => {
  const values = new Map<string, any>();
  return {
    values,
    kv: {
      get: async (key: string) => structuredClone(values.get(key)),
      set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
    },
  };
};

describe('nonsecret vault posture index', () => {
  test('fresh install publishes an actionable false posture without authority', async () => {
    const storage = makeKv();
    const index = createVaultPostureIndex({ kv: storage.kv, now: () => 42 });
    expect(await index.markFreshInstall()).toEqual({
      schema: 1, initialized: false, prfEnrolled: false, hasRecovery: false, updatedAt: 42,
    });
    expect(await index.loadForBoot()).toEqual(index.snapshot());
    expect(storage.values.has(VAULT_POSTURE_INDEX_KEY)).toBe(true);
  });

  test('missing update posture waits briefly then remains unknown for authority reconciliation', async () => {
    const storage = makeKv();
    let waits = 0;
    const index = createVaultPostureIndex({
      kv: storage.kv,
      wait: async () => { waits += 1; },
    });
    expect(await index.loadForBoot()).toBeNull();
    expect(waits).toBe(8);
  });

  test('writes exact booleans and rejects contradictory or secret-bearing shapes', async () => {
    const storage = makeKv();
    const index = createVaultPostureIndex({ kv: storage.kv, now: () => 7 });
    expect(await index.write({ initialized: true, prfEnrolled: true, hasRecovery: false }))
      .toMatchObject({ initialized: true, prfEnrolled: true, hasRecovery: false });
    expect(parseVaultPostureIndex({
      schema: 1, initialized: false, prfEnrolled: true, hasRecovery: false, updatedAt: 1,
    })).toBeNull();
    expect(parseVaultPostureIndex({
      schema: 1, initialized: true, prfEnrolled: true, hasRecovery: false,
      updatedAt: 1, wrappedDK: 'secret',
    })).toBeNull();
    expect(JSON.stringify(index.snapshot())).not.toContain('secret');
  });
});
