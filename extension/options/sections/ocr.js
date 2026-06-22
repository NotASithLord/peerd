// @ts-check
// Options → OCR (rendered inside the combined "Voice & OCR" tab).
//
// peerd reads PDFs with pdf.js (text layer) by default — no download, always
// on (the read_pdf tool). Scanned / image-only PDFs have NO text layer, so they
// need OCR: an on-device engine downloaded ONCE (the Moonshine-voice pattern).
// This section owns that opt-in download. It lives in its own file (one section
// = one file, the established options pattern) but is mounted alongside the
// Voice section under a single "Voice & OCR" nav entry — both are heavy on-device
// model downloads, so the owner groups them in one tab.
//
// The engine SRIs are pinned before shipping (scripts/compute-ocr-sri.sh); until
// they are, the download is fail-closed and the button reads "not available in
// this build yet" — exactly how voice's Moonshine upgrade behaved pre-pinning.

import m from '/vendor/mithril/mithril.js';
import { createOcrStore, hasValidOcrSris, OCR_TOTAL_BYTES } from '/peerd-runtime/index.js';

export const OcrSection = {
  oninit(/** @type {any} */ vnode) {
    vnode.state.busy = false;
    vnode.state.progress = 0;
    vnode.state.error = null;
    vnode.state.installed = null;     // null = unknown until checked
    vnode.state.confirmOpen = false;
    // The download runs in THIS options context (synchronous progress, no
    // per-chunk message overhead — the voice rationale). The offscreen extractor
    // later reads the same cached bytes by URL.
    vnode.state.store = createOcrStore();
    vnode.state.store.isInstalled({ dev: false })
      .then((/** @type {any} */ ok) => { vnode.state.installed = ok; m.redraw(); })
      .catch(() => { vnode.state.installed = false; m.redraw(); });
  },

  view: (/** @type {{ attrs: { send: any }, state: any }} */ { attrs: { send }, state: ui }) => {
    const shippable = hasValidOcrSris();
    // Readiness reflects the ACTUAL cached engine (isInstalled), not the
    // ocrEnabled setting — a cleared IDB cache must not show "✓ installed" while
    // extraction would fail. ocrEnabled is persisted INTENT only.
    const ocrReady = ui.installed === true;
    const sizeMb = Math.round(OCR_TOTAL_BYTES / 1_000_000);

    const enableOcr = async () => {
      if (ui.busy) return;
      ui.busy = true;
      ui.error = null;
      ui.confirmOpen = false;
      ui.progress = 0;
      m.redraw();
      try {
        await ui.store.getEngine({ onProgress: (/** @type {number} */ p) => { ui.progress = Math.max(0, Math.min(1, p)); m.redraw(); }, dev: false });
        await send({ type: 'settings/update', patch: { ocrEnabled: true } });
        ui.installed = true;
      } catch (e) {
        ui.error = (/** @type {{ message?: string }} */ (e))?.message ?? 'download-failed';
        await send({ type: 'settings/update', patch: { ocrEnabled: false } });
      }
      ui.busy = false;
      m.redraw();
    };

    return m('.ocr-section', [
      m('h3', { style: 'margin:0 0 4px; font-size:15px;' }, 'PDF OCR (scanned documents)'),
      m('p.muted', { style: 'margin:0 0 8px;' }, [
        'peerd reads PDFs automatically with the built-in pdf.js text reader — ',
        'no setup needed. ',
        m('strong', 'Scanned or photographed PDFs'),
        ' have no text layer, so they need OCR: an on-device engine that ',
        `downloads once (~${sizeMb} MB, cached locally) and then recognizes text fully on this device.`,
      ]),

      ocrReady
        ? m('.voice-status.is-ok', '✓ OCR engine installed — scanned PDFs are readable')
        : null,

      ui.busy ? m('div', [
        m('.voice-status', `Downloading OCR engine… ${Math.round(ui.progress * 100)}%`),
        m('.voice-progress', m('.voice-progress-fill', { style: `width: ${Math.round(ui.progress * 100)}%` })),
      ]) : null,

      ui.error ? m('.voice-status.is-err', `Error: ${ui.error}`) : null,

      m('div', { style: 'display:flex; gap:8px; align-items:center; margin-top:8px;' }, [
        ocrReady
          ? null
          : m('button', {
              type: 'button',
              disabled: ui.busy || !shippable,
              onclick: () => { ui.confirmOpen = true; m.redraw(); },
            }, shippable ? `Download OCR engine (~${sizeMb} MB)` : 'OCR not available in this build yet'),
      ]),

      !shippable
        ? m('p.muted', { style: 'font-size:12px; margin:8px 0 0;' },
            'The OCR engine has not been pinned for this build. pdf.js still reads born-digital PDFs.')
        : null,

      // Download confirmation — facts shown BEFORE any download (the voice rule).
      ui.confirmOpen ? m('.peerd-modal-backdrop', {
        onclick: (/** @type {any} */ e) => { if (e.target === e.currentTarget) { ui.confirmOpen = false; m.redraw(); } },
      }, m('.peerd-modal', [
        m('h3', 'Download on-device OCR engine?'),
        m('ul', [
          m('li', `Download size: ~${sizeMb} MB (one time, cached locally after)`),
          m('li', m('strong', 'After download: 100% on-device — page images never leave this device')),
          m('li', 'Storage: IndexedDB on this browser only'),
          m('li', 'Source: pinned, integrity-checked (SHA-384 SRI)'),
        ]),
        m('.peerd-modal-actions', [
          m('button.secondary', { type: 'button', disabled: ui.busy, onclick: () => { ui.confirmOpen = false; m.redraw(); } }, 'Cancel'),
          m('button', { type: 'button', disabled: ui.busy || !shippable, onclick: enableOcr }, 'Download & enable'),
        ]),
      ])) : null,
    ]);
  },
};
