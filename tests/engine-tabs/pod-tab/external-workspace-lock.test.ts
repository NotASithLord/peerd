import { describe, expect, test } from 'bun:test';
import { createExternalWorkspaceLockManager } from '../../../extension/engine-tabs/pod-tab/external-workspace-lock.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const harness = () => {
  let workspaceTail = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T> | T) => {
    const result = workspaceTail.then(operation, operation);
    workspaceTail = result.then(() => undefined, () => undefined);
    return result;
  };
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const manager = createExternalWorkspaceLockManager({
    appendHold: () => {
      const previous = workspaceTail.catch(() => {});
      let release = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      workspaceTail = previous.then(() => held);
      return { wait: previous, release };
    },
    setTimeoutFn: ((callback: () => void) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    }) as typeof setTimeout,
    clearTimeoutFn: ((id?: number) => { if (id != null) timers.delete(id); }) as typeof clearTimeout,
  });
  return {
    manager,
    enqueue,
    fire: (id: number) => {
      const callback = timers.get(id);
      timers.delete(id);
      callback?.();
    },
    timerIds: () => [...timers.keys()],
  };
};

describe('Pod external workspace lock leases', () => {
  test('a lost SW release expires and unblocks Pod filesystem work', async () => {
    const h = harness();
    await h.manager.acquire('lock-orphan');
    let ran = false;
    const waiting = h.enqueue(() => { ran = true; });
    await Promise.resolve();
    expect(ran).toBe(false);

    h.fire(h.timerIds()[0]);
    await waiting;
    expect(ran).toBe(true);
  });

  test('a fresh SW generation safely waits for then replaces a stale hold', async () => {
    const h = harness();
    await h.manager.acquire('lock-old-generation');
    const acquiring = h.manager.acquire('lock-new-generation');
    await Promise.resolve();
    let acquired = false;
    acquiring.then(() => { acquired = true; });
    await Promise.resolve();
    expect(acquired).toBe(false);

    const [oldTimer] = h.timerIds();
    h.fire(oldTimer);
    await acquiring;
    expect(acquired).toBe(true);
    expect(h.manager.release('lock-new-generation')).toBe(true);
  });

  test('release during acquisition is registered and cannot strand the queue', async () => {
    const h = harness();
    const predecessor = deferred();
    const first = h.enqueue(() => predecessor.promise);
    const acquiring = h.manager.acquire('lock-early-release');

    expect(h.manager.release('lock-early-release')).toBe(true);
    predecessor.resolve();
    await first;
    await expect(acquiring).rejects.toThrow('released before acquisition');
    let ran = false;
    await h.enqueue(() => { ran = true; });
    expect(ran).toBe(true);
  });

  test('renewal invalidates the old expiry callback', async () => {
    const h = harness();
    await h.manager.acquire('lock-renewed');
    const [oldTimer] = h.timerIds();
    expect(h.manager.renew('lock-renewed')).toBe(true);
    h.fire(oldTimer);

    let ran = false;
    const waiting = h.enqueue(() => { ran = true; });
    await Promise.resolve();
    expect(ran).toBe(false);
    h.fire(h.timerIds()[0]);
    await waiting;
    expect(ran).toBe(true);
  });
});
