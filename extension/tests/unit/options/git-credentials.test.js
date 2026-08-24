// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { GitCredentialsSection } from '/options/sections/git-credentials.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync?.();
};

/** @param {ParentNode} root @param {string} text */
const button = (root, text) => [...root.querySelectorAll('button')]
  .find((candidate) => candidate.textContent === text);

describe('Git credential unknown-outcome custody', () => {
  it('finishes the exact same token save without list-based guessing', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    /** @type {any[]} */ const saves = [];
    const send = async (/** @type {any} */ message) => {
      if (message.type === 'git-cred/list') return { ok: true, hosts: ['github.com'] };
      if (message.type === 'git-cred/set') {
        saves.push(message);
        return saves.length === 1
          ? { ok: false, outcomeKnown: false }
          : { ok: true, host: 'github.com' };
      }
      return { ok: false };
    };
    m.mount(root, { view: () => m(GitCredentialsSection, { send }) });
    try {
      await settle();
      const host = root.querySelector('[aria-label="Git credential host"]');
      const token = root.querySelector('[aria-label="Personal access token"]');
      if (!(host instanceof HTMLInputElement) || !(token instanceof HTMLInputElement)) {
        throw new Error('Git credential inputs missing');
      }
      host.value = 'github.com';
      host.dispatchEvent(new Event('input', { bubbles: true }));
      token.value = 'replacement-token-456';
      token.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await settle();
      expect(root.textContent).toContain('Finish the same save');
      expect(host.disabled).toBe(true);
      expect(token.disabled).toBe(true);
      const finish = button(root, 'Finish same save');
      if (!(finish instanceof HTMLButtonElement)) throw new Error('exact save retry missing');
      finish.click();
      await settle(); await settle();
      expect(saves.length).toBe(2);
      expect(saves[1]).toEqual(saves[0]);
      expect(root.textContent).toContain('encrypted in the vault');
      expect(host.value).toBe('');
      expect(token.value).toBe('');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('finishes the exact same removal and blocks unrelated credential effects', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    /** @type {any[]} */ const removes = [];
    const send = async (/** @type {any} */ message) => {
      if (message.type === 'git-cred/list') return { ok: true, hosts: ['github.com', 'gitlab.com'] };
      if (message.type === 'git-cred/delete') {
        removes.push(message);
        return removes.length === 1 ? { ok: false, outcomeKnown: false } : { ok: true };
      }
      return { ok: false };
    };
    m.mount(root, { view: () => m(GitCredentialsSection, { send }) });
    try {
      await settle();
      const first = button(root, 'Remove');
      if (!(first instanceof HTMLButtonElement)) throw new Error('remove missing');
      first.click();
      await settle();
      const finish = button(root, 'Finish same removal');
      if (!(finish instanceof HTMLButtonElement)) throw new Error('exact removal retry missing');
      const unrelated = [...root.querySelectorAll('button')]
        .find((candidate) => candidate.textContent === 'Remove');
      expect(unrelated instanceof HTMLButtonElement && unrelated.disabled).toBe(true);
      finish.click();
      await settle();
      expect(removes.length).toBe(2);
      expect(removes[1]).toEqual(removes[0]);
      expect(root.textContent).toContain('Removed github.com');
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });
});
