// @ts-check
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { OptionsApp } from '/options/components/options-app.js';

describe('Options startup recovery', () => {
  it('turns a lost initial worker request into an explicit Retry', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let retries = 0;
    m.mount(root, {
      view: () => m(OptionsApp, {
        state: null,
        send: async () => ({ ok: false }),
        section: 'providers',
        stateLoadFailed: true,
        retryState: () => { retries += 1; },
      }),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      m.redraw.sync?.();
      expect(root.textContent).toContain('Peerd is restarting');
      expect(root.textContent).toContain('Retry');
      const retry = /** @type {HTMLButtonElement|null} */ (root.querySelector('button'));
      if (!retry) throw new Error('retry button missing');
      retry.click();
      expect(retries).toBe(1);
      expect(root.textContent.includes('Loading…')).toBe(false);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });
});
