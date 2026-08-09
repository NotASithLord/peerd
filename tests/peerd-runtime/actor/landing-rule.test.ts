// issue 251 — the landing rule. What happens when a web actor's tab is
// somewhere.
//
// The property this file exists to pin, and the reason the rule is shaped the
// way it is: it judges WHERE THE TAB IS, never what was asked for. An
// args.url check catches only a navigation the actor made, and is defeated by
// any 302 — which is not theoretical, because navigate.js re-stamps the pin to
// the landing origin, laundering an open redirect into an owned one. Every
// test below therefore describes a LANDING, with no reference to how the tab
// got there, because the rule genuinely cannot tell and must not need to.

import { describe, test, expect } from 'bun:test';
import { decideLanding, EXCURSION_BUDGET, EXCURSION_MS, MAX_EXCURSIONS } from '../../../extension/peerd-runtime/actor/landing-rule.js';

const OWNED = 'https://app.test';
const bound = (over: any = {}) => decideLanding({ mode: 'bound', ownedOrigin: OWNED, landingIsSensitive: false, now: 1_000, ...over });
const roaming = (over: any = {}) => decideLanding({ mode: 'roaming', landingIsSensitive: false, ...over });

describe('roaming — the no-entry rule', () => {
  test('an ordinary page is fine; browsing is the whole point of roaming', () => {
    expect(roaming({ landing: 'https://blog.test/post' }).action).toBe('continue');
  });

  test('a credentialed site is REFUSED and handed off', () => {
    // The core of #251. A roaming actor holds no authority and must not
    // acquire any by walking into a site where the user has an identity.
    // Note what this is NOT: a confirm. An earlier draft let the actor in and
    // leaned on #242's prompt, which makes user attention the boundary.
    const v = roaming({ landing: 'https://github.com/acme/x', landingIsSensitive: true });
    expect(v.action).toBe('handoff');
    expect(v.handoffTo).toBe('https://github.com');
  });

  test('the handoff names the successor origin, normalized', () => {
    // The orchestrator routes on this value, so a path or a port must not ride along.
    expect(roaming({ landing: 'HTTPS://GitHub.com:443/a?b=c', landingIsSensitive: true }).handoffTo)
      .toBe('https://github.com');
  });

  test('a roaming actor has no owned origin to leave, so nothing else can end it', () => {
    const v = roaming({ landing: 'https://elsewhere.test', ownedOrigin: OWNED });
    expect(v.action).toBe('continue');
  });
});

describe('bound — the origin lock', () => {
  test('on its own site it continues', () => {
    expect(bound({ landing: `${OWNED}/deep/page` }).action).toBe('continue');
  });

  test('off its own site it ENDS — regardless of how it got there', () => {
    const v = bound({ landing: 'https://evil.test/x' });
    expect(v.action).toBe('end');
  });

  test('an off-origin landing ends it even when the destination looks harmless', () => {
    // The rule is about leaving, not about the destination's reputation.
    // A benign-looking open-redirect target is the whole attack.
    expect(bound({ landing: 'https://cdn.test/asset' }).action).toBe('end');
  });

  test('the FIRST landing defines what it owns', () => {
    // A bound actor starts on a blank tab and cannot know its origin before
    // arriving — same as an API actor, whose origin is fixed at mint.
    const v = decideLanding({ mode: 'bound', ownedOrigin: null, landing: 'https://app.test', landingIsSensitive: true });
    expect(v.action).toBe('continue');
  });

  test('a blank/unusable location is not a violation', () => {
    // Transient (a tab mid-load, about:blank). Ending an actor over it would
    // be a self-inflicted flake; the caller's null-tab handling owns this.
    for (const l of ['about:blank', '', 'chrome-extension://x/p.html', 'data:text/html,hi', 'javascript:0']) {
      expect(bound({ landing: l }).action).toBe('continue');
    }
  });

  // REGRESSION, and it was the worst bug in the first draft of this file.
  // normalizeApiOrigin's host rule exists so an ADDRESSED origin can't collide
  // with the literal 'web' or a numeric tabId — it is not a "where is this tab"
  // predicate. Reusing it as one folded every host below into "no page loaded"
  // and told a bound actor to CONTINUE on an attacker-controlled page. These all
  // load fine in a browser.
  test.each([
    ['https://evil.com./pwn'],        // trailing-dot FQDN
    ['http://192.168.1.9/admin'],     // IPv4 literal
    ['https://[2001:db8::1]/'],       // IPv6 literal
    ['http://localhost:8888/lab'],    // loopback
    ['https://intranet/'],            // single-label intranet host
    ['https://evil_x.com/'],          // underscore label
  ])('a real page we cannot canonicalize (%s) is FOREIGN, not "no page"', (landing) => {
    expect(bound({ landing }).action).toBe('end');
  });

  test('an unnameable FIRST landing cannot be adopted as an owned origin', () => {
    // Otherwise a bound actor could be pinned to something the rule that later
    // judges it is unable to express.
    const v = decideLanding({ mode: 'bound', ownedOrigin: null, landing: 'http://192.168.1.9/', landingIsSensitive: false });
    expect(v.action).toBe('end');
  });

  test('the first landing REPORTS what to adopt, so the caller never re-derives it', () => {
    // The obvious helper over there (originOfUrl) canonicalizes differently on
    // exactly the hosts above; a caller deriving its own would disagree with
    // the rule that later judges it.
    const v = decideLanding({ mode: 'bound', ownedOrigin: null, landing: 'HTTPS://App.test:443/x', landingIsSensitive: true });
    expect(v.adoptOrigin).toBe('https://app.test');
  });
});

