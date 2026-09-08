// @ts-check
// §5h - the onboarding provider step's SAVE path (the skip path is covered
// by the funnel tests). The contracts under test: verify-before-switch (a
// failed one-token ping must leave the active provider untouched), the
// plaintext key leaving component state after a successful save, and the
// probe-earned REACHED chip.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ProviderStep } from '/sidepanel/components/onboarding-provider-step.js';

/** @typedef {Record<string, any>} Msg */

const ROWS = [
  { name: 'anthropic', label: 'Anthropic', keyless: false },
  { name: 'ollama', label: 'Ollama', keyless: true, liveModels: true },
  { name: 'local-webgpu', label: 'Local (WebGPU)', keyless: true, liveModels: false },
];

/**
 * @param {{ testOk?: boolean, ollamaOk?: boolean, ollamaModels?:number, settingsOk?: boolean,
 *   unknownOnce?: 'save'|'test'|'switch' }} [opts]
 */
const makeHarness = ({
  testOk = true, ollamaOk = false, ollamaModels = 2, settingsOk = true, unknownOnce,
} = {}) => {
  /** @type {Msg[]} */
  const sends = [];
  let doneCount = 0;
  let unknownSent = false;
  /** @param {Msg} msg */
  const send = async (msg) => {
    sends.push(msg);
    if (msg.type === 'provider/status') return { ok: true, providers: ROWS };
    if (msg.type === 'provider/setKey' && unknownOnce === 'save' && !unknownSent) {
      unknownSent = true;
      return { ok: false, outcomeKnown: false };
    }
    if (msg.type === 'provider/test') {
      if (msg.provider === 'ollama') return {
        ok: ollamaOk, reachable: true, models: ollamaModels,
      };
      if (unknownOnce === 'test' && !unknownSent) {
        unknownSent = true;
        return { ok: false, outcomeKnown: false };
      }
      return testOk ? { ok: true } : { ok: false, error: 'invalid-key' };
    }
    if (msg.type === 'settings/update') {
      if (unknownOnce === 'switch' && !unknownSent) {
        unknownSent = true;
        return { ok: false, outcomeKnown: false };
      }
      return settingsOk ? { ok: true } : { ok: false, error: 'settings-unavailable' };
    }
    return { ok: true };
  };
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m('div', m(ProviderStep, { send, onDone: () => { doneCount += 1; } })) });
  return {
    root, sends,
    doneCount: () => doneCount,
    unmount: () => { m.mount(root, null); root.remove(); },
  };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

/** @param {ParentNode} root @param {string} sel @returns {HTMLElement} */
const need = (root, sel) => {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return /** @type {HTMLElement} */ (el);
};

