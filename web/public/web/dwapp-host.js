// web/dwapp-host.js — run a dwapp ON THE PAGE, and bake new ones.
//
// The page-side host for the App substrate: a peer-authored bundle composes
// through the REAL peerd-engine/app-compose.js (the same inliner the
// extension's app tab uses) and runs in a sandboxed OPAQUE-ORIGIN iframe with
// a no-network CSP — peer code renders and computes, but can't reach the
// page, the mesh, or the outside world. why srcdoc+sandbox: it is the page
// equivalent of the extension's runner-tab isolation (seam audit: the
// substrate is host-agnostic; only the host differs).
//
// The one INWARD channel is a postMessage the pad template sends when its
// creator hits share — the host bakes the drawing into a fresh bundle
// (bakePixelPad) and the arena shares it as the visitor's OWN dwapp. That's
// the create → trade → remix loop.

import { composeApp } from '/peerd-engine/app-compose.js';

// No-network fence for peer bundles: a dwapp is self-contained by
// construction (compose inlines its files), so nothing legitimate needs the
// wire from inside.
const CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; media-src data: blob:; worker-src blob:;">';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Open a dwapp bundle in a sandboxed overlay. Returns a close().
 * `onPadExport(art)` fires when the running pad posts its drawing out
 * (create/remix flows); omit it for plain viewing.
 * @param {{ files: Record<string, string>, title?: string, onPadExport?: (art: number[]) => void }} opts
 */
export function openDwapp({ files, title = 'dwapp', onPadExport }) {
  let html;
  try { html = composeApp(files); }
  catch (e) { throw new Error(`dwapp won't compose: ${e?.message ?? e}`); }

  const overlay = document.createElement('div');
  overlay.className = 'dwapp-overlay';
  overlay.innerHTML = `
    <div class="dwapp-frame">
      <header><span class="ic k-dweb">◇</span><b>${esc(title)}</b>
        <span class="hint">sandboxed · opaque origin · no network</span>
        <button class="dwapp-close" title="close">✕</button></header>
      <iframe sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
    </div>`;
  const iframe = overlay.querySelector('iframe');
  iframe.srcdoc = html.includes('<head>') ? html.replace('<head>', `<head>${CSP}`) : CSP + html;

  const onMsg = (e) => {
    // only OUR iframe, only the pad-export shape
    if (e.source !== iframe.contentWindow) return;
    const d = e.data;
    if (d && d.__peerdPad === 1 && Array.isArray(d.art) && onPadExport) {
      onPadExport(d.art.map((v) => Math.max(0, Math.min(5, Math.floor(Number(v) || 0)))));
    }
  };
  window.addEventListener('message', onMsg);

  const close = () => {
    window.removeEventListener('message', onMsg);
    overlay.remove();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.dwapp-close')) close();
  });
  document.body.appendChild(overlay);
  return close;
}

/** Fetch the pad template (this page's own served asset). */
export const fetchPadTemplate = async () =>
  // eslint-disable-next-line no-restricted-globals -- same-origin read of the page's OWN served asset, not egress
  (await fetch('/web/dwapps/pixel-pad.html')).text();

/**
 * Bake a drawing into a fresh pad bundle — pure text substitution, so the
 * shared artifact is a plain self-contained dwapp file, art included.
 * @param {string} template @param {{ title: string, art: number[] }} p
 * @returns {Record<string, string>} bundle files
 */
export const bakePixelPad = (template, { title, art }) => ({
  'index.html': template
    .replace('"__TITLE__"', JSON.stringify(String(title).slice(0, 48) || 'pixel pad'))
    .replace('/*__ART__*/null', JSON.stringify(art.slice(0, 256).map((v) => Math.max(0, Math.min(5, Math.floor(Number(v) || 0)))))),
});
