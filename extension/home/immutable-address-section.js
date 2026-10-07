// @ts-check
import m from '/vendor/mithril/mithril.js';
import { immutableAppRoot } from '/shared/address/immutable-app-root.js';

/** @typedef {import('../options/sections/reset-row.js').Send} Send */
/** @typedef {{send:Send, enabled:boolean}} Attrs */
const PENDING_KEY = 'peerd.manual-app-install.pending';

// why: an uncertain install may commit after the renderer deadline or reload.
// Absence from a catalog read is not a receipt authorizing another install.
export const ImmutableAddressSection = () => {
  let input = '';
  let epoch = 0;
  let dead = false;
  let enabled = false;
  let busy = '';
  let error = '';
  /** @type {any} */ let preview = null;
  /** @type {ReturnType<typeof immutableAppRoot>|null} */ let pending = null;
  /** @type {string|null} */ let appId = null;
  const redraw = () => { if (!dead) m.redraw(); };
  const forgetPending = () => { sessionStorage.removeItem(PENDING_KEY); pending = null; };
  /** @param {Send} send */
  const inspect = async send => {
    if (!enabled || busy || pending) return;
    error = ''; preview = null; appId = null;
    let target;
    try { target = immutableAppRoot(input); }
    catch (cause) { error = /** @type {Error} */ (cause).message; return; }
    const requestEpoch = ++epoch;
    busy = 'inspect'; redraw();
    try {
      const reply = await send({ type: 'dweb/base/inspect-address', address: target.address });
      if (dead || !enabled || requestEpoch !== epoch) return;
      if (reply?.ok && reply.summary?.address === target.address
          && reply.summary?.uri === target.uri && reply.summary?.publisher === target.publisher
          && reply.summary?.hash === target.hash) {
        const catalog = await send({ type: 'apps/list' });
        if (dead || !enabled || requestEpoch !== epoch) return;
        if (!catalog?.ok || !Array.isArray(catalog.apps)) throw new Error('catalog-unavailable');
        preview = reply.summary;
        appId = catalog.apps.find((/** @type {any} */ app) => app.dweb?.uri === target.uri
          && app.dweb?.hash === target.hash && app.dweb?.publisher === target.publisher)?.id ?? null;
      } else error = 'Could not verify this App. Check the address and peer-network connection, then try again.';
    } catch {
      if (requestEpoch === epoch) error = 'Could not inspect this App. Try again when the peer network is available.';
    } finally { busy = ''; redraw(); }
  };
  /** @param {Send} send */
  const install = async send => {
    if (!enabled || busy || pending || !preview) return;
    const target = immutableAppRoot(input);
    if (target.address !== preview.address) return;
    pending = target;
    // Persist BEFORE sending so reload keeps its UI receipt; the host owns cross-tab deduplication.
    try { sessionStorage.setItem(PENDING_KEY, target.address); }
    catch { pending = null; error = 'Could not retain the install receipt. Try again after reloading.'; return; }
    busy = 'install'; error = ''; redraw();
    try {
      const reply = await send({ type: 'dweb/base/install-address', address: target.address });
      if (reply?.ok && typeof reply.app?.id === 'string') {
        appId = reply.app.id;
        forgetPending();
        error = reply.warning === 'audit-write-failed' ? 'Installed, but the security audit entry could not be written.' : '';
        window.dispatchEvent(new CustomEvent('peerd:app-installed', { detail: { appId } }));
      } else if (reply?.ok === false && reply?.outcomeKnown !== false && reply?.performed !== true
          && !['effect-completed', 'host-lost', 'transport-lost'].includes(reply?.outcomeKind)) {
        forgetPending();
        error = 'Could not install this App. Its bytes or network availability may have changed. Inspect it again.';
        preview = null;
      }
    } catch { /* no receipt: keep the exact pending address fenced */ }
    finally { busy = ''; redraw(); }
  };
  /** @param {Send} send */
  const reconcile = async send => {
    if (!pending || busy) return;
    busy = 'reconcile'; error = ''; redraw();
    try {
      const result = await send({ type: 'apps/list' });
      const match = result?.ok && Array.isArray(result.apps) && result.apps.find((/** @type {any} */ app) =>
        app.dweb?.uri === pending?.uri && app.dweb?.hash === pending?.hash
        && app.dweb?.publisher === pending?.publisher);
      if (typeof match?.id === 'string') { appId = match.id; forgetPending(); }
      else error = 'No completed install receipt yet. The original request may still finish; another install remains blocked.';
    } catch { error = 'Could not read the Library. Refresh to reconcile again.'; }
    finally { busy = ''; redraw(); }
  };
  /** @param {Send} send */
  const open = async send => {
    if (!appId || busy) return;
    busy = 'open'; error = ''; redraw();
    try { if (!(await send({ type: 'apps/open', appId }))?.ok) error = 'Could not open the installed App.'; }
    catch { error = 'Could not confirm whether the App opened. Check your tabs.'; }
    finally { busy = ''; redraw(); }
  };
  return {
    oninit() {
      try {
        const saved = sessionStorage.getItem(PENDING_KEY);
        if (saved) { pending = immutableAppRoot(saved); input = pending.address; }
      } catch { error = 'Could not read the pending install receipt. Reload before installing.'; busy = 'receipt'; }
    },
    onremove() { dead = true; epoch++; },
    /** @param {{attrs:Attrs}} vnode */
    view({ attrs }) {
      if (enabled && !attrs.enabled) { epoch++; preview = null; }
      enabled = attrs.enabled;
      const details = preview && m('div', [
        m('h3', preview.name === null ? 'No signed App name' : preview.name),
        m('p', 'The manifest signature and content address match. This is not a safety review.'),
        m('dl', { style: 'overflow-wrap:anywhere;' }, [
          m('dt', 'Signed by'), m('dd', preview.publisher),
          m('dt', 'Exact revision'), m('dd', preview.hash),
          m('dt', 'Decoded files'), m('dd', `${preview.decodedBytes} bytes in ${preview.fileCount} ${preview.fileCount === 1 ? 'file' : 'files'}`),
          m('dt', 'Entry file'), m('dd', preview.entryFile),
        ]),
        preview.containsWasm ? m('p', 'Contains a .wasm file. Runtime compatibility has not been tested.') : null,
        m('p', 'Installing also shares this exact revision with peers while the peer network is enabled. It does not run the App.'),
      ]);
      return m('section.card', { 'aria-label': 'App address', style: 'margin:12px 0;padding:14px;overflow-wrap:anywhere;' }, [
        m('h3', 'Inspect an App address'),
        m('p', 'Paste a publisher-qualified dwapp://content/ address. Root App addresses only.'),
        m('input', {
          type: 'text', value: input, maxlength: 4096, 'aria-label': 'App address',
          placeholder: 'dwapp://content/publisher-key/manifest-hash',
          style: 'width:100%;box-sizing:border-box;', disabled: !!pending || busy === 'receipt',
          oninput: (/** @type {{target:HTMLInputElement}} */ event) => {
            input = event.target.value; epoch++; preview = null; appId = null; error = '';
          },
        }),
        !enabled ? m('p', 'Enable the peer network above before inspecting. Pasting an address does not connect.') : null,
        m('button.secondary', { type: 'button', disabled: !enabled || !!busy || !!pending || !input,
          onclick: () => inspect(attrs.send) }, busy === 'inspect' ? 'Fetching and verifying…' : 'Inspect App'),
        details,
        pending ? m('div', { role: 'status' }, [
          m('p', busy === 'install' ? 'Installing and sharing this revision…'
            : 'Peerd could not confirm whether the install finished. Refresh to reconcile before trying again.'),
          m('code', { style: 'display:block;overflow-wrap:anywhere;' }, pending.address),
          busy !== 'install' ? m('button.secondary', { disabled: !!busy, onclick: () => reconcile(attrs.send) }, 'Refresh install status') : null,
        ]) : appId ? m('button.secondary', { disabled: !!busy, onclick: () => open(attrs.send) }, 'Open installed App')
          : preview ? m('button.secondary', { disabled: !enabled || !!busy, onclick: () => install(attrs.send) }, 'Install and share') : null,
        error ? m('p.error', { role: 'alert' }, error) : null,
      ]);
    },
  };
};
