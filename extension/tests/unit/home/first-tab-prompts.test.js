// @ts-check
// "Keep peerd as the first tab": the turn-on after the first setup with its
// notice (on Home and in the side panel) and the hint in the pinned tab. These
// pin what peerd sends by itself, what each button sends, and when each one
// hides.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import {
  FirstTabHint, closeFirstTabs, makeFirstTabAuto, makePanelFirstTab,
} from '/home/first-tab-prompts.js';

/** @typedef {{ type: string, patch: Record<string, boolean> }} Msg */

const NEW_PROFILE = { firstTabEnabled: false, firstTabOffered: false };
const ON = { type: 'settings/update', patch: { firstTabEnabled: true, firstTabOffered: true } };
const OFF = { type: 'settings/update', patch: { firstTabEnabled: false } };

/**
 * @param {unknown | ((msg: Msg) => unknown)} reply what every send() answers
 * @param {{ steps?: boolean }} [options] steps - Home's tab steps, each one logged
 */
const mountAuto = (reply, { steps = false } = {}) => {
  /** @type {Msg[]} */
  const sent = [];
  /** @type {string[]} */
  const log = [];
  const step = (/** @type {string} */ name) => async () => { log.push(name); };
  const auto = makeFirstTabAuto({
    send: async (/** @type {Msg} */ msg) => {
      sent.push(msg);
      log.push('send');
      const answer = typeof reply === 'function' ? reply(msg) : reply;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    ...(steps ? { pinFirst: step('pin this tab'), unpin: step('unpin this tab'), closeTabs: step('close the tabs') } : {}),
    onChange: () => { log.push('changed'); },
    afterClose: () => { log.push('closed'); },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => auto.view() });
  return {
    root, sent, log,
    note: (settings = NEW_PROFILE, ready = true, sawSetup = true) => auto.note({ sawSetup, ready, settings }),
    unmount: () => { m.mount(root, null); root.remove(); },
  };
};

const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => m.redraw.sync());

/** @param {ParentNode} scope @param {string} text */
const button = (scope, text) => {
  const el = [...scope.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!el) throw new Error(`missing button: ${text}`);
  return el;
};
/** @param {ParentNode} scope */
const buttons = (scope) => [...scope.querySelectorAll('button')].map((b) => b.textContent);

