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
 * `local` models the on-device runner's REAL readiness, which is residency and
 * not the liveModels flag: 'installed' = weights here, 'empty' = supported host
 * with nothing downloaded, 'unsupported' = no host to run the engine at all.
 * @param {{ testOk?: boolean, ollamaOk?: boolean, settingsOk?: boolean,
 *   local?: 'installed'|'empty'|'unsupported' }} [opts]
 */
const makeHarness = ({
  testOk = true, ollamaOk = false, settingsOk = true, local = 'empty',
} = {}) => {
  /** @type {Msg[]} */
  const sends = [];
  let doneCount = 0;
  /** @param {Msg} msg */
  const send = async (msg) => {
    sends.push(msg);
    if (msg.type === 'provider/status') return { ok: true, providers: ROWS };
    if (msg.type === 'provider/test') {
      if (msg.provider === 'ollama') return { ok: ollamaOk, models: 2 };
      return testOk ? { ok: true } : { ok: false, error: 'invalid-key' };
    }
    if (msg.type === 'settings/update') {
      return settingsOk ? { ok: true } : { ok: false, error: 'settings-unavailable' };
    }
    if (msg.type === 'local-model/catalog') {
      if (local === 'unsupported') return { ok: false, error: 'runtime_capability_unavailable' };
      return { ok: true, models: [{ id: 'muse-glimmer-30b', available: local === 'installed' }] };
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
  it('renders the row shape, an undownloaded on-device row, key input for the keyed lead', async () => {
    const h = makeHarness();
    try {
      await tick(); await tick();
      m.redraw.sync();
      const rowEls = h.root.querySelectorAll('.onb-provider-row');
      expect(rowEls.length).toBe(3);
      expect(need(h.root, '.onb-provider-row.is-unusable').textContent).toContain('NOT DOWNLOADED');
      // Anthropic leads selected → the key input renders with its prefix hint.
      const input = /** @type {HTMLInputElement} */ (need(h.root, '#onb-key'));
      expect(input.getAttribute('placeholder')).toBe('sk-ant-...');
      expect(input.type).toBe('password');
    } finally { h.unmount(); }
  });

  it('the on-device runner is selectable once its weights are resident', async () => {
    // The regression this replaces: usability came from liveModels, which the
    // runner has no way to satisfy, so a shipped engine read NOT YET USABLE
    // even with a model downloaded.
    const ready = makeHarness({ local: 'installed' });
    try {
      await tick(); await tick();
      m.redraw.sync();
      const row = [...ready.root.querySelectorAll('.onb-provider-row')]
        .find((r) => r.textContent?.includes('On-device runner'));
      if (!(row instanceof HTMLButtonElement)) throw new Error('missing runner row');
      expect(row.textContent).toContain('ON DEVICE');
      expect(row.classList.contains('is-unusable')).toBe(false);
      expect(row.disabled).toBe(false);
    } finally { ready.unmount(); }
  });

  it('a host that cannot run the engine says so, not "not downloaded"', async () => {
    // Different facts: nothing downloaded yet vs. nowhere to run it.
    const h = makeHarness({ local: 'unsupported' });
    try {
      await tick(); await tick();
      m.redraw.sync();
      const row = need(h.root, '.onb-provider-row.is-unusable');
      expect(row.textContent).toContain('NOT AVAILABLE HERE');
      expect((row.textContent ?? '').includes('NOT DOWNLOADED')).toBe(false);
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
      // Mount-time probes (status, the daemon survey, the residency read) are
      // not part of the save sequence under test.
      const MOUNT_PROBES = ['provider/status', 'local-model/catalog'];
      const order = h.sends
        .filter((s) => !MOUNT_PROBES.includes(s.type))
        .filter((s) => !(s.type === 'provider/test' && s.activate === false))
        .map((s) => s.type);
      expect(order).toEqual(['provider/setKey', 'provider/test', 'settings/update']);
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
      expect(need(h.root, '.key-msg').textContent).toContain('settings-unavailable');
    } finally { h.unmount(); }
  });
});
