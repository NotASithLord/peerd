// @ts-check
// Real post-WebAuthn authority failures. These tests register only under the
// CDP harness because opening a user's authenticator during a manual run would
// be hostile. The harness's virtual platform authenticator still performs the
// browser ceremony; only the service-worker reply is controlled here.

import { describe, it, expect } from '../../framework.js';
import m from '/vendor/mithril/mithril.js';
import { VaultGate } from '/sidepanel/components/vault-gate.js';

const HAVE_VIRTUAL_AUTHENTICATOR =
  !!(/** @type {Record<string, unknown>} */ (globalThis).__PEERD_VIRTUAL_AUTHENTICATOR__);

/** @typedef {{ type: string } & Record<string, any>} Message */
/** @typedef {(message: Message) => Promise<any>} Send */

/** @param {() => boolean} predicate */
const waitFor = async (predicate) => {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    m.redraw.sync();
  }
  if (!predicate()) throw new Error('vault gate did not settle');
};

/** @param {{initialized:boolean, prfEnrolled:boolean}} vault */
const stateFor = (vault) => /** @type {any} */ ({
  hydrated: true,
  vault: {
    ...vault, locked: true, hasRecovery: false, lockReason: null,
  },
  settings: { vaultAutoLockMs: 0 },
});

/** @param {any} state @param {Send} send */
const mountGate = (state, send) => {
  const root = document.createElement('div');
  document.body.append(root);
  m.mount(root, { view: () => m(VaultGate, { state, send }) });
  m.redraw.sync();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

if (HAVE_VIRTUAL_AUTHENTICATOR) describe('sidepanel.vault-gate post-credential authority', () => {
  /** @type {Message | null} */
  let enrollment = null;

  it('does not replay initialization when authority rejects after credential return', async () => {
    /** @type {Message[]} */
    const sends = [];
    const send = async (/** @type {Message} */ message) => {
      sends.push(message);
      if (message.type === 'vault/initializeWithPasskey') {
        enrollment = message;
        throw Object.assign(new Error('authority channel lost'), { outcomeKnown: false });
      }
      return { ok: true };
    };
    const { root, unmount } = mountGate(stateFor({
      initialized: false, prfEnrolled: false,
    }), send);
    try {
      // Wait for the capability probe to replace the generic picker with the
      // platform-only path. Otherwise Chrome may choose the deliberately
      // PRF-less USB authenticator that the harness also provisions.
      const platformButton = () => [...root.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('this device')
        || button.textContent?.includes('Touch ID')
        || button.textContent?.includes('Windows Hello'));
      await waitFor(() => platformButton() !== undefined);
      /** @type {HTMLButtonElement} */ (platformButton()).click();

      await waitFor(() => root.textContent?.includes(
        'did not confirm whether that finished') === true);
      const commits = sends.filter(({ type }) => type === 'vault/initializeWithPasskey');
      expect(commits.length).toBe(1);
      expect(typeof commits[0].credentialId).toBe('string');
      expect(typeof commits[0].prfSalt).toBe('string');
      expect(typeof commits[0].prfOutput).toBe('string');
      expect(root.textContent).toContain('Wait a moment while peerd reconciles');
    } finally { unmount(); }
  });

  it('does not replay unlock when authority reports an unknown outcome', async () => {
    if (!enrollment) throw new Error('missing prior virtual-authenticator enrollment');
    /** @type {Message[]} */
    const sends = [];
    const send = async (/** @type {Message} */ message) => {
      sends.push(message);
      if (message.type === 'vault/prfStatus') return {
        ok: true, enrolled: true,
        credentialId: enrollment?.credentialId,
        prfSalt: enrollment?.prfSalt,
        transports: enrollment?.transports,
      };
      if (message.type === 'vault/unlockPrf') {
        return { ok: false, outcomeKnown: false, error: 'vault-authority-timeout' };
      }
      return { ok: true };
    };
    const { root, unmount } = mountGate(stateFor({
      initialized: true, prfEnrolled: true,
    }), send);
    try {
      /** @type {HTMLButtonElement} */ (root.querySelector('button')).click();

      await waitFor(() => root.textContent?.includes(
        'did not confirm whether that finished') === true);
      expect(sends.filter(({ type }) => type === 'vault/prfStatus').length).toBe(1);
      expect(sends.filter(({ type }) => type === 'vault/unlockPrf').length).toBe(1);
      expect(root.textContent).toContain('Wait a moment while peerd reconciles');
    } finally { unmount(); }
  });
});
