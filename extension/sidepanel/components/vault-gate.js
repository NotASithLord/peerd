// @ts-check
// First-run / locked-vault gate.
//
// A passkey (WebAuthn PRF — Touch ID, Windows Hello, or a hardware
// security key) is the DEFAULT and only factor at sign-up. A recovery
// passphrase is OPTIONAL and added later from settings; it exists as a
// fallback for losing access to the passkey.
//
// First-run states
// ----------------
//   - WebAuthn available: passkey-only sign-up — one ceremony →
//     `vault/initializeWithPasskey`. A capability probe (pure planning
//     in peerd-egress enroll-options) decides which choices to show:
//     the platform authenticator leads when one exists (labeled "Touch
//     ID"/"Windows Hello" where the platform is recognizable — label
//     only, never behavior), and a security key (YubiKey or any FIDO2
//     key with PRF) is ALWAYS offered, since keys are pluggable. A
//     quiet "Use a passphrase instead" link drops to the passphrase
//     path (also the automatic fallback if the browser can't do PRF).
//   - WebAuthn unavailable, the client can't do PRF, or the user chose
//     the fallback: passphrase-only init (`vault/initialize`). A
//     passkey can be added later from settings.
//
// Locked states
// -------------
//   - Passkey enrolled + WebAuthn available: lead with "Unlock with
//     passkey". The recovery-passphrase form is offered only when a
//     recovery passphrase actually exists (state.vault.hasRecovery).
//   - Otherwise: passphrase form.
//
// All real validation happens in the SW (the vault throws typed errors
// on bad passphrase / already-initialized / no-recovery-set). UI shows
// the SW's reply verbatim where it's actionable.

import m from '/vendor/mithril/mithril.js';
import {
  enrollWithPrf,
  getPrfOutput,
  isWebAuthnAvailable,
  probeWebAuthnCapabilities,
  planEnrollment,
  platformAuthenticatorLabel,
  PrfCancelledError,
  PrfNotSupportedError,
  PrfUnsupportedByAuthenticatorError,
} from '/peerd-egress/index.js';
import { base64ToBytes, bytesToBase64 } from '/shared/util.js';

// LABEL only (the enrollment flow is identical everywhere):
// navigator.userAgentData is Chromium-only; navigator.platform is the
// universal fallback. Unknown platforms render generic "passkey" copy.
const PLATFORM_LABEL = platformAuthenticatorLabel(
  (typeof navigator !== 'undefined'
    && (/** @type {{ userAgentData?: { platform?: string } }} */ (navigator).userAgentData?.platform
      || navigator.platform)) || '');

/**
 * Big "manifest" brand wordmark for the vault gate — the hero logo on
 * the lock / sign-up screen, and the only brand mark there (the top-bar
 * wordmark is suppressed while locked). It plays the same two-phase
 * intro as peerd.ai: the letters type out behind a terminal cursor,
 * then the blocks colorize. Pure CSS via .wordmark--intro/.wordmark--hero;
 * runs once on mount (Mithril patches the node across redraws).
 */
const BrandHeader = {
  view: () => m('.vault-brand', { style: 'display:flex; justify-content:center; margin: 8px 0 22px;' },
    m('.wordmark.wordmark--intro.wordmark--hero', {
      'aria-label': 'peerd',
      role: 'img',
    }, [
      m('.block.b-p',  'p'),
      m('.block.b-e',  'e'),
      m('.block.b-e2', 'e'),
      m('.block.b-r',  'r'),
      m('.block.b-d',  'd'),
      m('.wordmark-cursor', { 'aria-hidden': 'true' }),
    ])),
};

/** @type {Record<string, string>} */
const ERROR_MESSAGES = {
  'wrong-passphrase':    'That passphrase is wrong.',
  'not-initialized':     'Vault has not been set up yet.',
  'already-initialized': 'A vault already exists on this profile.',
  'locked':              'Vault is locked.',
  'prf-not-enrolled':    'No passkey is enrolled for this vault.',
  'prf-unlock-failed':   'Your passkey could not unlock the vault.',
  'recovery-not-set':    'No recovery passphrase has been set — unlock with your passkey.',
  'invalid-passphrase':  'Passphrase must be at least 8 characters.',
  'invalid-prf-payload': 'Passkey setup did not return usable credentials.',
};

