import { describe, expect, test } from 'bun:test';
import { createAuthorityEffectScheduler } from '../../extension/background/authority-effect-scheduler.js';
import { authorityEffectResourceKey } from '../../extension/background/authority-effect-resource.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const pageKey = (sessionId: string, tabId: number | null, pinned: string) =>
  authorityEffectResourceKey('turn.page.click', {}, {
    actorType: 'web', actorInstanceId: 'web', authorityPageResourceKey: pinned,
    activeTab: tabId === null ? null : { id: tabId }, session: { sessionId },
  });

const siteClientKey = (sessionId: string, tabId: number | null, pinned: string,
  backing: 'tab' | 'api', origin = 'https://example.test') =>
  authorityEffectResourceKey('turn.site-client.run', { origin }, {
    actorType: 'web', actorBacking: backing,
    actorInstanceId: backing === 'api' ? origin : 'web',
    authorityPageResourceKey: pinned,
    activeTab: tabId === null ? null : { id: tabId }, session: { sessionId },
  });

describe('authority effect scheduler', () => {
  test('admits a read wave before queued writers and preserves writer FIFO', async () => {
    const scheduler = createAuthorityEffectScheduler();
    const readGate = deferred();
    const readAEntered = deferred();
    const readBEntered = deferred();
    const firstWriterGate = deferred();
    const firstWriterEntered = deferred();
    const entered: string[] = [];
    const read = (label: string, started: ReturnType<typeof deferred>) =>
      scheduler.run({ read: true, target: 'memory:profile' }, async () => {
      entered.push(label);
      started.resolve();
      await readGate.promise;
    });
    const reads = [read('read-a', readAEntered), read('read-b', readBEntered)];
    await Promise.all([readAEntered.promise, readBEntered.promise]);
    const firstWriter = scheduler.run({ read: false, target: 'memory:profile' }, async () => {
      entered.push('writer-a');
      firstWriterEntered.resolve();
      await firstWriterGate.promise;
    });
    const secondWriter = scheduler.run({ read: false, target: 'memory:profile' }, () => {
      entered.push('writer-b');
    });
    await Promise.resolve();
    expect(entered).toEqual(['read-a', 'read-b']);
    readGate.resolve();
    await Promise.all(reads);
    await firstWriterEntered.promise;
    expect(entered).toEqual(['read-a', 'read-b', 'writer-a']);
    firstWriterGate.resolve();
    await Promise.all([firstWriter, secondWriter]);
    expect(entered).toEqual(['read-a', 'read-b', 'writer-a', 'writer-b']);
  });

  test('overlaps different tabs while serializing the same tab', async () => {
    const scheduler = createAuthorityEffectScheduler();
    const firstGate = deferred();
    const entered: string[] = [];
    const first = scheduler.run({ read: false, target: pageKey('actor-a', 7, 'page:tab:7') }, async () => {
      entered.push('first');
      await firstGate.promise;
    });
    await Promise.resolve();
    const sameTab = scheduler.run({ read: false, target: pageKey('actor-b', 7, 'page:tab:7') }, () => {
      entered.push('same-tab');
    });
    const otherTab = scheduler.run({ read: false, target: pageKey('actor-c', 8, 'page:tab:8') }, () => {
      entered.push('other-tab');
    });
    await otherTab;
    expect(entered).toEqual(['first', 'other-tab']);
    firstGate.resolve();
    await Promise.all([first, sameTab]);
    expect(entered).toEqual(['first', 'other-tab', 'same-tab']);
  });

  test('serializes tab-backed site-client runs with page mutation on that tab only', async () => {
    const scheduler = createAuthorityEffectScheduler();
    const pageGate = deferred();
    const pageEntered = deferred();
    const entered: string[] = [];
    const page = scheduler.run({
      read: false, target: pageKey('actor-a', 7, 'page:tab:7'),
    }, async () => {
      entered.push('page');
      pageEntered.resolve();
      await pageGate.promise;
    });
    await pageEntered.promise;
    const sameTabClient = scheduler.run({
      read: false,
      target: siteClientKey('actor-b', 7, 'page:tab:7', 'tab'),
    }, () => { entered.push('same-tab-client'); });
    const otherTabClient = scheduler.run({
      read: false,
      target: siteClientKey('actor-c', 8, 'page:tab:8', 'tab'),
    }, () => { entered.push('other-tab-client'); });
    const apiClient = scheduler.run({
      read: false,
      target: siteClientKey('actor-api', null, '', 'api'),
    }, () => { entered.push('api-client'); });
    await Promise.all([otherTabClient, apiClient]);
    expect(entered).toEqual(['page', 'other-tab-client', 'api-client']);
    pageGate.resolve();
    await Promise.all([page, sameTabClient]);
    expect(entered).toEqual([
      'page', 'other-tab-client', 'api-client', 'same-tab-client',
    ]);
  });

  test('serializes API Web actors by origin while unrelated origins overlap', async () => {
    const scheduler = createAuthorityEffectScheduler();
    const firstGate = deferred();
    const firstEntered = deferred();
    const entered: string[] = [];
    const first = scheduler.run({
      read: false,
      target: siteClientKey('api-a', null, '', 'api', 'https://example.test'),
    }, async () => {
      entered.push('first-origin');
      firstEntered.resolve();
      await firstGate.promise;
    });
    await firstEntered.promise;
    const sameOrigin = scheduler.run({
      read: false,
      target: siteClientKey('api-b', null, '', 'api', 'https://example.test'),
    }, () => { entered.push('same-origin'); });
    const otherOrigin = scheduler.run({
      read: false,
      target: siteClientKey('api-c', null, '', 'api', 'https://other.test'),
    }, () => { entered.push('other-origin'); });
    await otherOrigin;
    expect(entered).toEqual(['first-origin', 'other-origin']);
    firstGate.resolve();
    await Promise.all([first, sameOrigin]);
    expect(entered).toEqual(['first-origin', 'other-origin', 'same-origin']);
  });

  test('keeps a zero-tab actor on one lane through first-tab adoption', async () => {
    const scheduler = createAuthorityEffectScheduler();
    const navigationGate = deferred();
    const navigationEntered = deferred();
    const entered: string[] = [];
    const beforeAdoption = pageKey('actor-zero', null, 'page:actor:actor-zero');
    const afterAdoption = pageKey('actor-zero', 9, 'page:actor:actor-zero');
    expect(afterAdoption).toBe(beforeAdoption);
    const navigate = scheduler.run({ read: false, target: beforeAdoption }, async () => {
      entered.push('navigate');
      navigationEntered.resolve();
      await navigationGate.promise;
    });
    await navigationEntered.promise;
    const click = scheduler.run({ read: false, target: afterAdoption }, () => {
      entered.push('click');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(entered).toEqual(['navigate']);
    navigationGate.resolve();
    await Promise.all([navigate, click]);
    expect(entered).toEqual(['navigate', 'click']);
  });

  test('allows a nested same-target lease without self-deadlock', async () => {
    const scheduler = createAuthorityEffectScheduler();
    const entered: string[] = [];
    await scheduler.run({ read: false, target: 'instance:app:one' }, async (lease) => {
      entered.push('outer');
      await scheduler.run({
        read: false, target: 'instance:app:one', parentLease: lease,
      }, () => { entered.push('nested'); });
    });
    expect(entered).toEqual(['outer', 'nested']);
  });

  test('scope-only parents drain fire-and-forget children before settlement', async () => {
    const scheduler = createAuthorityEffectScheduler();
    const childGate = deferred();
    const childEntered = deferred();
    let settled = false;
    const outer = scheduler.run({ read: false, target: 'program', scopeOnly: true }, (lease) => {
      void scheduler.run({
        read: false, target: 'page:tab:7', parentLease: lease,
      }, async () => {
        childEntered.resolve();
        await childGate.promise;
      });
      return 'outer-result';
    }).then((value) => { settled = true; return value; });
    await childEntered.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    childGate.resolve();
    expect(await outer).toBe('outer-result');
    expect(settled).toBe(true);
  });

  test('refuses a retired parent and reuses a lane after rejection', async () => {
    const scheduler = createAuthorityEffectScheduler();
    let retired: object | null = null;
    await scheduler.run({ read: false, target: 'instance:app:one' }, (lease) => {
      retired = lease;
    });
    await expect(scheduler.run({
      read: false, target: 'instance:app:one', parentLease: retired,
    }, () => {})).rejects.toThrow('authority-parent-lease-retired');
    await expect(scheduler.run({ read: false, target: 'instance:app:two' }, () => {
      throw new Error('fixture failure');
    })).rejects.toThrow('fixture failure');
    let reused = false;
    await scheduler.run({ read: false, target: 'instance:app:two' }, () => {
      reused = true;
    });
    expect(reused).toBe(true);
  });

  test('settles an abort-ignoring host unknown and poisons only its target until restart', async () => {
    const scheduler = createAuthorityEffectScheduler({ abortDrainMs: 5 });
    const controller = new AbortController();
    const hostEntered = deferred();
    const neverSettles = new Promise<void>(() => {});
    const hung = scheduler.run({
      read: false, target: 'instance:app:hung', signal: controller.signal,
    }, async () => {
      hostEntered.resolve();
      await neverSettles;
    });
    const hungOutcome = hung.catch((error) => error);
    await hostEntered.promise;
    const queued = scheduler.run({ read: false, target: 'instance:app:hung' }, () => {
      throw new Error('poisoned target must never enter a second host');
    });
    const queuedOutcome = queued.catch((error) => error);
    controller.abort();
    expect(await hungOutcome).toMatchObject({
      code: 'authority-target-poisoned', outcomeKnown: false, retryable: false,
    });
    expect(await queuedOutcome).toMatchObject({
      code: 'authority-target-poisoned', outcomeKnown: false, retryable: false,
    });
    await expect(scheduler.run({
      read: false, target: 'instance:app:hung',
    }, () => {})).rejects.toMatchObject({
      code: 'authority-target-poisoned', outcomeKnown: false, retryable: false,
    });
    let otherTargetRan = false;
    await scheduler.run({ read: false, target: 'instance:app:other' }, () => {
      otherTargetRan = true;
    });
    expect(otherTargetRan).toBe(true);
    let recoveredAfterRestart = false;
    await createAuthorityEffectScheduler().run({
      read: false, target: 'instance:app:hung',
    }, () => { recoveredAfterRestart = true; });
    expect(recoveredAfterRestart).toBe(true);
  });

  test('lets a cooperative cancelled host settle known and reuses its target lane', async () => {
    const scheduler = createAuthorityEffectScheduler({ abortDrainMs: 50 });
    const controller = new AbortController();
    const hostEntered = deferred();
    const cancelled = scheduler.run({
      read: false, target: 'instance:app:cooperative', signal: controller.signal,
    }, async () => {
      hostEntered.resolve();
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure' };
    });
    await hostEntered.promise;
    controller.abort();
    expect(await cancelled).toMatchObject({
      ok: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure',
    });
    let reused = false;
    await scheduler.run({ read: false, target: 'instance:app:cooperative' }, () => {
      reused = true;
    });
    expect(reused).toBe(true);
  });
});
