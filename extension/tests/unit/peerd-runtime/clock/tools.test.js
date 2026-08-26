// @ts-check
// Controller-executed clock tools. The SW retains only turn cancellation custody.

import { describe, it, expect } from '../../../framework.js';
import { waitUntilTool, CLOCK_TOOLS } from '/peerd-runtime/clock/tools.js';

/** @param {Partial<import('/shared/tool-types.js').ToolContext>} [overrides] */
const ctx = (overrides = {}) => /** @type {import('/shared/tool-types.js').ToolContext} */ ({
  session: { sessionId: 'test-session' },
  audit: async () => {},
  ...overrides,
});

describe('clock.tools', () => {
  it('the controller clock surface keeps the durable wait', () => {
    expect(CLOCK_TOOLS.map((t) => t.name).join(',')).toBe('wait_until');
  });

  describe('wait_until', () => {
    it('blocks for a short duration', async () => {
      const t0 = Date.now();
      const r = await waitUntilTool.execute({ when: '1s' }, ctx());
      expect(r.ok).toBe(true);
      const elapsed = Date.now() - t0;
      // why: setTimeout is not precise — allow generous lower bound
      // (jitter), tight upper bound (no runaway).
      expect(elapsed >= 900).toBe(true);
      expect(elapsed < 3_000).toBe(true);
    });

    it('rejects waits longer than the hard cap', async () => {
      const r = await waitUntilTool.execute({ when: '999d' }, ctx());
      expect(r.ok).toBe(false);
      expect(/** @type {import('/shared/tool-types.js').ToolResultErr} */ (r).error.includes('refuses')).toBe(true);
    });

    it('errors on invalid input', async () => {
      const r = await waitUntilTool.execute({ when: 'gobbledygook' }, ctx());
      expect(r.ok).toBe(false);
    });

    it('stops immediately with its turn', async () => {
      const controller = new AbortController();
      const pending = waitUntilTool.execute(
        { when: '1h' }, ctx({ abortSignal: controller.signal }),
      );
      controller.abort();
      let error = null;
      try { await pending; } catch (cause) { error = cause; }
      expect(/** @type {{name?:string}|null} */ (error)?.name).toBe('AbortError');
    });
  });
});
