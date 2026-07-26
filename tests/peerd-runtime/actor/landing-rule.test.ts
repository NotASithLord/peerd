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
import { decideLanding, EXCURSION_BUDGET, EXCURSION_MS } from '../../../extension/peerd-runtime/actor/landing-rule.js';

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
    for (const l of ['about:blank', '', 'chrome-extension://x/p.html']) {
      expect(bound({ landing: l }).action).toBe('continue');
    }
  });
});

describe('auth excursions — the OAuth solve', () => {
  test('landing on a known IdP opens a bounded excursion instead of ending', () => {
    const v = bound({ landing: 'https://accounts.google.com', landingIsSensitive: true, landingIsIdp: true });
    expect(v.action).toBe('continue');
    expect(v.excursion).toEqual({ returnTo: OWNED, budget: EXCURSION_BUDGET, deadline: 1_000 + EXCURSION_MS });
  });

  test('an in-flight excursion spends budget on each further hop', () => {
    const ex = { returnTo: OWNED, budget: 2, deadline: 99_999 };
    const v = bound({ landing: 'https://idp-step2.test', excursion: ex });
    expect(v.action).toBe('continue');
    expect(v.excursion?.budget).toBe(1);
  });

  test('an exhausted budget ends the actor', () => {
    const v = bound({ landing: 'https://idp-step9.test', excursion: { returnTo: OWNED, budget: 0, deadline: 99_999 } });
    expect(v.action).toBe('end');
  });

  test('an expired deadline ends the actor even with budget left', () => {
    // why both: budget only decrements on navigation, so a tab parked
    // mid-excursion would otherwise hold the exception open indefinitely.
    const v = bound({ landing: 'https://idp.test', excursion: { returnTo: OWNED, budget: 9, deadline: 500 }, now: 1_000 });
    expect(v.action).toBe('end');
  });

  test('returning to the owned origin discharges it — the only good ending', () => {
    const v = bound({ landing: OWNED, excursion: { returnTo: OWNED, budget: 1, deadline: 99_999 } });
    expect(v.action).toBe('continue');
    expect(v.excursion).toBeUndefined();          // cleared, not carried
  });

  test('an excursion cannot be opened toward a NON-IdP', () => {
    // Otherwise "off-origin" would be self-authorizing and the lock would be
    // a suggestion.
    expect(bound({ landing: 'https://evil.test', landingIsIdp: false }).action).toBe('end');
  });

  test('a roaming actor never needs an excursion — most SSO happens there', () => {
    const v = roaming({ landing: 'https://accounts.google.com', landingIsSensitive: false, landingIsIdp: true });
    expect(v.action).toBe('continue');
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
