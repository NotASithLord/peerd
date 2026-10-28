// @ts-check
// "Keep peerd as the first tab": the offer after the first setup (on Home and
// in the side panel) and the hint in the pinned tab. These pin what each
// button sends and when each one hides.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import {
  FirstTabHint, FirstTabOffer, makePanelFirstTab,
} from '/home/first-tab-prompts.js';

/** @typedef {{ type: string, patch: Record<string, boolean> }} Msg */

/**
 * @param {unknown} reply what every send() answers
 * @param {{ beforeKeep?: () => Promise<void>, log?: string[] }} [options]
 */
const mountOffer = (reply, { beforeKeep, log = [] } = {}) => {
  /** @type {Msg[]} */
  const sent = [];
  /** @type {string[]} */
  const answers = [];
  let shown = true;
  const root = document.createElement('div');
  document.body.appendChild(root);
  const send = async (/** @type {Msg} */ msg) => {
    sent.push(msg);
    log.push('send');
    if (reply instanceof Error) throw reply;
    return reply;
  };
  m.mount(root, {
    view: () => (shown ? m(FirstTabOffer, {
      send, beforeKeep, onAnswered: (/** @type {string} */ answer) => { answers.push(answer); shown = false; },
    }) : null),
  });
  return { root, sent, answers, unmount: () => { m.mount(root, null); root.remove(); } };
};

const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => m.redraw.sync());

/** @param {ParentNode} scope @param {string} text */
const button = (scope, text) => {
  const el = [...scope.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!el) throw new Error(`missing button: ${text}`);
  return el;
};

describe('home: the first tab offer', () => {
  it('asks in plain words, as a section named by its question', async () => {
    const { root, unmount } = mountOffer({ ok: true });
    try {
      const section = root.querySelector('section.first-tab-offer');
      const title = root.querySelector('#first-tab-offer-title');
      expect(section?.getAttribute('aria-labelledby')).toBe('first-tab-offer-title');
      expect(title?.textContent).toBe('Keep peerd as the first tab?');
      expect([...root.querySelectorAll('.first-tab-offer p')].map((p) => p.textContent)).toEqual([
        'It stays at the start of your tabs in every window, so peerd is one click away.',
        'You can turn this on later in Settings.',
      ]);
      expect(!!button(root, 'Keep it') && !!button(root, 'Not now')).toBe(true);
    } finally { unmount(); }
  });

  it('"Keep it" turns the setting on and records the answer, then hides', async () => {
    const { root, sent, answers, unmount } = mountOffer({ ok: true });
    try {
      button(root, 'Keep it').click();
      await settle();
      expect(sent).toEqual([{ type: 'settings/update', patch: { firstTabEnabled: true, firstTabOffered: true } }]);
      expect(answers).toEqual(['keep']);
      expect(root.querySelector('.first-tab-offer')).toBe(null);
    } finally { unmount(); }
  });

  it('"Keep it" runs the step before the setting, so Home pins its own tab first', async () => {
    /** @type {string[]} */
    const log = [];
    const { root, answers, unmount } = mountOffer({ ok: true }, {
      log, beforeKeep: async () => { log.push('pin this tab'); },
    });
    try {
      button(root, 'Keep it').click();
      await settle();
      expect(log).toEqual(['pin this tab', 'send']);
      expect(answers).toEqual(['keep']);
    } finally { unmount(); }
  });

  it('a refused "Keep it" stays, says what failed and what to do, and can be tried again', async () => {
    for (const reply of [{ ok: false, error: 'kernel-route-unauthorized' }, new Error('port closed')]) {
      const { root, answers, unmount } = mountOffer(reply);
      try {
        button(root, 'Keep it').click();
        await settle();
        expect(answers).toEqual([]);
        const error = root.querySelector('.first-tab-offer p.error');
        expect(error?.getAttribute('role')).toBe('alert');
        expect(error?.textContent).toBe('peerd could not turn this on. Try again, or turn it on in Settings.');
        expect(/** @type {HTMLButtonElement} */ (button(root, 'Keep it')).disabled).toBe(false);
      } finally { unmount(); }
    }
  });

  it('"Not now" hides at once and only records the answer', async () => {
    const { root, sent, answers, unmount } = mountOffer({ ok: true });
    try {
      button(root, 'Not now').click();
      expect(answers).toEqual(['later']);
      await settle();
      expect(sent).toEqual([{ type: 'settings/update', patch: { firstTabOffered: true } }]);
      expect(root.querySelector('.first-tab-offer')).toBe(null);
    } finally { unmount(); }
  });
});

