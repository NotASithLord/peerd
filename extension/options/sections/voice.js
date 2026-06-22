// @ts-check
// Options → Voice — enable/disable, engine status, on-device upgrade,
// silence slider, mic-permission help.
//
// Engine posture (2026-06-14, DECISIONS #22): the browser Web Speech API is
// the DEFAULT, instant, no-download engine; Moonshine (~250 MB, fully local)
// is an OPT-IN PRIVACY UPGRADE. When Web Speech is available, "Enable voice"
// turns it on instantly with an inline cloud-audio disclosure, and a separate
// upgrade block offers Moonshine with the rationale shown BEFORE any download.
// On a browser with no Web Speech (Firefox), Moonshine is the required engine.
//
// Ported from the panel's "Voice input" section. The one structural
// difference: this page owns its OWN voice manager instead of receiving
// the panel's. The SW forwards voice/chunk + voice/error pushes only to
// the panel port, so the subscription here is a deliberate no-op —
// enable() awaits its sends and drives Moonshine download progress
// locally (manager.js onProgress), which is everything this page needs.
// Live LISTENING stays a panel affair (the mic button lives there).

import m from '/vendor/mithril/mithril.js';
import browser from '/vendor/browser-polyfill.js';
import { createVoiceManager, detectVoiceCapability } from '/peerd-runtime/index.js';
import { resetRow } from './reset-row.js';
// OCR shares this tab (both are heavy on-device model downloads), but lives in
// its own section file — one section, one file.
import { OcrSection } from './ocr.js';

/** @typedef {import('./reset-row.js').Send} Send */

