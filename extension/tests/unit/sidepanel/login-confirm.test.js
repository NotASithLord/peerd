// @ts-check
// Login confirmation must show both sides of a verified SSO transition.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ConfirmModal } from '/sidepanel/components/app.js';

/** @param {any} prompt @param {any} [uiActions] */
const mount = (prompt, uiActions) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.render(root, m(ConfirmModal, { prompt, uiActions }));
  return { root, unmount: () => { m.render(root, null); root.remove(); } };
};

describe('sidepanel login confirmation', () => {
  it('shows the relying site and exact verified provider origin', () => {
    const { root, unmount } = mount({
      id: 'login-confirm', kind: 'login', method: 'sso', provider: 'Okta', verified: true,
      origins: ['https://app.example'], idpOrigin: 'https://acme.okta.com',
    });
    try {
      expect(root.querySelector('.login-hero .host')?.textContent).toBe('app.example');
      expect(root.querySelector('.login-destination strong')?.textContent).toBe('acme.okta.com');
      const allow = /** @type {HTMLButtonElement | null} */ (
        root.querySelector('button:not(.secondary)')
      );
      expect(allow?.disabled).toBe(false);
    } finally { unmount(); }
  });

  it('refuses approval when a verified SSO prompt omits its exact destination', () => {
    const { root, unmount } = mount({
      id: 'login-confirm', kind: 'login', method: 'sso', provider: 'Okta', verified: true,
      origins: ['https://app.example'],
    });
    try {
      expect(root.querySelector('.login-destination')).toBe(null);
      const allow = /** @type {HTMLButtonElement | null} */ (
        root.querySelector('button:not(.secondary)')
      );
      expect(allow?.disabled).toBe(true);
    } finally { unmount(); }
  });
});

for (const blocked of [false, true]) {
  describe(`sidepanel login focus: ${blocked ? 'missing destination' : 'verified destination'}`, () => {
    it('traps focus, rejects on Escape and returns to the opener', () => {
      const opener = document.createElement('button');
      document.body.appendChild(opener);
      opener.focus();
      /** @type {string[]} */
      const answers = [];
      const { root, unmount } = mount({
        id: 'login-focus', kind: 'login', method: 'sso', provider: 'Okta', verified: true,
        origins: ['https://app.example'], ...(blocked ? {} : { idpOrigin: 'https://acme.okta.com' }),
      }, { confirmAnswer: (/** @type {any} */ _prompt, /** @type {string} */ answer) => answers.push(answer) });
      try {
        const dialog = /** @type {HTMLElement} */ (root.querySelector('[role="dialog"]'));
        const cancel = /** @type {HTMLButtonElement} */ (dialog.querySelector('button.secondary'));
        const allow = /** @type {HTMLButtonElement} */ (dialog.querySelector('button:not(.secondary)'));
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(dialog.getAttribute('aria-labelledby')).toBe('peerd-confirm-title');
        expect(root.querySelector('#peerd-confirm-title')?.textContent).toBe('Approve sign-in');
        expect(document.activeElement).toBe(cancel);
        expect(allow.disabled).toBe(blocked);
        cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(blocked ? cancel : allow);
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
        expect(document.activeElement).toBe(cancel);
        dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(answers).toEqual(['no']);
      } finally {
        unmount();
        expect(document.activeElement).toBe(opener);
        opener.remove();
      }
    });
  });
}
