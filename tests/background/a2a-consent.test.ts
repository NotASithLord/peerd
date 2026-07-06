// The a2a first-contact consent decisions. Guards the exact regression the
// re-swarm found: "Allow once" must NOT persist as a standing signing grant,
// while "Allow for session" is the intended revocable allowlist-add — and
// a2a_contact must escape the actor per-turn downgrade so that distinction
// can even be made for the (ephemeral) dweb actor.

import { describe, test, expect } from 'bun:test';
import { downgradesActorConfirm, a2aConsentOutcome } from '../../extension/background/a2a-consent.js';

describe('downgradesActorConfirm — the actor per-turn rule + the a2a_contact exception', () => {
  test('a NON-a2a actor confirm downgrades yes_session to one-shot (DESIGN-17)', () => {
    expect(downgradesActorConfirm('fetch_url', true, 'yes_session')).toBe(true);
  });
  test('a2a_contact is the exception — its yes_session is NOT downgraded', () => {
    // why it matters: the dweb actor is an ephemeral (kind:'actor') session, so
    // without this exception every a2a "Allow for session" would be silently
    // rewritten to yes_once and could never persist to the allowlist.
    expect(downgradesActorConfirm('a2a_contact', true, 'yes_session')).toBe(false);
  });
  test('a NON-ephemeral (chat) confirm never downgrades', () => {
    expect(downgradesActorConfirm('fetch_url', false, 'yes_session')).toBe(false);
    expect(downgradesActorConfirm('a2a_contact', false, 'yes_session')).toBe(false);
  });
  test('only yes_session is a downgrade candidate — yes_once / no pass through', () => {
    expect(downgradesActorConfirm('fetch_url', true, 'yes_once')).toBe(false);
    expect(downgradesActorConfirm('fetch_url', true, 'no')).toBe(false);
  });
});

describe('a2aConsentOutcome — persist only on yes_session', () => {
  test('yes_session → allowed AND persisted (the revocable allowlist-add)', () => {
    expect(a2aConsentOutcome('yes_session')).toEqual({ ok: true, persist: true });
  });
  test('yes_once → allowed for THIS call only, never persisted (the regression fix)', () => {
    expect(a2aConsentOutcome('yes_once')).toEqual({ ok: true, persist: false });
  });
  test('no / dismissed → denied, not persisted', () => {
    expect(a2aConsentOutcome('no')).toEqual({ ok: false, persist: false });
    expect(a2aConsentOutcome('')).toEqual({ ok: false, persist: false });
  });
});

// The end-to-end regression, in pure form: the two decisions composed exactly as
// service-worker.js wires them (confirmAction downgrade → a2aResolveConsent
// outcome) for the ephemeral dweb actor answering a2a_contact.
describe('composed: the dweb actor (ephemeral) answering a2a_contact', () => {
  const resolve = (rawAnswer: string) => {
    const delivered = downgradesActorConfirm('a2a_contact', true, rawAnswer) ? 'yes_once' : rawAnswer;
    return a2aConsentOutcome(delivered);
  };
  test('"Allow once" authorizes the call but does NOT persist the peer', () => {
    expect(resolve('yes_once')).toEqual({ ok: true, persist: false });
  });
  test('"Allow for session" authorizes AND persists (survives the downgrade)', () => {
    expect(resolve('yes_session')).toEqual({ ok: true, persist: true });
  });
  test('"No" denies', () => {
    expect(resolve('no')).toEqual({ ok: false, persist: false });
  });
});

describe('a2a_reply — per-conversation reply consent is an allowlist grant too', () => {
  test('an actor "yes_session" for a2a_reply is NOT downgraded (it persists per-thread)', () => {
    expect(downgradesActorConfirm('a2a_reply', true, 'yes_session')).toBe(false);
  });
  test('other actor tools still strictly downgrade', () => {
    expect(downgradesActorConfirm('click', true, 'yes_session')).toBe(true);
  });
})