export const VoiceSection = {
  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  oninit(vnode) {
    vnode.state.voiceConfirmOpen = false;     // Moonshine download confirmation modal
    vnode.state.voiceBusy = false;
    vnode.state.voiceError = null;
    vnode.state.voiceState = null;            // subscribed snapshot
    // why the no-op onMessage: SW voice pushes ride the panel port only;
    // this page never listens, so there is nothing to subscribe to.
    vnode.state.mgr = createVoiceManager({
      send: vnode.attrs.send,
      onMessage: () => () => {},
    });
    vnode.state.voiceUnsub = vnode.state.mgr.subscribe((/** @type {any} */ s) => {
      vnode.state.voiceState = s;
      m.redraw();
    });
  },

  /** @param {{ state: any }} vnode */
  onremove(vnode) {
    vnode.state.voiceUnsub?.();
  },

  /** @param {{ attrs: { state: any, send: Send }, state: any }} vnode */
  view: ({ attrs: { state, send }, state: ui }) => {
    const voiceManager = ui.mgr;
    const voiceEnabled = !!state.settings?.voiceEnabled;
    const voiceVariant = state.settings?.voiceVariant ?? 'base';
    const voiceEngine = state.settings?.voiceEngine ?? 'auto';
    const voiceSilenceMs = state.settings?.voiceSilenceMs ?? 1500;
    const voice = ui.voiceState ?? voiceManager?.getState?.() ?? null;
    const voiceStatus = voice?.status ?? 'idle';
    const voiceProgress = voice?.progress ?? 0;
    // Capability snapshot for the CURRENT preference. Reports both
    // availabilities so we can offer the on-device upgrade independently of
    // the live engine.
    const capability = detectVoiceCapability(voiceEngine);
    // Active engine — live state from the manager. Only set after enable.
    const activeEngine = voice?.engine ?? null;
    const cloudVendor = voice?.cloudVendor ?? capability.cloudVendor ?? 'the browser vendor\'s cloud service';
    // The on-device upgrade is offered whenever Moonshine is available and is
    // not already the live engine.
    const canUpgrade = capability.moonshine && activeEngine !== 'moonshine';

    // Enable voice. With no `engine` arg it uses the stored preference (instant
    // Web Speech under 'auto'); with engine === 'moonshine' it persists the
    // preference and downloads the on-device model (the upgrade).
    /** @param {string} [engine] */
    const enableVoice = async (engine) => {
      if (ui.voiceBusy) return;
      ui.voiceBusy = true;
      ui.voiceError = null;
      ui.voiceConfirmOpen = false;
      m.redraw();
      try {
        if (engine && engine !== voiceEngine) {
          await send({ type: 'settings/update', patch: { voiceEngine: engine } });
        }
        // why disable first: switching engines (Web Speech → Moonshine) must
        // tear down the live transcriber before the new one inits.
        if (voiceEnabled) await voiceManager?.disable?.();
        await voiceManager?.enable?.({ variant: voiceVariant, engine: engine ?? voiceEngine });
        await send({ type: 'settings/update', patch: { voiceEnabled: true } });
      } catch (e) {
        ui.voiceError = /** @type {{ message?: string }} */ (e)?.message ?? 'enable-failed';
        await send({ type: 'settings/update', patch: { voiceEnabled: false } });
      }
      ui.voiceBusy = false;
      m.redraw();
    };

    return m('div', [
      m('.voice-section', [
        // Lead paragraph — set expectations for the resolved engine.
        m('p', voiceEnabled
          ? activeEngine === 'moonshine'
            ? 'Voice input is enabled. Using Moonshine — transcription runs entirely on this device.'
            : activeEngine === 'web-speech'
              ? `Voice input is enabled via the browser's Web Speech API — audio is sent to ${cloudVendor} for transcription.${capability.moonshine ? ' Upgrade to on-device transcription below.' : ''}`
              : 'Voice input is enabled. Click the mic next to any text field in the peerd panel, then speak.'
          : capability.webSpeech
            ? `Talk to peerd instead of typing. Your browser's Web Speech API works instantly — but it typically sends your audio to ${cloudVendor} for transcription.`
            : capability.moonshine
              ? 'Talk to peerd instead of typing. This browser has no built-in speech API, so peerd uses the on-device Moonshine model — it downloads once (~250 MB) and then runs fully on this device.'
              : 'Voice input requires a browser with the Web Speech API or a vendored Moonshine model. Neither is available here.'),

        // Moonshine download progress (after opt-in).
        voiceStatus === 'downloading' ? m('div', [
          m('.voice-status', activeEngine === 'moonshine'
            ? `Downloading voice model… ${Math.round(voiceProgress * 100)}%`
            : 'Preparing…'),
          activeEngine === 'moonshine' ? m('.voice-progress',
            m('.voice-progress-fill', { style: `width: ${Math.round(voiceProgress * 100)}%` }),
          ) : null,
        ]) : null,

        voiceStatus === 'available' || voiceStatus === 'listening'
          ? m('.voice-status.is-ok', activeEngine === 'moonshine'
              ? '✓ Voice ready — Moonshine (on-device)'
              : '✓ Voice ready — Web Speech API (browser)')
          : null,

        voice?.error === 'mic-permission-denied'
          ? m(MicPermissionHelp, { voiceManager })
          : voice?.error ? m('.voice-status.is-err',
              voice.error === 'mic-hardware-error'
                ? 'No microphone detected, or the browser could not open one. Check that a mic is connected and try again.'
                : voice.error === 'transcriber-network-error'
                  ? 'The browser\'s speech service could not be reached. Check your network connection.'
                  : voice.error === 'model-integrity-check-failed'
                    ? 'Model integrity check failed. The download was discarded; try a different variant or update the extension.'
                    : voice.error === 'voice-not-supported-in-this-build'
                      ? 'Voice is not supported in this build (moonshine-js not vendored).'
                      : `Error: ${voice.error}`,
            ) : null,
        ui.voiceError ? m('.voice-status.is-err', ui.voiceError) : null,

        m('div', { style: 'display:flex; gap:8px; align-items:center; margin-top:8px;' }, [
          voiceEnabled
            ? m('button.secondary', {
                type: 'button',
                disabled: ui.voiceBusy,
                onclick: async () => {
                  if (ui.voiceBusy) return;
                  ui.voiceBusy = true;
                  ui.voiceError = null;
                  try {
                    await voiceManager?.disable?.();
                    await send({ type: 'settings/update', patch: { voiceEnabled: false } });
                  } catch (e) {
                    ui.voiceError = /** @type {{ message?: string }} */ (e)?.message ?? 'disable-failed';
                  }
                  ui.voiceBusy = false;
                  m.redraw();
                },
              }, 'Disable voice')
            : m('button', {
                type: 'button',
                disabled: ui.voiceBusy || voiceStatus === 'downloading'
                  || (!capability.webSpeech && !capability.moonshine),
                onclick: () => {
                  // why: Web Speech is instant (no download) → enable straight
                  // away with the inline disclosure above. No Web Speech
                  // (Firefox) → Moonshine is required, so open the download
                  // confirm modal first.
                  if (capability.webSpeech) enableVoice();
                  else { ui.voiceConfirmOpen = true; m.redraw(); }
                },
              }, capability.webSpeech
                  ? 'Enable voice'
                  : capability.moonshine ? 'Enable voice (downloads model)' : 'Unavailable'),
        ]),

        // ---- Upgrade to on-device transcription (Moonshine) ----------------
        // Always visible when Moonshine is available and not the live engine.
        // The privacy rationale + the ~250 MB cost are shown HERE, BEFORE the
        // user triggers any download (owner requirement).
        canUpgrade ? m('div', {
          style: 'border:1px solid var(--border); border-radius:var(--radius); padding:10px 12px; background:var(--bg-elev); margin-top:12px;',
        }, [
          m('p', { style: 'margin:0 0 4px; font-weight:600;' }, 'Upgrade to on-device transcription'),
          m('p.muted', { style: 'margin:0 0 8px;' }, [
            'Web Speech needs no download, but it typically ',
            m('strong', 'sends your audio to the browser vendor\'s servers'),
            ' for transcription. Moonshine downloads once (~250 MB, cached locally) so speech-to-text runs entirely on this device — peerd avoids the cloud round-trip.',
          ]),
          m('button.secondary', {
            type: 'button',
            disabled: ui.voiceBusy || voiceStatus === 'downloading',
            onclick: () => { ui.voiceConfirmOpen = true; m.redraw(); },
          }, 'Upgrade to on-device (Moonshine)'),
        ]) : null,

        // Silence threshold (only when enabled). The Model line is Moonshine-
        // specific, so it only shows when Moonshine is the live engine.
        voiceEnabled ? m('div', { style: 'margin-top:14px; display:flex; flex-direction:column; gap:6px;' }, [
          activeEngine === 'moonshine' ? m('label', { style: 'font-size:13px;' }, 'Model') : null,
          activeEngine === 'moonshine'
            ? m('p.muted', { style: 'margin:0;' }, 'Moonshine base — ~250 MB, runs on-device (downloaded once, cached locally).')
            : null,
          m('label', { style: 'font-size:13px; margin-top:8px;' },
            `Stop on silence: ${(voiceSilenceMs / 1000).toFixed(1)}s`),
          m('input', {
            type: 'range',
            min: 500, max: 5000, step: 100,
            value: voiceSilenceMs,
            disabled: ui.voiceBusy,
            oninput: (/** @type {{ target: HTMLInputElement }} */ e) => {
              const ms = Number(e.target.value);
              send({ type: 'settings/update', patch: { voiceSilenceMs: ms } });
              voiceManager?.setSilenceThreshold?.(ms);
            },
          }),
        ]) : null,

        // ---- Moonshine download confirmation modal ------------------------
        // Reached from "Upgrade to on-device" (Chrome) or "Enable voice"
        // (Firefox, where it's required). Always about the on-device model.
        ui.voiceConfirmOpen ? m('.peerd-modal-backdrop', {
          onclick: (/** @type {Event} */ e) => { if (e.target === e.currentTarget) ui.voiceConfirmOpen = false; },
        }, m('.peerd-modal', [
          m('h3', 'Download on-device voice model?'),
          m('p', [
            'peerd will use ',
            m('a', {
              href: 'https://github.com/moonshine-ai/moonshine',
              target: '_blank',
              rel: 'noopener noreferrer',
            }, 'Moonshine'),
            ', an open-source local speech recognition model.',
          ]),
          m('ul', [
            m('li', 'Download size: ~250 MB (one time, cached locally after)'),
            m('li', 'Source: pinned Hugging Face commit'),
            m('li', m('strong', 'After download: 100% on-device — your audio never leaves this device')),
            m('li', 'Storage: IndexedDB on this browser only'),
            m('li', 'License: MIT'),
          ]),
          !capability.webSpeech
            ? m('p.muted', { style: 'margin:8px 0 0;' },
                'This browser has no built-in speech API, so the on-device model is required for voice.')
            : null,
          m('.peerd-modal-actions', [
            m('button.secondary', {
              type: 'button',
              disabled: ui.voiceBusy,
              onclick: () => { ui.voiceConfirmOpen = false; m.redraw(); },
            }, 'Cancel'),
            m('button', {
              type: 'button',
              disabled: ui.voiceBusy || !capability.moonshine,
              onclick: () => enableVoice('moonshine'),
            }, 'Download & enable'),
          ]),
        ])) : null,
      ]),
      m('hr', { style: 'border:none; border-top:1px solid var(--border); margin:20px 0;' }),
      m(OcrSection, { state, send }),
      resetRow(send, ['voiceEnabled', 'voiceVariant', 'voiceEngine', 'voiceSilenceMs', 'voiceOnboardingDismissed', 'ocrEnabled']),
    ]);
  },
};