describe('home: the first tab turn-on', () => {
  it('turns the setting on with no question, then says what changed in plain words', async () => {
    const { root, sent, note, unmount } = mountAuto({ ok: true });
    try {
      expect(root.innerHTML).toBe('');
      note();
      await settle();
      expect(sent).toEqual([ON]);
      const section = root.querySelector('section.first-tab-offer');
      expect(section?.getAttribute('aria-labelledby')).toBe('first-tab-offer-title');
      expect(root.querySelector('#first-tab-offer-title')?.textContent)
        .toBe('peerd is now the first tab in every window.');
      expect(root.querySelector('.first-tab-offer-text')?.getAttribute('role')).toBe('status');
      expect([...root.querySelectorAll('.first-tab-offer p')].map((p) => p.textContent))
        .toEqual(['You can change this in Settings.']);
      expect(buttons(root)).toEqual(['Got it', 'Turn off']);
    } finally { unmount(); }
  });

  it('does nothing for a profile that has its answer, has it on, or did not see setup here', async () => {
    const { root, sent, note, unmount } = mountAuto({ ok: true });
    try {
      note({ firstTabEnabled: false, firstTabOffered: true });
      note({ firstTabEnabled: true, firstTabOffered: false });
      note(NEW_PROFILE, false);
      note(NEW_PROFILE, true, false);
      await settle();
      expect(sent).toEqual([]);
      expect(root.innerHTML).toBe('');
    } finally { unmount(); }
  });

  it('turns on one time, whatever number of states come', async () => {
    const { sent, note, unmount } = mountAuto({ ok: true });
    try {
      note();
      note();
      await settle();
      // The settings push says it is on. A later push says the user turned it off in Settings.
      note({ firstTabEnabled: true, firstTabOffered: true });
      note(NEW_PROFILE);
      await settle();
      expect(sent).toEqual([ON]);
    } finally { unmount(); }
  });

  it('runs the step before the setting, so Home pins its own tab first', async () => {
    const { log, note, unmount } = mountAuto({ ok: true }, { steps: true });
    try {
      note();
      await settle();
      expect(log).toEqual(['pin this tab', 'send', 'changed']);
    } finally { unmount(); }
  });

  it('a refused turn-on says what failed and what to do, takes the pin back, and does not try again', async () => {
    for (const reply of [{ ok: false, error: 'kernel-route-unauthorized' }, new Error('port closed')]) {
      const { root, sent, log, note, unmount } = mountAuto(reply, { steps: true });
      try {
        note();
        await settle();
        expect(root.querySelector('#first-tab-offer-title')?.textContent).toBe('Keep peerd as the first tab');
        expect(root.querySelector('.first-tab-offer p.error')?.textContent)
          .toBe('peerd could not turn this on. Turn it on in Settings.');
        expect(buttons(root)).toEqual(['Got it']);
        expect(log).toEqual(['pin this tab', 'send', 'unpin this tab', 'changed']);
        // The settings still say that nobody did it. peerd does not loop.
        note();
        await settle();
        button(root, 'Got it').click();
        m.redraw.sync();
        note();
        await settle();
        expect(sent).toEqual([ON]);
        expect(root.innerHTML).toBe('');
      } finally { unmount(); }
    }
  });

  it('"Turn off" turns the setting off, keeps the record, takes the tabs back, then hides', async () => {
    const { root, sent, log, note, unmount } = mountAuto({ ok: true }, { steps: true });
    try {
      note();
      await settle();
      log.length = 0;
      button(root, 'Turn off').click();
      await settle();
      expect(sent).toEqual([ON, OFF]);
      expect(log).toEqual(['send', 'unpin this tab', 'close the tabs', 'changed', 'closed']);
      expect(root.innerHTML).toBe('');
      // The setting is off now, and peerd does not turn it on again.
      note({ firstTabEnabled: false, firstTabOffered: true });
      note(NEW_PROFILE);
      await settle();
      expect(sent).toEqual([ON, OFF]);
    } finally { unmount(); }
  });

  it('a refused "Turn off" stays, says what failed and what to do, and keeps the tabs', async () => {
    const { root, log, note, unmount } = mountAuto(
      (/** @type {Msg} */ msg) => ({ ok: msg.patch.firstTabEnabled === true }), { steps: true });
    try {
      note();
      await settle();
      log.length = 0;
      button(root, 'Turn off').click();
      await settle();
      const error = root.querySelector('.first-tab-offer p.error');
      expect(error?.getAttribute('role')).toBe('alert');
      expect(error?.textContent).toBe('peerd could not turn this off. Turn it off in Settings.');
      expect(log).toEqual(['send']);
      expect(/** @type {HTMLButtonElement} */ (button(root, 'Turn off')).disabled).toBe(false);
    } finally { unmount(); }
  });

  it('"Got it" only closes the notice', async () => {
    const { root, sent, log, note, unmount } = mountAuto({ ok: true }, { steps: true });
    try {
      note();
      await settle();
      log.length = 0;
      button(root, 'Got it').click();
      m.redraw.sync();
      expect(sent).toEqual([ON]);
      expect(log).toEqual(['closed']);
      expect(root.innerHTML).toBe('');
    } finally { unmount(); }
  });

  it('closes the pinned Home tabs, and keeps the tab that shows the notice', async () => {
    const home = 'chrome-extension://id/home/home.html';
    /** @type {unknown[]} */
    const calls = [];
    const tabs = {
      query: async (/** @type {{ pinned: boolean }} */ query) => {
        calls.push(query);
        return [{ id: 1, pinned: true, url: home }, { id: 2, pinned: true, url: `${home}#chat` },
          { id: 3, pinned: true, url: 'https://example.com/' }];
      },
      remove: async (/** @type {number[]} */ ids) => { calls.push(ids); },
    };
    await closeFirstTabs(tabs, home, 1);
    expect(calls).toEqual([{ pinned: true }, [2]]);
    calls.length = 0;
    await closeFirstTabs({ ...tabs, query: async () => [] }, home);
    expect(calls).toEqual([]);
  });
});

