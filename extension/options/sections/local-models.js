// @ts-check
// Options → Local models — on-device WebGPU models. Each model is LOCKED until a
// hardware "Test" confirms this machine's GPU can run it (probe WebGPU + WebGL +
// memory; judge against the model's min-spec). Pass → Download (one-time, browser-
// cached) → it becomes available in the Lab and as a runner / main-loop model.
//
// Mirrors the Ollama recommendation card, but the model runs IN-BROWSER via
// WebGPU (no daemon). The probe runs HERE (document context has navigator.gpu);
// download + status go through the SW (offscreen engine). Settings keeps no live
// port, so download progress is polled off local-model/catalog.
//
// ONE CARD PER MODEL, each with its own test verdict, download state and
// progress. Two gates stack, in this order - a model is offered for download
// only when BOTH pass:
//   1. RUNTIME: can this model's vendored engine (Transformers.js or the muse
//      GGUF runtime) load it here at all? (the engine's support probe - see
//      offscreen/local-model.js). A model it can't load says so plainly
//      instead of failing mid-download.
//   2. HARDWARE: can THIS machine's GPU hold it? (the "Test" button).
//
// Brand rule: monochrome; capability carried by glyph (✓ / ✕ / 🔒), red only for
// a hard "won't run here".

import m from '/vendor/mithril/mithril.js';
import {
  listLocalModelSpecs, probeLocalModelCapability, judgeModelCapability,
} from '/peerd-provider/options.js';
import {
  isUnknownMutationOutcome, mutationFailureCopy, unknownMutationCopy,
} from '../mutation-custody.js';

/** @typedef {import('./reset-row.js').Send} Send */

// The shipped WebGPU models - the provider registry is the list, so a new
// on-device model appears here with no edit to this file.
const MODELS = listLocalModelSpecs();

const GB = 2 ** 30;
export const LOCAL_MODEL_POLL = { ms: 3000 };

/**
 * Download narration for ONE model. `progress` is the engine's last event; it
 * carries the model it belongs to, so a card never renders another card's bar.
 * @param {any} status per-model catalog entry
 * @param {any} progress last local-model progress event
 */
