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

describe('sidepanel.vault-gate cleanup posture', () => {
  for (const cleanup of ['pending', 'unconfirmed', 'restart-required']) it(`keeps unlock unavailable while cleanup is ${cleanup}`, async () => {
    const state = stateFor({ initialized: true, prfEnrolled: false });
    state.vault.hasRecovery = true;
    state.vault.lockCleanup = cleanup;
    /** @type {Message[]} */ const sent = [];
    const { root, unmount } = mountGate(state, async message => { sent.push(message); return { ok: true }; });
    try {
      expect(root.textContent).toContain('Vault locked.');
      expect(root.querySelector('input[type="password"]')).toBe(null);
      expect(!!root.querySelector('[role="status"]')).toBe(true);
      const retry = root.querySelector('button');
      if (cleanup === 'unconfirmed') {
        expect(retry?.textContent).toBe('Retry shutdown');
        retry?.click();
        await Promise.resolve();
        expect(sent).toEqual([{ type: 'vault/lock' }]);
      } else expect(retry).toBe(null);
      if (cleanup === 'restart-required') expect(root.textContent).toContain('Fully quit and restart your browser');
    } finally { unmount(); }
  });
});

describe('sidepanel.vault-gate passphrase errors', () => {
  it('keeps focus through repeated wrong replies and permits one corrected retry', async () => {
    const state = stateFor({ initialized: true, prfEnrolled: false });
    state.vault.hasRecovery = true;
    /** @type {Message[]} */ const sent = [];
    /** @type {(reply: any) => void} */ let finish = () => {};
    const { root, unmount } = mountGate(state, async message => {
      sent.push(message);
      return new Promise(resolve => { finish = resolve; });
    });
    try {
      const field = /** @type {HTMLInputElement} */ (root.querySelector('#pass'));
      const form = /** @type {HTMLFormElement} */ (root.querySelector('form'));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        field.value = `wrong passphrase ${attempt}`;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.focus();
        form.requestSubmit();
        m.redraw.sync();
        expect(field.disabled).toBe(false);
        expect(field.readOnly).toBe(true);
        expect(field.getAttribute('aria-busy')).toBe('true');
        expect(document.activeElement).toBe(field);
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        expect(sent.length).toBe(attempt + 1);
        finish({ ok: false, error: 'wrong-passphrase' });
        await waitFor(() => !field.readOnly);
        const error = root.querySelector('#vault-error');
        expect(error?.textContent).toBe('That passphrase is wrong.');
        expect(error?.getAttribute('role')).toBe('alert');
        expect(field.getAttribute('aria-invalid')).toBe('true');
        expect(field.getAttribute('aria-describedby')).toBe(error?.id);
        expect(document.activeElement).toBe(field);
        expect(root.querySelector('#pass')).toBe(field);
      }
      field.value = 'correct fixture passphrase';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      form.requestSubmit();
      m.redraw.sync();
      expect(field.getAttribute('aria-invalid')).toBe(null);
      expect(field.getAttribute('aria-describedby')).toBe(null);
      expect(root.querySelector('#vault-error')).toBe(null);
      finish({ ok: true });
      await waitFor(() => !field.readOnly);
      expect(field.value).toBe('');
      expect(sent).toEqual([
        { type: 'vault/unlock', passphrase: 'wrong passphrase 0' },
        { type: 'vault/unlock', passphrase: 'wrong passphrase 1' },
        { type: 'vault/unlock', passphrase: 'correct fixture passphrase' },
      ]);
    } finally { unmount(); }
  });

  it('does not take focus back after the user leaves a pending field', async () => {
    const state = stateFor({ initialized: true, prfEnrolled: false });
    state.vault.hasRecovery = true;
    /** @type {(reply: any) => void} */ let finish = () => {};
    const { root, unmount } = mountGate(state, async () => new Promise(resolve => { finish = resolve; }));
    const other = document.createElement('button');
    other.textContent = 'Other control';
    document.body.append(other);
    try {
      const field = /** @type {HTMLInputElement} */ (root.querySelector('#pass'));
      field.value = 'wrong passphrase';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();
      root.querySelector('form')?.requestSubmit();
      m.redraw.sync();
      expect(field.readOnly).toBe(true);
      other.focus();
      finish({ ok: false, error: 'wrong-passphrase' });
      await waitFor(() => !field.readOnly);
      expect(document.activeElement).toBe(other);
    } finally { other.remove(); unmount(); }
  });

  it('keeps the readiness fence and does not mark an authority failure as an invalid passphrase', async () => {
    const state = stateFor({ initialized: true, prfEnrolled: false });
    state.vault.hasRecovery = true;
    state.hydrated = false;
    /** @type {Message[]} */ const sent = [];
    const { root, unmount } = mountGate(state, async message => {
      sent.push(message);
      return { ok: false, error: 'vault authority bootstrap timed out' };
    });
    try {
      const field = /** @type {HTMLInputElement} */ (root.querySelector('#pass'));
      const form = /** @type {HTMLFormElement} */ (root.querySelector('form'));
      expect(field.disabled).toBe(true);
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      expect(sent.length).toBe(0);
      state.hydrated = true;
      m.redraw.sync();
      expect(field.disabled).toBe(false);
      field.value = 'fixture passphrase';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();
      form.requestSubmit();
      await waitFor(() => root.querySelector('#vault-error') !== null);
      expect(root.querySelector('#vault-error')?.textContent).toBe('Vault unlock could not be completed.');
      expect(field.getAttribute('aria-invalid')).toBe(null);
      expect(field.getAttribute('aria-describedby')).toBe(null);
      expect(field.classList.contains('is-error')).toBe(false);
      expect(document.activeElement).toBe(field);
      expect(sent.length).toBe(1);
    } finally { unmount(); }
  });
});

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
