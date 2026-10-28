// Actual component rendering with injected replies; network/install proof is separate.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { evalIn, waitFor, PANEL_METRICS } from './e2e-harness.mjs';
import { discoverSurface } from './starter-visuals.mjs';

// Reads Discover sends while the peer network is on. Any other route but the
// inspection is an effect. why the copy read: a link page of an installed app
// asks whether its copy changed on this device, as the app page does.
const READS = ['apps/list', 'dweb/base/heard', 'bootstrap/ready', 'dweb/distributed/info', 'contacts/list', 'dweb/blocked-peers',
  'dweb/app-local-changes'];

// The older tree's separate address section, as it shipped.
const renderSection = (mode) => `(async () => {
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
})()`;

// The one-flow Discover: "Paste link" opens the share row in place, and
// "Check link" opens the app page for that exact link.
const renderShareLink = (mode) => `(async () => {
  const m = (await import('/vendor/mithril/mithril.js')).default;
  const { DiscoverSection } = await import('/home/discover-section.js');
  const { createEffects } = await import('/home/discover-model.js');
  const { encodeDidKey } = await import('/shared/address/did.js');
  const { formatDwappUri } = await import('/shared/address/dwapp-uri.js');
  const { immutableAppRoot } = await import('/shared/address/immutable-app-root.js');
  const address = formatDwappUri({ did: encodeDidKey(new Uint8Array(32)), hash: 'a'.repeat(64) });
  const target = immutableAppRoot(address);
  const key = 'peerd.manual-app-install.pending';
  window.__manualAddressPrior = sessionStorage.getItem(key); sessionStorage.removeItem(key);
  window.__manualAddressCalls = [];
  if (${JSON.stringify(mode)} === 'unknown') sessionStorage.setItem(key, address);
  // why: Discover's rules live in the full-tab sheet, which the side panel never loads.
  const sheet = document.createElement('link'); sheet.id = 'e2e-manual-address-sheet';
  sheet.rel = 'stylesheet'; sheet.href = '/options/options.css';
  await new Promise((resolve, reject) => { sheet.onload = resolve; sheet.onerror = reject; document.head.append(sheet); });
  const root = document.createElement('div'); root.id = 'e2e-manual-address';
  root.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--bg);padding:14px;overflow:auto;';
  document.body.append(root);
  const send = async message => {
    window.__manualAddressCalls.push(message);
    if (message.type === 'apps/list') return { ok: true, apps: ${JSON.stringify(mode)} === 'installed'
      ? [{ id: 'app-fixture', dweb: target }] : [] };
    if (message.type === 'dweb/base/heard') return { ok: true, apps: [] };
    if (message.type === 'contacts/list') return { ok: true, contacts: [] };
    if (message.type === 'dweb/blocked-peers') return { ok: true, blocked: [] };
    if (message.type === 'bootstrap/ready') return { ok: true, featureLeases: { leases: { dweb: { status: 'active' } } } };
    if (message.type === 'dweb/distributed/info') return { ok: true, running: true, linkedCount: 1 };
    if (message.type === 'dweb/app-local-changes') return { ok: true, changed: false };
    if (message.type !== 'dweb/base/inspect-address') throw new Error('unexpected fixture mutation');
    // why declared: a link check also reports what the verified files ask of peerd.
    return { ok: true, summary: { ...target, name: 'Peer-hosted WASM notebook',
      decodedBytes: 1200123, fileCount: 3, entryFile: 'index.html', containsWasm: true,
      declared: { hash: target.hash, dweb: true, instructions: false, observeAct: false } } };
  };
  const effects = createEffects();
  m.mount(root, { view: () => m(DiscoverSection, { send, enabled: ${mode !== 'off'}, effects }) });
  m.redraw.sync();
  if (${JSON.stringify(mode)} !== 'unknown') {
    root.querySelector('[data-paste-link]').click(); m.redraw.sync();
    const input = root.querySelector('input[aria-label="Share link"]');
    input.value = address + (${JSON.stringify(mode)} === 'rejected' ? '/index.html' : '');
    input.dispatchEvent(new Event('input', { bubbles: true })); m.redraw.sync();
    if (${JSON.stringify(mode)} !== 'off') root.querySelector('.disc-start-form button').click();
  }
})()`;

const SECTION_LABELS = { off: 'Pasting an address does not connect.', verified: 'Install and share',
  rejected: 'File paths are not supported', unknown: 'Refresh install status', installed: 'Open installed App' };
