import { describe, test, expect } from 'bun:test';
import { flattenCategorisedDenylist } from '../../extension/peerd-egress/denylist/denylist.js';
import {
  denylistBlockDomains,
  denylistSessionRuleUpdate,
} from '../../extension/peerd-egress/denylist/dnr-rules.js';
import { knownIdpDomains, knownIdpSeeds } from '../../extension/peerd-runtime/actor/idp-registry.js';
import seed from '../../extension/peerd-egress/denylist/default.json';

// The sign-in corridor, asserted ACROSS module boundaries over the REAL data.
//
// why this file exists (and why in meta/): the seed denylist and the IdP
// registry deliberately OVERLAP — okta.com, auth0.com, duosecurity.com,
// appleid.apple.com are in both — because the two lists gate different
// parties: the denylist stops the AGENT driving a login box, the excursion
// rule keeps the TAB usable so the human can sign in. That intent lived only
// in two file headers, so nothing executable failed when the DNR backstop's
// first draft blanket-blocked IdPs in driven tabs and silently broke the
// excursion. Each module's unit tests passed; the bug lived in their
// COMPOSITION. These tests make the coupling an artifact: whichever side
// drifts (a registry edit, a seed edit, a rule-shape change), the invariant
// is re-checked against the other.

const patterns = flattenCategorisedDenylist(seed as any);
const idpDomains = knownIdpDomains();

/** requestDomains semantics: does `domain` cover `host` (itself or a subdomain)? */
const covers = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

describe('denylist × IdP registry — the sign-in corridor', () => {
  test('the overlap exists (the coupling these tests protect is live, not vestigial)', () => {
    const blocked = denylistBlockDomains(patterns);
    const overlap = idpDomains.filter((idp) => blocked.some((b) => covers(idp, b)));
    // If this goes empty, the identity category left the seed (or the registry
    // emptied) and the corridor machinery below is guarding nothing — that is a
    // design change to make knowingly, not by drift.
    expect(overlap.length).toBeGreaterThan(0);
    expect(overlap).toContain('okta.com');
  });

  test('every IdP registry entry stays network-reachable inside a driven tab', () => {
    const update: any = denylistSessionRuleUpdate({
      patterns, tabIds: [7], exemptDomains: idpDomains,
    });
    const block = update.addRules.find((r: any) => r.action.type === 'block');
    const allow = update.addRules.find((r: any) => r.action.type === 'allow');
    expect(block).toBeDefined();
    // The real seed denylists IdP vendors, so the carve-out MUST ride along...
    expect(allow).toBeDefined();
    // ...and outrank the block, or it decides nothing.
    expect(allow.priority).toBeGreaterThan(block.priority);
    // The decisive check, per registry entry: any entry the block rule would
    // catch is also caught by the allow rule — DNR resolves same-match
    // conflicts by priority, so allow-covered means reachable. This is the
    // exact property the first draft violated.
    for (const idp of idpDomains) {
      const blockedBy = block.condition.requestDomains.filter((d: string) => covers(idp, d));
      if (blockedBy.length === 0) continue;   // not denylisted — nothing to carve
      const allowedBy = allow.condition.requestDomains.filter((d: string) => covers(idp, d));
      expect({ idp, blockedBy, allowedBy: allowedBy.length > 0 }).toEqual(
        { idp, blockedBy, allowedBy: true },
      );
    }
  });

  test('the carve-out grants reachability to registry entries ONLY', () => {
    const update: any = denylistSessionRuleUpdate({
      patterns, tabIds: [7], exemptDomains: idpDomains,
    });
    const allow = update.addRules.find((r: any) => r.action.type === 'allow');
    // Every allow-rule domain traces back to the registry — the corridor cannot
    // quietly widen past the one file that owns IdP membership.
    for (const domain of allow.condition.requestDomains) {
      expect(idpDomains).toContain(domain);
    }
  });

  test('knownIdpDomains covers the whole registry (derivation cannot drop entries)', () => {
    const seeds = knownIdpSeeds();
    for (const suffix of seeds.suffixes) expect(idpDomains).toContain(suffix);
    for (const origin of seeds.origins) {
      const host = new URL(origin).hostname;
      expect(idpDomains.some((d) => covers(host, d))).toBe(true);
    }
  });
});
