import { describe, expect, test } from 'bun:test';
import { createKernelBrowserChildOutcomes } from '../../extension/background/kernel-browser-child-outcomes.js';
import { makeDrivenChildRequestGuard } from '../../extension/background/driven-child-request-guard.js';
import { createKernelTabCustody } from '../../extension/background/kernel-tab-events.js';

describe('kernel browser child outcomes', () => {
  test('binds blocked and unverified child lineage to the exact source action', async () => {
    const audit: any[] = [];
    const blanks: number[] = [];
    const owner = createKernelBrowserChildOutcomes({
      audit: async (entry) => { audit.push(entry); },
      noteBlank: (tabId) => { blanks.push(tabId); },
    });
    const blockedToken = owner.begin(7, 8);
    const failedToken = owner.begin(7, 9);
    owner.recordBlocked({
      sourceTabId: 7, tabId: 8, reason: 'private_network', child: 'closed',
      guarded: true, outcome: 'not_run', flowToken: blockedToken,
    });
    owner.recordFailed({
      sourceTabId: 7, tabId: 9, reason: 'child_guard_failed',
      child: 'left_blank', guarded: false, flowToken: failedToken,
    });

    expect(owner.has(7)).toBe(true);
    expect(owner.has(8)).toBe(false);
    expect(owner.consume(8)).toEqual([]);
    expect(owner.consume(7)).toEqual([
      {
        reason: 'protected_child_navigation', outcome: 'not_run',
        child: 'closed', retryable: false,
      },
      {
        reason: 'child_navigation_failed', outcome: 'unverified',
        child: 'left_blank', retryable: false,
      },
    ]);
    await Promise.resolve();
    expect(audit.map((entry) => entry.type)).toEqual([
      'browser_child_navigation_blocked', 'browser_child_navigation_failed',
    ]);
    expect(blanks).toEqual([9]);
  });

  test('reserves an action before a delayed child event and waits only for that generation', async () => {
    const owner = createKernelBrowserChildOutcomes({});
    const action = owner.reserveAction(7);
    expect(typeof action).toBe('symbol');
    const onset = owner.waitAction(7, action!, 50);
    await Promise.resolve();
    const child = owner.begin(7, 8, Symbol('delayed-child'));
    expect(await onset).toBe(true);
    owner.recordBlocked({
      sourceTabId: 7, tabId: 8, reason: 'private_network', child: 'closed',
      guarded: true, outcome: 'not_run', flowToken: child,
    });
    owner.settle(7, 8, child);
    expect(await owner.waitAction(7, action!, 50, true)).toBe(true);
    expect(owner.consumeAction(7, action!)).toEqual([{
      reason: 'protected_child_navigation', outcome: 'not_run',
      child: 'closed', retryable: false,
    }]);
    expect(owner.releaseAction(7, action!)).toBe(true);
  });

  test('duplicate events preserve the original action through its final settlement', async () => {
    const owner = createKernelBrowserChildOutcomes({});
    const action = owner.reserveAction(7)!;
    const child = Symbol('duplicate-child');
    owner.begin(7, 8, child);
    owner.begin(7, 8, child);
    owner.settle(7, 8, child);
    owner.recordBlocked({
      sourceTabId: 7, tabId: 8, reason: 'private_network', child: 'closed',
      guarded: true, outcome: 'not_run', flowToken: child,
    });
    expect(owner.consumeAction(7, action)).toEqual([{
      reason: 'protected_child_navigation', outcome: 'not_run',
      child: 'closed', retryable: false,
    }]);
    expect(owner.consume(7)).toEqual([]);

    let terminalSettled = false;
    const terminal = owner.waitAction(7, action, 50, true)
      .then((settled) => { terminalSettled = true; return settled; });
    await Promise.resolve();
    expect(terminalSettled).toBe(false);
    owner.settle(7, 8, child);
    expect(await terminal).toBe(true);
    expect(owner.releaseAction(7, action)).toBe(true);
  });

  test('a pre-reservation generation is never rebound by a duplicate event', async () => {
    const owner = createKernelBrowserChildOutcomes({});
    const child = owner.begin(7, 8, Symbol('pre-reservation-child'));
    const action = owner.reserveAction(7)!;
    owner.begin(7, 8, child);
    expect(await owner.waitAction(7, action, 0)).toBe(false);
    owner.recordBlocked({
      sourceTabId: 7, tabId: 8, reason: 'private_network', child: 'closed',
      guarded: true, outcome: 'not_run', flowToken: child,
    });
    owner.settle(7, 8, child);
    owner.settle(7, 8, child);
    expect(owner.consumeAction(7, action)).toEqual([]);
    expect(owner.consume(7)).toEqual([{
      reason: 'protected_child_navigation', outcome: 'not_run',
      child: 'closed', retryable: false,
    }]);
    expect(owner.releaseAction(7, action)).toBe(true);
  });

  test('a fully settled pre-reservation generation cannot be rebound to a later action', async () => {
    const owner = createKernelBrowserChildOutcomes({});
    const child = owner.begin(7, 8, Symbol('settled-before-reservation'));
    owner.settle(7, 8, child);

    const action = owner.reserveAction(7)!;
    owner.begin(7, 8, child);
    owner.recordBlocked({
      sourceTabId: 7, tabId: 8, reason: 'private_network', child: 'closed',
      guarded: true, outcome: 'not_run', flowToken: child,
    });
    owner.settle(7, 8, child);

    expect(owner.consumeAction(7, action)).toEqual([]);
    expect(owner.consume(7)).toEqual([{
      reason: 'protected_child_navigation', outcome: 'not_run',
      child: 'closed', retryable: false,
    }]);
    expect(await owner.waitAction(7, action, 0)).toBe(false);
    expect(owner.releaseAction(7, action)).toBe(true);
  });

  test('generation replacement and tab release retire the bounded tombstone', () => {
    const owner = createKernelBrowserChildOutcomes({});
    const stale = owner.begin(7, 8, Symbol('stale-generation'));
    owner.settle(7, 8, stale);
    const action = owner.reserveAction(7)!;
    const current = owner.begin(7, 8, Symbol('replacement-generation'));
    owner.recordBlocked({
      sourceTabId: 7, tabId: 8, reason: 'private_network', child: 'closed',
      guarded: true, outcome: 'not_run', flowToken: current,
    });
    owner.settle(7, 8, current);
    expect(owner.consumeAction(7, action)).toHaveLength(1);
    owner.release(8);
    owner.recordBlocked({
      sourceTabId: 7, tabId: 8, reason: 'late', child: 'closed',
      guarded: true, outcome: 'not_run', flowToken: current,
    });
    expect(owner.consumeAction(7, action)).toEqual([]);
    expect(owner.releaseAction(7, action)).toBe(true);
  });

  test('terminal action custody waits for every child even after an early notice', async () => {
    const owner = createKernelBrowserChildOutcomes({});
    const action = owner.reserveAction(7)!;
    const first = owner.begin(7, 8, Symbol('first-child'));
    const second = owner.begin(7, 9, Symbol('second-child'));
    owner.recordBlocked({
      sourceTabId: 7, tabId: 8, reason: 'private_network', child: 'closed',
      guarded: true, outcome: 'not_run', flowToken: first,
    });
    owner.settle(7, 8, first);

    let terminalSettled = false;
    const terminal = owner.waitAction(7, action, 50, true)
      .then((settled) => { terminalSettled = true; return settled; });
    await Promise.resolve();
    expect(terminalSettled).toBe(false);
    owner.recordFailed({
      sourceTabId: 7, tabId: 9, reason: 'child_guard_failed',
      child: 'left_blank', guarded: false, flowToken: second,
    });
    owner.settle(7, 9, second);
    expect(await terminal).toBe(true);
    expect(owner.consumeAction(7, action)).toEqual([
      {
        reason: 'protected_child_navigation', outcome: 'not_run',
        child: 'closed', retryable: false,
      },
      {
        reason: 'child_navigation_failed', outcome: 'unverified',
        child: 'left_blank', retryable: false,
      },
    ]);
    expect(owner.releaseAction(7, action)).toBe(true);
  });

  test('same-tab actions serialize while different source tabs remain independent', () => {
    const owner = createKernelBrowserChildOutcomes({});
    const first = owner.reserveAction(7)!;
    expect(owner.reserveAction(7)).toBeNull();
    const independent = owner.reserveAction(8)!;
    expect(typeof independent).toBe('symbol');
    expect(owner.releaseAction(7, first)).toBe(true);
    const successor = owner.reserveAction(7)!;
    expect(typeof successor).toBe('symbol');
    expect(owner.releaseAction(7, successor)).toBe(true);
    expect(owner.releaseAction(8, independent)).toBe(true);
  });

  test('an action with no child takes only its onset path and leaves no synthetic receipt', async () => {
    const owner = createKernelBrowserChildOutcomes({});
    const action = owner.reserveAction(7)!;
    expect(await owner.waitAction(7, action, 1)).toBe(false);
    expect(await owner.waitAction(7, action, 5, true)).toBe(false);
    expect(owner.consumeAction(7, action)).toEqual([]);
    expect(owner.releaseAction(7, action)).toBe(true);
  });

  test('Stop releases an exact action without fabricating a browser outcome', async () => {
    const owner = createKernelBrowserChildOutcomes({});
    const action = owner.reserveAction(7)!;
    const controller = new AbortController();
    const waiting = owner.waitAction(7, action, 5_000, false, controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
    expect(owner.consumeAction(7, action)).toEqual([]);
    owner.releaseAction(7, action);
    expect(typeof owner.reserveAction(7)).toBe('symbol');
  });

  test('a retired action generation cannot write into its successor', () => {
    const owner = createKernelBrowserChildOutcomes({});
    const first = owner.reserveAction(7)!;
    const oldChild = owner.begin(7, 8, Symbol('old-child'));
    owner.releaseAction(7, first);
    const next = owner.reserveAction(7)!;
    owner.recordBlocked({
      sourceTabId: 7, tabId: 8, reason: 'late-old-flow', child: 'closed',
      guarded: true, outcome: 'not_run', flowToken: oldChild,
    });
    expect(owner.consumeAction(7, next)).toEqual([]);
    owner.releaseAction(7, next);
  });

  test('wakes only the exact source and records Firefox request blocks', async () => {
    const owner = createKernelBrowserChildOutcomes({});
    const exact = owner.wait(3, 50);
    const unrelated = owner.wait(4, 0);
    const token = owner.begin(3, 5);
    owner.recordRequestBlocked({
      sourceTabId: 3, tabId: 5, reason: 'cloud_metadata', flowToken: token,
    });
    expect(await exact).toBe(true);
    expect(await unrelated).toBe(false);
    expect(owner.consume(3)).toEqual([{
      reason: 'protected_child_request', outcome: 'not_run',
      child: 'guarded', retryable: false,
    }]);
  });

  test('bounds hostile queues and clears closed source state', () => {
    const owner = createKernelBrowserChildOutcomes({});
    for (let index = 0; index < 64; index += 1) {
      const token = owner.begin(1, index + 2);
      owner.recordRequestBlocked({
        sourceTabId: 1, tabId: index + 2, reason: 'private_network', flowToken: token,
      });
    }
    expect(owner.consume(1)).toHaveLength(32);
    owner.recordRequestBlocked({
      sourceTabId: 1, tabId: 2, reason: 'private_network', flowToken: Symbol('rejected'),
    });
    owner.release(1);
    expect(owner.has(1)).toBe(false);
  });

  test('keeps a slow child flow on its source action and suppresses late reassignment', async () => {
    const owner = createKernelBrowserChildOutcomes({});
    const token = Symbol('first');
    owner.begin(7, 8, token);
    owner.begin(7, 8, token);
    expect(owner.has(7)).toBe(true);
    expect(await owner.wait(7, 1)).toBe(false);
    owner.settle(7, 8, token);
    expect(owner.has(7)).toBe(true);
    expect(await owner.wait(7, 1, true)).toBe(true);
    expect(owner.consume(7)).toEqual([{
      reason: 'child_navigation_unverified', outcome: 'unverified',
      child: 'uncontained', retryable: false,
    }]);
    owner.recordBlocked({
      sourceTabId: 7, tabId: 8, reason: 'private_network',
      child: 'closed', guarded: true, outcome: 'not_run', flowToken: token,
    });
    owner.settle(7, 8, token);
    expect(owner.consume(7)).toEqual([]);
  });

  test('rejects a timed-out flow outcome after numeric child id reuse', async () => {
    const owner = createKernelBrowserChildOutcomes({});
    const oldToken = Symbol('old');
    const nextToken = Symbol('next');
    owner.begin(7, 8, oldToken);
    expect(await owner.wait(7, 1, true)).toBe(true);
    expect(owner.consume(7)).toHaveLength(1);

    owner.begin(9, 8, nextToken);
    owner.recordFailed({
      sourceTabId: 7, tabId: 8, reason: 'late-old-flow', child: 'closed',
      guarded: false, flowToken: oldToken,
    });
    owner.settle(9, 8, nextToken);
    expect(owner.consume(7)).toEqual([]);
    expect(owner.consume(9)).toEqual([]);
  });

  test('reports a contained authority timeout as guarded and retryable', async () => {
    const owner = createKernelBrowserChildOutcomes({});
    const token = Symbol('guarded');
    owner.begin(7, 8, token);
    owner.contain(7, 8, token);
    expect(await owner.wait(7, 1, true)).toBe(true);
    expect(owner.consume(7)).toEqual([{
      reason: 'child_authority_unavailable', outcome: 'unverified',
      child: 'guarded', retryable: true,
    }]);
    owner.recordFailed({
      sourceTabId: 7, tabId: 8, reason: 'late', child: 'guarded',
      guarded: true, flowToken: token,
    });
    expect(owner.consume(7)).toEqual([]);
  });

  test('keeps Firefox request receipts exact across numeric child id reuse', async () => {
    const outcomes = createKernelBrowserChildOutcomes({});
    let token = Symbol('old');
    const network = {
      flowToken: () => token,
      onNavigationTarget: async (details: any) => {
        outcomes.begin(details.sourceTabId, details.tabId, details.flowToken);
        outcomes.settle(details.sourceTabId, details.tabId, details.flowToken);
        return true;
      },
      onRemoved: async (tabId: number) => { outcomes.release(tabId); return true; },
    };
    const child = makeDrivenChildRequestGuard({
      isDrivenSource: () => true,
      classifyTarget: (url) => ({ allowed: !url.includes('127.0.0.1'),
        ...url.includes('127.0.0.1') ? { reason: 'private_network' } : {} }),
      onBlocked: outcomes.recordRequestBlocked,
    });
    const custody = createKernelTabCustody({
      firefox: true, browser: { tabs: { query: async () => [] } }, network, child,
      getRelays: () => ({ eventOwners: {
        onNavigationTarget: async () => {}, onRemoved: async () => {},
      } }),
    });
    await custody.onNavigationTarget({ sourceTabId: 7, tabId: 8 });
    await custody.onRemoved(8, {});
    token = Symbol('new');
    await custody.onNavigationTarget({ sourceTabId: 9, tabId: 8 });
    expect(custody.onBeforeRequest({
      tabId: 8, url: 'http://127.0.0.1/', type: 'main_frame',
    })).toEqual({ cancel: true });
    outcomes.recordRequestBlocked({
      sourceTabId: 7, tabId: 8, reason: 'late', flowToken: Symbol('old'),
    });
    expect(outcomes.consume(7)).toEqual([]);
    expect(outcomes.consume(9)).toEqual([{
      reason: 'protected_child_request', outcome: 'not_run',
      child: 'guarded', retryable: false,
    }]);
  });

  test('retires hostile generation churn without reopening a reused tab id', () => {
    const owner = createKernelBrowserChildOutcomes({});
    let stale = Symbol('stale');
    for (let index = 0; index < 10_000; index += 1) {
      stale = Symbol(`stale:${index}`);
      owner.begin(1, 2, stale);
      owner.release(2);
    }
    const current = Symbol('current');
    owner.begin(3, 2, current);
    owner.recordBlocked({
      sourceTabId: 1, tabId: 2, reason: 'late', child: 'closed',
      guarded: true, outcome: 'not_run', flowToken: stale,
    });
    owner.recordBlocked({
      sourceTabId: 3, tabId: 2, reason: 'private_network', child: 'closed',
      guarded: true, outcome: 'not_run', flowToken: current,
    });
    expect(owner.consume(1)).toEqual([]);
    expect(owner.consume(3)).toHaveLength(1);
  });
});
