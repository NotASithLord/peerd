import { describe, test, expect } from 'bun:test';
import { signalIsAttributable } from '../../../extension/peerd-runtime/dom/capture.js';

// The tab record is resolved BEFORE the capture; the password-field probe runs
// after, in whatever document is committed by then. Crediting the signal to the
// origin we started on is a primitive: a hostile page can mark arbitrary third
// parties as "the user has an account here" — roaming helpers are then refused
// there — and repeating it fills the learned-origin cap so nothing further is
// ever learned (issue 278).

describe('signalIsAttributable', () => {
  test('same origin → attributable', () => {
    expect(signalIsAttributable('https://bank.test', 'https://bank.test')).toBe(true);
  });

  test('the page moved under the probe → NOT attributable', () => {
    // The attack shape: start on the attacker, land on the bank mid-capture.
    expect(signalIsAttributable('https://bank.test', 'https://attacker.test')).toBe(false);
    // …and the reverse, which is the one that marks a third party.
    expect(signalIsAttributable('https://attacker.test', 'https://bank.test')).toBe(false);
  });

  test('a probe that cannot report its origin is UNKNOWN, not a mismatch', () => {
    // An opaque document cannot read location.origin. Treating that as a
    // mismatch would silently stop learning on pages where the signal is still
    // the caller's own — the same posture as reading hasPasswordField strictly.
    expect(signalIsAttributable(null, 'https://bank.test')).toBe(true);
    expect(signalIsAttributable(undefined, 'https://bank.test')).toBe(true);
  });

  test('port and scheme are part of the identity — no accidental folding here', () => {
    // Cookie-scope folding is a separate, deliberate decision (issue 264). This
    // rule must not quietly pre-empt it.
    expect(signalIsAttributable('https://bank.test:8443', 'https://bank.test')).toBe(false);
    expect(signalIsAttributable('http://bank.test', 'https://bank.test')).toBe(false);
  });
});
