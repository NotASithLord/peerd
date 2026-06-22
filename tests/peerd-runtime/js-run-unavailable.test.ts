// js_run — clean "unavailable" signal when the offscreen host is absent.
//
// On Firefox there is no chrome.offscreen, so the SW injects a NULL
// jsOffscreenClient into the tool context (service-worker.js: gated on
// `offscreenAvailable`). This test pins the TOOL CONTRACT that gating relies
// on: a missing/!execHeadless client yields the actionable
// `headless_js_unavailable` error the agent can read — NOT an opaque "headless
// job failed" from a job message that no offscreen context is alive to answer.
//
// Scope note: this exercises the tool's guard (which is unchanged by the fix);
// the SW-level `offscreenAvailable ? … : null` gate that actually injects the
// null on Firefox is pinned separately by tests/background/offscreen-gate.test.ts.

import { describe, test, expect } from 'bun:test';
import { jsRunTool } from '../../extension/peerd-runtime/tools/defs/js-run.js';

const ctx = (over: any = {}) => ({ session: { sessionId: 's1' }, ...over });

describe('js_run — offscreen host availability', () => {
  test('no jsOffscreenClient (Firefox) → headless_js_unavailable', async () => {
    const r = await jsRunTool.execute({ code: 'return 1' }, ctx() as any);
    expect(r).toEqual({ ok: false, error: 'headless_js_unavailable' });
  });

  test('client present but missing execHeadless → headless_js_unavailable', async () => {
    const r = await jsRunTool.execute(
      { code: 'return 1' },
      ctx({ jsOffscreenClient: {} }) as any,
    );
    expect(r).toEqual({ ok: false, error: 'headless_js_unavailable' });
  });

  test('empty code is rejected before the availability check', async () => {
    const r = await jsRunTool.execute({ code: '' }, ctx() as any);
    expect(r).toEqual({ ok: false, error: 'code_required' });
  });

  test('a live client still dispatches (the tool contract holds with a real client)', async () => {
    let dispatched = false;
    const r = await jsRunTool.execute(
      { code: 'return 1' },
      ctx({
        jsOffscreenClient: {
          execHeadless: async () => {
            dispatched = true;
            return { durationMs: 1, value: 1 };
          },
        },
      }) as any,
    );
    expect(dispatched).toBe(true);
    expect(r.ok).toBe(true);
  });
});