describe('fail-closed on a bad mode', () => {
  test.each([[undefined], ['Bound'], ['web'], [null], [42]])('mode %p ends the actor', (mode) => {
    // An actor record predating the field, a storage.session JSON round-trip, or
    // a typo in the SW ctx rebuild must not silently disable this whole core.
    const v = decideLanding({ mode: mode as any, landing: 'https://bank.test', landingIsSensitive: true });
    expect(v.action).toBe('end');
  });
});

describe('auth excursions — the OAuth solve', () => {
  const IDP = 'https://accounts.google.com';
  const inFlight = (over: any = {}) => ({ returnTo: OWNED, openedAt: IDP, lastLanding: IDP, budget: 2, deadline: 99_999, ...over });

  test('landing on a known IdP opens a bounded excursion instead of ending', () => {
    const v = bound({ landing: IDP, landingIsSensitive: true, landingIsIdp: true });
    expect(v.action).toBe('continue');
    expect(v.excursion).toEqual({
      returnTo: OWNED, openedAt: IDP, lastLanding: IDP,
      budget: EXCURSION_BUDGET, deadline: 1_000 + EXCURSION_MS,
    });
  });

  test('an in-flight excursion spends budget when it actually MOVES', () => {
    const v = bound({ landing: 'https://idp-step2.test', excursion: inFlight() });
    expect(v.action).toBe('continue');
    expect(v.excursion?.budget).toBe(1);
  });

  test('repeated calls on the SAME page do not spend budget', () => {
    // This function runs per tool call (resolveTargetTab is on every DOM tool),
    // not per navigation. A single-page login — snapshot, type, click, snapshot
    // — would otherwise burn the budget standing still and end the actor
    // mid-sign-in. The budget is denominated in navigations, so it must only
    // decrement on one.
    const v = bound({ landing: IDP, landingIsSensitive: true, excursion: inFlight() });
    expect(v.excursion?.budget).toBe(2);
  });

  test('an exhausted budget ends the actor on the next move', () => {
    const v = bound({ landing: 'https://idp-step9.test', excursion: inFlight({ budget: 0 }) });
    expect(v.action).toBe('end');
  });

  test('an expired deadline ends the actor even with budget left', () => {
    const v = bound({ landing: 'https://idp.test', excursion: inFlight({ budget: 9, deadline: 500 }), now: 1_000 });
    expect(v.action).toBe('end');
  });

  test('returning to the owned origin discharges it — the only good ending', () => {
    const v = bound({ landing: OWNED, excursion: inFlight({ budget: 1 }) });
    expect(v.action).toBe('continue');
    expect(v.excursion).toBeUndefined();          // cleared, not carried
  });

  test('a blank read mid-excursion carries it through rather than discharging it', () => {
    // Absence of the field means "cleared" to the caller, so a tab caught
    // mid-load must not silently end a sign-in in progress.
    const ex = inFlight();
    expect(bound({ landing: 'about:blank', excursion: ex }).excursion).toEqual(ex);
  });

  test('an open corridor is NOT a window onto other credentialed sites', () => {
    // The bound path ignoring landingIsSensitive was the design gap: a docs-site
    // actor could be bounced onto an IdP, then walked to mail or a bank for four
    // free hops. A roaming actor — which holds nothing — gets a hard handoff on
    // its first sensitive landing, so the actor that DOES carry authority must
    // not get a softer rule.
    const v = bound({ landing: 'https://bank.test/transfer', landingIsSensitive: true, excursion: inFlight() });
    expect(v.action).toBe('end');
  });

  test('...but the IdP that opened it stays reachable, because an IdP is credentialed by nature', () => {
    // Which is why the exemption is keyed on openedAt rather than a blanket
    // "refuse every sensitive hop" that would break every real sign-in.
    const v = bound({ landing: `${IDP}/signin/step2`, landingIsSensitive: true, excursion: inFlight() });
    expect(v.action).toBe('continue');
  });

  test('the lifetime cap survives discharge, so the corridor cannot be refreshed', () => {
    // Discharging at home clears the corridor, so a per-leg budget alone lets a
    // hostile page loop home → IdP → hops → home forever, buying a fresh budget
    // and deadline every two navigations. Bounded per leg, unbounded per task.
    const v = bound({ landing: IDP, landingIsSensitive: true, landingIsIdp: true, excursionsUsed: MAX_EXCURSIONS });
    expect(v.action).toBe('end');
  });

  test('an excursion cannot be opened toward a NON-IdP', () => {
    // Otherwise "off-origin" would be self-authorizing and the lock would be
    // a suggestion.
    expect(bound({ landing: 'https://evil.test', landingIsIdp: false }).action).toBe('end');
  });

  test('a roaming actor cannot turn a sign-in service into a standalone destination', () => {
    const v = roaming({ landing: 'https://accounts.google.com', landingIsSensitive: true, landingIsIdp: true });
    expect(v.action).toBe('end');
    expect(v.handoffTo).toBeUndefined();
    expect(v.excursion).toBeUndefined();
  });
});

