// @ts-check
// Options → Vault & unlock — passkey enrollment, recovery passphrase,
// idle auto-lock.
//
// Ported from the panel's "Vault & unlock" section. Enrollment
// ceremonies (WebAuthn PRF) are fine in a full tab — arguably better
// than the panel for the platform-authenticator sheet. UNLOCK ceremonies
// stay in the panel's VaultGate; this page only ever renders when the
// vault is already unlocked (the options shell gates on locked).

import m from '/vendor/mithril/mithril.js';
import {
  enrollWithPrf,
  isWebAuthnAvailable,
  probeWebAuthnCapabilities,
  planEnrollment,
  platformAuthenticatorLabel,
  PrfCancelledError,
  PrfNotSupportedError,
  PrfUnsupportedByAuthenticatorError,
} from '/peerd-egress/index.js';
import { bytesToBase64 } from '/shared/util.js';

/** @typedef {import('./reset-row.js').Send} Send */

export const VaultSection = {
  /** @param {{ state: any }} vnode */
  oninit(vnode) {
    vnode.state.prfBusy = false;
    vnode.state.prfMessage = null;
    vnode.state.prfError = null;
    // Capability probe → enrollment plan (pure planEnrollment in
    // peerd-egress). null while the async probes resolve (milliseconds);
    // the section renders the generic single button meanwhile.
    vnode.state.prfProbe = null;
    probeWebAuthnCapabilities().then((/** @type {any} */ p) => {
      vnode.state.prfProbe = p;
      m.redraw();
    }).catch(() => { /* keep generic button */ });
    // Recovery-passphrase form state
    vnode.state.recoveryPass = '';
    vnode.state.recoveryConfirm = '';
    vnode.state.recoveryBusy = false;
    vnode.state.recoveryMessage = null;
    vnode.state.recoveryError = null;
  },

  /** @param {{ attrs: { state: any, send: Send }, state: any }} vnode */
  view: ({ attrs: { state, send }, state: ui }) => {
    const prfEnrolled = !!state.vault?.prfEnrolled;
    const hasRecovery = !!state.vault?.hasRecovery;
    const webauthnAvailable = isWebAuthnAvailable();
    // Enrollment choices from the capability probe (null while the
    // probe resolves → generic single button, the legacy behavior).
    const prfPlan = ui.prfProbe ? planEnrollment(ui.prfProbe) : null;
    // LABEL only — never behavior. navigator.userAgentData is
    // Chromium-only (not in the TS DOM lib); navigator.platform is the
    // universal fallback.
    const uaData = /** @type {{ userAgentData?: { platform?: string } }} */ (navigator).userAgentData;
    const platformLabel = platformAuthenticatorLabel(
      uaData?.platform || navigator.platform || '');

    // flavor: 'platform' | 'security-key' | undefined (browser's picker).
    /** @param {import('/peerd-egress/vault/enroll-options.js').EnrollFlavor} [flavor] */
    const enrollPasskey = async (flavor) => {
      if (ui.prfBusy) return;
      ui.prfBusy = true;
      ui.prfError = null;
      ui.prfMessage = null;
      try {
        const { credentialId, prfSalt, prfOutput, transports } =
          await enrollWithPrf({ flavor });
        const reply = await send({
          type: 'vault/enrollPrf',
          credentialId: bytesToBase64(credentialId),
          prfSalt:      bytesToBase64(prfSalt),
          prfOutput:    bytesToBase64(prfOutput),
          transports,
        });
        if (reply?.ok) {
          ui.prfMessage = 'Passkey added. You can now unlock with a tap.';
        } else {
          ui.prfError = reply?.error === 'locked'
            ? 'Vault is locked — unlock in the peerd panel first.'
            : reply?.error ?? 'Could not add the passkey.';
        }
      } catch (e) {
        if (e instanceof PrfCancelledError) {
          // User cancelled — silent.
        } else if (e instanceof PrfUnsupportedByAuthenticatorError) {
          // PRF honesty: the ceremony worked but THIS authenticator can't
          // produce the vault KEK — nothing was enrolled.
          ui.prfError = 'This authenticator can’t protect the vault key — it '
            + 'doesn’t support the PRF extension. Try a different one '
            + '(YubiKey 5 or newer security keys work).';
        } else if (e instanceof PrfNotSupportedError) {
          ui.prfError = 'This browser does not support the PRF extension.';
        } else {
          console.error('[options] enroll passkey threw', e);
          ui.prfError = 'Passkey enrollment failed.';
        }
      } finally {
        ui.prfBusy = false;
        m.redraw();
      }
    };

    const disableTouchId = async () => {
      if (ui.prfBusy) return;
      ui.prfBusy = true;
      ui.prfError = null;
      ui.prfMessage = null;
      const reply = await send({ type: 'vault/disablePrf' });
      ui.prfBusy = false;
      if (reply?.ok) {
        ui.prfMessage = 'Passkey removed. Your recovery passphrase is now required to unlock.';
      } else if (reply?.error === 'recovery-not-set') {
        ui.prfError = 'Set a recovery passphrase first — it would be your only way back in.';
      } else {
        ui.prfError = reply?.error ?? 'Could not remove the passkey.';
      }
      m.redraw();
    };

    /** @param {Event} [e] */
    const setRecovery = async (e) => {
      e?.preventDefault?.();
      if (ui.recoveryBusy) return;
      ui.recoveryError = null;
      ui.recoveryMessage = null;
      if (ui.recoveryPass.length < 8) {
        ui.recoveryError = 'Passphrase must be at least 8 characters.';
        return;
      }
      if (ui.recoveryPass !== ui.recoveryConfirm) {
        ui.recoveryError = 'Passphrases do not match.';
        return;
      }
      ui.recoveryBusy = true;
      const reply = await send({ type: 'vault/setRecoveryPassphrase', passphrase: ui.recoveryPass });
      ui.recoveryBusy = false;
      if (reply?.ok) {
        ui.recoveryPass = '';
        ui.recoveryConfirm = '';
        ui.recoveryMessage = hasRecovery
          ? 'Recovery passphrase updated.'
          : 'Recovery passphrase set. Keep it somewhere safe — we can\'t recover it for you.';
      } else {
        ui.recoveryError = reply?.error === 'locked'
          ? 'Vault is locked — unlock in the peerd panel first.'
          : reply?.error ?? 'Could not save the recovery passphrase.';
      }
      m.redraw();
    };

    return m('div', [
      m('h3', 'Passkey'),
      m('p', prfEnrolled
        ? 'A passkey is enrolled — unlock is a single tap (Touch ID / Windows Hello) or a security-key touch.'
        : prfPlan && prfPlan.paths.length === 0
          // Definite client-level "no PRF" (getClientCapabilities):
          // no authenticator could protect the vault key here, so be
          // honest instead of offering a button that can only fail.
          ? 'This browser can’t use passkeys to protect the vault key (no PRF support). Passphrase unlock only.'
          : webauthnAvailable
            ? `Add a passkey so you can unlock without typing a passphrase. ${
              prfPlan?.paths?.includes('platform')
                ? `${platformLabel ?? 'This device’s built-in authenticator'} works, and so does a hardware security key.`
                : 'A hardware security key (YubiKey 5 or any FIDO2 key that supports PRF) works; no built-in authenticator was detected on this machine.'}`
            : 'WebAuthn is not available in this browser. Passphrase unlock only.'),
      webauthnAvailable ? m('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;' },
        prfEnrolled
          // why: only allow removing the passkey when a recovery
          // passphrase exists — otherwise it's the only factor and the
          // vault would be unrecoverable. The SW enforces this too.
          ? m('button.secondary', {
              type: 'button',
              disabled: ui.prfBusy || !hasRecovery,
              title: hasRecovery ? '' : 'Set a recovery passphrase first',
              onclick: disableTouchId,
            }, ui.prfBusy ? '…' : 'Remove passkey')
          // Choices from the pure plan: the platform authenticator
          // (labeled where recognizable — label only, never behavior)
          // leads when one exists; a security key is ALWAYS offered
          // (keys are pluggable, absence right now proves nothing).
          // Probe pending/failed → the generic single button (legacy
          // full-picker behavior). Plan says no paths → no buttons
          // (copy above explains why).
          : (prfPlan
              ? prfPlan.paths.map((flavor, i) =>
                  m(i === 0 ? 'button' : 'button.secondary', {
                    type: 'button',
                    disabled: ui.prfBusy,
                    onclick: () => enrollPasskey(flavor),
                  }, ui.prfBusy ? '…'
                    : flavor === 'platform' ? `Add ${platformLabel ?? 'a passkey (this device)'}`
                    : 'Add a security key (YubiKey or other FIDO2 key)'))
              : [m('button', { type: 'button', disabled: ui.prfBusy, onclick: () => enrollPasskey(undefined) },
                  ui.prfBusy ? '…' : 'Add passkey')])
      ) : null,
      // why "recent" and no version trivia: PRF via Windows Hello
      // depends on OS plumbing older Windows lacks; the honest,
      // durable statement is "recent Windows 11".
      (!prfEnrolled && platformLabel === 'Windows Hello' && prfPlan?.paths?.includes('platform')) ? m('p.hint',
        'Windows Hello can protect the vault on recent Windows 11. If enrollment fails, use a security key.') : null,
      (prfEnrolled && !hasRecovery) ? m('p.hint',
        'Your passkey is the only way into this vault. Set a recovery passphrase below as a backup.') : null,
      ui.prfError   ? m('p.error', ui.prfError) : null,
      ui.prfMessage ? m('p', { style: 'color: var(--ok);' }, ui.prfMessage) : null,

      m('.settings-divider'),
      m('h3', 'Recovery passphrase'),
      m('p', hasRecovery
        ? 'A recovery passphrase is set. It can unlock the vault if you lose access to your passkey. Enter a new one below to replace it.'
        : 'Optional backup factor. Set a passphrase you can use to unlock the vault if you ever lose access to your passkey — we cannot recover it for you.'),
      m('form', { onsubmit: setRecovery }, [
        m('.input-row', [
          m('label', { for: 'recpass' }, hasRecovery ? 'New recovery passphrase' : 'Recovery passphrase'),
          m('input', {
            id: 'recpass',
            type: 'password',
            autocomplete: 'new-password',
            value: ui.recoveryPass,
            disabled: ui.recoveryBusy,
            oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.recoveryPass = e.target.value; },
          }),
        ]),
        m('.input-row', [
          m('label', { for: 'recpass2' }, 'Confirm passphrase'),
          m('input', {
            id: 'recpass2',
            type: 'password',
            autocomplete: 'new-password',
            value: ui.recoveryConfirm,
            disabled: ui.recoveryBusy,
            oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.recoveryConfirm = e.target.value; },
          }),
        ]),
        m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
          m('button', { type: 'submit', disabled: ui.recoveryBusy },
            ui.recoveryBusy ? '…' : hasRecovery ? 'Update recovery passphrase' : 'Set recovery passphrase'),
        ]),
        ui.recoveryError   ? m('p.error', ui.recoveryError) : null,
        ui.recoveryMessage ? m('p', { style: 'color: var(--ok);' }, ui.recoveryMessage) : null,
      ]),

      m('.settings-divider'),
      m('h3', 'Auto-lock'),
      m('p', 'Lock the vault after a period of inactivity. While unlocked, your decrypted key is held in memory; auto-lock bounds that window. Re-unlocking is a single tap with a passkey — in the peerd panel.'),
      m('.input-row', [
        m('label', { for: 'autolock' }, 'Lock when idle for'),
        m('select', {
          id: 'autolock',
          value: String(state.settings?.vaultAutoLockMs ?? 2700000),
          onchange: async (/** @type {{ target: HTMLSelectElement }} */ e) => {
            await send({ type: 'settings/update', patch: { vaultAutoLockMs: Number(e.target.value) } });
            m.redraw();
          },
        }, [
          [60000, '1 minute'],
          [300000, '5 minutes'],
          [900000, '15 minutes'],
          [1800000, '30 minutes'],
          [2700000, '45 minutes'],
          [3600000, '1 hour'],
          [0, 'Never'],
        ].map(([ms, label]) => m('option', { value: String(ms) }, label))),
      ]),
    ]);
  },
};
