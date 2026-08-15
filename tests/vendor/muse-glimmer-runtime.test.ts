import { describe, test, expect } from 'bun:test';
// @ts-ignore — vendored, untyped ESM bundle
import * as muse from '../../extension/vendor/muse-glimmer/muse-glimmer.js';
// @ts-ignore — JS module with JSDoc types
import { MODEL_SPECS } from '../../extension/peerd-provider/local-model-capability.js';

// The engine (offscreen/local-model.js) calls exactly this surface on the
// vendored bundle; a re-vendor that drops or renames any of it must fail HERE,
// not at first use on a user's machine.
describe('vendored muse-glimmer runtime', () => {
  test('imports without a DOM and exposes the engine contract', () => {
    expect(typeof muse.MuseGlimmer30B).toBe('function');
    expect(typeof muse.MuseGlimmer30B.checkAvailability).toBe('function');
    expect(typeof muse.MuseGlimmer30B.load).toBe('function');
  });

  test('checkAvailability without WebGPU refuses cleanly: no throw, ok:false, a human reason', async () => {
    const res = await muse.MuseGlimmer30B.checkAvailability();
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/WebGPU/);
  });

  test('the registry entry pins the runtime\'s own model + weight file', () => {
    // The spec must name exactly the artifact the vendored runtime was built
    // around - drift here would stream a different multi-GB file than the one
    // the Space validated.
    const spec = MODEL_SPECS['muse-glimmer-30b'];
    expect(String(spec.repo)).toBe(String(muse.DEFAULT_MODEL_ID));
    expect(String(spec.file)).toBe(String(muse.DEFAULT_GGUF_FILE));
  });
});
