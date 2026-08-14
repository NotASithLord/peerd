// @ts-check
// Engine picker — chooses the live transcription engine.
//
// Priority (2026-06-14 reframe — DECISIONS #22, owner call):
//   Web Speech API is the DEFAULT, instant, no-download engine. It works out
//   of the box, but most browsers route audio to the vendor's cloud
//   (Chrome/Edge → cloud; Safari → on-device since ~2021).
//   Moonshine (~250 MB WASM, fully on-device) is the OPT-IN PRIVACY UPGRADE —
//   picked only when the user prefers 'moonshine', or as the required fallback
//   when Web Speech is absent and a Moonshine host exists. The download
//   rationale is shown by the settings UI BEFORE Moonshine is selected, never
//   here.
//
// The picker is the single place that decides which engine to instantiate;
// everything above (manager, mic button, UI) is engine-agnostic and passes
// down the user's voiceEngine preference ('auto' | 'web-speech' | 'moonshine').

import { isWebSpeechAvailable } from './web-speech-transcriber.js';
import { hasValidModelSris } from './model-store.js';
import { MOONSHINE_VENDORED } from './vendor-status.js';

// why: Moonshine is only a real option when it's BOTH vendored AND its model
// SRIs are pinned (compute-model-sri.sh). Until then it can't download, so
// 'auto' must never resolve to it.
export const moonshineReady = () => MOONSHINE_VENDORED && hasValidModelSris();

/**
 * Pure resolution of which engine to run, given a preference + what each
 * engine offers. The single chokepoint for the web-speech-default reframe;
 * exported pure so the truth table is unit-testable without stubbing globals.
 *   'auto': Web Speech when available, else hosted Moonshine.
 *   'web-speech' — force the browser engine (cloud-routed on most browsers).
 *   'moonshine'  — force the local model; degrades to Web Speech if the model
 *                  isn't ready so voice still works rather than dying.
 * @param {'auto'|'web-speech'|'moonshine'} pref
 * @param {boolean} webSpeech  is the browser Web Speech API available?
 * @param {boolean} moonshine  is Moonshine vendored + SRI-pinned (downloadable)?
 * @returns {'web-speech'|'moonshine'|null}
 */
export const resolveEngine = (pref, webSpeech, moonshine) => {
  if (pref === 'moonshine' && moonshine) return 'moonshine';   // forced upgrade
  if (pref === 'web-speech' && webSpeech) return 'web-speech'; // forced cloud
  if (webSpeech) return 'web-speech';                          // 'auto' default
  if (moonshine) return 'moonshine';                           // 'auto' on Firefox
  return null;
};

/**
 * Capability snapshot for the settings UI AND the engine decision. Reports
 * BOTH availabilities so the card can offer the Moonshine upgrade even while
 * Web Speech is the active engine.
 *
 * @param {'auto'|'web-speech'|'moonshine'} [pref] default 'auto'
 * @param {{ moonshineHostAvailable?: boolean }} [hosts]
 * @returns {{
 *   engine: 'web-speech'|'moonshine'|null,  // what WOULD run, given pref
 *   webSpeech: boolean,                     // instant browser engine present?
 *   moonshine: boolean,                     // local engine vendored + SRIs pinned?
 *   cloudVendor: string|null,               // only when engine === 'web-speech'
 *   source: 'browser'|'vendored'|null,
 * }}
 */
export const detectVoiceCapability = (pref = 'auto', hosts = {}) => {
  const webSpeech = isWebSpeechAvailable();
  const moonshine = hosts.moonshineHostAvailable !== false && moonshineReady();
  const engine = resolveEngine(pref, webSpeech, moonshine);
  /** @type {string|null} */
  let cloudVendor = null;
  /** @type {'browser'|'vendored'|null} */
  let source = null;
  if (engine === 'web-speech') {
    source = 'browser';
    const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') ?? '';
    // Safari (Mac/iOS) processes Web Speech locally since ~2021; everything
    // else (Chrome/Edge/Chromium/Firefox) routes audio to a cloud service.
    const isSafari = /Safari\//.test(ua) && !/Chrome\//.test(ua) && !/Chromium\//.test(ua);
    if (!isSafari) cloudVendor = 'the browser vendor\'s cloud service';
  } else if (engine === 'moonshine') {
    source = 'vendored';
  }
  return { engine, webSpeech, moonshine, cloudVendor, source };
};
