// @ts-check
// Settings forms: every field has a name, every result line is a live region.
//
// A field named only by its placeholder loses that name as soon as the user
// types, an unnamed select or slider reads as a bare "popup button" or
// "slider", and a result line inserted after a save is not announced. These
// pin the names and the always-mounted role=status lines across the
// sections the audit named: API integrations, Providers, Memory, Voice and
// Hooks. `send` is the seam: no SW, no storage.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { OptionsApp } from '/options/components/options-app.js';
import { ProvidersSection } from '/options/sections/providers.js';
import { VoiceSection } from '/options/sections/voice.js';
import { HooksView } from '/sidepanel/components/hooks-view.js';

/**
 * @template {HTMLElement} [T=HTMLElement]
 * @param {ParentNode} root
 * @param {string} sel
 * @returns {T}
 */
const need = (root, sel) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return /** @type {T} */ (el);
};

const UNLOCKED_STATE = Object.freeze({
  vault: { initialized: true, locked: false, prfEnrolled: false, hasRecovery: false },
  settings: {},
  session: { permission: { mode: 'act', confirmActions: false } },
  providers: { current: 'anthropic', hasKey: false },
});

const USER_DOC = { id: 'user', kind: 'user', body: '# User memory\n\n- likes tea' };

// Answers the routes the shell and the two sections under test fetch on mount.
const shellSend = async (/** @type {any} */ msg) => {
  switch (msg.type) {
    case 'origin-cred/list': return { ok: true, integrations: [] };
    case 'git-cred/list': return { ok: true, hosts: [] };
    case 'site-client/list': return { ok: true, clients: [] };
    case 'memory/suggestions': return { ok: true, suggestions: [] };
    case 'memory/export': return { ok: true, payload: { version: 1, docs: [USER_DOC] } };
    default: return { ok: true };
  }
};

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); m.redraw.sync(); };

/** @param {() => boolean} predicate */
const until = async (predicate) => {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('timed out waiting for the section to settle');
};

/** @param {string} section */
const mountShell = async (section) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(OptionsApp, { state: UNLOCKED_STATE, send: shellSend, section }) });
  await until(() => !root.textContent?.includes('Loading…'));
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

/** @param {(root: HTMLElement) => any} view */
const mountView = (view) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => view(root) });
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

// An always-mounted, still empty role=status line: the region exists before
// its first announcement.
/** @param {ParentNode} scope @param {string} sel */
const emptyStatus = (scope, sel) => {
  const el = need(scope, sel);
  expect(el.getAttribute('role')).toBe('status');
  expect(el.textContent).toBe('');
};

describe('options.settings-form-names', () => {
  it('API integrations: host, key, authentication and header carry names; the result line is live', async () => {
    const { root, unmount } = await mountShell('api-integrations');
    try {
      const form = need(root, 'form.provider-card-form');
      const texts = [...form.querySelectorAll('input[type="text"]')];
      expect(texts[0]?.getAttribute('aria-label')).toBe('API host');
      expect(need(form, 'input[type="password"]').getAttribute('aria-label')).toBe('API key');
      expect(need(form, 'select').getAttribute('aria-label')).toBe('Authentication');
      expect(texts[1]?.getAttribute('aria-label')).toBe('Header name');
      emptyStatus(root, 'form.provider-card-form + p.key-msg');
    } finally { unmount(); }
  });

  it('Providers: each key field is named after its provider; the card result line is live', async () => {
    const state = {
      providers: { current: 'openai', hasKey: false, model: 'gpt' },
      settings: { providerName: '', providerModel: '' },
      capabilities: { localWebGpuHost: { status: 'unsupported' } },
    };
    const send = async (/** @type {any} */ msg) => {
      if (msg.type === 'provider/status') {
        return {
          ok: true,
          providers: [{ name: 'openai', label: 'OpenAI', defaultModel: 'gpt', hasKey: false, keyless: false }],
        };
      }
      if (msg.type === 'models/options') return { ok: true, options: [] };
      return { ok: false };
    };
    const { root, unmount } = mountView(() => m(ProvidersSection, { state, send }));
    try {
      await until(() => !!root.querySelector('.provider-card-form input[type="password"]'));
      // Every card with a key field names the field after the card.
      const cards = [...root.querySelectorAll('.provider-card')]
        .filter((card) => card.querySelector('input[type="password"]'));
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        const name = card.querySelector('.provider-card-name')?.textContent;
        expect(need(card, 'input[type="password"]').getAttribute('aria-label')).toBe(`${name} API key`);
      }
      emptyStatus(root, '.provider-card p.key-msg');
    } finally { unmount(); }
  });

  it('Memory: the editor is named by its scope; the page and card result lines are live', async () => {
    const { root, unmount } = await mountShell('memory');
    try {
      await until(() => !!root.querySelector('textarea.memory-editor'));
      expect(need(root, 'textarea.memory-editor').getAttribute('aria-label')).toBe('User · global memory');
      emptyStatus(root, '.memory-pane > p.key-msg');
      emptyStatus(root, '.memory-card p.key-msg');
    } finally { unmount(); }
  });

  it('Voice: the silence slider is tied to its label and reads its value in seconds', async () => {
    const voiceManager = {
      subscribe: (/** @type {(state: any) => void} */ listener) => {
        listener({ status: 'available', engine: 'web-speech' });
        return () => {};
      },
      getState: () => ({ status: 'available', engine: 'web-speech' }),
      setSilenceThreshold: () => {},
    };
    const state = {
      settings: { voiceEnabled: true, voiceEngine: 'auto', voiceVariant: 'base', voiceSilenceMs: 1500 },
      capabilities: { moonshineVoiceHost: { status: 'unsupported' }, pdfOcr: { status: 'unsupported' } },
    };
    const { root, unmount } = mountView(() => m(VoiceSection, { state, voiceManager, send: async () => ({ ok: true }) }));
    try {
      const slider = need(root, 'input[type="range"]');
      expect(slider.id).toBe('voice-silence');
      expect(need(root, 'label[for="voice-silence"]').textContent).toBe('Stop on silence: 1.5s');
      expect(slider.getAttribute('aria-valuetext')).toBe('1.5s');
    } finally { unmount(); }
  });

  it('Hooks: the result line is live before any action', async () => {
    const send = async (/** @type {any} */ msg) =>
      (msg.type === 'hooks/list' ? { ok: true, hooks: [] } : { ok: true });
    const { root, unmount } = mountView(() => m(HooksView, { send }));
    try {
      await until(() => !root.textContent?.includes('Loading…'));
      emptyStatus(root, '.hooks-pane p.key-msg');
    } finally { unmount(); }
  });
});
