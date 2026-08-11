import { describe, test, expect } from 'bun:test';
import { makeDenylistNetGuard } from '../../extension/background/denylist-net-guard.js';
import {
  denylistSessionRuleUpdate,
  PRIVATE_NETWORK_INITIATOR_RULE_IDS,
  PRIVATE_NETWORK_RULE_IDS,
} from '../../extension/peerd-egress/denylist/dnr-rules.js';

// The imperative half of the denylist's DNR backstop: does it keep the exact
// session rule set, and does it stay harmless when the API isn't there?

const makeDnr = (opts: { fail?: () => Error | null } = {}) => {
  const calls: any[] = [];
  return {
    calls,
    updateSessionRules: async (update: any) => {
      const err = opts.fail?.();
      if (err) throw err;
      calls.push(update);
    },
  };
};

const guardOver = (dnr: any, patterns: string[], tabs: number[], audit?: any) => {
  let livePatterns = patterns;
  let liveTabs = tabs;
  const guard = makeDenylistNetGuard({
    dnr,
    buildUpdate: denylistSessionRuleUpdate,
    getPatterns: () => livePatterns,
    getTabIds: () => liveTabs,
    audit,
    console: { warn: () => {} } as any,
  });
  return {
    guard,
    setPatterns: (p: string[]) => { livePatterns = p; },
    setTabs: (t: number[]) => { liveTabs = t; },
  };
};

describe('denylist-net-guard — rule sync', () => {
  test('a driven tab gets a tab-scoped block rule', async () => {
    const dnr = makeDnr();
    const { guard } = guardOver(dnr, ['chase.com', '*.chase.com'], [12]);
    await guard.sync();
    expect(dnr.calls).toHaveLength(1);
    expect(dnr.calls[0].addRules[0].condition).toMatchObject({
      requestDomains: ['chase.com'], tabIds: [12],
    });
  });

  test('no driven tabs → the rule is removed, never left unscoped', async () => {
    const dnr = makeDnr();
    const { guard } = guardOver(dnr, ['chase.com'], []);
    await guard.sync();
    expect(dnr.calls[0].addRules).toEqual([]);
    // The three policy-owned base ids plus both private-network rule families.
    expect(dnr.calls[0].removeRuleIds).toHaveLength(3
      + PRIVATE_NETWORK_RULE_IDS.length
      + PRIVATE_NETWORK_INITIATOR_RULE_IDS.length);
  });

  test('origin changes atomically replace the no-tab worker scope', async () => {
    const dnr = makeDnr();
    let domains = ['a.example'];
    const guard = makeDenylistNetGuard({
      dnr,
      buildUpdate: denylistSessionRuleUpdate,
      getPatterns: () => [],
      getTabIds: () => [12],
      getInitiatorDomains: () => domains,
    });
    await guard.sync();
    domains = ['b.example'];
    await guard.sync();
    const workerRules = dnr.calls[1].addRules.filter((rule: any) =>
      rule.condition.tabIds?.includes(-1));
    expect(workerRules).toHaveLength(PRIVATE_NETWORK_INITIATOR_RULE_IDS.length);
    expect(workerRules.every((rule: any) =>
      JSON.stringify(rule.condition.initiatorDomains) === JSON.stringify(['b.example']))).toBe(true);
  });

  test('a repeat sync with unchanged state does not re-call the API', async () => {
    const dnr = makeDnr();
    const { guard } = guardOver(dnr, ['chase.com'], [12]);
    await guard.sync();
    await guard.sync();
    await guard.sync();
    expect(dnr.calls).toHaveLength(1);
  });

  test('a tab closing rescopes the rule', async () => {
    const dnr = makeDnr();
    const { guard, setTabs } = guardOver(dnr, ['chase.com'], [12, 13]);
    await guard.sync();
    setTabs([13]);
    await guard.sync();
    expect(dnr.calls).toHaveLength(2);
    expect(dnr.calls[1].addRules[0].condition.tabIds).toEqual([13]);
  });

  test('a denylist edit rebuilds the rule', async () => {
    const dnr = makeDnr();
    const { guard, setPatterns } = guardOver(dnr, ['chase.com'], [12]);
    await guard.sync();
    setPatterns(['chase.com', 'irs.gov']);
    await guard.sync();
    expect(dnr.calls[1].addRules[0].condition.requestDomains).toEqual(['chase.com', 'irs.gov']);
  });

  test('un-denylisting the last pattern removes the rule', async () => {
    const dnr = makeDnr();
    const { guard, setPatterns } = guardOver(dnr, ['chase.com'], [12]);
    await guard.sync();
    setPatterns([]);
    await guard.sync();
    expect(dnr.calls[1].addRules).toHaveLength(PRIVATE_NETWORK_RULE_IDS.length);
    expect(dnr.calls[1].addRules.every((rule: any) => rule.action.type === 'block')).toBe(true);
  });

  test('concurrent syncs never overlap on the owned rule set', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: any[] = [];
    const dnr = {
      updateSessionRules: async (u: any) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        calls.push(u);
        inFlight -= 1;
      },
    };
    const { guard, setTabs } = guardOver(dnr, ['chase.com'], [1]);
    const first = guard.sync();
    await new Promise((r) => setTimeout(r, 0));   // let the first apply get going
    setTabs([2]);
    const second = guard.sync();
    await Promise.all([first, second]);
    expect(maxInFlight).toBe(1);
    expect(calls.map((c) => c.addRules[0].condition.tabIds)).toEqual([[1], [2]]);
  });

  test('syncs that queue before the first runs COALESCE (state is read at apply time)', async () => {
    const dnr = makeDnr();
    const { guard, setTabs } = guardOver(dnr, ['chase.com'], [1]);
    const first = guard.sync();
    setTabs([2]);                                  // changed before any apply ran
    const second = guard.sync();
    await Promise.all([first, second]);
    // Both applies see the same (final) state, so only one write reaches the API.
    expect(dnr.calls).toHaveLength(1);
    expect(dnr.calls[0].addRules[0].condition.tabIds).toEqual([2]);
  });

  test('boot-deferred sync preserves existing rules until custody hydration finishes', async () => {
    const dnr = makeDnr();
    let tabs = [1];
    const guard = makeDenylistNetGuard({
      dnr,
      buildUpdate: denylistSessionRuleUpdate,
      getPatterns: () => ['chase.com'],
      getTabIds: () => tabs,
      deferUntilStarted: true,
    });
    const pending = guard.sync();
    await Promise.resolve();
    expect(dnr.calls).toEqual([]);
    tabs = [7, 9];
    await guard.start();
    await pending;
    expect(dnr.calls).toHaveLength(1);
    expect(dnr.calls[0].addRules[0].condition.tabIds).toEqual([7, 9]);
  });

  test('failed boot hydration preserves surviving rules and settles queued callers', async () => {
    const updates: unknown[] = [];
    const guard = makeDenylistNetGuard({
      dnr: { updateSessionRules: async (update: unknown) => { updates.push(update); } },
      getPatterns: () => ['blocked.example'],
      getTabIds: () => [],
      buildUpdate: ({ tabIds }) => ({
        removeRuleIds: [1],
        addRules: tabIds.length ? [{ id: 1, priority: 1, condition: { tabIds } }] : [],
      }),
      deferUntilStarted: true,
    });

    const queued = guard.sync();
    await guard.start({ ok: false, error: 'web_bindings_hydration_failed' });
    await queued;

    expect(updates).toEqual([]);
    expect(guard.state().startupError).toBe('web_bindings_hydration_failed');
    expect(guard.state().lastError).toBe('web_bindings_hydration_failed');
    await guard.sync();
    expect(updates).toEqual([]);
  });
});

