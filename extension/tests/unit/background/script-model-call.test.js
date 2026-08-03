// @ts-check
// 'script/model-call' — the design-5 sub-model relay, exercised at the WIRE
// against the REAL service worker (the state-get pattern: runner.html is a
// first-party page, so runtime.sendMessage crosses the real dispatcher). The
// route's refusal matrix is custody-critical — a dead/foreign run, a
// non-chat owner, or bad args must never reach a key-bearing model call —
// and scriptModelCallRoute is a deliberate closure over the SW's module
// singletons (sessions, scriptRuns, settings), not an importable unit, so
// the contract is pinned here at the wire.
//
// Scope (deliberate): only the refusal paths reachable WITHOUT a live model
// or an unlocked vault run unconditionally; the foreign-runId check for a
// REAL chat session additionally needs session/list (vault-gated), so that
// test soft-skips on a locked profile. The happy-path round-trip and the
// mid-stream Stop race ride the E2E verify loop (model wire faked over CDP),
// not this tier.

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

  it('refuses an unknown owner session — no key-bearing call without a real chat owner', async () => {
    const reply = await send({
      type: 'script/model-call',
      ownerSessionId: 'no-such-session', runId: 'run-x',
      args: { prompt: 'hi' },
    });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toContain('only a chat session');
  });

  it('refuses a missing owner entirely (fail closed on absent job params)', async () => {
    const reply = await send({ type: 'script/model-call', args: { prompt: 'hi' } });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toContain('only a chat session');
  });

  it('refuses a foreign/dead runId for a REAL chat session (owner check passes, run check refuses)', async () => {
    // Needs a real chat session id — session/list is vault-gated, so a locked
    // profile (the headless CDP default) soft-skips rather than false-fails.
    const list = await send({ type: 'session/list' });
    if (!list?.ok) { expect(String(list?.error)).toBe('locked'); return; }
    const sid = /** @type {any} */ (list).sessions?.[0]?.sessionId;
    if (!sid) return;   // fresh profile, no chats yet — nothing to pin against
    const reply = await send({
      type: 'script/model-call',
      ownerSessionId: sid, runId: 'never-registered-run',
      args: { prompt: 'hi' },
    });
    expect(reply?.ok).toBe(false);
    expect(String(reply?.error)).toContain('unknown or finished run');
  });
});
