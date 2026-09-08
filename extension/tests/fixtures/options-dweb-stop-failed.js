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
    // The switch is a role=switch button with no text content, so it is found
    // by its accessible name - the same string a screen reader would announce.
    const toggle = /** @type {HTMLButtonElement | null} */ (
      document.querySelector('button[role="switch"][aria-checked="true"]')
    );
    toggle?.click();
  },
  view: () => m(DwebSection, {
    state,
    send,
    loadStatus: async () => null,
  }),
};

m.mount(document.getElementById('app'), Fixture);
