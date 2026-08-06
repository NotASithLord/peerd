import { describe, expect, test } from 'bun:test';
import { createShareRollbackStore } from '../../extension/offscreen/share-rollback-store.js';

describe('share rollback transaction state', () => {
  test('keeps a failed rollback pending and retries the same transaction', async () => {
    const store = createShareRollbackStore();
    store.register('tx', { hash: 'new' });
    let calls = 0;
    const rollback = async (state: any) => {
      calls += 1;
      if (calls === 1) throw new Error('restore failed');
      return { restored: state.hash === 'new' };
    };
    await expect(store.rollback('tx', rollback)).rejects.toThrow('restore failed');
    expect(store.hasPending('tx')).toBe(true);
    expect(await store.rollback('tx', rollback)).toEqual({ ok: true, restored: true });
    expect(store.hasPending('tx')).toBe(false);
  });

  test('lost rollback and commit replies are idempotent', async () => {
    const rolled = createShareRollbackStore();
    rolled.register('rollback', {});
    const operation = async () => ({ restored: false });
    expect(await rolled.rollback('rollback', operation)).toEqual({ ok: true, restored: false });
    expect(await rolled.rollback('rollback', operation)).toEqual({ ok: true, restored: false });
    expect(rolled.commit('rollback')).toEqual({ ok: false, error: 'share-already-rolled-back' });

    const committed = createShareRollbackStore();
    committed.register('commit', {});
    expect(committed.commit('commit')).toEqual({ ok: true, committed: true });
    expect(committed.commit('commit')).toEqual({ ok: true, committed: true });
    expect(await committed.rollback('commit', operation)).toEqual({ ok: false, error: 'share-already-committed' });
  });

  test('concurrent rollback calls share one side effect', async () => {
    const store = createShareRollbackStore();
    store.register('tx', {});
    let release!: () => void;
    let started!: () => void;
    const rollbackStarted = new Promise<void>((resolve) => { started = resolve; });
    let calls = 0;
    const operation = async () => {
      calls += 1;
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { restored: true };
    };
    const first = store.rollback('tx', operation);
    const second = store.rollback('tx', operation);
    await rollbackStarted;
    release();
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, restored: true },
      { ok: true, restored: true },
    ]);
    expect(calls).toBe(1);
  });
});
