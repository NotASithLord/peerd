// @ts-check
// Onboarding flow — first-run gate, skip persistence, peer-name label.
//
// In-browser because this is a real Mithril component exercised against
// real DOM: the input+mirror peer name (transparent input owns the
// caret; the mirror paints brand-colored letter spans), the one-click
// Skip, and the assistant row label in the chat transcript. The SW side
// (profile store, user-doc seeding) is bun-tested; here we pin the
// component contract — what gets SENT and what gets RENDERED.

import { describe, it, expect } from '../../framework.js';
import m from '/vendor/mithril/mithril.js';
import { OnboardingView, needsOnboarding, TEASE, PROMPT_TYPE } from '/sidepanel/components/onboarding-view.js';
import { MessageList } from '/sidepanel/components/message-list.js';

/** @typedef {import('/sidepanel/components/onboarding-view.js').ChatState} ChatState */
/** @typedef {{ type: string } & Record<string, any>} Msg */
/** @typedef {(msg: Msg) => Promise<any>} Send */

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Shrink the tease cadence so timer-driven contracts run in real time
// (TEASE is exported mutable for exactly this — restore when done).
/** @param {() => Promise<void>} fn */
const withFastTease = async (fn) => {
  const saved = { ...TEASE };
  Object.assign(TEASE, { type: 5, del: 5, holdFull: 20, holdEmpty: 10 });
  try { await fn(); } finally { Object.assign(TEASE, saved); }
};

// A minimal stand-in for the full ChatState — needsOnboarding only reads
// vault + profile, so cast the fixture to the production type.
/** @param {Record<string, any>} [over] */
const freshProfileState = (over = {}) => /** @type {ChatState} */ ({
  vault: { initialized: true, locked: false },
  profile: { id: 'default', peerName: 'peerd', onboardingComplete: false },
  ...over,
});

// Query that asserts presence — a null here is a real test failure. The
// optional ctor drives the return type so .value/.focus/etc. resolve.
/**
 * @template {HTMLElement} [T=HTMLElement]
 * @param {ParentNode} root
 * @param {string} sel
 * @param {new () => T} [_ctor]
 * @returns {T}
 */
const need = (root, sel, _ctor) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return /** @type {T} */ (el);
};

// Mount into a real attached node (Mithril event handlers need the
// element in the document for .click() to behave like a user click).
/**
 * @param {any} component  a Mithril component (untyped — vendor m is any)
 * @param {{ state?: ChatState, send?: Send, messages?: any[], peerName?: string }} attrs
 */
const mount = (component, attrs) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(component, attrs) });
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

// Let the component's async send → redraw settle.
const tick = () => new Promise((r) => setTimeout(r, 0));


// Shrink the prompt-typing cadence for the whole suite (export-mutable,
// TEASE precedent) so step waits stay short and deterministic.
PROMPT_TYPE.ms = 1;

// Click a step's Skip and wait out the slide transition + prompt typing.
// (Tests run WITHOUT reduced motion, so the 170ms out-phase is real.)
/** @param {ParentNode} root */
const skipStep = async (root) => {
  // The question may still be typing — the fast-forward click reveals
  // the actions row (the same affordance impatient users get).
  /** @type {HTMLElement | null} */ (root.querySelector('.onb-step'))?.click();
  m.redraw.sync();
  need(root, '.onboarding-skip').click();
  await wait(230);
  m.redraw.sync();
  /** @type {HTMLElement | null} */ (root.querySelector('.onb-step'))?.click();   // fast-forward next prompt
  m.redraw.sync();
};