/** @param {ParentNode} root @param {string} value */
const typeKey = (root, value) => {
  const input = /** @type {HTMLInputElement} */ (need(root, '#onb-key'));
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('sidepanel.onboarding provider step (§5h)', () => {
  it('turns an initial status failure into a bounded visible retry', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let attempts = 0;
    const send = async (/** @type {Msg} */ msg) => {
      if (msg.type !== 'provider/status') return { ok: true };
      attempts += 1;
      if (attempts === 1) throw new Error('worker unavailable');
      return { ok: true, providers: ROWS };
    };
    m.mount(root, { view: () => m(ProviderStep, { send, onDone: () => {} }) });
    try {
      await tick();
      m.redraw.sync();
      expect(root.textContent).toContain('could not load provider choices');
      expect(root.textContent?.includes('Loading…')).toBe(false);
      const retry = [...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Retry loading providers');
      if (!(retry instanceof HTMLButtonElement)) throw new Error('provider retry missing');
      retry.click();
      await tick();
      m.redraw.sync();
      expect(root.querySelectorAll('.onb-provider-row').length).toBe(3);
      expect(root.textContent?.includes('could not load provider choices')).toBe(false);
      expect(attempts).toBe(2);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('renders the six-row shape: chips, an unusable on-device row, key input for the keyed lead', async () => {
    const h = makeHarness();
    try {
      await tick();
      m.redraw.sync();
      const rowEls = h.root.querySelectorAll('.onb-provider-row');
      expect(rowEls.length).toBe(3);
      expect(need(h.root, '.onb-provider-row.is-unusable').textContent).toContain('NOT YET USABLE');
      // Anthropic leads selected → the key input renders with its prefix hint.
      const input = /** @type {HTMLInputElement} */ (need(h.root, '#onb-key'));
      expect(input.getAttribute('placeholder')).toBe('sk-ant-...');
      expect(input.type).toBe('password');
    } finally { h.unmount(); }
  });

  it('a bad paste is refused before any send; nothing is saved or switched', async () => {
    const h = makeHarness();
    try {
      await tick();
      m.redraw.sync();
      typeKey(h.root, 'sk-or-wrong-provider-key');
      need(h.root, '.onboarding-actions button').click();
      await tick();
      m.redraw.sync();
      expect(need(h.root, '.key-msg').textContent).toContain('sk-ant-');
      expect(h.sends.some((s) => s.type === 'provider/setKey')).toBe(false);
      expect(h.sends.some((s) => s.type === 'settings/update')).toBe(false);
      expect(h.doneCount()).toBe(0);
    } finally { h.unmount(); }
  });

  it('save verifies BEFORE switching, clears the plaintext, then advances', async () => {
    const h = makeHarness({ testOk: true });
    try {
      await tick();
      m.redraw.sync();
      typeKey(h.root, 'sk-ant-api03-good-key');
      need(h.root, '.onboarding-actions button').click();
      await tick(); await tick(); await tick(); await tick();
      m.redraw.sync();
      const order = h.sends.filter((s) => s.type !== 'provider/status').map((s) => s.type);
      expect(order).toEqual(['provider/test', 'provider/setKey', 'provider/test', 'settings/update']);
      expect(h.sends.find((s) => s.type === 'provider/setKey')?.activate).toBe(false);
      expect(h.sends.find((s) => s.type === 'settings/update')?.patch?.providerName).toBe('anthropic');
      // The plaintext left component state with the save.
      const input = /** @type {HTMLInputElement|null} */ (h.root.querySelector('#onb-key'));
      expect(input ? input.value : '').toBe('');
      expect(h.doneCount()).toBe(1);
    } finally { h.unmount(); }
  });

  it('a failed verify keeps the active provider untouched and does not advance', async () => {
    const h = makeHarness({ testOk: false });
    try {
      await tick();
      m.redraw.sync();
      typeKey(h.root, 'sk-ant-api03-bad-key');
      need(h.root, '.onboarding-actions button').click();
      await tick(); await tick(); await tick(); await tick();
      m.redraw.sync();
      expect(h.sends.some((s) => s.type === 'settings/update')).toBe(false);
      expect(need(h.root, '.key-msg').textContent).toContain('rejected the key');
      expect(h.doneCount()).toBe(0);
    } finally { h.unmount(); }
  });

  for (const phase of ['save', 'test', 'switch']) {
    it(`an unconfirmed ${phase} resumes only that exact phase`, async () => {
      const h = makeHarness({ unknownOnce: /** @type {'save'|'test'|'switch'} */ (phase) });
      try {
        await tick();
        m.redraw.sync();
        typeKey(h.root, 'sk-ant-api03-resume-key');
        need(h.root, '.onboarding-actions button').click();
        await tick(); await tick(); await tick();
        m.redraw.sync();
        const label = phase === 'save' ? 'Finish the same save'
          : phase === 'test' ? 'Verify again' : 'Finish selection';
        expect(need(h.root, '.onboarding-actions button').textContent).toBe(label);
        expect(/** @type {HTMLInputElement} */ (need(h.root, '#onb-key')).disabled).toBe(true);
        const before = h.sends.filter((msg) => msg.provider === 'anthropic' || msg.type === 'settings/update');
        need(h.root, '.onboarding-actions button').click();
        await tick(); await tick(); await tick(); await tick();
        m.redraw.sync();
        expect(h.doneCount()).toBe(1);
        const after = h.sends.filter((msg) => msg.provider === 'anthropic' || msg.type === 'settings/update');
        const added = after.slice(before.length).map((msg) => msg.type);
        expect(added).toEqual(phase === 'save'
          ? ['provider/setKey', 'provider/test', 'settings/update']
          : phase === 'test' ? ['provider/test', 'settings/update'] : ['settings/update']);
        const saves = h.sends.filter((msg) => msg.type === 'provider/setKey');
        if (phase === 'save') {
          expect(saves.length).toBe(2);
          expect(saves[1]).toEqual(saves[0]);
        } else expect(saves.length).toBe(1);
      } finally { h.unmount(); }
    });
  }

  it('REACHED is earned: the chip appears only when the live probe answered ok', async () => {
    const reached = makeHarness({ ollamaOk: true });
    try {
      await tick(); await tick();
      m.redraw.sync();
      expect(reached.root.textContent).toContain('REACHED');
    } finally { reached.unmount(); }
    const down = makeHarness({ ollamaOk: false });
    try {
      await tick(); await tick();
      m.redraw.sync();
      expect((down.root.textContent ?? '').includes('REACHED')).toBe(false);
      expect(down.root.textContent).toContain('NO KEY NEEDED');
    } finally { down.unmount(); }
  });

  it('a reachable Ollama with zero models cannot finish onboarding', async () => {
    const h = makeHarness({ ollamaOk: false, ollamaModels: 0 });
    try {
      await tick(); await tick();
      m.redraw.sync();
      const ollama = [...h.root.querySelectorAll('.onb-provider-row')]
        .find((row) => row.textContent?.includes('Ollama'));
      if (!(ollama instanceof HTMLElement)) throw new Error('missing Ollama row');
      ollama.click();
      m.redraw.sync();
      expect(ollama.textContent).toContain('NO MODELS');
      expect(/** @type {HTMLButtonElement} */ (
        need(h.root, '.onboarding-actions button')
      ).disabled).toBe(true);
      expect(h.doneCount()).toBe(0);
    } finally { h.unmount(); }
  });

  it('a failed keyless switch stays on the provider step', async () => {
    const h = makeHarness({ settingsOk: false });
    try {
      await tick(); await tick();
      m.redraw.sync();
      const ollama = [...h.root.querySelectorAll('.onb-provider-row')]
        .find((row) => row.textContent?.includes('Ollama'));
      if (!(ollama instanceof HTMLElement)) throw new Error('missing Ollama row');
      ollama.click();
      m.redraw.sync();
      need(h.root, '.onboarding-actions button').click();
      await tick(); await tick();
      m.redraw.sync();
      expect(h.doneCount()).toBe(0);
      expect(need(h.root, '.key-msg').textContent).toContain('selection could not be saved');
      expect(need(h.root, '.key-msg').textContent?.includes('settings-unavailable')).toBe(false);
    } finally { h.unmount(); }
  });
});
