import { describe, test, expect } from 'bun:test';
import {
  denylistBlockDomains,
  buildDenylistBlockRule,
  buildIdpAllowRule,
  denylistSessionRuleUpdate,
  DENYLIST_RULE_ID,
  APP_EGRESS_RULE_ID,
  buildAppEgressBlockRule,
  DENYLIST_ALLOW_RULE_ID,
  DENYLIST_RESOURCE_TYPES,
  buildPrivateNetworkBlockRules,
  buildPrivateNetworkInitiatorBlockRules,
  PRIVATE_NETWORK_HOSTS,
  PRIVATE_NETWORK_IPV4_REGEX_RULES,
  PRIVATE_NETWORK_IPV6_REGEX_RULES,
  PRIVATE_NETWORK_DOTTED_HOST_REGEX_RULES,
  PRIVATE_NETWORK_RULE_IDS,
  PRIVATE_NETWORK_INITIATOR_RULE_ID_OFFSET,
  PRIVATE_NETWORK_INITIATOR_RULE_IDS,
  PRIVATE_NETWORK_NO_TAB_ID,
  CHROME_DNR_RESOURCE_TYPES,
} from '../../extension/peerd-egress/denylist/dnr-rules.js';

const ALL_RULE_IDS = [
  DENYLIST_RULE_ID,
  DENYLIST_ALLOW_RULE_ID,
  APP_EGRESS_RULE_ID,
  ...PRIVATE_NETWORK_RULE_IDS,
  ...PRIVATE_NETWORK_INITIATOR_RULE_IDS,
];

// The denylist's network-level backstop, pure half. The property that matters
// most is negative: every rule must be scoped either to peerd's driven tabs or
// to a custodied initiator with no-tab narrowing. An unscoped rule would block
// the user's browsing.

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
    expect(update.removeRuleIds).toEqual(ALL_RULE_IDS);
    expect(update.addRules).toHaveLength(1 + PRIVATE_NETWORK_RULE_IDS.length);
  });
  test('with no driven tabs it is a pure removal', () => {
    const update = denylistSessionRuleUpdate({ patterns: ['chase.com'], tabIds: [] });
    expect(update).toEqual({ removeRuleIds: ALL_RULE_IDS, addRules: [] });
  });
  test('exempt IdP domains ride along as a higher-priority allow rule', () => {
    const update: any = denylistSessionRuleUpdate({
      patterns: ['*.okta.com', 'chase.com'], tabIds: [4], exemptDomains: ['okta.com'],
    });
    expect(update.removeRuleIds).toEqual(ALL_RULE_IDS);
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
    const update: any = denylistSessionRuleUpdate({ patterns: ['chase.com'], tabIds: [4] });
    expect(update.addRules.some((rule: any) => rule.action.type === 'allow')).toBe(false);
  });

  test('an allow rule is never emitted without a block rule to carve out', () => {
    // No driven tabs → no block; the allow rule must not appear on its own.
    expect(denylistSessionRuleUpdate({ patterns: ['chase.com'], tabIds: [], exemptDomains: ['okta.com'] }).addRules)
      .toEqual([]);
    // No denylist at all → private-network rules remain, but no allow rule.
    expect(denylistSessionRuleUpdate({ patterns: [], tabIds: [4], exemptDomains: ['okta.com'] }).addRules
      .some((rule: any) => rule.action.type === 'allow')).toBe(false);
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
    // okta.com IS in the blocked set — the IdP registry's carve-out restores its
    // reachability via the higher-priority allow rule, not by narrowing this
    // list. The composition invariant lives in tests/meta/denylist-idp-corridor:
    // an earlier revision of THIS test pinned the bare containment with no
    // carve-out anywhere, i.e. encoded the broken sign-in corridor as expected.
    expect(domains).toContain('okta.com');
  });

});