describe('sidepanel.onboarding', () => {
  describe('needsOnboarding (route gate)', () => {
    it('fires only for an unlocked vault with the latch open', () => {
      expect(needsOnboarding(freshProfileState())).toBe(true);
    });
    it('stays closed when onboarding already completed', () => {
      expect(needsOnboarding(freshProfileState({
        profile: { id: 'default', peerName: 'peerd', onboardingComplete: true },
      }))).toBe(false);
    });
    it('stays closed while the vault is locked or uninitialized', () => {
      expect(needsOnboarding(freshProfileState({
        vault: { initialized: true, locked: true },
      }))).toBe(false);
      expect(needsOnboarding(freshProfileState({
        vault: { initialized: false, locked: true },
      }))).toBe(false);
    });
    it('stays closed before any SW push delivered a profile', () => {
      expect(needsOnboarding(freshProfileState({ profile: undefined }))).toBe(false);
    });
  });

  describe('first-run screen', () => {
    it('shows the greeting with an editable peer name and the terminal cursor', async () => {
      const { root, unmount } = mount(OnboardingView, {
        state: freshProfileState(),
        send: async () => ({ ok: true }),
      });
      try {
        expect(root.textContent).toContain('Hello, I’m');
        // The name is a real input (it owns the caret) twinned with a
        // colored mirror; the input's text is transparent via CSS, so
        // the mirror is what the user actually reads.
        const input = need(root, '.peer-name-input', HTMLInputElement);
        expect(!!input).toBe(true);
        expect(input.value).toBe('peerd');
        expect(input.getAttribute('aria-label')).toContain('editable');
        const mirror = need(root, '.peer-name-mirror');
        expect(!!mirror).toBe(true);
        // One brand-colored span per character, cycling the five vars.
        const spans = mirror.querySelectorAll('span');
        expect(spans.length).toBe(5);
        expect(spans[0].style.color).toBe('var(--cyan)');
        expect(spans[4].style.color).toBe('var(--magenta)');
        // The mirror is decoration; the input is the control.
        expect(mirror.getAttribute('aria-hidden')).toBe('true');
        expect(!!root.querySelector('.onboarding-cursor')).toBe(true);
        // The FUNNEL shows one step at a time: at mount only the name
        // step exists — the questions arrive on later steps.
        expect(root.querySelector('#onb-call')).toBe(null);
        expect(root.querySelector('#onb-notes')).toBe(null);
        expect(!!root.querySelector('.onboarding-skip')).toBe(true);
        // Progress dots: step 1 of 3 active.
        expect(root.querySelectorAll('.onb-dot').length).toBe(3);
        expect(root.querySelectorAll('.onb-dot.is-on').length).toBe(1);
      } finally { unmount(); }
    });

    it('caps the name at PEER_NAME_MAX via the input maxlength', async () => {
      const { root, unmount } = mount(OnboardingView, {
        state: freshProfileState(),
        send: async () => ({ ok: true }),
      });
      try {
        expect(need(root, '.peer-name-input').getAttribute('maxlength')).toBe('32');
      } finally { unmount(); }
    });

    it('the tease type-deletes the mirror, and a MID-TEASE submit sends the FULL name', async () => {
      await withFastTease(async () => {
        /** @type {Msg[]} */
        const sends = [];
        const { root, unmount } = mount(OnboardingView, {
          state: freshProfileState(),
          send: async (msg) => { sends.push(msg); return { ok: true }; },
        });
        try {
          // Past holdFull + a few del steps: the mirror must have shrunk.
          await wait(45);
          m.redraw.sync();
          const shrunk = root.querySelectorAll('.peer-name-mirror span').length;
          expect(shrunk < 5).toBe(true);
          // Skipping through the whole funnel against a half-deleted
          // DISPLAY still sends the full stored name — the tease is
          // render-only and dies at the first step change.
          await skipStep(root);   // name → call-me
          await skipStep(root);   // call-me → notes
          await skipStep(root);   // notes → finish
          await tick();
          expect(sends[0].peerName).toBe('peerd');
        } finally { unmount(); }
      });
    });

    it('Enter in the name field advances the funnel without sending', async () => {
      /** @type {Msg[]} */
      const sends = [];
      const { root, unmount } = mount(OnboardingView, {
        state: freshProfileState(),
        send: async (msg) => { sends.push(msg); return { ok: true }; },
      });
      try {
        const input = need(root, '.peer-name-input', HTMLInputElement);
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await wait(220);
        m.redraw.sync();
        expect(sends.length).toBe(0);
        // Step 2 is on screen: the call-me question (typing or typed).
        expect(root.querySelector('.peer-name-input')).toBe(null);
        expect(!!root.querySelector('.onb-ask')).toBe(true);
        expect(root.querySelectorAll('.onb-dot.is-done').length).toBe(1);
      } finally { unmount(); }
    });

    it('an emptied name falls back to peerd on blur — value AND mirror', async () => {
      const { root, unmount } = mount(OnboardingView, {
        state: freshProfileState(),
        send: async () => ({ ok: true }),
      });
      try {
        const input = need(root, '.peer-name-input', HTMLInputElement);
        input.focus();
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        await tick();
        m.redraw.sync();
        expect(input.value).toBe('peerd');
        expect(root.querySelectorAll('.peer-name-mirror span').length).toBe(5);
      } finally { unmount(); }
    });

    it('typing recolors the mirror and stops the tease for good', async () => {
      await withFastTease(async () => {
        const { root, unmount } = mount(OnboardingView, {
          state: freshProfileState(),
          send: async () => ({ ok: true }),
        });
        try {
          const input = need(root, '.peer-name-input', HTMLInputElement);
          input.value = 'Jarvis';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await tick();
          m.redraw.sync();
          const spans = root.querySelectorAll('.peer-name-mirror span');
          expect(spans.length).toBe(6);
          expect([...spans].map((s) => s.textContent).join('')).toBe('Jarvis');
          // Sixth letter wraps the five-color cycle back to cyan.
          expect(/** @type {HTMLElement} */ (spans[5]).style.color).toBe('var(--cyan)');
          // "For good": well past a full fast-tease cycle, the mirror
          // still shows the typed name — no zombie timer resumed it.
          await wait(120);
          m.redraw.sync();
          expect(root.querySelectorAll('.peer-name-mirror span').length).toBe(6);
        } finally { unmount(); }
      });
    });
  });

  describe('skip', () => {
    it('skipping every step completes onboarding with facts:null (writes nothing)', async () => {
      /** @type {Msg[]} */
      const sends = [];
      const { root, unmount } = mount(OnboardingView, {
        state: freshProfileState(),
        send: async (msg) => { sends.push(msg); return { ok: true }; },
      });
      try {
        await skipStep(root);
        await skipStep(root);
        await skipStep(root);
        await tick();
        expect(sends.length).toBe(1);
        expect(sends[0].type).toBe('onboarding/complete');
        expect(sends[0].facts).toBe(null);
        expect(sends[0].peerName).toBe('peerd');
      } finally { unmount(); }
    });

    it('an edited peer name survives skipping the rest', async () => {
      /** @type {Msg[]} */
      const sends = [];
      const { root, unmount } = mount(OnboardingView, {
        state: freshProfileState(),
        send: async (msg) => { sends.push(msg); return { ok: true }; },
      });
      try {
        const name = need(root, '.peer-name-input', HTMLInputElement);
        name.value = 'jarvis';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        await skipStep(root);
        await skipStep(root);
        await skipStep(root);
        await tick();
        expect(sends[0].peerName).toBe('jarvis');
        expect(sends[0].facts).toBe(null);
      } finally { unmount(); }
    });
  });

  describe('start with facts', () => {
    it('submits the basic facts for user-doc seeding', async () => {
      /** @type {Msg[]} */
      const sends = [];
      const { root, unmount } = mount(OnboardingView, {
        state: freshProfileState(),
        send: async (msg) => { sends.push(msg); return { ok: true }; },
      });
      try {
        /**
         * @param {string} sel
         * @param {string} value
         */
        const type = (sel, value) => {
          const el = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (need(root, sel));
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const continueStep = async () => {
          // The non-skip action button (first button in the actions row).
          need(root, '.onboarding-actions button').click();
          await wait(230);
          m.redraw.sync();
          // Fast-forward the next question's typing reveal.
          /** @type {HTMLElement | null} */ (root.querySelector('.onb-step'))?.click();
          m.redraw.sync();
        };
        await continueStep();                      // name → call-me
        type('#onb-call', 'Ari');
        await continueStep();                      // call-me → notes
        type('#onb-notes', 'Keep answers terse.');
        await continueStep();                      // notes → finish (Start)
        await tick();
        expect(sends.length).toBe(1);
        expect(sends[0].type).toBe('onboarding/complete');
        expect(sends[0].facts).toEqual({ callMe: 'Ari', notes: 'Keep answers terse.' });
      } finally { unmount(); }
    });
  });

  describe('peerName in the chat transcript', () => {
    const assistantMsg = { id: 'a1', role: 'assistant', content: 'hello there' };

    it('labels the assistant row with the profile peer name', () => {
      const { root, unmount } = mount(MessageList, {
        messages: [assistantMsg],
        peerName: 'jarvis',
      });
      try {
        const role = need(root, '.message-assistant .role');
        expect(role.textContent).toBe('jarvis');
      } finally { unmount(); }
    });

    it('falls back to the brand name when no peerName is set', () => {
      const { root, unmount } = mount(MessageList, {
        messages: [assistantMsg],
      });
      try {
        const role = need(root, '.message-assistant .role');
        expect(role.textContent).toBe('peerd');
      } finally { unmount(); }
    });
  });
});
