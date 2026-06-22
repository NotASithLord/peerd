// @ts-check
// WebAuthn PRF ceremonies against REAL navigator.credentials, driven by
// CDP virtual authenticators (scripts/cdp/run-inbrowser-tests.mjs adds
// them and injects __PEERD_VIRTUAL_AUTHENTICATOR__ before the suite
// loads). The harness provisions two personalities:
//
//   - transport 'internal' + hasPrf  → a platform authenticator
//     (Touch ID-like). The 'platform' enrollment flavor lands here.
//   - transport 'usb' WITHOUT hasPrf → an old security key. The
//     'security-key' flavor lands here and MUST fail enrollment — this
//     is the PRF-honesty path (never enroll a credential that can't
//     actually unlock the vault).
//
// Registration is gated on the harness flag: a manually opened
// runner.html has no virtual authenticators, and a real Touch ID prompt
// popping mid-suite would be hostile. The single always-registered test
// documents the gate so a manual run shows WHY the ceremonies are
// absent. The pure decision logic these ceremonies sit on
// (enroll-options.js) is covered in Bun (tests/peerd-egress/
// enroll-options.test.ts) — this file is the integration proof that the
// imperative shell speaks real WebAuthn.

import { describe, it, expect, eq } from '../../framework.js';
import {
  enrollWithPrf,
  getPrfOutput,
  probeWebAuthnCapabilities,
  PrfUnsupportedByAuthenticatorError,
} from '/peerd-egress/vault/webauthn.js';
import { planEnrollment } from '/peerd-egress/vault/enroll-options.js';
import { createVault } from '/peerd-egress/index.js';
import { base64ToBytes } from '/shared/util.js';
import { makeMockKV } from '../../mocks/kv.js';
import { fakeTimers } from '../../mocks/clock.js';

// why the cast: __PEERD_VIRTUAL_AUTHENTICATOR__ is injected by the CDP
// harness (run-inbrowser-tests.mjs); it has no ambient type declaration.
const HAVE_VIRTUAL_AUTHENTICATOR =
  !!(/** @type {Record<string, unknown>} */ (globalThis).__PEERD_VIRTUAL_AUTHENTICATOR__);

describe('webauthn.virtual', () => {
  it(HAVE_VIRTUAL_AUTHENTICATOR
    ? 'CDP virtual authenticators present — ceremony tests registered'
    : 'no CDP virtual authenticators — ceremony tests skipped (run via scripts/cdp/run-inbrowser-tests.mjs)', () => {
    // Documentation test: always passes; its NAME tells a human reading
    // the runner page whether the ceremonies below actually ran.
    expect(true).toBe(true);
  });

  if (!HAVE_VIRTUAL_AUTHENTICATOR) return;

  // Shared across the sequential tests below (the framework runs tests
  // in declaration order). Holds the platform enrollment so the unlock
  // tests exercise the same credential a real user would re-present.
  /** @type {import('/peerd-egress/vault/webauthn.js').PrfEnrollResult | null} */
  let enrolled = null;

  describe('capability probe', () => {
    it('reports WebAuthn + a platform authenticator, and the plan leads with it', async () => {
      const probe = await probeWebAuthnCapabilities();
      expect(probe.webAuthnAvailable).toBe(true);
      expect(probe.platformAuthenticator).toBe(true);
      const plan = planEnrollment(probe);
      expect(plan.paths[0]).toBe('platform');
      expect(plan.paths).toContain('security-key');
    });
  });

  describe('enrollment (platform flavor)', () => {
    it('returns 32 PRF bytes, a credentialId, and the internal transport', async () => {
      enrolled = await enrollWithPrf({ flavor: 'platform' });
      expect(enrolled.prfOutput.length).toBe(32);
      expect(enrolled.credentialId.length).toBeGreaterThan(0);
      expect(enrolled.transports).toContain('internal');
    });
  });

  describe('unlock ceremony', () => {
    it('reproduces the same 32 bytes for the same credential + salt', async () => {
      // Narrow the cross-test fixture: the enrollment test above ran first
      // (the framework runs tests in declaration order) so it is non-null.
      const e = /** @type {import('/peerd-egress/vault/webauthn.js').PrfEnrollResult} */ (enrolled);
      const again = await getPrfOutput({
        credentialId: e.credentialId,
        prfSalt:      e.prfSalt,
        transports:   e.transports,
      });
      expect(again).toEqual(e.prfOutput);
    });

    it('a different salt yields different bytes (the PRF is salt-bound)', async () => {
      const e = /** @type {import('/peerd-egress/vault/webauthn.js').PrfEnrollResult} */ (enrolled);
      const otherSalt = crypto.getRandomValues(new Uint8Array(32));
      const other = await getPrfOutput({
        credentialId: e.credentialId,
        prfSalt:      otherSalt,
        transports:   e.transports,
      });
      expect(other.length).toBe(32);
      expect(eq(other, e.prfOutput)).toBe(false);
    });
  });

  describe('vault round-trip (passkey-only)', () => {
    it('enroll → initializeWithPrfOnly → lock → PRF unlock decrypts the secret', async () => {
      const timers = fakeTimers();
      const kv = makeMockKV();
      const vault = createVault({
        kv, autoLockMs: 0,
        setTimer: timers.setTimer, clearTimer: timers.clearTimer,
      });

      const e = await enrollWithPrf({ flavor: 'platform' });
      await vault.initializeWithPrfOnly({
        prfOutput:    e.prfOutput,
        credentialId: e.credentialId,
        prfSalt:      e.prfSalt,
        transports:   e.transports,
      });
      await vault.setSecret('anthropic', 'sk-ant-virtual-authenticator');
      vault.lock();
      expect(vault.isLocked()).toBe(true);

      // Mirror the production unlock flow exactly: read the stored
      // context back (base64 across the SW boundary), run the ceremony,
      // feed the bytes to the vault.
      // prfStatus() returns a discriminated union; assert + narrow to the
      // enrolled branch so the opaque-context reads below typecheck.
      const status = await vault.prfStatus();
      expect(status.enrolled).toBe(true);
      if (!status.enrolled) throw new Error('expected PRF-enrolled');
      expect(status.transports).toEqual(['internal']);
      const prfOutput = await getPrfOutput({
        credentialId: base64ToBytes(status.credentialId),
        prfSalt:      base64ToBytes(status.prfSalt),
        transports:   status.transports,
      });
      await vault.unlockWithPrf(prfOutput);
      expect(vault.isLocked()).toBe(false);
      expect(await vault.getSecret('anthropic')).toBe('sk-ant-virtual-authenticator');
    });
  });

  describe('PRF honesty (security-key flavor, authenticator without PRF)', () => {
    it('fails enrollment with PrfUnsupportedByAuthenticatorError — never returns a credential', async () => {
      // The harness's usb authenticator has hasPrf:false; the
      // cross-platform attachment routes the ceremony to it. create()
      // SUCCEEDS at the WebAuthn level (a credential is minted) but
      // enrollWithPrf must refuse it: prf.enabled === false means this
      // credential could never unwrap the vault DK.
      await expect(() => enrollWithPrf({ flavor: 'security-key' }))
        .toThrow((err) => err?.name === 'PrfUnsupportedByAuthenticatorError'
          && err instanceof PrfUnsupportedByAuthenticatorError);
    });
  });
});
