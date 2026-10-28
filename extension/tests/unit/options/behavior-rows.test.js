// @ts-check
// Options → Behavior, rebuilt on the settings row (P1).
//
// The redesign's promise was "friendlier, keeping ALL functionality", so what
// these guard is parity, not looks: every setting still present, on its band,
// and — the one defect the design never retracted — reasoning effort still
// offering all five levels rather than the three an earlier draft showed.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { BehaviorSection } from '/options/sections/behavior.js';

const SETTINGS = {
  frontDoorView: 'panel', firstTabEnabled: false, reasoningEnabled: true, reasoningEffort: 'medium',
  confirmWebWrites: true, schemaValidatedReplies: false, advancedAutomationEnabled: true,
  devMode: false, autoResumeInterruptedTurns: true, providerFailoverEnabled: true,
  providerFallbacks: [], prewalkEnabled: false, enginePrewalkEnabled: false,
  webActorActionSurface: 'tools', providerName: 'anthropic',
};

/** @param {any} [reply] what every send() answers */
const mount = (reply = { ok: true }) => {
  const sent = /** @type {any[]} */ ([]);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const send = async (/** @type {any} */ msg) => { sent.push(msg); return reply; };
  const state = { settings: { ...SETTINGS }, session: { permission: { confirmActions: false } } };
  m.mount(root, { view: () => m(BehaviorSection, { state, send }) });
  return { root, sent, unmount: () => { m.mount(root, null); root.remove(); } };
};

/** @param {ParentNode} scope @param {string} text */
const button = (scope, text) => {
  const el = [...scope.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!el) throw new Error(`missing button: ${text}`);
  return el;
};

const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => m.redraw.sync());

/** Click the reset trigger, then its Yes. */
/** @param {ParentNode} root */
const confirmReset = async (root) => {
  button(root, 'Reset section to defaults').click();
  m.redraw.sync();
  button(root, 'Yes').click();
  await settle();
};