describe('side panel: the first tab offer', () => {
  const READY = { canSend: true };
  /**
   * @param {{ firstTabEnabled?: boolean, firstTabOffered?: boolean }} settings
   * @param {{ canSend?: boolean, messages?: number }} [options]
   */
  const state = (settings, { canSend = true, messages = 0 } = {}) => ({
    settings: { firstTabEnabled: false, firstTabOffered: false, ...settings },
    composer: { ...READY, canSend },
    session: { messages: Array.from({ length: messages }, () => ({})) },
  });
  /** @param {unknown} reply */
  const mountPanel = (reply) => {
    /** @type {Msg[]} */
    const sent = [];
    const handedBack = { count: 0 };
    const prompt = makePanelFirstTab({
      send: async (/** @type {Msg} */ msg) => { sent.push(msg); return reply; },
      afterAnswer: () => { handedBack.count += 1; },
    });
    let current = state({});
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.mount(root, { view: () => prompt.view(current) });
    return {
      root, sent, handedBack,
      show: (/** @type {ReturnType<typeof state>} */ next) => { current = next; m.redraw.sync(); },
      unmount: () => { m.mount(root, null); root.remove(); },
    };
  };

  it('waits until peerd can answer, so it never stacks on the provider setup', () => {
    const panel = mountPanel({ ok: true });
    try {
      panel.show(state({}, { canSend: false }));
      expect(panel.root.querySelector('.first-tab-offer')).toBe(null);
      panel.show(state({}));
      expect(panel.root.querySelector('.first-tab-offer h2')?.textContent).toBe('Keep peerd as the first tab?');
    } finally { panel.unmount(); }
  });

  it('after "Keep it", one line says what changed, until the chat starts', async () => {
    const panel = mountPanel({ ok: true });
    try {
      panel.show(state({}));
      button(panel.root, 'Keep it').click();
      await settle();
      expect(panel.sent).toEqual([{ type: 'settings/update', patch: { firstTabEnabled: true, firstTabOffered: true } }]);
      // The settings push that follows says the offer was answered.
      panel.show(state({ firstTabEnabled: true, firstTabOffered: true }));
      const kept = panel.root.querySelector('p.first-tab-kept');
      expect(kept?.getAttribute('role')).toBe('status');
      expect(kept?.textContent).toBe('peerd is now the first tab in every window.');
      expect(panel.root.querySelector('.first-tab-offer')).toBe(null);
      panel.show(state({ firstTabEnabled: true, firstTabOffered: true }, { messages: 1 }));
      expect(panel.root.querySelector('.first-tab-kept')).toBe(null);
    } finally { panel.unmount(); }
  });

  // The answer removes the button that had focus, so the panel moves focus on.
  it('each answer hands back to the panel, and a refused "Keep it" does not', async () => {
    const refused = mountPanel({ ok: false, error: 'kernel-route-unauthorized' });
    try {
      refused.show(state({}));
      button(refused.root, 'Keep it').click();
      await settle();
      expect(refused.handedBack.count).toBe(0);
    } finally { refused.unmount(); }
    for (const answer of ['Keep it', 'Not now']) {
      const panel = mountPanel({ ok: true });
      try {
        panel.show(state({}));
        button(panel.root, answer).click();
        await settle();
        expect(panel.handedBack.count).toBe(1);
      } finally { panel.unmount(); }
    }
  });

  it('"Not now", or an answer from another surface, hides it with no line', () => {
    const panel = mountPanel({ ok: true });
    try {
      panel.show(state({}));
      button(panel.root, 'Not now').click();
      m.redraw.sync();
      expect(panel.root.innerHTML).toBe('');
      expect(panel.sent).toEqual([{ type: 'settings/update', patch: { firstTabOffered: true } }]);
    } finally { panel.unmount(); }
    const other = mountPanel({ ok: true });
    try {
      other.show(state({ firstTabOffered: true }));
      expect(other.root.innerHTML).toBe('');
    } finally { other.unmount(); }
  });
});

describe('home: the first tab hint', () => {
  /** @returns {{ root: HTMLElement, dismissed: { count: number }, unmount: () => void }} */
  const mountHint = () => {
    const dismissed = { count: 0 };
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.mount(root, { view: () => m(FirstTabHint, { onDismiss: () => { dismissed.count += 1; } }) });
    return { root, dismissed, unmount: () => { m.mount(root, null); root.remove(); } };
  };

  it('says where peerd lives, in a section named by its heading', () => {
    const { root, unmount } = mountHint();
    try {
      expect(root.querySelector('section.first-tab-hint')?.getAttribute('aria-labelledby')).toBe('first-tab-hint-title');
      expect(root.querySelector('#first-tab-hint-title')?.textContent).toBe('peerd lives here.');
      expect(root.textContent).toContain('Click P anytime to ask peerd or open your apps.');
    } finally { unmount(); }
  });

  it('"Got it" and Escape both dismiss it', () => {
    const { root, dismissed, unmount } = mountHint();
    try {
      button(root, 'Got it').click();
      expect(dismissed.count).toBe(1);
      const ok = button(root, 'Got it');
      ok.focus();
      ok.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(dismissed.count).toBe(2);
      ok.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(dismissed.count).toBe(2);
    } finally { unmount(); }
  });
});
