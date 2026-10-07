// @ts-check
import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ImmutableAddressSection } from '/home/immutable-address-section.js';
import { encodeDidKey } from '/shared/address/did.js';
import { formatDwappUri } from '/shared/address/dwapp-uri.js';
import { immutableAppRoot } from '/shared/address/immutable-app-root.js';

const key = 'peerd.manual-app-install.pending';
const address = formatDwappUri({ did: encodeDidKey(new Uint8Array(32)), hash: 'a'.repeat(64) });
const target = immutableAppRoot(address);
const summary = { ...target, name: 'Signed App', decodedBytes: 3, fileCount: 1, entryFile: 'index.html', containsWasm: false };
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); m.redraw.sync(); };
/** @param {HTMLElement} root @param {string} text */
const button = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text);
/** @param {HTMLElement} root @param {string} value */
const enter = (root, value) => {
  const input = /** @type {HTMLInputElement} */ (root.querySelector('input'));
  input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); m.redraw.sync();
};

/** @param {(message:any)=>Promise<any>} send @param {boolean} [enabled] */
const mount = (send, enabled = true) => {
  const root = document.createElement('div'); document.body.append(root);
  m.mount(root, { view: () => m(ImmutableAddressSection, { send, enabled }) });
  return { root, close: () => { m.mount(root, null); root.remove(); } };
};

describe('manual immutable App addresses', () => {
  it('pasting while off never grants network consent or sends a request', async () => {
    sessionStorage.removeItem(key); const calls = [];
    const view = mount(async message => { calls.push(message); return { ok: true }; }, false);
    try {
      enter(view.root, address);
      expect(button(view.root, 'Inspect App')?.disabled).toBe(true);
      expect(view.root.textContent).toContain('Pasting an address does not connect');
      expect(calls.length).toBe(0);
    } finally { view.close(); }
  });
  it('editing the input invalidates a late inspection and malformed roots never fetch', async () => {
    sessionStorage.removeItem(key);
    /** @type {(value:any)=>void} */ let resolve = () => { throw new Error('inspection not started'); };
    let calls = 0;
    const view = mount(() => { calls++; return new Promise(done => { resolve = done; }); });
    try {
      enter(view.root, `${address}/index.html`); button(view.root, 'Inspect App')?.click(); await settle();
      expect(calls).toBe(0);
      expect(view.root.textContent).toContain('File paths are not supported');
      enter(view.root, address); button(view.root, 'Inspect App')?.click(); await settle();
      enter(view.root, address.replace(/a{64}$/, 'b'.repeat(64)));
      resolve?.({ ok: true, summary }); await settle();
      expect(button(view.root, 'Install and share')).toBe(undefined);
      expect(calls).toBe(1);
    } finally { view.close(); }
  });
  it('inspection, installation and opening require separate explicit actions', async () => {
    sessionStorage.removeItem(key);
    /** @type {any[]} */ const calls = [];
    let installed = false;
    const view = mount(async message => {
      calls.push(message);
      if (message.type === 'dweb/base/inspect-address') return { ok: true, summary };
      if (message.type === 'dweb/base/install-address') { installed = true; return { ok: true, app: { id: 'app-test' } }; }
      if (message.type === 'apps/list') return { ok: true, apps: installed ? [{ id: 'app-test', dweb: target }] : [] };
      return { ok: true };
    });
    try {
      enter(view.root, address); button(view.root, 'Inspect App')?.click(); await settle();
      expect(calls.map(call => call.type)).toEqual(['dweb/base/inspect-address', 'apps/list']);
      expect(view.root.textContent).toContain('Signed by');
      expect(view.root.textContent).toContain('Decoded files');
      button(view.root, 'Install and share')?.click(); await settle();
      expect(calls.map(call => call.type)).toEqual(['dweb/base/inspect-address', 'apps/list', 'dweb/base/install-address']);
      expect(sessionStorage.getItem(key)).toBe(null);
      button(view.root, 'Inspect App')?.click(); await settle();
      expect(button(view.root, 'Install and share')).toBe(undefined);
      expect(button(view.root, 'Open installed App')?.disabled).toBe(false);
      expect(calls.filter(call => call.type === 'dweb/base/install-address').length).toBe(1);
      button(view.root, 'Open installed App')?.click(); await settle();
      expect(calls[5]).toEqual({ type: 'apps/open', appId: 'app-test' });
    } finally { view.close(); sessionStorage.removeItem(key); }
  });
  it('an uncertain install survives remount and only its exact catalog receipt unlocks recovery', async () => {
    for (const receipt of [null, { outcomeKnown: false }, { performed: true },
      { outcomeKind: 'effect-completed' }, { outcomeKind: 'host-lost' }, { outcomeKind: 'transport-lost' }]) {
      sessionStorage.removeItem(key); let installs = 0; let exact = false;
      const send = async (/** @type {any} */ message) => {
        if (message.type === 'dweb/base/inspect-address') return { ok: true, summary };
        if (message.type === 'dweb/base/install-address') {
          installs++;
          if (receipt === null) throw new Error('renderer deadline');
          return { ok: false, ...receipt };
        }
        return { ok: true, apps: [{ id: 'app-receipt', dweb: {
          uri: exact ? target.uri : 'other', hash: target.hash, publisher: target.publisher,
        } }] };
      };
      let view = mount(send);
      try {
        enter(view.root, address); button(view.root, 'Inspect App')?.click(); await settle();
        button(view.root, 'Install and share')?.click(); await settle();
        view.close(); view = mount(send); await settle();
        expect(view.root.querySelector('input')?.disabled).toBe(true);
        expect(button(view.root, 'Inspect App')?.disabled).toBe(true);
        button(view.root, 'Refresh install status')?.click(); await settle();
        expect(sessionStorage.getItem(key)).toBe(address);
        expect(installs).toBe(1);
        exact = true; button(view.root, 'Refresh install status')?.click(); await settle();
        expect(sessionStorage.getItem(key)).toBe(null);
        expect(button(view.root, 'Open installed App')?.disabled).toBe(false);
      } finally { view.close(); sessionStorage.removeItem(key); }
    }
  });
});
