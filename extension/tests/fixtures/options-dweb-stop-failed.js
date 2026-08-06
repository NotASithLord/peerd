// @ts-check
// Real-component fixture for the persisted-Off/live-stop-failed visual state.

import m from '/vendor/mithril/mithril.js';
import { DwebSection } from '/options/sections/dweb.js';

const state = { settings: { dwebEnabled: true, dwebAgentEnabled: false } };

/** @param {{ type: string } & Record<string, unknown>} message */
const send = async (message) => {
  if (message.type !== 'settings/update') return { ok: true };
  const settings = { ...state.settings, dwebEnabled: false };
  state.settings = settings;
  return { ok: false, error: 'dweb-stop-failed', settings };
};

const Fixture = {
  oncreate: () => {
    const disable = /** @type {HTMLButtonElement | null} */ (
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Disable dweb') ?? null
    );
    disable?.click();
  },
  view: () => m(DwebSection, {
    state,
    send,
    loadStatus: async () => null,
  }),
};

m.mount(document.getElementById('app'), Fixture);