describe('denylist-net-guard — degrades, never breaks', () => {
  test('no declarativeNetRequest API → a silent no-op that still resolves', async () => {
    const { guard } = guardOver(undefined, ['chase.com'], [12]);
    expect(guard.supported()).toBe(false);
    await guard.sync();               // must not reject
    expect(guard.state().domains).toBe(0);
  });

  test('an API failure is swallowed, audited once, and retried on the next sync', async () => {
    const audited: any[] = [];
    let failing = true;
    const dnr = makeDnr({ fail: () => (failing ? new Error('tabIds unsupported') : null) });
    const { guard } = guardOver(dnr, ['chase.com'], [12], (e: any) => audited.push(e));
    await guard.sync();
    await guard.sync();
    expect(audited).toHaveLength(1);
    expect(audited[0].type).toBe('denylist_net_guard_failed');
    expect(guard.state().lastError).toContain('tabIds');
    // The failure did NOT latch the fingerprint, so a later sync re-attempts.
    failing = false;
    await guard.sync();
    expect(dnr.calls).toHaveLength(1);
    expect(guard.state().lastError).toBeNull();
  });

  test('a throwing audit sink cannot break the guard', async () => {
    const dnr = makeDnr({ fail: () => new Error('nope') });
    const { guard } = guardOver(dnr, ['chase.com'], [12], () => { throw new Error('audit down'); });
    await guard.sync();               // must not reject
    expect(guard.state().lastError).toBe('nope');
  });

  test('a custody projection failure closes page actions until a successful sync', async () => {
    const dnr = makeDnr();
    const { guard } = guardOver(dnr, [], [12]);
    guard.fail(new Error('origin persistence failed'));
    expect(guard.state().lastError).toBe('origin persistence failed');
    await guard.sync();
    expect(guard.state().lastError).toBe('origin persistence failed');
    guard.recover();
    await guard.sync();
    expect(guard.state().lastError).toBeNull();
    expect(dnr.calls).toHaveLength(2);
  });
});