// What each share-link posture draws; the page probes wait for its panel button.
const panelButton = label => `[...(document.querySelector('#e2e-manual-address .disc-page .disc-panel')?.querySelectorAll('button') ?? [])]
  .some(button => button.textContent === ${JSON.stringify(label)} && !button.disabled)`;
// why the tree's own words: these states also render on the merge-base tree,
// in its words, and a check that took either would not prove the new ones.
const PHASE2 = discoverSurface().phase2;
const rootHas = (now, before) => `document.querySelector('#e2e-manual-address')?.textContent
  .includes(${JSON.stringify(PHASE2 ? now : before)})`;
const SHARE_LINK_READY = {
  off: rootHas('Turn on the peer network first.', 'Join the peer network first.'),
  verified: panelButton('Install and share'),
  rejected: rootHas('This link points to one file inside an app.', 'File paths are not supported'),
  unknown: `${panelButton(PHASE2 ? 'Check again' : 'Refresh')}
    && ${rootHas('peerd is not sure the install finished.', 'peerd could not confirm whether the install finished.')}`,
  installed: panelButton('Open'),
};

export const IMMUTABLE_ADDRESS_VISUAL_STATES = ['off', 'verified', 'rejected', 'unknown', 'installed', 'verified-narrow'].map(visualMode => {
const narrow = visualMode === 'verified-narrow';
const mode = narrow ? 'verified' : visualMode;
return ({
  name: `manual-app-address-${visualMode}`, kind: 'visual', phase: 'pre-unlock', responder: null,
  async run(ctx, rec) {
    const surface = discoverSurface();
    const legacy = surface.base && existsSync(join(surface.tree, 'home/immutable-address-section.js'));
    if (surface.base && !legacy && !surface.flow) {
      rec.observe('merge-base surface', { present: false, reason: 'manual addresses introduced on branch' }); return;
    }
    rec.observe('scope', legacy
      ? 'real Home address component with injected signed-summary/catalog replies; render-only proof'
      : 'real Discover share-link flow with injected signed-summary/catalog replies; render-only proof');
    try {
      if (narrow) await ctx.page.send('Emulation.setDeviceMetricsOverride', {width:320,height:1100,deviceScaleFactor:1,mobile:false});
      await evalIn(ctx.page, legacy ? renderSection(mode) : renderShareLink(mode), true);
      const ready = await waitFor(() => evalIn(ctx.page, legacy
        ? `document.querySelector('#e2e-manual-address')?.textContent.includes(${JSON.stringify(SECTION_LABELS[mode])})`
        : SHARE_LINK_READY[mode]), { budgetMs: 5000, pollMs: 50 });
      if (!ready) throw new Error(`manual address ${mode} did not render`);
      rec.check('expected explicit address posture rendered', ready);
      const inspects = ['verified', 'installed'].includes(mode) ? 1 : 0;
      rec.check('render performs no network grant, installation or execution', await evalIn(ctx.page, legacy
        ? `window.__manualAddressCalls.every(message => ['apps/list', 'dweb/base/inspect-address'].includes(message.type))
          && (${['off', 'rejected', 'unknown'].includes(mode)} ? window.__manualAddressCalls.length === 0 : window.__manualAddressCalls.length === 2)`
        // Discover reads while the network is on. With it off it sends nothing.
        : `window.__manualAddressCalls.every(message => ${JSON.stringify([...READS, 'dweb/base/inspect-address'])}.includes(message.type))
          && window.__manualAddressCalls.filter(message => message.type === 'dweb/base/inspect-address').length === ${inspects}
          && (${mode !== 'off'} || window.__manualAddressCalls.length === 0)`));
      if (narrow) rec.check('full signed identity and address fit the narrow viewport', await evalIn(ctx.page, `document.querySelector('#e2e-manual-address').scrollWidth <= innerWidth`));
      await rec.visual(`manual-app-address-${visualMode}`);
    } finally {
      await evalIn(ctx.page, `(async () => {
        const root = document.querySelector('#e2e-manual-address');
        if (root) { (await import('/vendor/mithril/mithril.js')).default.mount(root, null); root.remove(); }
        document.querySelector('#e2e-manual-address-sheet')?.remove();
        const key = 'peerd.manual-app-install.pending';
        if (typeof window.__manualAddressPrior === 'string') sessionStorage.setItem(key, window.__manualAddressPrior);
        else sessionStorage.removeItem(key);
        delete window.__manualAddressPrior; delete window.__manualAddressCalls;
      })()`, true);
      if (narrow) await ctx.page.send('Emulation.setDeviceMetricsOverride', PANEL_METRICS);
    }
  },
});
});
