import { describe, expect, test } from 'bun:test';
import { createBrowserNetworkCustody } from '../../extension/background/browser-network-custody.js';

describe('browser network custody', () => {
  test('one operation cannot release another operation or a durable hold', async () => {
    const custody = createBrowserNetworkCustody({
      persist: async () => {},
      makeToken: (() => { let next = 0; return () => `lease-${next += 1}`; })(),
    });
    await custody.hydrate([]);
    await custody.addDurable(7);
    const first = custody.acquire(7);
    const second = custody.acquire(7);

    expect(custody.release(first)).toBe(true);
    expect(custody.tabIds()).toEqual([7]);
    expect(custody.release(first)).toBe(false);
    expect(custody.release(second)).toBe(true);
    expect(custody.tabIds()).toEqual([7]);
  });

  test('durable claims retain one generation and invalidate on close or removal', async () => {
    const custody = createBrowserNetworkCustody({
      persist: async () => {},
      makeToken: (() => { let next = 0; return () => `claim-${next += 1}`; })(),
    });
    await custody.hydrate([]);

    const first = await custody.claimDurable(21);
    const joined = await custody.claimDurable(21);
    expect(first).toEqual({ tabId: 21, token: 'claim-1', added: true });
    expect(joined).toEqual({ tabId: 21, token: 'claim-1', added: false });
    expect(custody.isDurableClaimValid(first)).toBe(true);
    expect(custody.isDurableClaimValid(joined)).toBe(true);

    await custody.close(21);
    expect(custody.isDurableClaimValid(first)).toBe(false);
    expect(custody.isDurableClaimValid(joined)).toBe(false);

    const reused = await custody.claimDurable(21);
    expect(reused).toEqual({ tabId: 21, token: 'claim-2', added: true });
    expect(custody.isDurableClaimValid(first)).toBe(false);
    expect(custody.isDurableClaimValid(reused)).toBe(true);

    await custody.removeDurable(21);
    expect(custody.isDurableClaimValid(reused)).toBe(false);
  });

  test('a close while the caller awaits DNR sync invalidates its durable claim', async () => {
    const custody = createBrowserNetworkCustody({ persist: async () => {} });
    await custody.hydrate([]);
    const claim = await custody.claimDurable(23);
    let finishSync = () => {};
    const sync = new Promise<void>((resolve) => { finishSync = resolve; });
    const validAfterSync = (async () => {
      await sync;
      return custody.isDurableClaimValid(claim);
    })();

    await custody.close(23);
    finishSync();

    expect(await validAfterSync).toBe(false);
  });

  test('lease validity is generation-bound across close and tab-id reuse', async () => {
    const custody = createBrowserNetworkCustody({
      persist: async () => {},
      makeToken: (() => { let next = 0; return () => `lease-${next += 1}`; })(),
    });
    await custody.hydrate([]);

    const first = custody.acquire(22);
    expect(custody.isLeaseValid(first)).toBe(true);
    await custody.close(22);
    expect(custody.isLeaseValid(first)).toBe(false);

    const reused = custody.acquire(22);
    expect(custody.isLeaseValid(first)).toBe(false);
    expect(custody.isLeaseValid(reused)).toBe(true);
    expect(custody.release(first)).toBe(false);
    expect(custody.isLeaseValid(reused)).toBe(true);
  });

  test('an invalid startup lease cannot mint durable custody after close', async () => {
    const writes: Array<readonly number[]> = [];
    const custody = createBrowserNetworkCustody({
      persist: async (tabIds) => { writes.push([...tabIds]); },
    });
    await custody.hydrate([]);
    const startupLease = custody.acquire(24);
    await custody.close(24);

    const error = await custody.claimDurable(24, startupLease)
      .then(() => null, (failure) => failure);
    expect(error?.name).toBe('BrowserNetworkCustodyClosedError');
    expect(custody.hasDurable(24)).toBe(false);
    expect(writes).toEqual([]);
  });

  test('a close during a startup claim invalidates its required generation', async () => {
    const writes: Array<{ tabIds: readonly number[]; release: () => void }> = [];
    const custody = createBrowserNetworkCustody({
      persist: (tabIds) => new Promise<void>((resolve) => { writes.push({ tabIds, release: resolve }); }),
    });
    await custody.hydrate([]);
    const startupLease = custody.acquire(25);
    const pending = custody.claimDurable(25, startupLease);
    while (!writes.length) await Promise.resolve();
    const closed = custody.close(25);
    writes[0].release();
    const error = await pending.then(() => null, (failure) => failure);
    expect(error?.name).toBe('BrowserNetworkCustodyClosedError');
    while (writes.length < 2) await Promise.resolve();
    writes[1].release();
    await closed;
    expect(custody.tabIds()).toEqual([]);
  });

  test('a close during add rejects the caller and persists the removal afterward', async () => {
    const writes: Array<{ tabIds: readonly number[]; release: () => void }> = [];
    const custody = createBrowserNetworkCustody({
      persist: (tabIds) => new Promise<void>((resolve) => { writes.push({ tabIds, release: resolve }); }),
    });
    await custody.hydrate([]);
    const added = custody.addDurable(9);
    while (!writes.length) await Promise.resolve();
    const closed = custody.close(9);
    expect(writes.map((write) => write.tabIds)).toEqual([[9]]);
    const addFailure = added.then(() => null, (error) => error);
    writes[0].release();
    const error = await addFailure;
    expect(error).toBeInstanceOf(Error);
    expect(error?.name).toBe('BrowserNetworkCustodyClosedError');
    while (writes.length < 2) await Promise.resolve();
    expect(writes.map((write) => write.tabIds)).toEqual([[9], []]);
    writes[1].release();
    await closed;
    expect(custody.tabIds()).toEqual([]);
  });

  test('concurrent adds join the same pending durable write', async () => {
    const writes: Array<readonly number[]> = [];
    let releaseWrite = () => {};
    const custody = createBrowserNetworkCustody({
      persist: (tabIds) => new Promise<void>((resolve) => {
        writes.push([...tabIds]);
        releaseWrite = resolve;
      }),
    });
    await custody.hydrate([]);

    const first = custody.addDurable(13);
    const second = custody.addDurable(13);
    while (!writes.length) await Promise.resolve();

    expect(writes).toEqual([[13]]);
    let secondSettled = false;
    second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseWrite();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(custody.hasDurable(13)).toBe(true);
    expect(writes).toEqual([[13]]);
  });

  test('a failed joined add rolls memory and persisted custody back before rejecting', async () => {
    const writes: Array<readonly number[]> = [];
    let rejectWrite = (_error: Error) => {};
    const custody = createBrowserNetworkCustody({
      persist: (tabIds) => {
        writes.push([...tabIds]);
        if (writes.length > 1) return Promise.resolve();
        return new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
      },
    });
    await custody.hydrate([]);

    const first = custody.addDurable(17);
    const second = custody.addDurable(17);
    while (!writes.length) await Promise.resolve();
    expect(writes).toEqual([[17]]);

    const firstFailure = first.then(() => null, (error) => error);
    const secondFailure = second.then(() => null, (error) => error);
    rejectWrite(new Error('session storage unavailable'));
    const [firstError, secondError] = await Promise.all([firstFailure, secondFailure]);
    expect(firstError).toBeInstanceOf(Error);
    expect(firstError?.message).toBe('session storage unavailable');
    expect(secondError).toBeInstanceOf(Error);
    expect(secondError?.message).toBe('session storage unavailable');

    expect(custody.hasDurable(17)).toBe(false);
    expect(custody.tabIds()).toEqual([]);
    expect(writes).toEqual([[17], []]);
  });

  test('a close during hydration cannot resurrect a reused tab id', async () => {
    const writes: Array<readonly number[]> = [];
    const custody = createBrowserNetworkCustody({
      persist: async (tabIds) => { writes.push([...tabIds]); },
    });

    await custody.close(11);
    await custody.hydrate([11, 12]);

    expect(custody.tabIds()).toEqual([12]);
    expect(writes).toEqual([[12]]);
  });
});
