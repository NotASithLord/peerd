// issue 251 — the origin lock's imperative shell: does the pure rule actually
// bind to a live actor, and does what changed get persisted?
//
// The pure policy is tested next door. What is testable ONLY here is the
// plumbing, and the plumbing is where this class of feature dies: a rule that
// decides correctly but whose verdict is never written back is a rule that does
// nothing on the second call.

import { describe, test, expect } from 'bun:test';
import { makeJudgeLanding } from '../../../extension/peerd-runtime/actor/origin-lock.js';

const harness = (state: any, deps: any = {}) => {
  const saved: any[] = [];
  const stops: any[] = [];
  const judge = makeJudgeLanding({
    getState: () => state,
    saveState: (p) => { saved.push(p); Object.assign(state ?? {}, p); },
    onStop: (e) => { stops.push(e); },
    now: () => 1_000,
    ...deps,
  });
  return { judge, saved, stops };
};

describe('the lock applies only where a state says it should', () => {
  test('no state means no lock — the orchestrator and engine kinds pass through', () => {
    // This runs on EVERY DOM tool call. Failing closed here would refuse the
    // orchestrator's own tools and every engine kind, i.e. break the product.
    // Which contexts get a state is decided once, in the SW.
    const { judge, stops } = harness(null);
    return judge('https://anywhere.test').then((v) => {
      expect(v).toBeNull();
      expect(stops).toEqual([]);
    });
  });
});

describe('roaming', () => {
  test('an ordinary page continues and nothing is stopped', async () => {
    const { judge, stops } = harness({ mode: 'roaming' });
    expect((await judge('https://blog.test'))?.action).toBe('continue');
    expect(stops).toEqual([]);
  });

  test('a credentialed site stops the actor and names the successor', async () => {
    const { judge, stops } = harness({ mode: 'roaming' }, { isUgcZone: (o: string) => o === 'https://github.com' });
    const v = await judge('https://github.com/acme/x/issues/1');
    expect(v?.action).toBe('handoff');
    expect(stops[0].handoffTo).toBe('https://github.com');
    expect(stops[0].to).toBe('https://github.com/acme/x/issues/1');
  });

  test('the stop event carries NO actor-authored text', async () => {
    // The handoff must not become a channel. If a hijacked roaming actor could
    // write the goal for its successor, the segmentation is decorative — the
    // orchestrator re-authors, and this event is only a fact report.
    const { judge, stops } = harness({ mode: 'roaming' }, { hasVaultSecret: () => true });
    await judge('https://bank.test/transfer');
    expect(Object.keys(stops[0]).sort()).toEqual(['action', 'from', 'handoffTo', 'reason', 'to']);
  });
});

describe('bound — persistence is the point', () => {
  test('the first landing is ADOPTED and written back', async () => {
    const state: any = { mode: 'bound', ownedOrigin: null };
    const { judge, saved } = harness(state);
    await judge('https://app.test/start');
    expect(saved[0].ownedOrigin).toBe('https://app.test');
    expect(state.ownedOrigin).toBe('https://app.test');
  });

  test('an adopted origin is not re-adopted on a later landing', async () => {
    const state: any = { mode: 'bound', ownedOrigin: 'https://app.test' };
    const { judge, saved } = harness(state);
    await judge('https://app.test/other');
    expect(saved[0].ownedOrigin).toBeUndefined();
  });

  test('leaving the owned origin stops the actor', async () => {
    const { judge, stops } = harness({ mode: 'bound', ownedOrigin: 'https://app.test' });
    const v = await judge('https://evil.test/x');
    expect(v?.action).toBe('end');
    expect(stops[0].from).toBe('https://app.test');
    expect(stops[0].handoffTo).toBeUndefined();   // no successor implied
  });
});

describe('excursions — the state that must survive', () => {
  const idp = { isIdp: (u: string) => u.startsWith('https://idp.test') };

  test('opening one persists it AND increments the lifetime counter', async () => {
    const state: any = { mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 0 };
    const { judge, saved } = harness(state, idp);
    await judge('https://idp.test/authorize');
    expect(saved[0].excursion).toBeTruthy();
    expect(saved[0].excursionsUsed).toBe(1);
  });

  test('a discharge CLEARS the corridor but NOT the counter', async () => {
    // This pairing is the whole anti-refresh property. Clearing the counter
    // alongside the corridor would let a hostile page loop home → IdP → hops →
    // home and buy a fresh budget every two navigations: bounded per leg,
    // unbounded per task.
    const state: any = {
      mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 1,
      excursion: { returnTo: 'https://app.test', openedAt: 'https://idp.test', lastLanding: 'https://idp.test', budget: 2, deadline: 9e9 },
    };
    const { judge, saved } = harness(state, idp);
    await judge('https://app.test/back');
    expect(saved[0].excursion).toBeNull();          // cleared, explicitly
    expect(saved[0].excursionsUsed).toBeUndefined(); // untouched
    expect(state.excursionsUsed).toBe(1);
  });

  test('the excursion is always ASSIGNED, never coalesced', async () => {
    // The rule's contract is that an absent field means "cleared". A shell that
    // wrote `verdict.excursion ?? stored` would keep a spent corridor alive
    // forever — the exact footgun the typedef warns about.
    const state: any = { mode: 'bound', ownedOrigin: 'https://app.test' };
    const { judge, saved } = harness(state);
    await judge('https://app.test/x');
    expect('excursion' in saved[0]).toBe(true);
    expect(saved[0].excursion).toBeNull();
  });
});
