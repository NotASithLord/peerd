// Actual component rendering with injected replies; network/install proof is separate.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { evalIn, waitFor } from './e2e-harness.mjs';

export const IMMUTABLE_ADDRESS_VISUAL_STATES = ['off', 'verified', 'rejected', 'unknown', 'installed'].map(mode => ({
  name: `manual-app-address-${mode}`, kind: 'visual', phase: 'pre-unlock', responder: null,
  async run(ctx, rec) {
    if (process.env.PEERD_VISUAL_BASE_RENDER === '1') {
      const tree = process.argv.find(arg => arg.startsWith('--extension='))?.slice(12);
      if (!tree) throw new Error('explicit base extension required');
      if (!existsSync(join(tree, 'home/immutable-address-section.js'))) {
        rec.observe('merge-base surface', { present: false, reason: 'manual addresses introduced on branch' }); return;
      }
    }
    rec.observe('scope', 'real Home address component with injected signed-summary/catalog replies; render-only proof');
    try {
      await evalIn(ctx.page, `(async () => {
        const m = (await import('/vendor/mithril/mithril.js')).default;
        const { ImmutableAddressSection } = await import('/home/immutable-address-section.js');
        const { encodeDidKey } = await import('/shared/address/did.js');
        const { formatDwappUri } = await import('/shared/address/dwapp-uri.js');
        const { immutableAppRoot } = await import('/shared/address/immutable-app-root.js');
        const address = formatDwappUri({ did: encodeDidKey(new Uint8Array(32)), hash: 'a'.repeat(64) });
        const target = immutableAppRoot(address);
        const key = 'peerd.manual-app-install.pending';
        window.__manualAddressPrior = sessionStorage.getItem(key); sessionStorage.removeItem(key);
        window.__manualAddressCalls = [];
        if (${JSON.stringify(mode)} === 'unknown') sessionStorage.setItem(key, address);
        const root = document.createElement('div'); root.id = 'e2e-manual-address';
        root.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--bg);padding:14px;overflow:auto;';
        document.body.append(root);
        const send = async message => {
          window.__manualAddressCalls.push(message);
          if (message.type === 'apps/list') return { ok: true, apps: ${JSON.stringify(mode)} === 'installed'
            ? [{ id: 'app-fixture', dweb: target }] : [] };
          if (message.type !== 'dweb/base/inspect-address') throw new Error('unexpected fixture mutation');
          return { ok: true, summary: { ...target, name: 'Peer-hosted WASM notebook',
            decodedBytes: 1200123, fileCount: 3, entryFile: 'index.html', containsWasm: true } };
        };
        m.mount(root, { view: () => m(ImmutableAddressSection, { send, enabled: ${mode !== 'off'} }) });
        m.redraw.sync();
        if (${JSON.stringify(mode)} !== 'unknown') {
          const input = root.querySelector('input'); input.value = address + (${JSON.stringify(mode)} === 'rejected' ? '/index.html' : '');
          input.dispatchEvent(new Event('input', { bubbles: true })); m.redraw.sync();
          if (${JSON.stringify(mode)} !== 'off') [...root.querySelectorAll('button')].find(button => button.textContent === 'Inspect App').click();
        }
      })()`, true);
      const label = mode === 'off' ? 'Pasting an address does not connect.' : mode === 'verified' ? 'Install and share'
        : mode === 'rejected' ? 'File paths are not supported' : mode === 'unknown' ? 'Refresh install status' : 'Open installed App';
      const ready = await waitFor(() => evalIn(ctx.page,
        `document.querySelector('#e2e-manual-address')?.textContent.includes(${JSON.stringify(label)})`), { budgetMs: 5000, pollMs: 50 });
      if (!ready) throw new Error(`manual address ${mode} did not render`);
      rec.check('expected explicit address posture rendered', ready);
      rec.check('render performs no network grant, installation or execution', await evalIn(ctx.page,
        `window.__manualAddressCalls.every(message => ['apps/list', 'dweb/base/inspect-address'].includes(message.type))
          && (${['off', 'rejected', 'unknown'].includes(mode)} ? window.__manualAddressCalls.length === 0 : window.__manualAddressCalls.length === 2)`));
      await rec.visual(`manual-app-address-${mode}`);
    } finally {
      await evalIn(ctx.page, `(async () => {
        const root = document.querySelector('#e2e-manual-address');
        if (root) { (await import('/vendor/mithril/mithril.js')).default.mount(root, null); root.remove(); }
        const key = 'peerd.manual-app-install.pending';
        if (typeof window.__manualAddressPrior === 'string') sessionStorage.setItem(key, window.__manualAddressPrior);
        else sessionStorage.removeItem(key);
        delete window.__manualAddressPrior; delete window.__manualAddressCalls;
      })()`, true);
    }
  },
}));
