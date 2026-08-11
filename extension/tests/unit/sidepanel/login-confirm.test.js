// @ts-check
// Login confirmation must show both sides of a verified SSO transition.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ConfirmModal } from '/sidepanel/components/app.js';

/** @param {any} prompt */
const mount = (prompt) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.render(root, m(ConfirmModal, { prompt }));
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
