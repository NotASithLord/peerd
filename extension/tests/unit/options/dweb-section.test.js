// @ts-check

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { DwebSection } from '/options/sections/dweb.js';
import browser from '/shared/browser-api.js';

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  m.redraw.sync?.();
};

// The switch carries no text - its accessible name is the assertion surface,
// which is also what a screen reader announces. That is the point of the row:
// the control states WHERE YOU STAND, so the test can read the same string the
// user hears instead of an imperative like "Disable dweb".
/** @param {HTMLElement} root */
const networkSwitch = (root) => /** @type {HTMLButtonElement} */ (
  root.querySelector('button[role="switch"]')
);
/** @param {HTMLElement} root */
const rowState = (root) => ({
  name: networkSwitch(root)?.getAttribute('aria-label') ?? '',
  checked: networkSwitch(root)?.getAttribute('aria-checked') ?? '',
  pill: root.querySelector('.set-pill')?.textContent ?? '',
  badge: root.querySelector('.set-badge')?.textContent ?? '',
});

describe('options.dweb live-stop status', () => {
  it('routes Commons to an explicit Discover choice without changing network consent', async () => {
    const root = document.createElement('div'); document.body.appendChild(root);
    const state = {settings:{dwebEnabled:true,dwebAgentEnabled:false}};
    let writes = 0;
    let opened = '';
    const tabs = /** @type {any} */ (browser.tabs);
    const originalQuery = tabs.query, originalCreate = tabs.create;
    tabs.query = async () => [];
    tabs.create = async (/** @type {{url:string}} */ options) => {opened=options.url; return {id:1};};
    m.mount(root,{view:()=>m(DwebSection,{state,send:async()=>{writes++;return {ok:true};},loadStatus:async()=>null})});
    try {
      expect(root.textContent).toContain('Add and open Commons');
      expect(root.textContent).toContain('same named room');
      expect(root.textContent.includes('pre-loaded')).toBe(false);
      /** @type {HTMLButtonElement} */ ([...root.querySelectorAll('button')].find(button=>button.textContent==='Open Discover')).click();
      await settle();
      expect(opened).toBe(`${browser.runtime.getURL('home/home.html')}#discover`);
      expect(writes).toBe(0);
      expect(rowState(root).checked).toBe('true');
    } finally {
      tabs.query = originalQuery; tabs.create = originalCreate;
      m.mount(root,null);root.remove();
    }
  });

  it('reports an incomplete stop and keeps the retry explicit', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = { settings: { dwebEnabled: true, dwebAgentEnabled: false } };
    /** @type {any[]} */
    const calls = [];
    let attempt = 0;
    const send = async (/** @type {any} */ message) => {
      calls.push(message);
      attempt += 1;
      const reply = attempt === 1
        ? { ok: false, error: 'dweb-stop-failed', settings: { ...state.settings, dwebEnabled: false } }
        : { ok: true, settings: { ...state.settings, dwebEnabled: false } };
      state.settings = reply.settings;
      return reply;
    };
    m.mount(root, { view: () => m(DwebSection, { state, send, loadStatus: async () => null }) });
    try {
      expect(rowState(root).pill).toBe('ON');
      networkSwitch(root).click();
      await settle();

      // The setting persisted Off but the network did not stop. The row must
      // NOT read as a clean OFF - the badge is what carries the disagreement.
      const alert = root.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('live network could not be stopped');
      expect(rowState(root).badge).toBe('STILL RUNNING');
      const retry = [...root.querySelectorAll('button')]
        .find((button) => button.textContent === 'Retry stop');
      expect(!!retry).toBe(true);
      expect(retry?.disabled).toBe(false);

      retry?.click();
      await settle();
      expect(root.querySelector('[role="alert"]')).toBe(null);
      expect(rowState(root).badge).toBe('');
      expect(rowState(root).pill).toBe('OFF');
      expect(rowState(root).checked).toBe('false');
      expect(calls.map((call) => call.patch)).toEqual([
        { dwebEnabled: false },
        { dwebEnabled: false },
      ]);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });

  it('unknown lifecycle custody offers only read-only reload reconciliation', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state = { settings: { dwebEnabled: true, dwebAgentEnabled: false } };
    let calls = 0;
    const send = async () => {
      calls += 1;
      return {
        ok: false, error: 'raw host transport failure', outcomeKnown: false,
        outcomeKind: 'unknown', retryable: false,
      };
    };
    m.mount(root, { view: () => m(DwebSection, { state, send, loadStatus: async () => null }) });
    try {
      networkSwitch(root).click();
      await settle();
      expect(root.textContent).toContain('could not confirm whether the dweb change finished');
      expect(root.textContent.includes('raw host transport failure')).toBe(false);
      expect([...root.querySelectorAll('button')].some((button) =>
        button.textContent === 'Reload dweb status')).toBe(true);
      expect(rowState(root).badge).toBe('STATUS UNKNOWN');
      expect(rowState(root).name.includes('retry stopping')).toBe(false);
      expect([...root.querySelectorAll('button')].some((button) =>
        button.textContent === 'Reset section to defaults')).toBe(false);
      expect([...root.querySelectorAll('button[role="switch"]')].every((button) =>
        button.hasAttribute('disabled'))).toBe(true);
      expect(calls).toBe(1);
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });
});