describe('the reasons are for humans', () => {
  test('every reason is plain prose with no identifiers', () => {
    const verdicts = [
      roaming({ landing: 'https://github.com', landingIsSensitive: true }),
      bound({ landing: 'https://evil.test' }),
      bound({ landing: 'https://x.test', excursion: { returnTo: OWNED, budget: 0, deadline: 9e9 } }),
      bound({ landing: 'https://x.test', excursion: { returnTo: OWNED, budget: 9, deadline: 1 } }),
    ];
    for (const v of verdicts) {
      expect(v.reason.length).toBeGreaterThan(10);
      expect(v.reason).not.toMatch(/[_{}();]|actor[A-Z]|null|undefined/);
    }
  });
});

// --- the www fold: a spelled origin vs the one the site actually serves ------
describe('a PROVISIONAL owned origin settles onto its own www-fold', () => {
  const bound = (over: any = {}) => decideLanding({
    mode: 'bound', ownedOrigin: 'https://reddit.com', landingIsSensitive: false, ...over,
  } as any);

  test('apex → www is adopted, not ended', () => {
    // `site:<origin>` is a handle the orchestrator SPELLS from the user's words,
    // so the origin is a request. Loading https://reddit.com lands on
    // https://www.reddit.com — ordinary web behaviour, not an attack. Before
    // this, the actor ended AND the durable binding made the handle a permanent
    // dead end for the chat, one orphaned tab per retry.
    const v = bound({ provisional: true, landing: 'https://www.reddit.com/r/x' });
    expect(v.action).toBe('continue');
    expect(v.adoptOrigin).toBe('https://www.reddit.com');
  });

  test('www → apex is adopted too — sites canonicalize both ways', () => {
    const v = decideLanding({
      mode: 'bound', ownedOrigin: 'https://www.example.com', provisional: true,
      landing: 'https://example.com/', landingIsSensitive: false,
    } as any);
    expect(v.action).toBe('continue');
    expect(v.adoptOrigin).toBe('https://example.com');
  });

  test('anything that is NOT the www fold still ends', () => {
    // The allowance is exactly one host convention, not "same-ish site". A
    // registrable-domain rule would need a public-suffix list we do not ship,
    // and its cheap approximation is wrong on co.uk.
    for (const landing of [
      'https://evil.com/', 'https://reddit.com.evil.test/', 'https://old.reddit.com/',
      'https://www.reddit.co.uk/', 'http://www.reddit.com/',
    ]) {
      expect(bound({ provisional: true, landing }).action).toBe('end');
    }
  });

  test('a different PORT is not a www fold', () => {
    expect(bound({ provisional: true, landing: 'https://www.reddit.com:8443/' }).action).toBe('end');
  });

  test('WITHOUT provisional, the same www redirect ends — an observed origin is not a guess', () => {
    // A handoff successor's origin is where a roaming actor already WAS, so it
    // needs no allowance; giving one would widen the handoff path for free.
    expect(bound({ landing: 'https://www.reddit.com/' }).action).toBe('end');
  });

  test('a provisional actor that lands exactly where it was told just continues', () => {
    const v = bound({ provisional: true, landing: 'https://reddit.com/r/x' });
    expect(v.action).toBe('continue');
    expect(v.adoptOrigin).toBeUndefined();
  });
});