const dlText = (status, progress) => {
  const p = progress && progress.model === status?.model ? progress : null;
  const size = status?.sizeGB ? `~${status.sizeGB} GB` : '~3 GB';
  if (!p) return `Downloading… (one-time, ${size} - this takes a few minutes)`;
  if (p.status === 'error') return 'Download failed.';
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
  /** @param {{ state: any, attrs: { state: any, send: Send } }} vnode */
  oninit(vnode) {
    vnode.state.verdicts = {};      // model id → capability verdict (absent = untested this session)
    vnode.state.testing = null;     // model id being tested
    vnode.state.entries = null;     // model id → local-model/catalog entry
    vnode.state.progress = null;    // last download-progress event (carries its model id)
    vnode.state.error = null;       // catalog-level failure
    vnode.state.downloading = {};   // model id → optimistic "we asked for it"
    vnode.state.downloadUncertain = {}; // model id → result lost; catalog must reconcile
    vnode.state.removed = false;
    vnode.state.readyNotified = false;
    vnode.state.pollTimer = null;
    vnode.state.statusGeneration = 0;
    LocalModelsSection.refreshStatus(vnode);
  },

  /** @param {{ state: any }} vnode */
  onremove(vnode) {
    vnode.state.removed = true;
    if (vnode.state.pollTimer) clearTimeout(vnode.state.pollTimer);
    vnode.state.pollTimer = null;
  },

  /** @param {{ state: any, attrs: { state: any, send: Send } }} vnode */
  schedulePoll(vnode) {
    if (vnode.state.removed || vnode.state.pollTimer) return;
    vnode.state.pollTimer = setTimeout(async () => {
      vnode.state.pollTimer = null;
      if (!vnode.state.removed) await LocalModelsSection.refreshStatus(vnode);
    }, LOCAL_MODEL_POLL.ms);
  },

  /** @param {{ state: any, attrs: { state: any, send: Send, onReady?: () => void } }} vnode */
  async refreshStatus(vnode) {
    // Direct tests and restored component state from older builds may predate
    // the custody latch. Treat that shape as an empty latch rather than
    // crashing the status poll and leaving the model surface stale forever.
    vnode.state.downloadUncertain ??= {};
    vnode.state.downloading ??= {};
    const generation = vnode.state.statusGeneration + 1;
    vnode.state.statusGeneration = generation;
    if (vnode.attrs.state?.capabilities?.localWebGpuHost?.status !== 'available') {
      vnode.state.entries = null;
      vnode.state.error = 'runtime_capability_unavailable';
      m.redraw();
      return;
    }
    let reply = null;
    try { reply = await vnode.attrs.send({ type: 'local-model/catalog' }); }
    catch { reply = null; }
    // A stale reply must never overwrite a newer one (mount + poll can overlap).
    if (vnode.state.removed || vnode.state.statusGeneration !== generation) return;
    if (Array.isArray(reply?.models)) {
      /** @type {Record<string, any>} */ const byId = {};
      for (const entry of reply.models) if (entry?.model) byId[entry.model] = entry;
      vnode.state.entries = byId;
      vnode.state.error = null;
    } else {
      // KEEP the last-known entries: a transient reply failure (SW mid-restart,
      // offscreen napping) must not repaint an installed model as locked and
      // re-offer buttons that act on stale state. The error renders as a hint
      // line and the poll below retries until the catalog answers again.
      vnode.state.error = 'unavailable';
      LocalModelsSection.schedulePoll(vnode);
    }
    vnode.state.progress = reply?.progress ?? vnode.state.progress;

    const entries = Object.values(vnode.state.entries ?? {});
    const anyReady = entries.some((/** @type {any} */ e) => e.available || e.downloaded);
    // Clear the optimistic flag for anything that finished or failed, and keep
    // polling only while something is actually in flight.
    let inFlight = false;
    for (const spec of MODELS) {
      const entry = vnode.state.entries?.[spec.id];
      const ready = !!(entry?.available || entry?.downloaded);
      const failed = vnode.state.progress?.model === spec.id && vnode.state.progress?.status === 'error';
      // A successful catalog reply is the reconciliation receipt for a lost
      // init reply. If it says this exact model is idle, replay is safe again.
      const reconciledIdle = vnode.state.downloadUncertain[spec.id]
        && Object.hasOwn(vnode.state.entries ?? {}, spec.id) && !entry?.loading && !ready;
      if (reconciledIdle) {
        vnode.state.downloadUncertain[spec.id] = false;
        vnode.state.downloading[spec.id] = false;
        vnode.state.progress = {
          status: 'error', model: spec.id,
          message: 'Status confirms the download did not start. You can try again.',
        };
      }
      if (ready || failed) vnode.state.downloading[spec.id] = false;
      if (!ready && (entry?.loading || vnode.state.downloading[spec.id])) inFlight = true;
    }
    if (anyReady && !vnode.state.readyNotified) {
      vnode.state.readyNotified = true;
      vnode.attrs.onReady?.();
    }
    if (inFlight) LocalModelsSection.schedulePoll(vnode);
    m.redraw();
  },

  /** @param {{ state: any, attrs: { state: any } }} vnode @param {any} spec */
  async test(vnode, spec) {
    if (vnode.attrs.state?.capabilities?.localWebGpuHost?.status !== 'available') return;
    vnode.state.testing = spec.id; m.redraw();
    try {
      const cap = await probeLocalModelCapability();
      vnode.state.verdicts[spec.id] = judgeModelCapability(cap, spec);
    } catch {
      vnode.state.verdicts[spec.id] = { capable: false, reason: 'Hardware check failed.', confidence: 'none' };
    }
    vnode.state.testing = null; m.redraw();
  },

  /** @param {{ state: any, attrs: { state: any, send: Send } }} vnode @param {any} spec */
  async download(vnode, spec) {
    if (vnode.attrs.state?.capabilities?.localWebGpuHost?.status !== 'available') return;
    // A retry must not keep rendering the PREVIOUS attempt's failure.
    if (vnode.state.progress?.model === spec.id && vnode.state.progress?.status === 'error') {
      vnode.state.progress = null;
    }
    vnode.state.downloading[spec.id] = true; m.redraw();
    let reply;
    try {
      reply = await vnode.attrs.send({ type: 'local-model/init', model: spec.id });
    } catch {
      reply = { ok: false, outcomeKnown: false };
    }
    if (!reply?.ok) {
      if (isUnknownMutationOutcome(reply)) {
        vnode.state.downloadUncertain[spec.id] = true;
        vnode.state.progress = {
          status: 'phase', model: spec.id,
          phase: unknownMutationCopy('starting the model download'),
        };
        // A read is safe. Keep the action disabled unless a catalog reply
        // proves the model is idle or reports that it is already loading.
        await LocalModelsSection.refreshStatus(vnode);
        if (vnode.state.downloadUncertain[spec.id]) LocalModelsSection.schedulePoll(vnode);
        return;
      }
      // Render the refusal on THIS card (a wrong-model progress event would be
      // ignored by the others' filters anyway).
      vnode.state.progress = {
        status: 'error', model: spec.id,
        message: mutationFailureCopy(reply, {
          action: 'starting the model download', fallback: 'Download could not start.',
        }),
      };
      vnode.state.downloading[spec.id] = false;
      m.redraw();
      return;
    }
    await LocalModelsSection.refreshStatus(vnode);
  },

  /** @param {{ state: any, attrs: { state: any, send: Send, logo?: any, label?: string, onReady?: () => void } }} vnode */
  view(vnode) {
    const ui = vnode.state;
    const hostAvailable = vnode.attrs.state?.capabilities?.localWebGpuHost?.status === 'available';
    const { logo = null, label = 'Local (WebGPU)' } = vnode.attrs;
    const installed = MODELS.filter((spec) => {
      const e = ui.entries?.[spec.id];
      return !!(e?.available || e?.downloaded);
    });
    const anyLoading = MODELS.some((spec) => ui.entries?.[spec.id]?.loading || ui.downloading[spec.id]);

    // Header badge mirrors the cloud provider cards — but green (.key-set) is
    // reserved for "actually ready", i.e. at least one model is installed. Until
    // then a NEUTRAL chip: keyless, yes, but not yet usable, so it must NOT read
    // as the verified-green the API providers earn by having a working key.
    const badge = !hostAvailable
      ? m('span.key-badge.key-local', 'Unavailable')
      : installed.length
        ? m('span.key-badge.key-set', installed.length > 1 ? `✓ ${installed.length} installed` : '✓ Installed')
        : anyLoading
          ? m('span.key-badge.key-local', 'Downloading…')
          : m('span.key-badge.key-local', 'On-device, not installed');

    const header = m('.provider-card-main', [
      logo,
      m('.provider-card-text', [
        m('span.provider-card-name', label),
        badge,
      ]),
    ]);

    if (!hostAvailable) {
      return m('.provider-card.provider-card-local', [
        header,
        m('p.muted', { style: 'margin:10px 0 0;' },
          'Local WebGPU models are unavailable in this browser. Use Ollama for local inference.'),
      ]);
    }

    if (MODELS.length === 0) {
      return m('.provider-card', [header, m('p.muted', { style: 'margin:10px 0 0;' }, 'No WebGPU models are bundled in this build.')]);
    }

    return m('.provider-card.provider-card-local', [
      header,
      m('.local-models', [
        m('p.muted', 'Run a model fully on-device via WebGPU — free, private (page content never leaves your machine for the read step), and offline. '
          + 'Test your hardware first; if it passes, download once (then it’s browser-cached). One model is held in GPU memory at a time.'),
        // A transient catalog failure while entries are already known: say so
        // instead of silently rendering stale rows as fresh.
        ui.error && ui.entries
          ? m('.lm-state.muted', 'Status refresh failed - showing the last known state, retrying.')
          : null,
        ...MODELS.map((spec) => LocalModelsSection.modelRow(vnode, spec)),
      ]),
    ]);
  },

  /**
   * One model's row: name + link, the size/requirements meta line, a state line
   * (runtime gate → download state → hardware verdict → locked), and its actions.
   * @param {{ state: any, attrs: any }} vnode @param {any} spec
   */
  modelRow(vnode, spec) {
    const ui = vnode.state;
    const entry = ui.entries?.[spec.id] ?? null;
    const available = !!entry?.available;
    const downloaded = !!entry?.downloaded; // weights cached (survives reloads)
    const ready = available || downloaded;
    const loading = !!entry?.loading || !!ui.downloading[spec.id];
    const verdict = ui.verdicts[spec.id];
    // Only a DEFINITE 'unsupported' locks the card. The verdict is absent until
    // the catalog answers, and 'unknown' means the support probe could not
    // reach a verdict (offline, repo unreachable) - neither may flash a hard
    // refusal for a model that would run.
    const unsupported = entry?.supportState === 'unsupported';
    const canDownload = !!verdict?.capable && !ready && !loading && !unsupported;

    // A settled failure for THIS model (download refused / failed mid-stream).
    // why its own branch: the error progress event arrives together with
    // loading flipping false, so without it the card would silently revert to
    // the hardware-pass line as if nothing happened - a failed 12 GB download
    // the user never learns about. Cleared on the next Download click.
    const failed = !ready && !loading && ui.progress?.model === spec.id && ui.progress?.status === 'error'
      ? ui.progress : null;

    const stateLine = unsupported
      ? m('.lm-state.muted', `🔒 ${entry.supportReason || 'Not supported by this build’s runtime yet.'}`)
      : ready
        ? m('.lm-state.ok', available
          ? '✓ Downloaded + loaded - available in the Lab and selectable as a runner / main-loop model.'
          : '✓ Downloaded (cached) - loads from cache on first use; already selectable in the Lab + model pickers.')
        : loading ? m('.lm-state', dlText({ ...entry, sizeGB: spec.sizeGB }, ui.progress))
          : failed ? m('.lm-state.bad', '✕ Download failed. Check the model status before trying again.')
            : verdict ? m('.lm-state', { class: verdict.capable ? 'ok' : 'bad' }, `${verdict.capable ? '✓' : '✕'} ${verdict.reason}`)
              : m('.lm-state.muted', '🔒 Locked - run a hardware test to check this model can run on this machine.');

    // why no `key`: these rows are a fixed-order registry list that never
    // reorders, and they are siblings of the unkeyed intro paragraph - Mithril
    // requires all-or-none keys among siblings.
    return m('.lm-model', [
      m('.lm-head', [
        m('span.lm-name-group', [
          m('span.lm-name', spec.label),
          spec.url ? m('a.lm-link', { href: spec.url, target: '_blank', rel: 'noopener noreferrer', title: 'View this model on Hugging Face' }, '↗ Hugging Face') : null,
        ]),
        m('span.lm-meta', [
          // Claim only what THIS spec requires (f16 is per-model, not universal).
          `~${spec.sizeGB} GB · ${spec.dtype} · WebGPU · needs ${spec.requiresShaderF16 ? 'shader-f16 + ' : ''}≥${spec.minStorageBufferBindingSizeGB} GB storage binding`,
          // An unmeasured spec must never read as a measured one.
          spec.specVerified ? null : m('span.lm-caveat', { title: spec.note ?? '' }, ' · figures unverified'),
        ]),
      ]),
      stateLine,
      m('.lm-actions', [
        ready || unsupported ? null : m('button.secondary', {
          disabled: !!ui.testing || loading,
          onclick: () => LocalModelsSection.test(vnode, spec),
        }, ui.testing === spec.id ? 'Testing…' : (verdict ? 'Re-test hardware' : 'Test hardware')),
        ready || unsupported ? null : m('button', {
          disabled: !canDownload,
          title: canDownload ? '' : 'Pass the hardware test first',
          onclick: () => LocalModelsSection.download(vnode, spec),
        }, loading ? 'Downloading…' : 'Download'),
      ]),
    ]);
  },
};
