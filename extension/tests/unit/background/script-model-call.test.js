// @ts-check
// 'script/model-call' — the design-5 sub-model relay, exercised at the WIRE
// against the REAL service worker (the state-get pattern: runner.html is a
// first-party page, so runtime.sendMessage crosses the real dispatcher). The
// Exact offscreen provenance is the outer custody wall: this runner page must
// never reach owner/run validation or a key-bearing model call —
// and scriptModelCallRoute is a deliberate closure over the SW's module
// singletons (sessions, scriptRuns, settings), not an importable unit, so
// the contract is pinned here at the wire.
//
// Deeper owner/capability behavior is covered by pure registry/tool tests; the
// happy path and Stop race ride the E2E verify loop.

import { describe, it, expect } from '../../framework.js';
import browser from '/vendor/browser-polyfill.js';

// bootstrap.js synthesizes runtime.id/getURL for the http harness but
// deliberately NOT sendMessage — its absence is the honest "no real SW
// here" signal (same environment gate as state-get.test.js).
const HAVE_LIVE_SW = typeof globalThis.chrome?.runtime?.sendMessage === 'function';

/** @param {object} msg @returns {Promise<{ ok?: boolean, error?: string, value?: object }>} */
const send = (msg) => /** @type {Promise<any>} */ (browser.runtime.sendMessage(msg));

describe('background/script-model-call — the sub-model relay refusal matrix', () => {
  it(HAVE_LIVE_SW
    ? 'live service worker present — round-trip tests registered'
    : 'no live service worker (http harness) — round-trips skipped (open chrome-extension://<id>/tests/runner.html)', () => {
    expect(true).toBe(true);
  });

  if (!HAVE_LIVE_SW) return;

  it('refuses the runner page before owner/run validation', async () => {
    const reply = await send({
      type: 'script/model-call',
      ownerSessionId: 'no-such-session', runId: 'run-x',
      args: { prompt: 'hi' },
    });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toContain('unauthorized relay');
  });

  it('refuses missing job params at the same provenance wall', async () => {
    const reply = await send({ type: 'script/model-call', args: { prompt: 'hi' } });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toContain('unauthorized relay');
  });
});
