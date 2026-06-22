// @ts-check
// Voice-related settings schema.
//
// Keys added to settings.v1:
//   voiceEnabled            — boolean. Master toggle. false by default.
//   voiceEngine             — 'auto' | 'web-speech' | 'moonshine'. Which
//                             transcription engine to use. 'auto' (default)
//                             prefers the instant browser Web Speech API and
//                             falls back to local Moonshine only when Web
//                             Speech is unavailable (Firefox). 'moonshine' is
//                             the opt-in privacy upgrade. Coerced via
//                             normalizeEngine.
//   voiceVariant            — LEGACY/back-compat only. peerd ships exactly
//                             ONE Moonshine model: 'base' (~250 MB, the more
//                             accurate of upstream's two real variants — there
//                             is no 'small', and 'tiny' is not shipped). Any
//                             stored value is coerced to 'base' by
//                             normalizeVariant; the key is kept so old installs
//                             (which may carry a bogus 'small') don't choke.
//                             First-release decision: one model, no chooser —
//                             hardware keeps catching up.
//   voiceOnboardingDismissed
//                           — boolean. Set true once the user has either
//                             completed or explicitly dismissed the
//                             first-run "extras" voice card. Prevents
//                             the card from re-appearing.
//
// All of these live in chrome.storage.local under 'settings.v1' (same
// store the SW already manages). The SW's updateSettings handler
// whitelists which keys it accepts — see service-worker.js.

/**
 * Collapse any candidate variant to the single shipped model. With one
 * model this only ever returns 'base', but it stays the chokepoint every
 * read routes through so a stored/legacy/bogus value (e.g. an old
 * 'small') can never reach the model store as an unknown key. The single
 * point to widen if a real second model is ever shipped.
 *
 * @param {unknown} _v
 * @returns {'base'}
 */
export const normalizeVariant = (_v) => 'base';

/**
 * Valid engine preferences. 'auto' = prefer Web Speech, fall back to Moonshine.
 * @type {readonly ['auto', 'web-speech', 'moonshine']}
 */
export const VOICE_ENGINES = Object.freeze(['auto', 'web-speech', 'moonshine']);

/**
 * Collapse any stored/legacy value to a known engine preference. Unknown
 * values become 'auto' (the instant, no-download default). Single chokepoint
 * every read routes through — same pattern as normalizeVariant.
 *
 * @param {unknown} v
 * @returns {'auto'|'web-speech'|'moonshine'}
 */
export const normalizeEngine = (v) => {
  // why: narrow `unknown` by membership in the frozen tuple. Cast to the
  // element type only for the `includes` arg position (its param is the
  // element type, not `unknown`); a positive test then guarantees the union.
  const engine = /** @type {'auto'|'web-speech'|'moonshine'} */ (v);
  return VOICE_ENGINES.includes(engine) ? engine : 'auto';
};
