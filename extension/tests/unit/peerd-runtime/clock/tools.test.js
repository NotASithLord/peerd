// @ts-check
// Clock tools — now, wait_until.

import { describe, it, expect } from '../../../framework.js';
import { nowTool, waitUntilTool, CLOCK_TOOLS } from '/peerd-runtime/clock/tools.js';

/** @param {Partial<import('/shared/tool-types.js').ToolContext>} [overrides] */
const ctx = (overrides = {}) => /** @type {import('/shared/tool-types.js').ToolContext} */ ({
  session: { sessionId: 'test-session' },
  audit: async () => {},
  ...overrides,
});

describe('clock.tools', () => {
  it('the clock surface is exactly now + wait_until (checkpoints ripped out 2026-06-12)', () => {
    expect(CLOCK_TOOLS.map((t) => t.name).join(',')).toBe('now,wait_until');
  });

  describe('now', () => {
    it('returns an ISO timestamp, timezone, and day-of-week', async () => {
      const r = await nowTool.execute({}, ctx());
      expect(r.ok).toBe(true);
      const parsed = JSON.parse(/** @type {import('/shared/tool-types.js').ToolResultOk} */ (r).content);
      expect(typeof parsed.iso).toBe('string');
      expect(parsed.iso.endsWith('Z')).toBe(true);
      expect(typeof parsed.timezone).toBe('string');
      expect(typeof parsed.dayOfWeek).toBe('string');
    });
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
  });
});
