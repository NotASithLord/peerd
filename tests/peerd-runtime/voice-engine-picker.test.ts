import { describe, test, expect } from 'bun:test';
import { resolveEngine } from '../../extension/peerd-runtime/voice/engine-picker.js';

// resolveEngine is the pure chokepoint for the web-speech-default reframe, so
// this pins its whole truth table across preference, browser engine presence,
// and Moonshine readiness.

type Pref = 'auto' | 'web-speech' | 'moonshine';
type Engine = 'web-speech' | 'moonshine' | null;

const cases: Array<[Pref, boolean, boolean, Engine]> = [
  // Forced Moonshine wins whenever the model is ready, with or without Web Speech.
  ['moonshine', true, true, 'moonshine'],
  ['moonshine', false, true, 'moonshine'],
  // Forced Moonshine degrades to Web Speech when the model is not ready.
  ['moonshine', true, false, 'web-speech'],
  ['moonshine', false, false, null],
  // Forced Web Speech wins whenever the browser engine is present.
  ['web-speech', true, true, 'web-speech'],
  ['web-speech', true, false, 'web-speech'],
  // Forced Web Speech falls back to Moonshine when the browser engine is absent.
  ['web-speech', false, true, 'moonshine'],
  ['web-speech', false, false, null],
  // Auto prefers Web Speech, then Moonshine, then nothing.
  ['auto', true, true, 'web-speech'],
  ['auto', true, false, 'web-speech'],
  ['auto', false, true, 'moonshine'],
  ['auto', false, false, null],
];

describe('resolveEngine', () => {
  for (const [pref, webSpeech, moonshine, expected] of cases) {
    test(`${pref} with webSpeech=${webSpeech} moonshine=${moonshine} resolves to ${expected}`, () => {
      expect(resolveEngine(pref, webSpeech, moonshine)).toBe(expected);
    });
  }
});