describe('buildPrivateNetworkBlockRules, tab-associated network floor', () => {
  test('no driven tabs means no private-network rule', () => {
    expect(buildPrivateNetworkBlockRules({ tabIds: [] })).toEqual([]);
  });

  test('all rules are block-only, tab-scoped, and outrank the IdP allow corridor', () => {
    const rules: any[] = buildPrivateNetworkBlockRules({ tabIds: [7, 7, -1, 9] });
    expect(rules.map((rule) => rule.id)).toEqual([...PRIVATE_NETWORK_RULE_IDS]);
    for (const rule of rules) {
      expect(rule.action).toEqual({ type: 'block' });
      expect(rule.priority).toBeGreaterThan(2);
      expect(rule.condition.tabIds).toEqual([7, 9]);
      expect(rule.condition.resourceTypes).toEqual([...DENYLIST_RESOURCE_TYPES]);
    }
  });

  test('host rule covers local aliases and metadata without a broad internal suffix', () => {
    expect(PRIVATE_NETWORK_HOSTS).toContain('localhost');
    expect(PRIVATE_NETWORK_HOSTS).toContain('local');
    expect(PRIVATE_NETWORK_HOSTS).toContain('home.arpa');
    expect(PRIVATE_NETWORK_HOSTS).toContain('metadata.google.internal');
    expect(PRIVATE_NETWORK_HOSTS).not.toContain('internal');
  });

  test('trailing-dot local names match the browser-portable regex backstop', () => {
    const matches = (raw: string) => PRIVATE_NETWORK_DOTTED_HOST_REGEX_RULES
      .some(({ regex }) => new RegExp(regex, 'i').test(new URL(raw).href));
    for (const raw of [
      'http://localhost.',
      'http://api.localhost.',
      'http://api.localhost.localdomain.',
      'http://printer.local.',
      'http://router.home.arpa.',
      'http://metadata.google.internal.',
      'http://ip6-loopback.',
      'ws://localhost.:8080/socket',
    ]) expect(matches(raw)).toBe(true);
    for (const raw of ['https://notlocalhost.com.', 'https://local.example.com.']) {
      expect(matches(raw)).toBe(false);
    }
  });

  test('Firefox covers its full supported request enum and Chrome stays explicit', () => {
    expect(DENYLIST_RESOURCE_TYPES).toContain('csp_report');
    expect(DENYLIST_RESOURCE_TYPES).toContain('beacon');
    expect(DENYLIST_RESOURCE_TYPES).toContain('imageset');
    expect(DENYLIST_RESOURCE_TYPES).toContain('json');
    expect(DENYLIST_RESOURCE_TYPES).toContain('web_manifest');
    expect(DENYLIST_RESOURCE_TYPES).toContain('xslt');
    expect(DENYLIST_RESOURCE_TYPES).toContain('xml_dtd');
    expect(DENYLIST_RESOURCE_TYPES).toContain('speculative');
    expect(DENYLIST_RESOURCE_TYPES).not.toContain('object_subrequest');
    expect(DENYLIST_RESOURCE_TYPES).not.toContain('webbundle');
    expect(DENYLIST_RESOURCE_TYPES).not.toContain('webtransport');
    expect(CHROME_DNR_RESOURCE_TYPES).toEqual([
      'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
      'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
      'webbundle', 'webtransport', 'other',
    ]);
    const update: any = denylistSessionRuleUpdate({
      patterns: [], tabIds: [7], resourceTypes: CHROME_DNR_RESOURCE_TYPES,
    });
    expect(update.addRules.every((rule: any) =>
      rule.condition.resourceTypes.includes('webtransport'))).toBe(true);
  });

  test('normalized private IPv4 URLs match, including userinfo and metadata', () => {
    const matches = (raw: string) => PRIVATE_NETWORK_IPV4_REGEX_RULES
      .some(({ regex }) => new RegExp(regex, 'i').test(new URL(raw).href));
    for (const raw of [
      'http://127.1',
      'http://user:pass@10.0.0.8/admin',
      'http://100.100.100.200/latest/meta-data',
      'http://168.63.129.16/machine',
      'http://3232235777',
      'http://224.0.0.1',
      'ws://127.0.0.1/socket',
      'wss://10.0.0.8/socket',
    ]) expect(matches(raw)).toBe(true);
    for (const raw of ['https://8.8.8.8', 'http://100.128.0.0', 'http://198.20.0.1']) {
      expect(matches(raw)).toBe(false);
    }
  });

  test('private IPv6 literals match while global and public embeddings do not', () => {
    const matches = (raw: string) => PRIVATE_NETWORK_IPV6_REGEX_RULES
      .some(({ regex }) => new RegExp(regex, 'i').test(new URL(raw).href));
    for (const raw of [
      'http://[::1]',
      'http://[fd00:ec2::254]/latest',
      'http://[fe80::1]',
      'http://[ff02::1]',
      'http://[::ffff:127.0.0.1]',
      'http://[::ff]',
      'http://[::ffff]',
      'http://[::ffff:1]',
      'http://[64:ff9b::a9fe:a9fe]',
      'http://[64:ff9b::]',
      'http://[64:ff9b::1]',
      'http://[64:ff9b:1::1]',
      'ws://[::1]/socket',
      'ws://[::ffff:127.0.0.1]/socket',
    ]) expect(matches(raw)).toBe(true);
    for (const raw of [
      'http://[2606:4700:4700::1111]',
      'http://[64:ff9b::808:808]',
      'http://[::ffff:808:808]',
    ]) expect(matches(raw)).toBe(false);
  });
});

