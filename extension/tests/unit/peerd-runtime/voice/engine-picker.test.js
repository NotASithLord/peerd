// @ts-check
// engine-picker — engine resolution (the web-speech-default reframe).
//
// The behavior change lives in resolveEngine(); it's pure (booleans in,
// engine out) so the full truth table is asserted without faking browser
// globals. The harness runs in real Chrome (Web Speech present), so
// detectVoiceCapability / createBestTranscriber are checked against that.

import { describe, it, expect } from '../../../framework.js';
import {
  resolveEngine,
  detectVoiceCapability,
  createBestTranscriber,
} from '/peerd-runtime/voice/engine-picker.js';

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
  it('auto resolves to web-speech in the harness and still reports moonshine', () => {
    const cap = detectVoiceCapability('auto');
    expect(cap.webSpeech).toBe(true);          // real Chrome has Web Speech
    expect(cap.engine).toBe('web-speech');     // the default
    expect(typeof cap.moonshine).toBe('boolean'); // present regardless of value
  });

  it('a web-speech engine carries a cloudVendor string on non-Safari', () => {
    const cap = detectVoiceCapability('auto');
    // Chrome/Chromium route to the cloud, so cloudVendor is named.
    expect(cap.engine).toBe('web-speech');
    expect(typeof cap.cloudVendor).toBe('string');
  });
});

describe('createBestTranscriber — lockstep with detectVoiceCapability', () => {
  it('builds the same engine that detectVoiceCapability resolves', () => {
    const cap = detectVoiceCapability('auto');
    const transcriber = createBestTranscriber({}, 'auto');
    expect(transcriber.engine).toBe(cap.engine); // both web-speech in the harness
  });
});