describe('options.behavior — settings rows', () => {
  it('keeps every setting: twelve rows across three bands', async () => {
    const { root, unmount } = mount();
    try {
      expect(root.querySelectorAll('.set-row').length).toBe(12);
      const bands = [...root.querySelectorAll('.set-band-name')].map((e) => e.textContent);
      expect(bands).toEqual(['Safety', 'Behavior', 'Experimental & diagnostics']);
    } finally { unmount(); }
  });

  it('reasoning effort STILL offers all five levels', async () => {
    // An earlier design draft cut this to three ("Quick / Balanced / Thorough")
    // and the correction ledger never retracted it. Dropping two levels under
    // cover of a visual change would be a capability loss, so it is pinned here.
    const { root, unmount } = mount();
    try {
      const select = /** @type {HTMLSelectElement} */ (root.querySelector('#reasoning-effort'));
      expect(!!select).toBe(true);
      expect([...select.options].map((o) => o.value)).toEqual(['max', 'xhigh', 'high', 'medium', 'low']);
    } finally { unmount(); }
  });

  it('states where you stand without reading prose: a pill and a switch per toggle row', async () => {
    const { root, unmount } = mount();
    try {
      const pills = [...root.querySelectorAll('.set-pill')].map((e) => e.textContent);
      expect(pills.includes('ON')).toBe(true);
      expect(pills.includes('OFF')).toBe(true);
      const sw = /** @type {HTMLElement} */ (root.querySelector('.set-toggle'));
      expect(sw.getAttribute('role')).toBe('switch');
      expect(sw.getAttribute('aria-checked')).toBe('false');   // confirmActions: false
    } finally { unmount(); }
  });

  it('the rationale is collapsed until asked for', async () => {
    const { root, unmount } = mount();
    try {
      expect(root.querySelector('.set-why-body')).toBe(null);
      const why = /** @type {HTMLButtonElement} */ (root.querySelector('.set-why'));
      expect(why.getAttribute('aria-expanded')).toBe('false');
      why.click();
      m.redraw.sync?.() ?? m.redraw();
      expect(!!root.querySelector('.set-why-body')).toBe(true);
    } finally { unmount(); }
  });

  it('only the safety band is raised — the tier is visual, not just wording', async () => {
    const { root, unmount } = mount();
    try {
      const safety = [...root.querySelectorAll('.set-band')].filter((b) => b.classList.contains('is-safety'));
      expect(safety.length).toBe(1);
      expect(safety[0].textContent).toContain('Confirm before actions');
      expect(safety[0].textContent).toContain('Confirm before sending data out');
    } finally { unmount(); }
  });

  it('a toggle dispatches the same route the old button did', async () => {
    const { root, sent, unmount } = mount();
    try {
      const sw = /** @type {HTMLButtonElement} */ (root.querySelector('.set-toggle'));
      sw.click();
      await new Promise((r) => setTimeout(r, 0));
      // Confirm-before-actions rides permission/set, NOT settings/update — it
      // must not yank the user out of Plan as a side effect.
      expect(sent[0]).toEqual({ type: 'permission/set', confirmActions: true });
    } finally { unmount(); }
  });

  it('"Keep peerd as the first tab" sits under the toolbar button and turns on with one switch', async () => {
    const { root, sent, unmount } = mount();
    try {
      const labels = [...root.querySelectorAll('.set-row-label')].map((e) => e.textContent);
      expect(labels.indexOf('Keep peerd as the first tab')).toBe(labels.indexOf('Toolbar button') + 1);
      const sw = /** @type {HTMLButtonElement} */ (root.querySelector('button[aria-label="Keep peerd as the first tab - off"]'));
      expect(root.textContent).toContain('peerd adds no tab to your windows.');
      sw.click();
      await settle();
      expect(sent[0]).toEqual({ type: 'settings/update', patch: { firstTabEnabled: true } });
    } finally { unmount(); }
  });

  it('the reset asks first: the trigger sends nothing, Yes sends settings/reset once', async () => {
    const { root, sent, unmount } = mount();
    try {
      button(root, 'Reset section to defaults').click();
      m.redraw.sync();
      expect(sent.length).toBe(0);
      expect(root.textContent).toContain('Reset the settings on this page to their defaults?');
      // The trigger left the pointer's spot: a repeat click lands on the question.
      expect([...root.querySelectorAll('button')].some((b) => b.textContent === 'Reset section to defaults')).toBe(false);
      button(root, 'No').click();
      m.redraw.sync();
      expect(sent.length).toBe(0);
      await confirmReset(root);
      expect(sent.filter((msg) => msg.type === 'settings/reset').length).toBe(1);
      const status = root.querySelector('.key-msg.ok');
      expect(status?.getAttribute('role')).toBe('status');
      expect(status?.textContent).toBe('Section reset to defaults.');
    } finally { unmount(); }
  });

  it('keyboard focus lands on No, and comes back to the trigger', async () => {
    // The strip replaces the focused trigger. Without a hand-off a keyboard
    // user lands on <body> and tabs through the whole page to reach it.
    const { root, unmount } = mount();
    try {
      const trigger = button(root, 'Reset section to defaults');
      trigger.focus();
      trigger.click();
      m.redraw.sync();
      expect(document.activeElement).toBe(button(root, 'No'));
      button(root, 'No').click();
      m.redraw.sync();
      expect(document.activeElement).toBe(button(root, 'Reset section to defaults'));
      // After Yes the trigger comes back once the reset has replied.
      await confirmReset(root);
      expect(document.activeElement).toBe(button(root, 'Reset section to defaults'));
    } finally { unmount(); }
  });

  it('the reset covers every setting this page writes, the web actor surface included', async () => {
    // #119 added the surface row without its reset key, so a store user who
    // tried the code surface and pressed Reset stayed on it.
    const { root, sent, unmount } = mount();
    try {
      await confirmReset(root);
      const reset = sent.find((msg) => msg.type === 'settings/reset');
      for (const key of Object.keys(SETTINGS).filter((k) => k !== 'providerName')) {
        expect(reset?.keys).toContain(key);
      }
    } finally { unmount(); }
  });

  it('a failed reset says so instead of looking like a reset', async () => {
    const { root, unmount } = mount({ ok: false, outcomeKnown: true });
    try {
      await confirmReset(root);
      expect(root.querySelector('.key-msg.err')?.textContent).toBe('The section could not be reset.');
      // A known failure leaves the row retryable.
      expect(/** @type {HTMLButtonElement} */ (button(root, 'Reset section to defaults')).disabled).toBe(false);
    } finally { unmount(); }
  });
});
