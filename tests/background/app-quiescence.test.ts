import { describe, expect, test } from 'bun:test';
import { createAppQuiescence } from '../../extension/background/app-quiescence.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('App editor quiescence', () => {
  test('holds one lifecycle lane while flushing before repository work', async () => {
    const order: string[] = [];
    const tracker = {
      getTabId: () => 7,
      quiesceTab: async () => { order.push('flush'); return true; },
      resumeTab: async () => { order.push('resume'); return true; },
      closeTab: async () => true,
      ensureTab: async () => 7,
      reloadTab: async () => true,
    };
    const quiescence = createAppQuiescence({
      tracker,
      withLifecycle: async (_appId, operation) => {
        order.push('lifecycle');
        try { return await operation(); }
        finally { order.push('release'); }
      },
    });

    await quiescence.run('app-1', async () => { order.push('repository'); });
    expect(order).toEqual(['lifecycle', 'flush', 'repository', 'resume', 'release']);
  });

  test('a failed flush or close fails closed before repository mutation', async () => {
    let mutations = 0;
    let closeCalls = 0;
    const make = (quiesceResult: boolean) => createAppQuiescence({
      tracker: {
        getTabId: () => 7,
        quiesceTab: async () => quiesceResult,
        resumeTab: async () => true,
        closeTab: async () => { closeCalls += 1; return false; },
        ensureTab: async () => 7,
        reloadTab: async () => true,
      },
      withLifecycle: async (_appId, operation) => operation(),
      afterClose: async () => {},
    });

    await expect(make(false).run('app-1', async () => { mutations += 1; }, { close: true }))
      .rejects.toThrow('pending save');
    expect(closeCalls).toBe(0);
    await expect(make(true).run('app-1', async () => { mutations += 1; }, { close: true }))
      .rejects.toThrow('could not close');
    expect(closeCalls).toBe(1);
    expect(mutations).toBe(0);
  });

  test('concurrent repository boundaries cannot unfreeze each other', async () => {
    const order: string[] = [];
    let tail = Promise.resolve();
    const withLifecycle = <T>(_appId: string, operation: () => Promise<T>) => {
      const result = tail.then(operation, operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
    const firstGate = deferred();
    const tracker = {
      getTabId: () => 7,
      quiesceTab: async () => { order.push('flush'); return true; },
      resumeTab: async () => { order.push('resume'); return true; },
      closeTab: async () => true,
      ensureTab: async () => 7,
      reloadTab: async () => true,
    };
    const quiescence = createAppQuiescence({ tracker, withLifecycle });

    const first = quiescence.run('app-1', async () => {
      order.push('first');
      await firstGate.promise;
    });
    const second = quiescence.run('app-1', async () => { order.push('second'); });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['flush', 'first']);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['flush', 'first', 'resume', 'flush', 'second', 'resume']);
  });
});
