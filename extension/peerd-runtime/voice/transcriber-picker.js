// @ts-check
// Offscreen-only engine construction. Capability checks stay in the lightweight
// engine-picker; importing this module pulls the multi-megabyte Moonshine vendor.

import { createTranscriber } from './transcriber.js';
import { createWebSpeechTranscriber, isWebSpeechAvailable } from './web-speech-transcriber.js';
import { moonshineReady, resolveEngine } from './engine-picker.js';
import { VoiceUnsupportedError } from './errors.js';

/**
 * @param {object} [deps]
 * @param {'auto'|'web-speech'|'moonshine'} [pref]
 * @returns {ReturnType<typeof createTranscriber> | ReturnType<typeof createWebSpeechTranscriber>}
 */
export const createBestTranscriber = (deps = {}, pref = 'auto') => {
  const engine = resolveEngine(pref, isWebSpeechAvailable(), moonshineReady());
  if (engine === 'web-speech') return createWebSpeechTranscriber(deps);
  if (engine === 'moonshine') return createTranscriber(deps);
  throw new VoiceUnsupportedError(
    'No transcription engine available. Run peerd in a browser with the Web '
    + 'Speech API, or pin the Moonshine model SRIs (scripts/compute-model-sri.sh) '
    + 'for local voice.',
  );
};