describe('side panel: the first tab turn-on', () => {
  const READY = { canSend: true };
  const home = 'chrome-extension://id/home/home.html';
  /**
   * @param {{ firstTabEnabled?: boolean, firstTabOffered?: boolean }} settings
   * @param {{ canSend?: boolean, messages?: number }} [options]
   */
  const state = (settings, { canSend = true, messages = 0 } = {}) => ({
    settings: { ...NEW_PROFILE, ...settings },
    composer: { ...READY, canSend },
    session: { messages: Array.from({ length: messages }, () => ({})) },
  });
  /** @param {unknown} reply */
  const mountPanel = (reply) => {
    /** @type {Msg[]} */
    const sent = [];
    /** @type {number[][]} */
    const removed = [];
    const handedBack = { count: 0 };
    const prompt = makePanelFirstTab({
      send: async (/** @type {Msg} */ msg) => { sent.push(msg); return reply; },
      tabs: {
        query: async () => [{ id: 7, pinned: true, url: home }, { id: 8, pinned: false, url: home }],
        remove: async (ids) => { removed.push(ids); },
      },
      homeUrl: home,
      afterClose: () => { handedBack.count += 1; },
    });
    let current = state({});
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.mount(root, { view: () => prompt.view(current) });
    return {
      root, sent, removed, handedBack,
      // Each state goes to the prompt first, as in sidepanel.js.
      show: (/** @type {ReturnType<typeof state>} */ next) => { current = next; prompt.note(next); m.redraw.sync(); },
      unmount: () => { m.mount(root, null); root.remove(); },
    };
  };

  it('waits until peerd can answer, so the notice never stacks on the provider setup', async () => {
    const panel = mountPanel({ ok: true });
    try {
      panel.show(state({}, { canSend: false }));
      await settle();
      expect(panel.sent).toEqual([]);
      expect(panel.root.innerHTML).toBe('');
      panel.show(state({}));
      await settle();
      expect(panel.sent).toEqual([ON]);
      expect(panel.root.querySelector('.first-tab-offer h2')?.textContent)
        .toBe('peerd is now the first tab in every window.');
    } finally { panel.unmount(); }
  });

  it('the notice stays through the settings push, until the chat starts', async () => {
    const panel = mountPanel({ ok: true });
    try {
      panel.show(state({}));
      await settle();
      panel.show(state({ firstTabEnabled: true, firstTabOffered: true }));
      expect(buttons(panel.root)).toEqual(['Got it', 'Turn off']);
      panel.show(state({ firstTabEnabled: true, firstTabOffered: true }, { messages: 1 }));
      expect(panel.root.innerHTML).toBe('');
      expect(panel.sent).toEqual([ON]);
    } finally { panel.unmount(); }
  });

  // Each button removes the button that had focus, so the panel moves focus on.
  it('"Turn off" closes the pinned Home tabs; each button hands back to the panel', async () => {
    const off = mountPanel({ ok: true });
    try {
      off.show(state({}));
      await settle();
      expect(off.handedBack.count).toBe(0);
      button(off.root, 'Turn off').click();
      await settle();
      expect(off.sent).toEqual([ON, OFF]);
      expect(off.removed).toEqual([[7]]);
      expect(off.handedBack.count).toBe(1);
      expect(off.root.innerHTML).toBe('');
    } finally { off.unmount(); }
    const ok = mountPanel({ ok: true });
    try {
      ok.show(state({}));
      await settle();
      button(ok.root, 'Got it').click();
      m.redraw.sync();
      expect(ok.removed).toEqual([]);
      expect(ok.handedBack.count).toBe(1);
      expect(ok.root.innerHTML).toBe('');
    } finally { ok.unmount(); }
  });

  it('a profile that another surface handled, or an existing profile, gets nothing', async () => {
    for (const settings of [{ firstTabOffered: true }, { firstTabEnabled: true }]) {
      const panel = mountPanel({ ok: true });
      try {
        panel.show(state(settings));
        await settle();
        expect(panel.sent).toEqual([]);
        expect(panel.root.innerHTML).toBe('');
      } finally { panel.unmount(); }
    }
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
