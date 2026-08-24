// @ts-check
// ModelPicker request ordering: a slow response for an OLD provider/options
// fingerprint must never overwrite the response for the CURRENT fingerprint.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ChatView } from '/sidepanel/components/chat-view.js';

/** @returns {{ promise: Promise<any>, resolve: (value: any) => void }} */
const deferred = () => {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync();
};

describe('sidepanel.model-picker request ordering', () => {
  it('ignores an old A response after an A → B → A options-key cycle', async () => {
    const oldARequest = deferred();
    const bRequest = deferred();
    const newARequest = deferred();
    let optionCalls = 0;
    const send = async (/** @type {{ type?: string }} */ msg) => {
      if (msg.type !== 'models/options') return { ok: true };
      optionCalls += 1;
      return [oldARequest.promise, bRequest.promise, newARequest.promise][optionCalls - 1];
    };
    const state = /** @type {any} */ ({
      session: {
        sessionId: 's-model-race', messages: [],
        permission: { mode: 'act', confirmActions: false },
      },
      providers: { hasKey: true, current: 'peerd' },
      settings: {
        providerName: 'peerd', providerModel: '', openrouterModels: [],
        voiceOnboardingDismissed: true, voiceEnabled: false,
      },
      goalRuns: {},
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.mount(root, { view: () => m(ChatView, {
      state, send, voiceManager: null, uiActions: {},
    }) });

    try {
      expect(optionCalls).toBe(1);
      state.settings.providerName = 'anthropic';
      state.providers.current = 'anthropic';
      m.redraw.sync();
      expect(optionCalls).toBe(2);

      state.settings.providerName = 'peerd';
      state.providers.current = 'peerd';
      m.redraw.sync();
      expect(optionCalls).toBe(3);

      newARequest.resolve({
        ok: true,
        options: [
          { value: 'peerd::new-a', label: 'New A', provider: 'peerd', providerLabel: 'peerd' },
          { value: 'peerd::new-b', label: 'New B', provider: 'peerd', providerLabel: 'peerd' },
        ],
        selected: 'peerd::new-a',
      });
      await flush();
      expect(/** @type {HTMLSelectElement | null} */ (
        root.querySelector('select.model-picker-select'))?.value).toBe('peerd::new-a');

      oldARequest.resolve({
        ok: true,
        options: [
          { value: 'peerd::old-a', label: 'Old A', provider: 'peerd', providerLabel: 'peerd' },
          { value: 'peerd::old-b', label: 'Old B', provider: 'peerd', providerLabel: 'peerd' },
        ],
        selected: 'peerd::old-a',
      });
      await flush();
      expect(/** @type {HTMLSelectElement | null} */ (
        root.querySelector('select.model-picker-select'))?.value).toBe('peerd::new-a');
      expect(root.textContent?.includes('Old A')).toBe(false);

      bRequest.resolve({
        ok: true,
        options: [
          { value: 'anthropic::late-a', label: 'Late A', provider: 'anthropic', providerLabel: 'Anthropic' },
          { value: 'anthropic::late-b', label: 'Late B', provider: 'anthropic', providerLabel: 'Anthropic' },
        ],
        selected: 'anthropic::late-a',
      });
      await flush();
      expect(root.textContent?.includes('Late A')).toBe(false);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('keeps an unknown model change fenced until the exact same change settles', async () => {
    /** @type {any[]} */
    const changes = [];
    let optionReads = 0;
    const options = [
      { value: 'anthropic::old', model: 'old', label: 'Old', provider: 'anthropic', providerLabel: 'Anthropic' },
      { value: 'anthropic::new', model: 'new', label: 'New', provider: 'anthropic', providerLabel: 'Anthropic' },
    ];
    const send = async (/** @type {any} */ message) => {
      if (message.type === 'models/options') {
        optionReads += 1;
        return {
          ok: true, options, selected: 'anthropic::old', sessionProvider: 'anthropic',
        };
      }
      changes.push(message);
      return changes.length === 1
        ? { ok: false, outcomeKnown: false }
        : { ok: true, model: 'new' };
    };
    const state = /** @type {any} */ ({
      session: {
        sessionId: 's-model-unknown', provider: 'anthropic', model: 'old', messages: [],
        permission: { mode: 'act', confirmActions: false },
      },
      providers: { hasKey: true, current: 'anthropic' },
      settings: {
        providerName: 'anthropic', providerModel: 'old', openrouterModels: [],
        voiceOnboardingDismissed: true, voiceEnabled: false,
      },
      goalRuns: {},
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.mount(root, { view: () => m(ChatView, {
      state, send, voiceManager: null, uiActions: {},
    }) });
    try {
      await flush();
      const select = /** @type {HTMLSelectElement} */ (
        root.querySelector('select.model-picker-select'));
      select.value = 'anthropic::new';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(changes).toEqual([{
        type: 'session/setModel', sessionId: 's-model-unknown', model: 'new',
      }]);
      expect(optionReads).toBe(2);
      expect(select.disabled).toBe(true);
      expect(select.value).toBe('anthropic::new');
      expect(root.textContent).toContain('Model change unconfirmed.');

      const finish = [...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Finish same model change');
      expect(finish).toBeTruthy();
      finish?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      expect(changes).toEqual([
        { type: 'session/setModel', sessionId: 's-model-unknown', model: 'new' },
        { type: 'session/setModel', sessionId: 's-model-unknown', model: 'new' },
      ]);
      expect(select.disabled).toBe(false);
      expect(select.value).toBe('anthropic::new');
      expect(root.textContent?.includes('Model change unconfirmed.')).toBe(false);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('unlocks and restores authority after a known retry refusal', async () => {
    const options = [
      { value: 'anthropic::old', model: 'old', label: 'Old', provider: 'anthropic', providerLabel: 'Anthropic' },
      { value: 'anthropic::new', model: 'new', label: 'New', provider: 'anthropic', providerLabel: 'Anthropic' },
    ];
    let changes = 0;
    const send = async (/** @type {any} */ message) => {
      if (message.type === 'models/options') {
        return { ok: true, options, selected: 'anthropic::old', sessionProvider: 'anthropic' };
      }
      changes += 1;
      return changes === 1
        ? { ok: false, outcomeKnown: false }
        : { ok: false, outcomeKnown: true };
    };
    const state = /** @type {any} */ ({
      session: {
        sessionId: 's-model-refused', provider: 'anthropic', model: 'old', messages: [],
        permission: { mode: 'act', confirmActions: false },
      },
      providers: { hasKey: true, current: 'anthropic' },
      settings: {
        providerName: 'anthropic', providerModel: 'old', openrouterModels: [],
        voiceOnboardingDismissed: true, voiceEnabled: false,
      },
      goalRuns: {},
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    m.mount(root, { view: () => m(ChatView, {
      state, send, voiceManager: null, uiActions: {},
    }) });
    try {
      await flush();
      const select = /** @type {HTMLSelectElement} */ (
        root.querySelector('select.model-picker-select'));
      select.value = 'anthropic::new';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
      expect(select.disabled).toBe(true);
      const finish = [...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Finish same model change');
      finish?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
      expect(select.disabled).toBe(false);
      expect(select.value).toBe('anthropic::old');
      expect(root.textContent).toContain('Model change failed.');
      expect(root.textContent?.includes('Finish same model change')).toBe(false);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });
});
