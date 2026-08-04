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
  frontDoorView: 'panel', reasoningEnabled: true, reasoningEffort: 'medium',
  confirmWebWrites: true, schemaValidatedReplies: false, advancedAutomationEnabled: true,
  devMode: false, autoResumeInterruptedTurns: true, providerFailoverEnabled: true,
  providerFallbacks: [], prewalkEnabled: false, enginePrewalkEnabled: false,
  webActorActionSurface: 'tools', providerName: 'anthropic',
};

const mount = () => {
  const sent = /** @type {any[]} */ ([]);
  const root = document.createElement('div');
  document.body.appendChild(root);
  const send = async (/** @type {any} */ msg) => { sent.push(msg); return { ok: true }; };
  const state = { settings: { ...SETTINGS }, session: { permission: { confirmActions: false } } };
  m.mount(root, { view: () => m(BehaviorSection, { state, send }) });
  return { root, sent, unmount: () => { m.mount(root, null); root.remove(); } };
};

describe('options.behavior — settings rows', () => {
  it('keeps every setting: eleven rows across three bands', async () => {
    const { root, unmount } = mount();
    try {
      expect(root.querySelectorAll('.set-row').length).toBe(11);
      const bands = [...root.querySelectorAll('.set-band-name')].map((e) => e.textContent);
      expect(bands).toEqual(['Safety', 'Behaviour', 'Experimental & diagnostics']);
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
});
