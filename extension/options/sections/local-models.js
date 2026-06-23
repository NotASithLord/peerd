// @ts-check
// Options → Local models — on-device WebGPU models. Each model is LOCKED until a
// hardware "Test" confirms this machine's GPU can run it (probe WebGPU + WebGL +
// memory; judge against the model's min-spec). Pass → Download (one-time, browser-
// cached) → it becomes available in the Lab and as a runner / main-loop model.
//
// Mirrors the Ollama recommendation card, but the model runs IN-BROWSER via
// WebGPU (no daemon). The probe runs HERE (document context has navigator.gpu);
// download + status go through the SW (offscreen engine). Settings keeps no live
// port, so download progress is polled off local-model/status.
//
// Brand rule: monochrome; capability carried by glyph (✓ / ✕ / 🔒), red only for
// a hard "won't run here".

import m from '/vendor/mithril/mithril.js';
import { MODEL_SPECS, probeLocalModelCapability, judgeModelCapability } from '/peerd-provider/index.js';

/** @typedef {import('./reset-row.js').Send} Send */

// The shipped WebGPU models (one for now; the list grows as more are vendored).
const MODELS = [MODEL_SPECS['gemma-4-e2b']].filter(Boolean);

const GB = 2 ** 30;

/** @param {any} status local-model/status reply */
const dlText = (status) => {
  const p = status?.progress;
  if (!p) return 'Downloading… (one-time, ~3 GB — this takes a few minutes)';
  if (p.status === 'error') return `Error: ${p.message || 'download failed'}`;
  if (p.status === 'phase') return p.phase || 'Working…';
  // Prefer the AGGREGATE across all weight files — a single, monotonic total %.
  // The per-file `progress` (the fallback below) resets to 0 each new file, so it
  // misreads as a stall/regression mid-download.
  if (typeof p.overall === 'number') {
    const gb = (typeof p.overallLoaded === 'number' && typeof p.overallTotal === 'number' && p.overallTotal > 0)
      ? ` (${(p.overallLoaded / GB).toFixed(1)} / ${(p.overallTotal / GB).toFixed(1)} GB)`
      : '';
    return `Downloading model — ${p.overall.toFixed(0)}%${gb}`;
  }
  if (typeof p.progress === 'number' && p.file) return `Downloading ${String(p.file).split('/').pop()} — ${p.progress.toFixed(0)}%`;
  if (p.file) return `Downloading ${String(p.file).split('/').pop()}…`;
  return 'Downloading…';
};

export const LocalModelsSection = {
  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  oninit(vnode) {
    vnode.state.verdict = null;     // capability verdict (null = untested this session)
    vnode.state.testing = false;
    vnode.state.status = null;      // local-model/status reply
    vnode.state.downloading = false;
    LocalModelsSection.refreshStatus(vnode);
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  async refreshStatus(vnode) {
    try { vnode.state.status = await vnode.attrs.send({ type: 'local-model/status' }); }
    catch { vnode.state.status = null; }
    m.redraw();
  },

  /** @param {{ state: any }} vnode */
  async test(vnode) {
    vnode.state.testing = true; m.redraw();
    try {
      const cap = await probeLocalModelCapability();
      vnode.state.verdict = judgeModelCapability(cap, MODELS[0]);
    } catch (e) {
      vnode.state.verdict = { capable: false, reason: `probe failed: ${/** @type {{ message?: string }} */ (e)?.message ?? e}`, confidence: 'none' };
    }
    vnode.state.testing = false; m.redraw();
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  async download(vnode) {
    vnode.state.downloading = true; m.redraw();
    await vnode.attrs.send({ type: 'local-model/init' }).catch(() => {});
    const poll = async () => {
      await LocalModelsSection.refreshStatus(vnode);
      if (vnode.state.status?.available || vnode.state.status?.progress?.status === 'error') {
        vnode.state.downloading = false; m.redraw();
      } else { setTimeout(poll, 3000); }
    };
    poll();
  },

  /** @param {{ state: any, attrs: { send: Send, logo?: any, label?: string } }} vnode */
  view(vnode) {
    const ui = vnode.state;
    const { logo = null, label = 'Local (WebGPU)' } = vnode.attrs;
    const spec = MODELS[0];
    const status = ui.status;
    const available = !!status?.available;
    const downloaded = !!status?.downloaded; // weights cached (survives reloads)
    const ready = available || downloaded;
    const loading = !!status?.loading || ui.downloading;
    const verdict = ui.verdict;
    const canDownload = !!verdict?.capable && !ready && !loading;

    // Header badge mirrors the cloud provider cards — but green (.key-set) is
    // reserved for "actually ready", i.e. the model is installed. Until then a
    // NEUTRAL chip: keyless, yes, but not yet usable, so it must NOT read as the
    // verified-green the API providers earn by having a working key.
    const badge = ready
      ? m('span.key-badge.key-set', '✓ Installed')
      : loading
        ? m('span.key-badge.key-local', 'Downloading…')
        : m('span.key-badge.key-local', 'On-device — not installed');

    const header = m('.provider-card-main', [
      logo,
      m('.provider-card-text', [
        m('span.provider-card-name', label),
        badge,
      ]),
    ]);

    if (!spec) {
      return m('.provider-card', [header, m('p.muted', { style: 'margin:10px 0 0;' }, 'No WebGPU models are bundled in this build.')]);
    }

    const stateLine = ready
      ? m('.lm-state.ok', available
        ? '✓ Downloaded + loaded — available in the Lab and selectable as a runner / main-loop model.'
        : '✓ Downloaded (cached) — loads from cache on first use; already selectable in the Lab + model pickers.')
      : loading ? m('.lm-state', dlText(status))
        : verdict ? m('.lm-state', { class: verdict.capable ? 'ok' : 'bad' }, `${verdict.capable ? '✓' : '✕'} ${verdict.reason}`)
          : m('.lm-state.muted', '🔒 Locked — run a hardware test to check this model can run on this machine.');

    return m('.provider-card.provider-card-local', [
      header,
      m('.local-models', [
        m('p.muted', 'Run a model fully on-device via WebGPU — free, private (page content never leaves your machine for the read step), and offline. '
          + 'Test your hardware first; if it passes, download once (then it’s browser-cached).'),
        m('.lm-head', [
          m('span.lm-name-group', [
            m('span.lm-name', spec.label),
            spec.url ? m('a.lm-link', { href: spec.url, target: '_blank', rel: 'noopener noreferrer', title: 'View this model on Hugging Face' }, '↗ Hugging Face') : null,
          ]),
          m('span.lm-meta', `~${spec.sizeGB} GB · q4f16 · WebGPU · needs shader-f16 + ≥${spec.minStorageBufferBindingSizeGB} GB storage binding`),
        ]),
        stateLine,
        m('.lm-actions', [
          ready ? null : m('button.secondary', {
            disabled: ui.testing || loading,
            onclick: () => LocalModelsSection.test(vnode),
          }, ui.testing ? 'Testing…' : (verdict ? 'Re-test hardware' : 'Test hardware')),
          ready ? null : m('button', {
            disabled: !canDownload,
            title: canDownload ? '' : 'Pass the hardware test first',
            onclick: () => LocalModelsSection.download(vnode),
          }, loading ? 'Downloading…' : 'Download'),
        ]),
      ]),
    ]);
  },
};
