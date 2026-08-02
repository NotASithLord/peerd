import { describe, test, expect } from 'bun:test';
import {
  denylistBlockDomains,
  buildDenylistBlockRule,
  buildIdpAllowRule,
  denylistSessionRuleUpdate,
  DENYLIST_RULE_ID,
  DENYLIST_ALLOW_RULE_ID,
  DENYLIST_RESOURCE_TYPES,
} from '../../extension/peerd-egress/denylist/dnr-rules.js';

// The denylist's network-level backstop, pure half. The property that matters
// most is negative: this must never produce a rule that isn't scoped to peerd's
// own driven tabs, because that rule would block the USER's browsing.

describe('denylistBlockDomains — patterns → requestDomains', () => {
  test('apex and its wildcard collapse to one domain', () => {
    expect(denylistBlockDomains(['chase.com', '*.chase.com'])).toEqual(['chase.com']);
  });
  test('a wildcard-only pattern maps to the base domain (deliberately stricter)', () => {
    // requestDomains has no subdomain-only form; blocking okta.com's apex too
    // is the safe direction of that imprecision. See dnr-rules.js.
    expect(denylistBlockDomains(['*.okta.com'])).toEqual(['okta.com']);
  });
  test('domains already covered by a broader entry are dropped', () => {
    expect(denylistBlockDomains(['proton.me', 'mail.proton.me', '*.proton.me']))
      .toEqual(['proton.me']);
  });
  test('a look-alike is NOT treated as covered (label boundary)', () => {
    expect(denylistBlockDomains(['chase.com', 'evilchase.com']))
      .toEqual(['chase.com', 'evilchase.com']);
  });
  test('patterns the JS matcher would reject are dropped, not passed through', () => {
    expect(denylistBlockDomains(['not a host', 'nodot', 'ev*il.com', '', 'ok.com']))
      .toEqual(['ok.com']);
  });
  test('a pasted URL normalizes like it does in the matcher', () => {
    expect(denylistBlockDomains(['https://chase.com/login?x=1'])).toEqual(['chase.com']);
  });
  test('output is sorted and deduped (stable across resyncs)', () => {
    const a = denylistBlockDomains(['b.com', 'a.com', 'b.com']);
    const b = denylistBlockDomains(['a.com', 'b.com']);
    expect(a).toEqual(['a.com', 'b.com']);
    expect(a).toEqual(b);
  });
  test('empty input is empty output, not a throw', () => {
    expect(denylistBlockDomains([])).toEqual([]);
  });
});

describe('buildDenylistBlockRule — never unscoped', () => {
  test('no tabs → no rule (an unscoped rule would block the user\'s own browsing)', () => {
    expect(buildDenylistBlockRule({ domains: ['chase.com'], tabIds: [] })).toBeNull();
  });
  test('no domains → no rule', () => {
    expect(buildDenylistBlockRule({ domains: [], tabIds: [7] })).toBeNull();
  });
  test('the built rule blocks, is tab-scoped, and covers main_frame', () => {
    const rule: any = buildDenylistBlockRule({ domains: ['chase.com'], tabIds: [7, 9] });
    expect(rule.id).toBe(DENYLIST_RULE_ID);
    expect(rule.action).toEqual({ type: 'block' });
    expect(rule.condition.requestDomains).toEqual(['chase.com']);
    expect(rule.condition.tabIds).toEqual([7, 9]);
    expect(rule.condition.resourceTypes).toContain('main_frame');
    expect(rule.condition.resourceTypes).toContain('sub_frame');
    expect(rule.condition.resourceTypes).toEqual([...DENYLIST_RESOURCE_TYPES]);
  });
  test('tab ids are deduped and non-integers dropped', () => {
    const rule: any = buildDenylistBlockRule({
      domains: ['a.com'], tabIds: [3, 3, -1, 4.5, 8] as any,
    });
    expect(rule.condition.tabIds).toEqual([3, 8]);
  });
});

describe('denylistSessionRuleUpdate — idempotent reconcile', () => {
  test('always removes the rule id first, so applying it is self-healing', () => {
    const update = denylistSessionRuleUpdate({ patterns: ['chase.com'], tabIds: [1] });
    expect(update.removeRuleIds).toEqual([DENYLIST_RULE_ID, DENYLIST_ALLOW_RULE_ID]);
    expect(update.addRules).toHaveLength(1);
  });
  test('with no driven tabs it is a pure removal', () => {
    const update = denylistSessionRuleUpdate({ patterns: ['chase.com'], tabIds: [] });
    expect(update).toEqual({ removeRuleIds: [DENYLIST_RULE_ID, DENYLIST_ALLOW_RULE_ID], addRules: [] });
  });
  test('exempt IdP domains ride along as a higher-priority allow rule', () => {
    const update: any = denylistSessionRuleUpdate({
      patterns: ['*.okta.com', 'chase.com'], tabIds: [4], exemptDomains: ['okta.com'],
    });
    expect(update.removeRuleIds).toEqual([DENYLIST_RULE_ID, DENYLIST_ALLOW_RULE_ID]);
    const [block, allow] = update.addRules;
    expect(block.action.type).toBe('block');
    expect(allow.action.type).toBe('allow');
    // The corridor only works if allow OUTRANKS block where they overlap.
    expect(allow.priority).toBeGreaterThan(block.priority);
    expect(allow.condition.requestDomains).toEqual(['okta.com']);
    expect(allow.condition.tabIds).toEqual([4]);
    // The block rule is NOT narrowed — the allow rule is what carves it out, so
    // the denylist entry still exists for every other consumer to reason about.
    expect(block.condition.requestDomains).toContain('okta.com');
  });

  test('no exempt domains → no allow rule (nothing extra in front of the user)', () => {
    const update = denylistSessionRuleUpdate({ patterns: ['chase.com'], tabIds: [4] });
    expect(update.addRules).toHaveLength(1);
  });

  test('an allow rule is never emitted without a block rule to carve out', () => {
    // No driven tabs → no block; the allow rule must not appear on its own.
    expect(denylistSessionRuleUpdate({ patterns: ['chase.com'], tabIds: [], exemptDomains: ['okta.com'] }).addRules)
      .toEqual([]);
    // No denylist at all → same.
    expect(denylistSessionRuleUpdate({ patterns: [], tabIds: [4], exemptDomains: ['okta.com'] }).addRules)
      .toEqual([]);
    expect(buildIdpAllowRule({ domains: ['okta.com'], tabIds: [] })).toBeNull();
    expect(buildIdpAllowRule({ domains: [], tabIds: [4] })).toBeNull();
  });

  test('the real seed denylist collapses to a workable domain count', async () => {
    const seed = await Bun.file('extension/peerd-egress/denylist/default.json').json();
    const patterns: string[] = Object.values(seed.categories).flat() as string[];
    const domains = denylistBlockDomains(patterns);
    // Every pattern maps to something (nothing silently dropped as invalid)...
    expect(domains.length).toBeGreaterThan(0);
    // ...and apex+wildcard pairing means the rule carries roughly half the list,
    // comfortably inside one rule's condition.
    expect(domains.length).toBeLessThan(patterns.length);
    expect(domains).toContain('chase.com');
    expect(domains).toContain('okta.com');
  });
});
