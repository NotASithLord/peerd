// @ts-check
// engine-picker — engine resolution (the web-speech-default reframe).
//
// The behavior change lives in resolveEngine(); it's pure (booleans in,
// engine out) so the full truth table is asserted without faking browser
// globals. Capability checks run against whichever real browser owns the
// harness, including Firefox where Web Speech is absent.

import { describe, it, expect } from '../../../framework.js';
import {
  resolveEngine,
  detectVoiceCapability,
} from '/peerd-runtime/voice/engine-picker.js';
import { createBestTranscriber } from '/peerd-runtime/voice/transcriber-picker.js';

describe('resolveEngine — web-speech is the default, moonshine the opt-in', () => {
  // [pref, webSpeech, moonshine] -> resolved engine
  /** @type {Array<['auto'|'web-speech'|'moonshine', boolean, boolean, 'web-speech'|'moonshine'|null]>} */
  const cases = [
    ['auto',       true,  true,  'web-speech'], // THE reframe (was 'moonshine')
    ['auto',       false, true,  'moonshine'],  // Firefox: no Web Speech
    ['auto',       true,  false, 'web-speech'],
    ['auto',       false, false, null],
    ['moonshine',  true,  true,  'moonshine'],  // forced upgrade
    ['moonshine',  true,  false, 'web-speech'], // model not ready -> voice still works
    ['moonshine',  false, false, null],
    ['web-speech', true,  true,  'web-speech'], // forced cloud even with Moonshine present
    ['web-speech', false, true,  'moonshine'],  // forced cloud unavailable -> only option
  ];
  for (const [pref, ws, ms, expected] of cases) {
    it(`pref=${pref} webSpeech=${ws} moonshine=${ms} -> ${expected}`, () => {
      expect(resolveEngine(pref, ws, ms)).toBe(expected);
    });
  }
});

describe('detectVoiceCapability — reports BOTH availabilities for the UI', () => {
  it('reports the browser API and chooses the corresponding shipped engine', () => {
    const browserGlobal = /** @type {any} */ (globalThis);
    const browserHasWebSpeech = typeof browserGlobal.SpeechRecognition === 'function'
      || typeof browserGlobal.webkitSpeechRecognition === 'function';
    const cap = detectVoiceCapability('auto');
    expect(cap.webSpeech).toBe(browserHasWebSpeech);
    expect(cap.moonshine).toBe(true);
    expect(cap.engine).toBe(browserHasWebSpeech ? 'web-speech' : 'moonshine');
    expect(cap.source).toBe(browserHasWebSpeech ? 'browser' : 'vendored');
  });

  it('cloudVendor is never reported for a local engine', () => {
    const cap = detectVoiceCapability('auto');
    expect(cap.cloudVendor === null || typeof cap.cloudVendor === 'string').toBe(true);
    if (cap.engine !== 'web-speech') expect(cap.cloudVendor).toBe(null);
  });
});

describe('detectVoiceCapability host support', () => {
  it('an unavailable Moonshine host removes it before any setup begins', () => {
    const cap = detectVoiceCapability('moonshine', { moonshineHostAvailable: false });
    expect(cap.moonshine).toBe(false);
    expect(cap.engine === 'moonshine').toBe(false);
  });
});

describe('createBestTranscriber — lockstep with detectVoiceCapability', () => {
  it('builds the engine selected from the browser API', () => {
    const browserGlobal = /** @type {any} */ (globalThis);
    const browserHasWebSpeech = typeof browserGlobal.SpeechRecognition === 'function'
      || typeof browserGlobal.webkitSpeechRecognition === 'function';
    const transcriber = createBestTranscriber({}, 'auto');
    expect(transcriber.engine).toBe(browserHasWebSpeech ? 'web-speech' : 'moonshine');
  });
});
