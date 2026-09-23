// The on-device runner's row on the provider front door. Its usability used to
// be derived from `liveModels` - a flag meaning "this adapter can enumerate a
// remote inventory" - which the runner will never satisfy, so a shipped engine
// rendered permanently NOT YET USABLE on the first screen a new user sees.
import { describe, expect, test } from 'bun:test';
import { localPhase } from '../../extension/sidepanel/components/onboarding-provider-step.js';

describe('on-device runner readiness on the provider step', () => {
  test('a resident model reads as installed', () => {
    expect(localPhase({ ok: true, models: [{ available: true }] })).toBe('installed');
    // downloaded-but-not-loaded still counts: the weights are here.
    expect(localPhase({ ok: true, models: [{ downloaded: true }] })).toBe('installed');
    expect(localPhase({ ok: true, models: [{ available: false }, { downloaded: true }] })).toBe('installed');
  });

  test('a supported host with nothing downloaded is empty, not unsupported', () => {
    // These are different facts and the row says different things for each.
    expect(localPhase({ ok: true, models: [] })).toBe('empty');
    expect(localPhase({ ok: true, models: [{ available: false, downloaded: false }] })).toBe('empty');
  });

  test("a host that cannot run the engine is unsupported", () => {
    // The route answers with a capability refusal where there is no offscreen
    // document to host the engine (Firefox today).
    expect(localPhase({
      ok: false, error: 'runtime_capability_unavailable', facility: 'localWebGpuHost',
    } as never)).toBe('unsupported');
    expect(localPhase(null)).toBe('unsupported');
    expect(localPhase(undefined)).toBe('unsupported');
  });

  test('a malformed reply never reads as ready', () => {
    expect(localPhase({ ok: true } as never)).toBe('empty');
    expect(localPhase({ ok: true, models: 'nope' } as never)).toBe('empty');
  });
});
