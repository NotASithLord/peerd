// issue 251 — the origin lock's imperative shell: does the pure rule actually
// bind to a live actor, and does what changed get persisted?
//
// The pure policy is tested next door. What is testable ONLY here is the
// plumbing, and the plumbing is where this class of feature dies: a rule that
// decides correctly but whose verdict is never written back is a rule that does
// nothing on the second call.

import { describe, test, expect } from 'bun:test';
import {
  makeJudgeLanding,
  makeSignInOriginAuthorizer,
} from '../../../extension/peerd-runtime/actor/origin-lock.js';

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

  test('an identity provider ends without suggesting a standalone successor', async () => {
    const isIdp = (origin: string) => origin.startsWith('https://idp.test');
    const { judge, stops } = harness({ mode: 'roaming' }, {
      isIdp,
      isKnownIdp: isIdp,
    });
    expect((await judge('https://idp.test/login'))?.action).toBe('end');
    expect(stops[0].handoffTo).toBeUndefined();
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
  const idp = {
    isIdp: (u: string) => u.startsWith('https://idp.test'),
    isKnownIdp: (u: string) => u.startsWith('https://idp.test'),
  };

  test('opening one persists it AND increments the lifetime counter', async () => {
    const state: any = { mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 0 };
    const { judge, saved } = harness(state, idp);
    await judge('https://idp.test/authorize');
    expect(saved[0].excursion).toBeTruthy();
    expect(saved[0].excursionsUsed).toBe(1);
  });

  test('the IdP being sensitive does not break a bound sign-in excursion', async () => {
    const state: any = { mode: 'bound', ownedOrigin: 'https://app.test', excursionsUsed: 0 };
    const { judge, stops } = harness(state, idp);
    expect((await judge('https://idp.test/authorize'))?.action).toBe('continue');
    expect((await judge('https://idp.test/login'))?.action).toBe('continue');
    expect(stops).toEqual([]);
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

describe('provisional origins — the shell half', () => {
  test('a www-fold adoption is WRITTEN BACK even though ownedOrigin was already set', async () => {
    // The adopt guard used to be `!state.ownedOrigin`, which silently dropped
    // this second adopt case: the rule agreed to continue while the state kept
    // pointing at the origin the site had just redirected away from — the same
    // dead end, one step later.
    const state: any = { mode: 'bound', ownedOrigin: 'https://reddit.com', provisional: true };
    const { judge, saved } = harness(state);
    const v = await judge('https://www.reddit.com/r/x');
    expect(v?.action).toBe('continue');
    expect(saved[0].ownedOrigin).toBe('https://www.reddit.com');
    expect(state.ownedOrigin).toBe('https://www.reddit.com');
  });

  test('a real landing CLEARS provisional, so the allowance is once-only', async () => {
    const state: any = { mode: 'bound', ownedOrigin: 'https://app.test', provisional: true };
    const { judge } = harness(state);
    await judge('https://app.test/start');
    expect(state.provisional).toBe(false);
    // …and a later redirect elsewhere now ends, as a settled bound actor should.
    const v = await judge('https://www.app.test/x');
    expect(v?.action).toBe('end');
  });

  test("'no page loaded' does NOT consume the allowance", async () => {
    // A blank tab mid-load is not a landing. Spending the one-shot allowance on
    // it would end the actor on the redirect that follows.
    const state: any = { mode: 'bound', ownedOrigin: 'https://reddit.com', provisional: true };
    const { judge } = harness(state);
    await judge('about:blank');
    expect(state.provisional).toBe(true);
    expect((await judge('https://www.reddit.com/'))?.action).toBe('continue');
  });
});

describe('confirmed sign-in promotion', () => {
  const build = (over: any = {}) => {
    let state: any = over.state ?? { mode: 'roaming' };
    const saved: any[] = [];
    const bound: string[] = [];
    const authorize = makeSignInOriginAuthorizer({
      getState: () => state,
      getLiveLanding: over.getLiveLanding ?? (async () => ({ status: 'live', url: 'https://app.test/login' })),
      saveState: (patch) => { saved.push(patch); Object.assign(state, patch); },
      isKnownIdp: (origin) => new URL(origin).hostname.replace(/\.$/, '') === 'accounts.google.com',
      isCurrent: over.isCurrent ?? (() => true),
      onBound: (origin) => { bound.push(origin); },
    });
    return { authorize, saved, bound, setState: (next: any) => { state = next; } };
  };

  test('a live roaming relying site becomes the exact bound origin', async () => {
    const { authorize, saved, bound } = build();
    expect(await authorize('HTTPS://APP.TEST:443/login')).toBe(true);
    expect(saved).toEqual([{
      mode: 'bound', ownedOrigin: 'https://app.test', provisional: false, excursion: null,
    }]);
    expect(bound).toEqual(['https://app.test']);
  });

  test('an existing same-origin bound actor is idempotent', async () => {
    const { authorize, saved, bound } = build({ state: { mode: 'bound', ownedOrigin: 'https://app.test' } });
    expect(await authorize('https://app.test')).toBe(true);
    expect(saved).toEqual([]);
    expect(bound).toEqual([]);
  });

  test('identity-provider, insecure, mismatched, unreadable, and stale turns refuse', async () => {
    for (const origin of [
      'https://accounts.google.com',
      'https://accounts.google.com:8443',
      'https://accounts.google.com.',
      'http://app.test',
    ]) {
      const { authorize, saved } = build();
      expect(await authorize(origin)).toBe(false);
      expect(saved).toEqual([]);
    }
    for (const getLiveLanding of [
      async () => ({ status: 'none' as const }),
      async () => ({ status: 'unreadable' as const }),
      async () => ({ status: 'live' as const, url: 'https://other.test' }),
    ]) {
      const { authorize, saved } = build({ getLiveLanding });
      expect(await authorize('https://app.test')).toBe(false);
      expect(saved).toEqual([]);
    }
    const stale = build({ isCurrent: () => false });
    expect(await stale.authorize('https://app.test')).toBe(false);
    expect(stale.saved).toEqual([]);
  });

  test('state is re-read after the live tab lookup', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const h = build({ getLiveLanding: async () => { await wait; return { status: 'live', url: 'https://app.test' }; } });
    const pending = h.authorize('https://app.test');
    h.setState({ mode: 'bound', ownedOrigin: 'https://other.test' });
    release();
    expect(await pending).toBe(false);
    expect(h.saved).toEqual([]);
  });

  test('cancellation during the live lookup cannot persist authority', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const h = build({ getLiveLanding: async () => { await wait; return { status: 'live', url: 'https://app.test' }; } });
    const pending = h.authorize('https://app.test', controller.signal);
    controller.abort();
    release();
    expect(await pending).toBe(false);
    expect(h.saved).toEqual([]);
    expect(h.bound).toEqual([]);
  });

  test('an audit failure cannot turn a completed promotion into a tool failure', async () => {
    const state: any = { mode: 'roaming' };
    const saved: any[] = [];
    const authorize = makeSignInOriginAuthorizer({
      getState: () => state,
      getLiveLanding: async () => ({ status: 'live', url: 'https://app.test' }),
      saveState: (patch) => { saved.push(patch); Object.assign(state, patch); },
      onBound: async () => { throw new Error('audit unavailable'); },
    });
    expect(await authorize('https://app.test')).toBe(true);
    expect(saved.length).toBe(1);
    expect(state.ownedOrigin).toBe('https://app.test');
  });
});
