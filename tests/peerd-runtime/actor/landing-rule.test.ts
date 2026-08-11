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
import { decideLanding, MAX_EXCURSIONS } from '../../../extension/peerd-runtime/actor/landing-rule.js';

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

describe('auth excursions are confirmed, exact, and user-controlled', () => {
  const IDP = 'https://accounts.google.com';
  const grant = (over: any = {}) => ({ returnTo: OWNED, idpOrigin: IDP, deadline: 99_999, ...over });
  const inFlight = (over: any = {}) => ({
    returnTo: OWNED, idpOrigin: IDP, deadline: 99_999, authorized: true, ...over,
  });

  test('a matching live grant is consumed into an authorized wait', () => {
    const v = bound({
      landing: `${IDP}/authorize`, landingIsSensitive: true,
      landingIsIdp: true, authGrant: grant(),
    });
    expect(v.action).toBe('wait');
    expect(v.authGrant).toBeUndefined();
    expect(v.excursion).toEqual(inFlight());
  });

  test('an IdP without a grant has a dedicated not-authorized reason', () => {
    const v = bound({ landing: IDP, landingIsIdp: true });
    expect(v.action).toBe('end');
    expect(v.reason).toBe('this sign-in was not authorized, so this task was stopped');
  });

  test('the actor waits at the exact provider and cannot act there', () => {
    const v = bound({
      landing: `${IDP}/signin/step2`, landingIsSensitive: true,
      landingIsIdp: true, excursion: inFlight(),
    });
    expect(v.action).toBe('wait');
    expect(v.excursion).toEqual(inFlight());
  });

  test('home resumes and clears the active excursion', () => {
    const v = bound({ landing: OWNED, excursion: inFlight() });
    expect(v.action).toBe('continue');
    expect(v.excursion).toBeUndefined();
  });

  test('blank carries valid state and a home safety read preserves a grant', () => {
    const pending = grant();
    expect(bound({ landing: OWNED, authGrant: pending }).authGrant).toEqual(pending);
    expect(bound({ landing: 'about:blank', authGrant: pending }).authGrant).toEqual(pending);
    expect(bound({ landing: 'about:blank', excursion: inFlight() }).excursion).toEqual(inFlight());
  });

  test('wrong provider, third origin, expiry, and replay fail closed', () => {
    expect(bound({
      landing: 'https://login.microsoftonline.com', landingIsIdp: true, authGrant: grant(),
    }).action).toBe('end');
    expect(bound({ landing: 'https://evil.test', excursion: inFlight() }).action).toBe('end');
    expect(bound({ landing: OWNED, authGrant: grant({ deadline: 999 }), now: 1_000 }).action).toBe('end');
    expect(bound({ landing: OWNED, excursion: inFlight({ deadline: 999 }), now: 1_000 }).action).toBe('end');
    expect(bound({ landing: IDP, landingIsIdp: true }).action).toBe('end');
  });

  test('legacy and malformed persisted state fails closed', () => {
    for (const excursion of [
      { returnTo: OWNED, openedAt: IDP, lastLanding: IDP, budget: 2, deadline: 99_999 },
      { returnTo: OWNED, idpOrigin: IDP, deadline: 99_999 },
      { returnTo: 'https://other.test', idpOrigin: IDP, deadline: 99_999, authorized: true },
      { returnTo: OWNED, idpOrigin: 'not-an-origin', deadline: 99_999, authorized: true },
      { returnTo: OWNED, idpOrigin: `${IDP}/login`, deadline: 99_999, authorized: true },
    ]) {
      expect(bound({ landing: IDP, landingIsIdp: true, excursion }).action).toBe('end');
    }
    expect(bound({ landing: OWNED, authGrant: false }).action).toBe('end');
    expect(bound({ landing: IDP, landingIsIdp: true, authGrant: grant({ idpOrigin: `${IDP}/login` }) }).action).toBe('end');
    expect(bound({ landing: OWNED, authGrant: grant(), excursion: inFlight() }).action).toBe('end');
  });

  test('a grant target removed from the IdP registry fails closed', () => {
    const v = bound({ landing: IDP, landingIsIdp: false, authGrant: grant() });
    expect(v.action).toBe('end');
    expect(v.reason).toBe('this sign-in was not authorized, so this task was stopped');
  });

  test('the lifetime cap is checked only when a grant activates', () => {
    expect(bound({ landing: OWNED, authGrant: grant(), excursionsUsed: MAX_EXCURSIONS }).action).toBe('continue');
    expect(bound({
      landing: IDP, landingIsIdp: true, authGrant: grant(), excursionsUsed: MAX_EXCURSIONS,
    }).action).toBe('end');
  });

  test('a roaming actor cannot turn a sign-in service into a standalone destination', () => {
    const v = roaming({ landing: IDP, landingIsSensitive: true, landingIsIdp: true });
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