describe('buildPrivateNetworkInitiatorBlockRules, no-tab worker floor', () => {
  test('no custodied initiator domains means no no-tab rule', () => {
    expect(buildPrivateNetworkInitiatorBlockRules({ initiatorDomains: [] })).toEqual([]);
  });

  test('every rule requires both no-tab and canonical initiator scope', () => {
    const rules: any[] = buildPrivateNetworkInitiatorBlockRules({
      initiatorDomains: ['worker.example', 'worker.example', 'api.worker.example'],
    });
    expect(rules.map((rule) => rule.id)).toEqual([...PRIVATE_NETWORK_INITIATOR_RULE_IDS]);
    expect(rules).toHaveLength(PRIVATE_NETWORK_RULE_IDS.length);
    for (const rule of rules) {
      expect(rule.action).toEqual({ type: 'block' });
      expect(rule.priority).toBe(4);
      expect(rule.condition.tabIds).toEqual([PRIVATE_NETWORK_NO_TAB_ID]);
      expect(rule.condition.initiatorDomains).toEqual(['api.worker.example', 'worker.example']);
      expect(rule.condition.resourceTypes).toEqual([...DENYLIST_RESOURCE_TYPES]);
    }
  });

  test('the companion ids are disjoint from every tab-scoped rule id', () => {
    expect(PRIVATE_NETWORK_INITIATOR_RULE_IDS.every((id) =>
      id >= PRIVATE_NETWORK_INITIATOR_RULE_ID_OFFSET
        && !PRIVATE_NETWORK_RULE_IDS.includes(id))).toBe(true);
  });

  test('invalid or non-canonical initiators cannot widen the no-tab scope', () => {
    const rules: any[] = buildPrivateNetworkInitiatorBlockRules({
      initiatorDomains: [
        '', 'Worker.Example', 'https://worker.example', 'worker.example:8443',
        '*.worker.example', 'worker.example/path', 'work\u00e9r.example',
      ],
    });
    expect(rules).toEqual([]);
  });

  test('a caller cannot substitute an ordinary or browser-wide tab scope', () => {
    expect(buildPrivateNetworkInitiatorBlockRules({
      initiatorDomains: ['worker.example'], noTabId: 7,
    })).toEqual([]);
  });

  test('the full reconcile adds companions only for live initiators', () => {
    const withoutInitiator = denylistSessionRuleUpdate({ patterns: [], tabIds: [7] });
    expect(withoutInitiator.addRules).toHaveLength(PRIVATE_NETWORK_RULE_IDS.length);

    const withInitiator: any = denylistSessionRuleUpdate({
      patterns: [], tabIds: [7], initiatorDomains: ['worker.example'],
    });
    expect(withInitiator.removeRuleIds).toEqual(ALL_RULE_IDS);
    expect(withInitiator.addRules).toHaveLength(
      PRIVATE_NETWORK_RULE_IDS.length
        + PRIVATE_NETWORK_INITIATOR_RULE_IDS.length,
    );
    const companions = withInitiator.addRules.filter((rule: any) =>
      PRIVATE_NETWORK_INITIATOR_RULE_IDS.includes(rule.id));
    expect(companions).toHaveLength(PRIVATE_NETWORK_INITIATOR_RULE_IDS.length);
    expect(companions.every((rule: any) =>
      JSON.stringify(rule.condition.tabIds) === JSON.stringify([PRIVATE_NETWORK_NO_TAB_ID])
        && JSON.stringify(rule.condition.initiatorDomains) === JSON.stringify(['worker.example'])))
      .toBe(true);
  });
});

describe('buildAppEgressBlockRule: App tabs have no remote network edge', () => {
  test('no App tabs means no rule', () => {
    expect(buildAppEgressBlockRule({ tabIds: [] })).toBeNull();
  });

  test('the rule is tab-scoped and blocks every HTTP(S) resource type', () => {
    const rule: any = buildAppEgressBlockRule({ tabIds: [11, 11, -1, 12] });
    expect(rule.id).toBe(APP_EGRESS_RULE_ID);
    expect(rule.action).toEqual({ type: 'block' });
    expect(rule.condition.regexFilter).toBe('^https?://');
    expect(rule.condition.tabIds).toEqual([11, 12]);
    expect(rule.condition.resourceTypes).toEqual([...DENYLIST_RESOURCE_TYPES]);
  });

  test('the App rule survives even when the user denylist is empty', () => {
    const update: any = denylistSessionRuleUpdate({
      patterns: [], tabIds: [], appTabIds: [17],
    });
    expect(update.addRules).toHaveLength(1);
    expect(update.addRules[0].id).toBe(APP_EGRESS_RULE_ID);
    expect(update.addRules[0].condition.tabIds).toEqual([17]);
  });
});

describe('buildAppEgressBlockRule — App tabs have no remote network edge', () => {
  test('no App tabs means no rule', () => {
    expect(buildAppEgressBlockRule({ tabIds: [] })).toBeNull();
  });

  test('the rule is tab-scoped and blocks every HTTP(S) resource type', () => {
    const rule: any = buildAppEgressBlockRule({ tabIds: [11, 11, -1, 12] });
    expect(rule.id).toBe(APP_EGRESS_RULE_ID);
    expect(rule.action).toEqual({ type: 'block' });
    expect(rule.condition.regexFilter).toBe('^https?://');
    expect(rule.condition.tabIds).toEqual([11, 12]);
    expect(rule.condition.resourceTypes).toEqual([...DENYLIST_RESOURCE_TYPES]);
  });

  test('the App rule survives even when the user denylist is empty', () => {
    const update: any = denylistSessionRuleUpdate({
      patterns: [], tabIds: [], appTabIds: [17],
    });
    expect(update.addRules).toHaveLength(1);
    expect(update.addRules[0].id).toBe(APP_EGRESS_RULE_ID);
    expect(update.addRules[0].condition.tabIds).toEqual([17]);
  });
});
