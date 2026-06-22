// @ts-check
// 'state/get' — the options page's one-shot snapshot route. LIVE
// round-trip: runner.html is a first-party extension page, so
// runtime.sendMessage hits the REAL service worker through the real
// makeDispatcher (isFirstPartySender gate included). buildStateSnapshot
// is a deliberate closure over the SW's module singletons — not an
// importable unit like vm-tab-tracker — so the contract is pinned at
// the wire, not the function.
//
// Scope (deliberate): only invariants shared by BOTH snapshot shapes
// (locked minimal / unlocked full) are asserted. The runner may execute
// against a locked vault (headless CDP profile) or an unlocked dev
// profile, and exercising the unlocked shape on purpose would mean
// initializing/unlocking the real vault from a test — destructive
// outside the disposable CDP profile.
//
// Environment gate (same pattern as webauthn-virtual.test.js): the CDP
// harness serves the runner over http with NO real SW behind it (Chrome
// blocks top-level CDP navigation to extension pages), so a live
// round-trip is only possible when the runner is opened from
// chrome-extension://<id>/tests/runner.html. Elsewhere the suite
// registers a single always-passing documentation test whose name says
// the round-trips were skipped.

import { describe, it, expect } from '../../framework.js';
import browser from '/vendor/browser-polyfill.js';

// bootstrap.js synthesizes runtime.id/getURL for the http harness but
// deliberately NOT sendMessage — its absence is the honest "no real SW
// here" signal.
const HAVE_LIVE_SW = typeof globalThis.chrome?.runtime?.sendMessage === 'function';

/**
 * The slice of the SW's buildStateSnapshot reply this contract test reads
 * back over the wire. The snapshot itself is an untyped closure return in the
 * service worker; pinning the shape here makes the test a drift detector for
 * the route's contract (CLAUDE.md: tests double as JSDoc-contract detectors).
 * @typedef {object} StateSnapshot
 * @property {{ initialized: boolean, locked: boolean, prfEnrolled: boolean, hasRecovery: boolean }} vault
 * @property {object} settings
 * @property {{ hasKey: boolean }} providers
 * @property {{ permission: { mode: string, confirmActions: boolean }, messages?: unknown }} session
 *
 * @typedef {{ ok?: boolean, state: StateSnapshot }} StateReply
 */

/** @returns {Promise<StateReply>} */
const getState = () =>
  /** @type {Promise<StateReply>} */ (browser.runtime.sendMessage({ type: 'state/get' }));

// Property names that would indicate key material. hasKey (a boolean)
// passes the VALUE check below; an actual API key / secret / passphrase
// would be a non-empty string and fail.
const SECRET_NAME = /(key|secret|token|passphrase|credential)/i;

/**
 * Walk the snapshot and collect paths where a secret-suggesting NAME
 * holds a value-bearing string — the leak shape. session.messages is
 * excluded: transcript content is user-authored data the snapshot
 * carries faithfully (a user pasting a key into chat is not a builder
 * leak), and on an unlocked dev profile it is arbitrary.
 */
/**
 * @param {unknown} node
 * @param {string} [path]
 * @param {string[]} [out]
 * @returns {string[]}
 */
const findLeaks = (node, path = '', out = []) => {
  if (node === null || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k;
    if (p === 'session.messages') continue;
    if (SECRET_NAME.test(k) && typeof v === 'string' && v.length > 0) out.push(p);
    findLeaks(v, p, out);
  }
  return out;
};

describe('background/state-get — one-shot snapshot route', () => {
  it(HAVE_LIVE_SW
    ? 'live service worker present — round-trip tests registered'
    : 'no live service worker (http harness) — round-trips skipped (open chrome-extension://<id>/tests/runner.html)', () => {
    // Documentation test: always passes; its NAME tells a human reading
    // the runner page whether the round-trips below actually ran.
    expect(true).toBe(true);
  });

  if (!HAVE_LIVE_SW) return;

  it('replies ok with a state object (route exists, sender admitted)', async () => {
    const reply = await getState();
    expect(reply?.ok).toBe(true);
    expect(typeof reply.state).toBe('object');
    expect(reply.state !== null).toBe(true);
  });

  it('vault block carries the gate fields in both shapes', async () => {
    const { state } = await getState();
    expect(typeof state.vault.initialized).toBe('boolean');
    expect(typeof state.vault.locked).toBe('boolean');
    expect(typeof state.vault.prfEnrolled).toBe('boolean');
    expect(typeof state.vault.hasRecovery).toBe('boolean');
  });

  it('settings is an object and providers.hasKey is a boolean', async () => {
    const { state } = await getState();
    expect(typeof state.settings).toBe('object');
    expect(state.settings !== null).toBe(true);
    expect(typeof state.providers.hasKey).toBe('boolean');
  });

  it('session.permission resolves in both shapes (the options Behavior page reads it)', async () => {
    const { state } = await getState();
    expect(typeof state.session.permission.mode).toBe('string');
    expect(typeof state.session.permission.confirmActions).toBe('boolean');
  });

  it('carries no key material anywhere in the snapshot', async () => {
    const { state } = await getState();
    expect(findLeaks(state)).toEqual([]);
  });
});
