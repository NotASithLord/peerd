// @ts-check
// The DEFAULT (code) hook set — what ships ON, for everyone, with no opt-in.
//
// This lives in the BROWSER suite rather than under Bun for one concrete
// reason: the defaults barrel pulls egress-allowlist, which reaches
// /peerd-egress and therefore the browser polyfill. Bun can't load it, so the
// tripwire's behaviour is tested there against the hook file directly
// (tests/peerd-runtime/tools/egress-tripwire-hook.test.ts) and the claim that
// it is actually REGISTERED is made here, where the real barrel loads.
//
// why the claim is worth a test at all: a security hook that is written,
// reviewed, and merged but never added to DEFAULT_HOOKS is indistinguishable
// from one that doesn't exist — and nothing else in the suite would notice.

import { describe, it, expect } from '../../framework.js';
import { DEFAULT_HOOKS } from '/peerd-runtime/index.js';

describe('DEFAULT_HOOKS', () => {
  const ids = () => DEFAULT_HOOKS.map((h) => h.id);

  it('registers the egress allowlist — the hard network floor', () => {
    expect(ids().includes('egress-allowlist')).toBe(true);
  });

  it('registers the egress tripwire beside it (security-arc issue 243)', () => {
    // The pairing IS the design: the allowlist deliberately EXEMPTS
    // primitive:'tab' tools (reaching the user's own logged-in apps is the
    // thesis), and the tripwire covers exactly that exemption. Either alone
    // leaves the DOM-data→URL exfiltration hole open.
    expect(ids().includes('egress-tripwire')).toBe(true);
  });

  it('orders the allowlist first, so a hard-floor block is what a user sees', () => {
    const orderOf = (/** @type {string} */ id) => DEFAULT_HOOKS.find((h) => h.id === id)?.order ?? -1;
    expect(orderOf('egress-allowlist') < orderOf('egress-tripwire')).toBe(true);
  });

  it('every default is a pre-tool-use veto with a user-readable description', () => {
    // Both are rendered verbatim in Context → Hooks. An empty description there
    // is a hook the user cannot reason about.
    for (const h of DEFAULT_HOOKS) {
      expect(h.event).toBe('pre-tool-use');
      expect(typeof h.description === 'string' && h.description.length > 40).toBe(true);
    }
  });
});
