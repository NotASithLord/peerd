// @ts-check
// InputBar composer palette keys. Escape must close the popup, with or
// without matches, and stay closed through the keyup that follows it (the
// keyup re-derives the trigger from unchanged text). A chat switch drops a
// stale popup, and an empty "no matches" popup names no active descendant.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { InputBar } from '/sidepanel/components/input-bar.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync();
};

/** @param {string} sessionId */
const readyState = (sessionId) => ({
  session: { sessionId, provider: 'ollama' },
  providers: { current: 'ollama', hasKey: false, model: 'local' },
  composer: { provider: 'ollama', model: 'local', canSend: true, reason: null },
  capabilities: {},
});

/** @param {any} state @param {Array<{ name: string, description?: string }>} [commands] */
const mountInput = (state, commands = []) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const send = async (/** @type {any} */ msg) =>
    msg.type === 'commands/list' ? { ok: true, commands } : { ok: true };
  m.mount(root, { view: () => m(InputBar, { state, send, voiceManager: null }) });
  const textarea = root.querySelector('textarea');
  if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('textarea missing');
  return { root, textarea, unmount: () => { m.mount(root, null); root.remove(); } };
};

/** @param {HTMLTextAreaElement} textarea @param {string} value */
const type = (textarea, value) => {
  textarea.value = value;
  textarea.setSelectionRange(value.length, value.length);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  m.redraw.sync();
};

/** @param {HTMLTextAreaElement} textarea @param {'keydown'|'keyup'} kind @param {string} key */
const press = (textarea, kind, key) => {
  textarea.dispatchEvent(new KeyboardEvent(kind, { key, bubbles: true, cancelable: true }));
  m.redraw.sync();
};

describe('sidepanel.input-bar composer palette keys', () => {
  it('Escape closes the palette and the keyup does not reopen it; typing reopens it', async () => {
    const mounted = mountInput(readyState('palette-escape'));
    try {
      await settle();
      type(mounted.textarea, '@');
      expect(mounted.root.querySelectorAll('.command-palette [role="option"]').length).toBe(2);
      expect(mounted.textarea.getAttribute('aria-expanded')).toBe('true');
      expect(mounted.textarea.getAttribute('aria-activedescendant')).toBe('palette-opt-0');
      press(mounted.textarea, 'keydown', 'Escape');
      expect(mounted.root.querySelector('.command-palette')).toBe(null);
      press(mounted.textarea, 'keyup', 'Escape');
      expect(mounted.root.querySelector('.command-palette')).toBe(null);
      expect(mounted.textarea.getAttribute('aria-expanded')).toBe('false');
      expect(mounted.textarea.getAttribute('aria-activedescendant')).toBe(null);
      expect(mounted.textarea.value).toBe('@');
      type(mounted.textarea, '@t');
      expect(mounted.root.querySelector('.command-palette')).toBeTruthy();
    } finally {
      mounted.unmount();
      localStorage.removeItem('peerd.draft.palette-escape');
    }
  });

  it('an empty "no matches" popup names no active descendant and closes on Escape', async () => {
    const mounted = mountInput(readyState('palette-empty'));
    try {
      await settle();
      type(mounted.textarea, '/zzzz');
      await settle();
      expect(mounted.root.querySelector('.palette-empty')?.textContent).toBe('No matching commands');
      expect(mounted.textarea.getAttribute('aria-expanded')).toBe('true');
      expect(mounted.textarea.getAttribute('aria-activedescendant')).toBe(null);
      press(mounted.textarea, 'keydown', 'Escape');
      press(mounted.textarea, 'keyup', 'Escape');
      expect(mounted.root.querySelector('.command-palette')).toBe(null);
      expect(mounted.textarea.getAttribute('aria-expanded')).toBe('false');
    } finally {
      mounted.unmount();
      localStorage.removeItem('peerd.draft.palette-empty');
    }
  });

  it('lists the worker built-ins ahead of listed commands and hides a same-named row', async () => {
    const mounted = mountInput(readyState('palette-builtins'), [
      { name: 'deploy', description: 'ship it' },
      { name: 'tools', description: 'a skill that never runs' },
    ]);
    try {
      await settle();
      type(mounted.textarea, '/');
      await settle();
      const options = [...mounted.root.querySelectorAll('.palette-option')];
      expect(options.map((o) => o.querySelector('.palette-label')?.textContent))
        .toEqual(['/init', '/system', '/tools', '/deploy']);
      expect(options[2].querySelector('.palette-detail')?.textContent).toBe('show or narrow this chat’s toolset');
      expect(mounted.root.querySelector('.palette-empty')).toBe(null);
      type(mounted.textarea, '/sys');
      expect(mounted.root.querySelector('.palette-option .palette-label')?.textContent).toBe('/system');
      press(mounted.textarea, 'keydown', 'Enter');
      expect(mounted.textarea.value).toBe('/system ');
      expect(mounted.root.querySelector('.command-palette')).toBe(null);
    } finally {
      mounted.unmount();
      localStorage.removeItem('peerd.draft.palette-builtins');
    }
  });

  it('a chat switch closes a stale palette', async () => {
    const state = readyState('palette-switch-a');
    const mounted = mountInput(state);
    try {
      await settle();
      type(mounted.textarea, '@');
      expect(mounted.root.querySelector('.command-palette')).toBeTruthy();
      state.session = { sessionId: 'palette-switch-b', provider: 'ollama' };
      m.redraw.sync();
      expect(mounted.root.querySelector('.command-palette')).toBe(null);
      expect(mounted.textarea.getAttribute('aria-expanded')).toBe('false');
    } finally {
      mounted.unmount();
      localStorage.removeItem('peerd.draft.palette-switch-a');
      localStorage.removeItem('peerd.draft.palette-switch-b');
    }
  });
});