// ---- mic permission help -------------------------------------------------
//
// Shown when state.error === 'mic-permission-denied'. The two situations
// that put us here are:
//   1. The user denied the browser prompt (or denied it earlier and the
//      browser cached the rejection).
//   2. Chrome itself doesn't have OS-level mic permission. On macOS,
//      that's System Settings → Privacy → Microphone → Chrome.
// Neither is fixable from extension code. The button below opens
// chrome://settings/content/microphone in a new tab so the user is one
// click away from the relevant browser-level setting. The text walks
// them through the OS-level case in parallel — we can't detect which
// of the two it is, so we name both.

const platformLabel = () => {
  const ua = navigator.userAgent ?? '';
  if (/Mac OS X|Macintosh/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
};

const MicPermissionHelp = {
  /** @param {{ attrs: { voiceManager: any } }} vnode */
  view: ({ attrs: { voiceManager } }) => {
    const platform = platformLabel();
    return m('div', { style: 'border:1px solid var(--warn); border-radius:var(--radius); padding:10px 12px; background:var(--bg-elev); margin-top:8px;' }, [
      m('p', { style: 'margin:0 0 8px; font-weight:600; color:var(--warn);' },
        'Microphone access is blocked.'),
      m('p.muted', { style: 'font-size:12px; margin:0 0 8px;' },
        'Extension pages can\'t always surface the microphone prompt in Chrome. '
        + 'Click the button below to open a dedicated grant page — your browser '
        + 'will show the permission prompt there, and the grant carries back to '
        + 'every peerd surface (this page and the panel).'),
      m('p.muted', { style: 'font-size:12px; margin:0 0 8px;' },
        'If the grant page also fails to prompt, the most likely cause is your '
        + 'operating system blocking microphone access for the browser itself:'),
      m('ol', { style: 'font-size:12px; padding-left:18px; margin:0 0 10px;' }, [
        platform === 'mac' ? m('li', { style: 'margin-bottom:6px;' }, [
          m('strong', 'macOS:'),
          ' System Settings → Privacy & Security → Microphone → enable Google Chrome.',
        ]) : platform === 'windows' ? m('li', { style: 'margin-bottom:6px;' }, [
          m('strong', 'Windows:'),
          ' Settings → Privacy & security → Microphone → Microphone access ON, and Chrome allowed.',
        ]) : m('li', { style: 'margin-bottom:6px;' },
          'Allow your browser to access the microphone in your OS privacy settings.'),
      ]),
      m('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;' }, [
        m('button', {
          type: 'button',
          onclick: () => {
            // why: opening a dedicated extension page in a real tab works
            // where panel/options prompts don't — the grant lands at
            // chrome-extension://<id> origin and every extension surface
            // inherits it for subsequent calls.
            try {
              browser.tabs.create({ url: browser.runtime.getURL('permissions/mic.html') });
            } catch (e) {
              console.warn('[options] open grant page failed', e);
            }
          },
        }, 'Grant microphone access'),
        // why the guard: chrome://settings/* only exists on Chromium, and
        // Firefox refuses tabs.create for its privileged about: pages —
        // there is no equivalent deep link to offer, so on Firefox the
        // shortcut is omitted rather than shipped broken.
        browser.runtime.getURL('').startsWith('chrome-extension://')
          ? m('button.secondary', {
            type: 'button',
            onclick: () => {
              try {
                browser.tabs.create({ url: 'chrome://settings/content/microphone' });
              } catch (e) {
                console.warn('[options] open browser settings failed', e);
              }
            },
          }, 'Open browser mic settings')
          : null,
        m('button.secondary', {
          type: 'button',
          onclick: () => {
            // Clear the cached error so the UI returns to a clean
            // state. The next enable/mic attempt re-runs the prompt; if
            // the user fixed the underlying setting in the meantime, it
            // goes through.
            voiceManager?.clearError?.();
          },
        }, 'Clear error & retry'),
      ]),
    ]);
  },
};
