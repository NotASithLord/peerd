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
import { PeerNetworkStep, PeerNetworkStatus, needsPeerNetworkChoice } from '/sidepanel/components/onboarding-network-step.js';
import { DWEB_ENABLED } from '/shared/channel-config.js';
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

// why poll instead of one fixed wait: the tease deletes on a timer, so "sleep
// 45ms, assert it shrank" is really "assert this runner delivered enough timer
// ticks in 45ms". A loaded CI box does not, and the test fails for a reason that
// has nothing to do with the contract. Waiting for the shrink itself keeps the
// meaning; a tease that never shrinks still fails, one budget later.
/** @param {ParentNode} root @param {number} [budgetMs] */
const teaseShrinks = async (root, budgetMs = 2000) => {
  const spans = () => root.querySelectorAll('.peer-name-mirror span').length;
  const deadline = performance.now() + budgetMs;
  let n = spans();
  while (n >= 5 && performance.now() < deadline) {
    await wait(5);
    m.redraw.sync();
    n = spans();
  }
  return n;
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
 * @param {{ state?: ChatState, send?: Send, reconcileState?:()=>Promise<any>,
 * messages?: any[], peerName?: string, onDone?:()=>void }} attrs
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

// §5h put the provider step in front of the greeting. The naming-funnel
// tests pass it the way a keyless user would - "I'll do this later" wears
// the same .onboarding-skip class and writes nothing.
/** @param {ParentNode} root */
const passProviderStep = async (root) => {
  await tick();          // provider/status resolves
  m.redraw.sync();
  await skipStep(root);
  if (root.querySelector('.onboarding-network')) await skipStep(root);
};

// The mount stubs answer every route, so raw send counts now include the
// provider step's provider/status probe - assertions read the completes.
/** @param {Msg[]} sends */
const completions = (sends) => sends.filter((s) => s.type === 'onboarding/complete');

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
        await passProviderStep(root);
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
        // Progress dots: four steps since §5h; the greeting is the active one.
        expect(root.querySelectorAll('.onb-dot').length).toBe(DWEB_ENABLED ? 5 : 4);
        expect(root.querySelectorAll('.onb-dot.is-on').length).toBe(1);
      } finally { unmount(); }
    });

    it('caps the name at PEER_NAME_MAX via the input maxlength', async () => {
      const { root, unmount } = mount(OnboardingView, {
        state: freshProfileState(),
        send: async () => ({ ok: true }),
      });
      try {
        await passProviderStep(root);
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
          await passProviderStep(root);
          // Past holdFull + a few del steps: the mirror must have shrunk.
          const shrunk = await teaseShrinks(root);
          expect(shrunk < 5).toBe(true);
          // Skipping through the whole funnel against a half-deleted
          // DISPLAY still sends the full stored name — the tease is
          // render-only and dies at the first step change.
          await skipStep(root);   // name → call-me
          await skipStep(root);   // call-me → notes
          await skipStep(root);   // notes → finish
          await tick();
          expect(completions(sends)[0].peerName).toBe('peerd');
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
        await passProviderStep(root);
        const input = need(root, '.peer-name-input', HTMLInputElement);
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await wait(220);
        m.redraw.sync();
        expect(completions(sends).length).toBe(0);
        // The call-me question is on screen (typing or typed).
        expect(root.querySelector('.peer-name-input')).toBe(null);
        expect(!!root.querySelector('.onb-ask')).toBe(true);
        // Two steps behind us now: provider + name.
        expect(root.querySelectorAll('.onb-dot.is-done').length).toBe(DWEB_ENABLED ? 3 : 2);
      } finally { unmount(); }
    });

    it('an emptied name falls back to peerd on blur — value AND mirror', async () => {
      const { root, unmount } = mount(OnboardingView, {
        state: freshProfileState(),
        send: async () => ({ ok: true }),
      });
      try {
        await passProviderStep(root);
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
          await passProviderStep(root);
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
        await passProviderStep(root);   // provider → name (writes nothing)
        await skipStep(root);
        await skipStep(root);
        await skipStep(root);
        await tick();
        const done = completions(sends);
        expect(done.length).toBe(1);
        expect(done[0].facts).toBe(null);
        expect(done[0].peerName).toBe('peerd');
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
        await passProviderStep(root);
        const name = need(root, '.peer-name-input', HTMLInputElement);
        name.value = 'jarvis';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        await skipStep(root);
        await skipStep(root);
        await skipStep(root);
        await tick();
        const done = completions(sends);
        expect(done[0].peerName).toBe('jarvis');
        expect(done[0].facts).toBe(null);
      } finally { unmount(); }
    });

    it('reconciles a committed completion when its state push is lost', async () => {
      /** @type {Msg[]} */ const sends = [];
      let reconciles = 0;
      const { root, unmount } = mount(OnboardingView, {
        state: freshProfileState(),
        send: async (msg) => { sends.push(msg); return { ok: true }; },
        reconcileState: async () => { reconciles += 1; },
      });
      try {
        await passProviderStep(root);
        await skipStep(root); await skipStep(root); await skipStep(root); await tick();
        expect(completions(sends).length).toBe(1);
        expect(reconciles).toBe(DWEB_ENABLED ? 2 : 1);
      } finally { unmount(); }
    });

    it('never replays an unknown completion and reconciles before releasing busy state', async () => {
      /** @type {Msg[]} */ const sends = [];
      let reconciles = 0;
      const { root, unmount } = mount(OnboardingView, {
        state: freshProfileState(),
        send: async (msg) => {
          sends.push(msg);
          if (msg.type === 'onboarding/complete') throw new Error('worker recycled');
          return { ok: true };
        },
        reconcileState: async () => { reconciles += 1; },
      });
      try {
        await passProviderStep(root);
        await skipStep(root); await skipStep(root); await skipStep(root); await tick();
        expect(completions(sends).length).toBe(1);
        expect(reconciles).toBe(DWEB_ENABLED ? 2 : 1);
        expect(root.textContent).toContain('could not confirm');
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
        await passProviderStep(root);              // provider → name
        await continueStep();                      // name → call-me
        type('#onb-call', 'Ari');
        await continueStep();                      // call-me → notes
        type('#onb-notes', 'Keep answers terse.');
        await continueStep();                      // notes → finish (Start)
        await tick();
        const done = completions(sends);
        expect(done.length).toBe(1);
        expect(done[0].facts).toEqual({ callMe: 'Ari', notes: 'Keep answers terse.' });
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


describe('peer-network onboarding consent', () => {
  it('asks existing profiles only when an explicit network choice is missing', () => {
    const state = freshProfileState({ settings: { dwebChoiceMade: false } });
    expect(needsPeerNetworkChoice(state)).toBe(true);
    expect(needsPeerNetworkChoice(freshProfileState({ settings: { dwebChoiceMade: true } }))).toBe(false);
    expect(needsPeerNetworkChoice(freshProfileState())).toBe(false);
    expect(needsPeerNetworkChoice({ ...state, vault: { ...state.vault, locked: true } })).toBe(false);
  });

  it('does not replay a persisted network decision after interrupted personal setup', async () => {
    /** @type {Msg[]} */ const sends = [];
    const { root, unmount } = mount(OnboardingView, {
      state: freshProfileState({ settings: { dwebChoiceMade: true, dwebEnabled: false } }),
      send: async message => { sends.push(message); return { ok: true }; },
    });
    try {
      await tick(); m.redraw.sync();
      await skipStep(root);
      expect(root.querySelector('.onboarding-network')).toBe(null);
      expect(!!root.querySelector('.peer-name-input')).toBe(true);
      expect(sends.filter(message => message.type === 'settings/update')).toEqual([]);
    } finally { unmount(); }
  });

  for (const [choice, enabled] of [['enable', true], ['skip', false]]) {
    it(`persists the explicit ${choice} choice without enabling agent execution`, async () => {
      /** @type {Msg[]} */ const sends = [];
      let completed = 0;
      const { root, unmount } = mount(PeerNetworkStep, {
        send: async (message) => { sends.push(message); return { ok: true }; },
        onDone: () => { completed += 1; },
      });
      try {
        await tick(); m.redraw.sync();
        expect(sends.length).toBe(0);
        need(root, `[data-network-choice="${choice}"]`).click();
        await tick(); m.redraw.sync();
        expect(sends.filter(message => message.type === 'settings/update')).toEqual([
          { type: 'settings/update', patch: { dwebEnabled: enabled } },
        ]);
        expect(completed).toBe(enabled ? 0 : 1);
        if (enabled) {
          need(root, '[data-network-choice="continue"]').click();
          expect(completed).toBe(1);
        }
      } finally { unmount(); }
    });
  }

  it('waits for persistence and does not advance or double-submit during a pending choice', async () => {
    let completed = 0;
    let sends = 0;
    /** @type {(value:any)=>void} */ let release = () => {};
    const pending = new Promise((resolve) => { release = resolve; });
    const { root, unmount } = mount(PeerNetworkStep, {
      send: async () => { sends += 1; return pending; },
      onDone: () => { completed += 1; },
    });
    try {
      need(root, '[data-network-choice="enable"]').click();
      need(root, '[data-network-choice="skip"]').click();
      await tick(); m.redraw.sync();
      expect(sends).toBe(1);
      expect(completed).toBe(0);
      expect(need(root, '[data-network-choice="enable"]', HTMLButtonElement).disabled).toBe(true);
      release({ ok: true }); await tick(); m.redraw.sync();
      expect(completed).toBe(0);
      need(root, '[data-network-choice="continue"]').click();
      expect(completed).toBe(1);
    } finally { release({ ok: false }); unmount(); }
  });

  it('reconciles failed persistence before permitting another choice', async () => {
    let completed = 0;
    let calls = 0;
    const { root, unmount } = mount(PeerNetworkStep, {
      send: async (message) => message.type === 'state/get'
        ? { ok: true, state: { settings: { dwebChoiceMade: false, dwebEnabled: false } } }
        : { ok: ++calls > 1 },
      onDone: () => { completed += 1; },
    });
    try {
      need(root, '[data-network-choice="enable"]').click(); await tick(); m.redraw.sync();
      expect(completed).toBe(0);
      expect(root.textContent).toContain('could not be confirmed');
      expect(need(root, '[data-network-choice="skip"]', HTMLButtonElement).disabled).toBe(true);
      need(root, '.onboarding-network .error + button').click(); await tick(); m.redraw.sync();
      need(root, '[data-network-choice="skip"]').click(); await tick(); m.redraw.sync();
      expect(completed).toBe(1);
    } finally { unmount(); }
  });
  it('allows continuing and disabling after persistence while startup remains pending', async () => {
    /** @type {Msg[]} */ const sends = [];
    let completed = 0;
    /** @type {(value:any)=>void} */ let release = () => {};
    const startup = new Promise(resolve => { release = resolve; });
    /** @type {(value:any)=>void} */ let releaseStatus = () => {};
    const status = new Promise(resolve => { releaseStatus = resolve; });
    /** @type {()=>void} */ let statusObserved = () => {};
    const statusRequested = new Promise(resolve => { statusObserved = () => resolve(undefined); });
    /** @type {()=>void} */ let observed = () => {};
    const persisted = new Promise(resolve => { observed = () => resolve(undefined); });
    const { root, unmount } = mount(PeerNetworkStep, {
      send: async message => {
        sends.push(message);
        if (message.type === 'bootstrap/ready') { statusObserved(); return status; }
        if (message.type === 'settings/update' && message.patch.dwebEnabled) return startup;
        if (message.type === 'state/get') {
          observed();
          return { ok: true, state: { settings: { dwebChoiceMade: true, dwebEnabled: true } } };
        }
        return { ok: true, running: false };
      },
      onDone: () => { completed += 1; },
    });
    try {
      need(root, '[data-network-choice="enable"]').click();
      await persisted; await tick(); m.redraw.sync();
      // Mounting the status child begins another asynchronous read. Observe
      // that read explicitly; persistence alone does not mean it has settled.
      await statusRequested;
      expect(root.textContent).toContain('Connecting to the peer network');
      releaseStatus({ ok: true });
      const deadline = performance.now() + 1_000;
      while (!root.textContent?.includes('offline') && performance.now() < deadline) {
        await tick(); m.redraw.sync();
      }
      expect(root.textContent).toContain('offline');
      expect(completed).toBe(0);
      expect(need(root, '[data-network-choice="continue"]', HTMLButtonElement).disabled).toBe(false);
      need(root, '.onboarding-actions button.secondary').click(); await tick(); m.redraw.sync();
      expect(sends.filter(message => message.type === 'settings/update')).toEqual([
        { type: 'settings/update', patch: { dwebEnabled: true } },
        { type: 'settings/update', patch: { dwebEnabled: false } },
      ]);
      expect(completed).toBe(1);
      release({ ok: true }); await tick(); m.redraw.sync();
      expect(completed).toBe(1);
      expect(root.querySelector('[data-network-choice="continue"]')).toBe(null);
    } finally { releaseStatus({ ok: false }); release({ ok: false }); unmount(); }
  });

  it('does not treat a legacy enabled default as consent or advance after unmount', async () => {
    /** @type {(value:any)=>void} */ let release = () => {};
    const startup = new Promise(resolve => { release = resolve; });
    /** @type {()=>void} */ let observed = () => {};
    const checked = new Promise(resolve => { observed = () => resolve(undefined); });
    let completed = 0;
    const { root, unmount } = mount(PeerNetworkStep, {
      send: async message => {
        if (message.type === 'settings/update') return startup;
        observed();
        return { ok: true, state: { settings: { dwebChoiceMade: false, dwebEnabled: true } } };
      },
      onDone: () => { completed += 1; },
    });
    try {
      need(root, '[data-network-choice="enable"]').click();
      await checked; await tick(); m.redraw.sync();
      expect(root.querySelector('[data-network-choice="continue"]')).toBe(null);
      expect(need(root, '[data-network-choice="enable"]', HTMLButtonElement).disabled).toBe(true);
    } finally { unmount(); }
    release({ ok: true }); await tick(); m.redraw.sync();
    expect(completed).toBe(0);
  });

  it('checks offline status without starting a host and retries only after a click', async () => {
    /** @type {Msg[]} */ const sends = [];
    const { root, unmount } = mount(PeerNetworkStatus, {
      send: async message => {
        sends.push(message);
        return { ok: true, featureLeases: { leases: { dweb: { status: 'idle' } } } };
      },
    });
    try {
      await tick(); m.redraw.sync();
      expect(root.textContent).toContain('offline');
      expect(sends).toEqual([{ type: 'bootstrap/ready' }]);
      need(root, 'button').click(); await tick(); m.redraw.sync();
      expect(sends.filter(message => message.type === 'dweb/base/start')).toEqual([
        { type: 'dweb/base/start' },
      ]);
    } finally { unmount(); }
  });

  it('retains an unknown stop across persisted-off rendering and confirms an explicit stop retry', async () => {
    let completed = 0;
    let mutations = 0;
    let reads = 0;
    /** @type {(value:any)=>void} */ let release = () => {};
    const reading = new Promise(resolve => { release = resolve; });
    const attrs = {
      enabled: true,
      send: async (/** @type {Msg} */ message) => {
        if (message.type === 'settings/update') return { ok: ++mutations > 1 };
        if (message.type === 'state/get') { reads += 1; return reading; }
        return { ok: true };
      },
      onDone: () => { completed += 1; },
    };
    const { root, unmount } = mount(PeerNetworkStep, attrs);
    try {
      need(root, '.onboarding-actions button.secondary').click(); await tick(); m.redraw.sync();
      attrs.enabled = false; m.redraw.sync();
      expect(root.textContent).toContain('could not be confirmed');
      expect(need(root, '.onboarding-actions button.secondary', HTMLButtonElement).disabled).toBe(true);
      need(root, '.error + button').click();
      need(root, '.error + button').click();
      expect(reads).toBe(1);
      release({ ok: true, state: { settings: { dwebChoiceMade: true, dwebEnabled: false } } });
      await tick(); m.redraw.sync();
      expect(root.textContent).toContain('shutdown is unconfirmed');
      expect(completed).toBe(0);
      expect(need(root, '.onboarding-actions button').textContent).toBe('Retry stopping');
      need(root, '.onboarding-actions button').click(); await tick(); m.redraw.sync();
      expect(mutations).toBe(2);
      expect(completed).toBe(1);
      expect(root.querySelector('[role="alert"]')).toBe(null);
    } finally { release({ ok: false }); unmount(); }
  });

});