/** @typedef {import('../chat-reducer.js').ChatState} ChatState */
/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {import('/peerd-egress/vault/enroll-options.js').CapabilityProbe} CapabilityProbe */
/** @typedef {import('/peerd-egress/vault/enroll-options.js').EnrollFlavor} EnrollFlavor */

/**
 * Component-local UI state for the vault gate.
 * @typedef {Object} VaultGateState
 * @property {string} passphrase
 * @property {string} confirmPassphrase
 * @property {string|null} error
 * @property {boolean} busy
 * @property {boolean} showPassphrase
 * @property {boolean} forcePassphrase
 * @property {CapabilityProbe|null} probe
 */

/** @typedef {{ state: VaultGateState, attrs: { state: ChatState, send: Send, minimal?: boolean } }} VaultGateVnode */

export const VaultGate = {
  // Component-local UI state. The "real" vault state lives in the SW.
  /** @param {VaultGateVnode} vnode */
  oninit(vnode) {
    vnode.state.passphrase = '';
    vnode.state.confirmPassphrase = '';
    vnode.state.error = null;
    vnode.state.busy = false;
    // Unlock-state: with a passkey enrolled, the recovery-passphrase
    // form is collapsed behind a link. Persisted for the component mount
    // so a single cancelled passkey tap doesn't yank the form away.
    vnode.state.showPassphrase = false;
    // First-run-state: when WebAuthn is available, sign-up is passkey-
    // only by default. The user can fall back to a passphrase-only vault
    // (the only path when WebAuthn is unavailable). Forced true on a
    // PrfNotSupported result so the user is never stranded.
    vnode.state.forcePassphrase = false;
    // Capability probe → enrollment plan (pure planEnrollment). null
    // while the async probes run (they resolve in milliseconds — well
    // before a human can click); the UI renders the generic single
    // passkey button meanwhile, which is the legacy behavior.
    vnode.state.probe = null;
    probeWebAuthnCapabilities().then((p) => {
      vnode.state.probe = p;
      m.redraw();
    }).catch(() => { /* keep legacy generic button */ });
  },

  /** @param {VaultGateVnode} vnode */
  view: ({ attrs: { state, send, minimal }, state: ui }) => {
    // `minimal` (home SPA): no card box, and the unlock screen trims to just the
    // animated wordmark + the action — home is the full-page surface, so the
    // chrome + explanatory copy the cramped side panel needs is noise there.
    /** @param {any} kids */
    const shell = (kids) => m(minimal ? '.gate-card' : '.card.gate-card', kids);
    const isFirstRun = !state.vault.initialized;
    const prfEnrolled = !!state.vault.prfEnrolled;
    const hasRecovery = !!state.vault.hasRecovery;
    const webauthnAvailable = isWebAuthnAvailable();
    // What this machine offers, per the capability probe. null while the
    // probe is in flight → the generic single passkey button (legacy).
    const plan = ui.probe ? planEnrollment(ui.probe) : null;
    // Definite client-level "no PRF" (getClientCapabilities) — no
    // authenticator could ever produce the vault KEK through this
    // browser, so sign-up routes straight to the passphrase with honest
    // copy instead of letting every ceremony fail.
    const passkeyBlocked = !!plan && plan.paths.length === 0;
    // Passkey sign-up is the default whenever WebAuthn is available and
    // the user hasn't explicitly fallen back to a passphrase.
    const usePasskeySignup = isFirstRun && webauthnAvailable && !ui.forcePassphrase && !passkeyBlocked;
    const usePasskeyUnlock = !isFirstRun && prfEnrolled && webauthnAvailable && !ui.showPassphrase;

    // ---------- First-run: passkey-only --------------------------------
    // flavor: 'platform' | 'security-key' | undefined (browser's picker).
    /** @param {EnrollFlavor} [flavor] */
    const setupWithPasskey = async (flavor) => {
      if (ui.busy) return;
      ui.error = null;
      ui.busy = true;
      m.redraw();
      try {
        // Run the ceremony FIRST while the click is the active gesture —
        // create() needs user activation, which a SW round-trip can lose.
        const { credentialId, prfSalt, prfOutput, transports } =
          await enrollWithPrf({ flavor });
        const reply = await send({
          type: 'vault/initializeWithPasskey',
          credentialId: bytesToBase64(credentialId),
          prfSalt:      bytesToBase64(prfSalt),
          prfOutput:    bytesToBase64(prfOutput),
          transports,
        });
        if (!reply?.ok) {
          ui.error = ERROR_MESSAGES[reply?.error] ?? reply?.error ?? 'Setup failed.';
        }
        // on success the SW unlocks → state push flips us out of the gate
      } catch (err) {
        if (err instanceof PrfCancelledError) {
          ui.error = 'Passkey setup was cancelled. Try again, or use a passphrase.';
        } else if (err instanceof PrfUnsupportedByAuthenticatorError) {
          // THIS authenticator can't do PRF, so it can't protect the
          // vault key — but another one (or the passphrase) still can.
          // Stay on the passkey screen with the other choices intact.
          ui.error = 'This authenticator can’t protect the vault key — it doesn’t '
            + 'support the PRF extension. Try a different one (YubiKey 5 or '
            + 'newer security keys work), or use a passphrase instead.';
        } else if (err instanceof PrfNotSupportedError) {
          // The BROWSER can't do WebAuthn PRF — there's nothing to retry
          // with any authenticator. Drop to the passphrase path so the
          // user can still get a vault.
          ui.error = 'This browser can’t use passkeys for the vault. Set a passphrase instead.';
          ui.forcePassphrase = true;
        } else {
          console.error('[vault-gate] passkey setup threw', err);
          ui.error = 'Passkey setup failed. Try again, or use a passphrase.';
        }
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    /** @param {Event} [e] */
    const setupWithPassphrase = async (e) => {
      e?.preventDefault?.();
      if (ui.busy) return;
      ui.error = null;
      if (ui.passphrase.length < 8) {
        ui.error = 'Passphrase must be at least 8 characters.';
        return;
      }
      if (ui.passphrase !== ui.confirmPassphrase) {
        ui.error = 'Passphrases do not match.';
        return;
      }
      ui.busy = true;
      const reply = await send({ type: 'vault/initialize', passphrase: ui.passphrase });
      ui.busy = false;
      if (reply?.ok) {
        ui.passphrase = '';
        ui.confirmPassphrase = '';
      } else {
        ui.error = ERROR_MESSAGES[reply?.error] ?? reply?.error ?? 'Something went wrong.';
      }
      m.redraw();
    };

    // ---------- Unlock paths ------------------------------------------
    const unlockWithPasskey = async () => {
      if (ui.busy) return;
      ui.error = null;
      ui.busy = true;
      m.redraw();
      try {
        const status = await send({ type: 'vault/prfStatus' });
        if (!status?.ok || !status.enrolled) {
          ui.error = ERROR_MESSAGES['prf-not-enrolled'];
          if (hasRecovery) ui.showPassphrase = true;
          return;
        }
        const prfOutput = await getPrfOutput({
          credentialId: base64ToBytes(status.credentialId),
          prfSalt:      base64ToBytes(status.prfSalt),
          // Recorded at enrollment (when the authenticator reported
          // them); routes the browser prompt to the right authenticator
          // class — absent on older enrollments, which keeps today's
          // try-everything prompt.
          transports:   status.transports,
        });
        const reply = await send({
          type: 'vault/unlockPrf',
          prfOutput: bytesToBase64(prfOutput),
        });
        if (!reply?.ok) {
          ui.error = ERROR_MESSAGES[reply?.error] ?? reply?.error ?? 'Passkey unlock failed.';
        }
      } catch (err) {
        if (err instanceof PrfCancelledError) {
          // User dismissed the prompt. Offer the recovery passphrase if
          // one exists; otherwise leave them on the passkey screen.
          if (hasRecovery) ui.showPassphrase = true;
        } else if (err instanceof PrfNotSupportedError) {
          ui.error = 'Passkeys are not supported in this browser.';
          if (hasRecovery) ui.showPassphrase = true;
        } else {
          console.error('[vault-gate] passkey unlock threw', err);
          ui.error = hasRecovery
            ? 'Your passkey could not be used. Use your recovery passphrase.'
            : 'Your passkey could not be used. Try again.';
          if (hasRecovery) ui.showPassphrase = true;
        }
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    /** @param {Event} [e] */
    const unlockWithPassphrase = async (e) => {
      e?.preventDefault?.();
      if (ui.busy) return;
      ui.error = null;
      if (!ui.passphrase) {
        ui.error = 'Enter your recovery passphrase.';
        return;
      }
      ui.busy = true;
      const reply = await send({ type: 'vault/unlock', passphrase: ui.passphrase });
      ui.busy = false;
      if (reply?.ok) {
        ui.passphrase = '';
      } else {
        ui.error = ERROR_MESSAGES[reply?.error] ?? reply?.error ?? 'Something went wrong.';
      }
      m.redraw();
    };

    // ---------- Render: first-run -------------------------------------
    if (isFirstRun) {
      if (usePasskeySignup) {
        // Ordered choices from the pure plan. Probe still in flight (or
        // failed) → [undefined] = one generic button driving the
        // browser's full picker, exactly the pre-probe behavior.
        const paths = plan?.paths?.length ? plan.paths : [undefined];
        const leadsWithPlatform = paths[0] === 'platform';
        /**
         * @param {EnrollFlavor|undefined} flavor
         * @param {boolean} isLead
         */
        const buttonLabel = (flavor, isLead) => {
          if (flavor === 'platform') {
            return `Create vault with ${PLATFORM_LABEL ?? 'a passkey on this device'}`;
          }
          if (flavor === 'security-key') {
            // As the lead (no platform authenticator detected) say what
            // it creates; as the secondary it reads as the alternative.
            return isLead
              ? 'Create vault with a security key'
              : 'Use a security key (YubiKey or other FIDO2 key)';
          }
          return 'Create vault with passkey';
        };
        return shell([
          m(BrandHeader),
          m('h2', 'Set up peerd'),
          m('p.muted', leadsWithPlatform || !plan
            ? `Create your vault with a passkey — ${
              PLATFORM_LABEL ? `${PLATFORM_LABEL}, ` : 'Touch ID, Windows Hello, ' 
              }or a hardware security key. It encrypts your API keys and ` +
              `secrets on this device. No password to choose or remember.`
            : 'No built-in authenticator was detected on this machine. You ' +
              'can create your vault with a hardware security key — a ' +
              'YubiKey 5 or any FIDO2 key that supports PRF — or use a ' +
              'passphrase.'),
          m('.auth-actions', [
            ...paths.map((flavor, i) => m(i === 0 ? 'button' : 'button.secondary', {
              type: 'button',
              disabled: ui.busy,
              onclick: () => setupWithPasskey(flavor),
            }, ui.busy ? '…' : buttonLabel(flavor, i === 0))),
            m('button.linklike', {
              type: 'button',
              disabled: ui.busy,
              onclick: () => { ui.forcePassphrase = true; ui.error = null; m.redraw(); },
            }, 'Use a passphrase instead'),
          ]),
          // why "recent" and no version trivia: PRF support via Windows
          // Hello depends on OS plumbing that older Windows lacks; the
          // honest, durable statement is "recent Windows 11".
          (leadsWithPlatform && PLATFORM_LABEL === 'Windows Hello') ? m('p.muted', { style: 'font-size:11px; margin-top:12px;' },
            'Windows Hello can protect the vault on recent Windows 11. ' +
            'If setup fails, use a security key or a passphrase.') : null,
          m('p.muted', { style: 'font-size:11px; margin-top:12px;' },
            'You can add a recovery passphrase later in Settings, in case ' +
            'you lose access to your passkey.'),
          ui.error ? m('p.error', ui.error) : null,
        ]);
      }

      // Passphrase-only first-run — WebAuthn unavailable, the client
      // can't do PRF, or the user chose the fallback. This vault has no
      // passkey factor (one can be enrolled later from settings).
      return shell([
        m(BrandHeader),
        m('h2', 'Set a passphrase'),
        m('p.muted',
          'This passphrase encrypts your provider API keys and other ' +
          'secrets at rest. We cannot recover it for you.'),
        // Capability honesty: tell the user WHY there is no passkey
        // option rather than silently hiding it.
        passkeyBlocked ? m('p.muted', { style: 'font-size:11px;' },
          'This browser can’t use passkeys to protect the vault key ' +
          '(no PRF support), so a passphrase is required.') : null,
        m('form', { onsubmit: setupWithPassphrase }, [
          m('.input-row', [
            m('label', { for: 'pass' }, 'Passphrase'),
            m('input', {
              id: 'pass',
              type: 'password',
              autocomplete: 'new-password',
              value: ui.passphrase,
              disabled: ui.busy,
              oninput: (/** @type {Event} */ e) => { ui.passphrase = /** @type {HTMLInputElement} */ (e.target).value; },
              autofocus: true,
            }),
          ]),
          m('.input-row', [
            m('label', { for: 'pass2' }, 'Confirm passphrase'),
            m('input', {
              id: 'pass2',
              type: 'password',
              autocomplete: 'new-password',
              value: ui.confirmPassphrase,
              disabled: ui.busy,
              oninput: (/** @type {Event} */ e) => { ui.confirmPassphrase = /** @type {HTMLInputElement} */ (e.target).value; },
            }),
          ]),
          m('.auth-actions.auth-actions--row', [
            m('button', { type: 'submit', disabled: ui.busy },
              ui.busy ? '…' : 'Create vault'),
            // No passkey toggle when the client definitively can't do
            // PRF — offering a path that can only fail is worse than
            // not offering it.
            (webauthnAvailable && !passkeyBlocked) ? m('button.secondary', {
              type: 'button',
              disabled: ui.busy,
              onclick: () => { ui.forcePassphrase = false; ui.error = null; m.redraw(); },
            }, 'Use a passkey instead') : null,
          ]),
          ui.error ? m('p.error', ui.error) : null,
        ]),
      ]);
    }

    // ---------- Render: unlock ----------------------------------------
    if (usePasskeyUnlock) {
      return shell([
        m(BrandHeader),
        // Minimal (home): the wordmark + the button say it all — no heading/subtext.
        minimal ? null : m('h2', 'Unlock peerd'),
        minimal ? null : m('p.muted', 'Use your passkey to unlock.'),
        m('.auth-actions.auth-actions--row', [
          m('button', {
            type: 'button',
            disabled: ui.busy,
            onclick: unlockWithPasskey,
          }, ui.busy ? '…' : 'Unlock with passkey'),
          // Recovery passphrase is only an option if one was ever set.
          hasRecovery ? m('button.secondary', {
            type: 'button',
            disabled: ui.busy,
            onclick: () => { ui.showPassphrase = true; ui.error = null; m.redraw(); },
          }, 'Use recovery passphrase') : null,
        ]),
        ui.error ? m('p.error', ui.error) : null,
      ]);
    }

    // Passphrase unlock — no passkey enrolled, or the user chose their
    // recovery passphrase this time.
    return shell([
      m(BrandHeader),
      minimal ? null : m('h2', 'Unlock peerd'),
      minimal ? null : m('p.muted', prfEnrolled
        ? 'Enter your recovery passphrase.'
        : 'Your vault is locked. Enter your passphrase to continue.'),
      m('form', { onsubmit: unlockWithPassphrase }, [
        m('.input-row', [
          m('label', { for: 'pass' }, prfEnrolled ? 'Recovery passphrase' : 'Passphrase'),
          m('input', {
            id: 'pass',
            type: 'password',
            autocomplete: 'current-password',
            value: ui.passphrase,
            disabled: ui.busy,
            oninput: (/** @type {Event} */ e) => { ui.passphrase = /** @type {HTMLInputElement} */ (e.target).value; },
            autofocus: true,
          }),
        ]),
        m('.auth-actions.auth-actions--row', [
          m('button', { type: 'submit', disabled: ui.busy },
            ui.busy ? '…' : 'Unlock'),
          (prfEnrolled && webauthnAvailable) ? m('button.secondary', {
            type: 'button',
            disabled: ui.busy,
            onclick: () => { ui.showPassphrase = false; ui.error = null; m.redraw(); },
          }, 'Use passkey') : null,
        ]),
        ui.error ? m('p.error', ui.error) : null,
      ]),
    ]);
  },
};
