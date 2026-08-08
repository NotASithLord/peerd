// @ts-check
// Denylist → declarativeNetRequest rules. The NETWORK-level half of the
// denylist; the pure core, so it is testable without a browser.
//
// why a second enforcement point at all — the JS gates already check the
// denylist in three places (the dispatcher's origin gate, webFetch, and the
// tab-affordance hint). All three are DECISION-TIME checks: they judge a URL
// the agent hands us, BEFORE the request. What none of them can see is what
// the page does next. Once a peerd-driven tab is on a page, that page can
// navigate itself anywhere — `location =`, a meta refresh, a form POST, an
// iframe, an OAuth bounce — and nothing in peerd is on that path. The agent
// then reads a bank's DOM through a tool call that never named the bank, so
// no gate ever got a URL to refuse. Same hole in an App sandbox: agent-authored
// code in an opaque-origin iframe reaches the network directly, not through
// webFetch.
//
// declarativeNetRequest closes it at the layer the page cannot argue with. The
// rules are SESSION-scoped and custody-scoped. Ordinary page requests are tied
// to tabs peerd is driving. Page service-worker requests are tied to both the
// browser's no-tab identity and a currently custodied initiator domain. Neither
// form becomes a browser-wide rule. Blocking the user's bank tab would be a
// bug, not a feature. The denylist says "the agent may not go here", not "this
// browser may not go here".
//
// This is a BACKSTOP, not the primary control. The JS gates stay exactly as
// they are: they produce the refusal the model can read and the audit entry the
// user can see. DNR produces a dead socket and no explanation. Where they
// disagree, the JS gates are the specification.
//
// The mapping is deliberately COARSER than the JS matcher, in the strict
// direction. DNR's `requestDomains` matches a domain AND its subdomains; there
// is no subdomain-only form short of a regex rule. So `*.okta.com` maps to the
// domain `okta.com`, which also blocks the apex the JS matcher would allow.
// Over-blocking one apex inside an agent-driven tab is the cheap side of that
// trade — and every seed entry that has an apex lists it explicitly anyway.

import { normalizeDenylistPattern } from './denylist.js';

/**
 * The session rule id the denylist block rule occupies. ONE rule carries every
 * domain and every protected tab, so a resync is a single remove+add and the id
 * can be a constant. why one rule: `requestDomains` and `tabIds` are both lists
 * on a single condition, so per-domain or per-tab rules would buy nothing but
 * bookkeeping (and rule-count pressure against the session-rule cap).
 */
export const DENYLIST_RULE_ID = 1;

/**
 * The companion ALLOW rule's id, at a higher priority than the block — the
 * sign-in corridor.
 *
 * why it exists: the origin lock (peerd-runtime/actor/landing-rule.js) lets a
 * BOUND actor's tab leave its owned origin exactly once, for an identity
 * provider, on a budgeted excursion. Several of those providers — okta.com,
 * auth0.com, duosecurity.com, appleid.apple.com — are also denylist entries, and
 * that overlap is deliberate on both sides: the denylist stops the AGENT from
 * driving a login box, while the excursion rule keeps the tab usable so the
 * SIGN-IN can still happen and the actor can resume when the tab comes home.
 *
 * A blanket network block would collapse that distinction — the login page would
 * not render at all, so not even the person at the keyboard could complete it.
 * The allow rule keeps the corridor open at the network layer ONLY. It grants
 * the agent nothing: `isDenylistedTab` still refuses every DOM tool on such a
 * tab and the origin gate still refuses a navigate to it, so what the agent may
 * DO on an IdP page is unchanged — only whether the bytes arrive for the human.
 *
 * The exempt set is INJECTED (peerd-runtime owns the IdP registry, and egress
 * sits below runtime — it must not reach up for it). Widening that registry is a
 * security decision that belongs in one place, and this file is not it.
 */
export const DENYLIST_ALLOW_RULE_ID = 2;

// App code is an untrusted opaque-origin document. Its CSP is the primary
// resource/connect fence, but CSP does not reliably govern self-navigation:
// `location = https://…` can still issue a sub-frame request before the host
// notices the runner was replaced. This session rule is the browser-network
// floor for every live App tab. It deliberately matches only remote schemes,
// so the chrome-extension:// host and runner continue to load.
export const APP_EGRESS_RULE_ID = 3;

// Private-network navigation is a separate policy from the user's sensitive-
// site denylist. These rules are always present for driven tabs, even when the
// denylist is empty, because a public page can initiate a form submit, redirect,
// iframe load, or popup without naming that destination in a tool call.
export const PRIVATE_NETWORK_HOST_RULE_ID = 4;

export const PRIVATE_NETWORK_HOSTS = Object.freeze([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'local', 'home.arpa', 'metadata.google.internal',
]);

// DNR evaluates the browser-normalized request URL. Keep each range in a small
// regex: Chrome applies a compiled-memory limit per expression, and one combined
// IPv4/IPv6 expression exceeds it even though its source text is short. Browser
// URL parsing has already validated and canonicalized the rest of each literal,
// so a range prefix is enough except for Azure's exact metadata address.
const WEB_AUTHORITY_REGEX = '^(?:http|ws)s?://(?:[^/]+@)?';
const HTTP_AUTHORITY_REGEX = '^https?://(?:[^/]+@)?';
const WEBSOCKET_AUTHORITY_REGEX = '^wss?://(?:[^/]+@)?';
export const PRIVATE_NETWORK_IPV4_REGEX_RULES = Object.freeze([
  Object.freeze({ id: 5, regex: `${WEB_AUTHORITY_REGEX}(?:0|10|127)\\.` }),
  Object.freeze({ id: 6, regex: `${WEB_AUTHORITY_REGEX}100\\.(?:6[4-9]|[789][0-9]|1[01][0-9]|12[0-7])\\.` }),
  Object.freeze({ id: 7, regex: `${WEB_AUTHORITY_REGEX}169\\.254\\.` }),
  Object.freeze({ id: 8, regex: `${WEB_AUTHORITY_REGEX}172\\.(?:1[6-9]|2[0-9]|3[01])\\.` }),
  Object.freeze({ id: 9, regex: `${WEB_AUTHORITY_REGEX}192\\.168\\.` }),
  Object.freeze({ id: 10, regex: `${WEB_AUTHORITY_REGEX}198\\.1[89]\\.` }),
  Object.freeze({ id: 11, regex: `${WEB_AUTHORITY_REGEX}(?:22[4-9]|23[0-9]|24[0-9]|25[0-5])\\.` }),
  Object.freeze({ id: 12, regex: `${WEB_AUTHORITY_REGEX}168\\.63\\.129\\.16(?::[0-9]+)?/` }),
]);

const PRIVATE_EMBEDDED_IPV4_HEXTET = '(?:[0-9a-f]{1,2}|a[0-9a-f]{2}|64[4-7][0-9a-f]'
  + '|7f[0-9a-f]{2}|a9fe|ac1[0-9a-f]|c0a8|c61[23]|[ef][0-9a-f]{3})';

// Browser URLs canonicalize IPv6 literals before DNR matching. Native local
// prefixes only need a host prefix. Embedded IPv4 forms need their final two
// hextets checked so a public mapped address remains reachable.
/** @param {string} prefix */
const embeddedIpv4PrefixRegex = (prefix) => `${WEB_AUTHORITY_REGEX}\\[${prefix}`
  + `(?:${PRIVATE_EMBEDDED_IPV4_HEXTET}:|a83f:8110\\])`;
/** @param {string} authorityRegex */
const compatibleIpv4Regex = (authorityRegex) => `${authorityRegex}\\[::`
  + `(?:${PRIVATE_EMBEDDED_IPV4_HEXTET}:[0-9a-f]{1,4}|a83f:8110)\\](?::[0-9]+)?/`;
const PRIVATE_NETWORK_IPV6_BASE_REGEX_RULES = Object.freeze([
  Object.freeze({ id: 13, regex: `${WEB_AUTHORITY_REGEX}\\[::(?:1)?\\](?::[0-9]+)?/` }),
  Object.freeze({ id: 14, regex: `${WEB_AUTHORITY_REGEX}\\[f[cd][0-9a-f]{2}:` }),
  Object.freeze({ id: 15, regex: `${WEB_AUTHORITY_REGEX}\\[fe[89a-f][0-9a-f]:` }),
  Object.freeze({ id: 16, regex: `${WEB_AUTHORITY_REGEX}\\[ff[0-9a-f]{2}:` }),
  Object.freeze({ id: 17, regex: `${WEB_AUTHORITY_REGEX}\\[64:ff9b:1:` }),
  Object.freeze({ id: 18, regex: embeddedIpv4PrefixRegex('64:ff9b::') }),
  Object.freeze({ id: 19, regex: embeddedIpv4PrefixRegex('::ffff:') }),
  // This form must consume the complete literal. A prefix-only match would
  // mistake `::ffff:<public-v4>` for compatible IPv4 whose first hextet is
  // the private 255.255 range.
  Object.freeze({ id: 20, regex: compatibleIpv4Regex(HTTP_AUTHORITY_REGEX) }),
  // IPv6 compression removes the all-zero first embedded IPv4 hextet. These
  // one-hextet tails are all in 0.0.0.0/8 and must not fall between the native
  // and two-hextet rules above.
  Object.freeze({ id: 21, regex: `${WEB_AUTHORITY_REGEX}\\[::[0-9a-f]{1,4}\\](?::[0-9]+)?/` }),
  Object.freeze({ id: 22, regex: `${WEB_AUTHORITY_REGEX}\\[::ffff:[0-9a-f]{1,4}\\](?::[0-9]+)?/` }),
  Object.freeze({ id: 23, regex: `${WEB_AUTHORITY_REGEX}\\[64:ff9b::(?:[0-9a-f]{1,4})?\\](?::[0-9]+)?/` }),
]);
const PRIVATE_NETWORK_IPV6_WEBSOCKET_REGEX_RULES = Object.freeze([
  // The HTTP-compatible rule is already close to Chrome's compiled-memory
  // limit. A separate small WebSocket rule keeps both schemes enforceable.
  Object.freeze({ id: 30, regex: compatibleIpv4Regex(WEBSOCKET_AUTHORITY_REGEX) }),
]);
export const PRIVATE_NETWORK_IPV6_REGEX_RULES = Object.freeze([
  ...PRIVATE_NETWORK_IPV6_BASE_REGEX_RULES,
  ...PRIVATE_NETWORK_IPV6_WEBSOCKET_REGEX_RULES,
]);

// URL hostname normalization used by the JS classifier strips a final dot.
// DNR requestDomains does not do that consistently across browsers, so cover
// the accepted absolute-DNS spelling explicitly, including local subdomains.
export const PRIVATE_NETWORK_DOTTED_HOST_REGEX_RULES = Object.freeze([
  Object.freeze({ id: 24, regex: `${WEB_AUTHORITY_REGEX}(?:[^./]+\\.)*localhost\\.(?::[0-9]+)?/` }),
  Object.freeze({ id: 25, regex: `${WEB_AUTHORITY_REGEX}(?:[^./]+\\.)*localhost\\.localdomain\\.(?::[0-9]+)?/` }),
  Object.freeze({ id: 26, regex: `${WEB_AUTHORITY_REGEX}(?:[^./]+\\.)*local\\.(?::[0-9]+)?/` }),
  Object.freeze({ id: 27, regex: `${WEB_AUTHORITY_REGEX}(?:[^./]+\\.)*home\\.arpa\\.(?::[0-9]+)?/` }),
  Object.freeze({ id: 28, regex: `${WEB_AUTHORITY_REGEX}metadata\\.google\\.internal\\.(?::[0-9]+)?/` }),
  Object.freeze({ id: 29, regex: `${WEB_AUTHORITY_REGEX}(?:ip6-localhost|ip6-loopback)\\.(?::[0-9]+)?/` }),
]);

export const PRIVATE_NETWORK_REGEX_RULES = Object.freeze([
  ...PRIVATE_NETWORK_IPV4_REGEX_RULES,
  ...PRIVATE_NETWORK_IPV6_BASE_REGEX_RULES,
  ...PRIVATE_NETWORK_DOTTED_HOST_REGEX_RULES,
  ...PRIVATE_NETWORK_IPV6_WEBSOCKET_REGEX_RULES,
]);
export const PRIVATE_NETWORK_RULE_IDS = Object.freeze([
  PRIVATE_NETWORK_HOST_RULE_ID,
  ...PRIVATE_NETWORK_REGEX_RULES.map(({ id }) => id),
]);

// Page service-worker requests have no tab identity. Give their companion
// rules a disjoint id range so tab custody and origin custody can be replaced
// atomically without either set mistaking the other's rules for stale state.
export const PRIVATE_NETWORK_INITIATOR_RULE_ID_OFFSET = 100;
export const PRIVATE_NETWORK_INITIATOR_RULE_IDS = Object.freeze(
  PRIVATE_NETWORK_RULE_IDS.map((id) => id + PRIVATE_NETWORK_INITIATOR_RULE_ID_OFFSET),
);
// browser.tabs.TAB_ID_NONE is -1 in both supported browsers. Keep the value in
// the pure core so rule construction does not import a privileged browser API.
export const PRIVATE_NETWORK_NO_TAB_ID = -1;

/**
 * Resource types the block rule covers. Enumerated EXPLICITLY rather than left
 * to the default: implementations differ on whether an omitted `resourceTypes`
 * includes `main_frame`, and main_frame is the one that matters most here. The
 * Firefox and Chrome validate different enums, so each browser gets its own
 * complete set. `object_subrequest` is intentionally absent because Firefox
 * documents it as unsupported even though it remains in the schema.
 */
export const DENYLIST_RESOURCE_TYPES = Object.freeze([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'xslt', 'ping', 'beacon', 'xml_dtd',
  'csp_report', 'media', 'websocket', 'imageset', 'web_manifest',
  'speculative', 'json', 'other',
]);

// Chrome rejects Firefox-only request-type enum values and rejects the entire
// atomic rule update with them present. Keep this list explicit instead of
// spreading the Firefox set so either browser adding an enum stays deliberate.
export const CHROME_DNR_RESOURCE_TYPES = Object.freeze([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
  'webbundle', 'webtransport', 'other',
]);

/**
 * Is `host` equal to, or a subdomain of, `base`? (Label-boundary aware — the
 * same care denylist.js takes: `evilchase.com` is not under `chase.com`.)
 * @param {string} host
 * @param {string} base
 */
const isUnder = (host, base) => host === base || host.endsWith(`.${base}`);

/**
 * Reduce denylist patterns to the set of domains a DNR `requestDomains`
 * condition should carry.
 *
 * Three reductions, in order:
 *   1. normalize + drop anything the JS matcher itself wouldn't accept (the one
 *      source of truth for pattern validity is normalizeDenylistPattern);
 *   2. strip the leading `*.` — `requestDomains` already covers subdomains;
 *   3. drop entries a broader entry already covers (`mail.proton.me` under
 *      `proton.me`), so the list carries no redundancy.
 *
 * Pure; returns a stable (sorted) array so a resync with unchanged input
 * produces an identical rule.
 *
 * @param {readonly string[]} patterns
 * @returns {string[]}
 */
export const denylistBlockDomains = (patterns) => {
  const bases = new Set();
  for (const raw of patterns ?? []) {
    const normalized = normalizeDenylistPattern(raw);
    if (!normalized) continue;
    bases.add(normalized.startsWith('*.') ? normalized.slice(2) : normalized);
  }
  const all = [...bases];
  return all
    .filter((host) => !all.some((other) => other !== host && isUnder(host, other)))
    .sort();
};

/**
 * Build the block rule for a set of driven tabs, or null when there is nothing
 * to enforce (no domains, or no tab is currently being driven). Null means
 * "remove the rule" — an unscoped rule would be a browser-wide block, which is
 * exactly the outcome this module must never produce, so the tab list is
 * REQUIRED, not defaulted.
 *
 * @param {Object} input
 * @param {readonly string[]} input.domains  from denylistBlockDomains
 * @param {readonly number[]} input.tabIds   tabs peerd is currently driving
 * @param {number} [input.ruleId]
 * @param {readonly string[]} [input.resourceTypes]
 * @returns {object | null}
 */
export const buildDenylistBlockRule = ({
  domains, tabIds, ruleId = DENYLIST_RULE_ID, resourceTypes = DENYLIST_RESOURCE_TYPES,
}) => {
  const tabs = [...new Set((tabIds ?? []).filter((t) => Number.isInteger(t) && t >= 0))];
  if (!domains?.length || !tabs.length) return null;
  return {
    id: ruleId,
    // Priority is only meaningful against our OWN other rules; we ship one.
    priority: 1,
    action: { type: 'block' },
    condition: {
      requestDomains: [...domains],
      tabIds: tabs,
      resourceTypes: [...resourceTypes],
    },
  };
};

/**
 * Build the ALLOW rule that keeps the sign-in corridor open (see
 * DENYLIST_ALLOW_RULE_ID). Same tab scoping as the block rule, one priority
 * step above it, so it wins wherever the two overlap.
 *
 * Only ever emitted alongside a block rule — an allow rule on its own would be
 * a no-op, and emitting one anyway would put a rule in front of a user who has
 * no block in effect.
 *
 * @param {Object} input
 * @param {readonly string[]} input.domains  exempt domains (the IdP registry)
 * @param {readonly number[]} input.tabIds
 * @param {number} [input.ruleId]
 * @param {readonly string[]} [input.resourceTypes]
 * @returns {object | null}
 */
export const buildIdpAllowRule = ({
  domains, tabIds, ruleId = DENYLIST_ALLOW_RULE_ID, resourceTypes = DENYLIST_RESOURCE_TYPES,
}) => {
  const tabs = [...new Set((tabIds ?? []).filter((t) => Number.isInteger(t) && t >= 0))];
  const exempt = [...new Set((domains ?? []).filter((d) => typeof d === 'string' && d.includes('.')))].sort();
  if (!exempt.length || !tabs.length) return null;
  return {
    id: ruleId,
    priority: 2,
    action: { type: 'allow' },
    condition: {
      requestDomains: exempt,
      tabIds: tabs,
      resourceTypes: [...resourceTypes],
    },
  };
};

/**
 * Block every HTTP(S) request made in a live App tab. App code has no ambient
 * network capability; its only external edge is the trusted parent bridge.
 * @param {Object} input
 * @param {readonly number[]} input.tabIds
 * @param {number} [input.ruleId]
 * @param {readonly string[]} [input.resourceTypes]
 * @returns {object | null}
 */
export const buildAppEgressBlockRule = ({
  tabIds, ruleId = APP_EGRESS_RULE_ID, resourceTypes = DENYLIST_RESOURCE_TYPES,
}) => {
  const tabs = [...new Set((tabIds ?? []).filter((t) => Number.isInteger(t) && t >= 0))];
  if (!tabs.length) return null;
  return {
    id: ruleId,
    priority: 3,
    action: { type: 'block' },
    condition: {
      regexFilter: '^https?://',
      tabIds: tabs,
      resourceTypes: [...resourceTypes],
    },
  };
};

/**
 * Browser-network floor for local/private/metadata destinations in driven tabs.
 * The IdP allow rule must never override these, so every rule outranks it.
 * @param {Object} input
 * @param {readonly number[]} input.tabIds
 * @param {readonly string[]} [input.resourceTypes]
 * @returns {object[]}
 */
export const buildPrivateNetworkBlockRules = ({
  tabIds, resourceTypes = DENYLIST_RESOURCE_TYPES,
}) => {
  const tabs = [...new Set((tabIds ?? []).filter((t) => Number.isInteger(t) && t >= 0))];
  if (!tabs.length) return [];
  const base = {
    priority: 4,
    action: { type: 'block' },
  };
  /** @param {Record<string, unknown>} condition */
  const scoped = (condition) => ({
    ...base,
    condition: {
      ...condition,
      tabIds: tabs,
      resourceTypes: [...resourceTypes],
    },
  });
  return [
    {
      id: PRIVATE_NETWORK_HOST_RULE_ID,
      ...scoped({ requestDomains: [...PRIVATE_NETWORK_HOSTS] }),
    },
    ...PRIVATE_NETWORK_REGEX_RULES.map(({ id, regex }) => ({
      id,
      ...scoped({ regexFilter: regex, isUrlFilterCaseSensitive: false }),
    })),
  ];
};

/**
 * Retain only browser-canonical initiator hostnames. The imperative custody
 * shell supplies URL.hostname values; validating again here prevents a scheme,
 * path, wildcard, port, mixed-case alias, or empty entry from widening a
 * no-tab rule. IPv4 and bracketed IPv6 literals ride the same URL
 * canonicalization as DNS names.
 *
 * @param {readonly string[]} domains
 * @returns {string[]}
 */
const canonicalInitiatorDomains = (domains) => [...new Set((domains ?? [])
  .filter((domain) => {
    if (typeof domain !== 'string' || !domain || domain !== domain.toLowerCase()
        || !/^[\x21-\x7e]+$/.test(domain)) return false;
    try {
      const parsed = new URL(`https://${domain}/`);
      const canonicalHostname = parsed.hostname === domain;
      const ipv6Literal = /^\[[0-9a-f:.]+\]$/.test(domain);
      const dnsName = domain.length <= 253 && domain.split('.').every((label) =>
        label.length > 0 && label.length <= 63
          && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
      return canonicalHostname
        && (ipv6Literal || dnsName)
        && parsed.username === ''
        && parsed.password === ''
        && parsed.port === '';
    } catch { return false; }
  }))].sort();

/**
 * Private-network floor for requests the browser attributes to no tab, such
 * as a page service worker. Both scopes are mandatory: TAB_ID_NONE alone
 * would intercept unrelated extension, provider, and browser traffic, while
 * an initiator alone would also affect ordinary page requests in user tabs.
 *
 * The browser's initiator condition is domain-scoped rather than origin-
 * scoped. The imperative shell therefore passes only hostnames currently
 * under peerd custody and retains visited domains until custody ends because a
 * service worker can survive page navigation.
 *
 * @param {Object} input
 * @param {readonly string[]} input.initiatorDomains
 * @param {number} [input.noTabId]
 * @param {readonly string[]} [input.resourceTypes]
 * @returns {object[]}
 */
export const buildPrivateNetworkInitiatorBlockRules = ({
  initiatorDomains,
  noTabId = PRIVATE_NETWORK_NO_TAB_ID,
  resourceTypes = DENYLIST_RESOURCE_TYPES,
}) => {
  const initiators = canonicalInitiatorDomains(initiatorDomains);
  if (!initiators.length || noTabId !== PRIVATE_NETWORK_NO_TAB_ID) return [];
  const base = {
    priority: 4,
    action: { type: 'block' },
  };
  /** @param {Record<string, unknown>} condition */
  const scoped = (condition) => ({
    ...base,
    condition: {
      ...condition,
      initiatorDomains: initiators,
      tabIds: [PRIVATE_NETWORK_NO_TAB_ID],
      resourceTypes: [...resourceTypes],
    },
  });
  return [
    {
      id: PRIVATE_NETWORK_HOST_RULE_ID + PRIVATE_NETWORK_INITIATOR_RULE_ID_OFFSET,
      ...scoped({ requestDomains: [...PRIVATE_NETWORK_HOSTS] }),
    },
    ...PRIVATE_NETWORK_REGEX_RULES.map(({ id, regex }) => ({
      id: id + PRIVATE_NETWORK_INITIATOR_RULE_ID_OFFSET,
      ...scoped({ regexFilter: regex, isUrlFilterCaseSensitive: false }),
    })),
  ];
};

/**
 * The full `updateSessionRules` argument for the current state. Always removes
 * all owned rule ids first so the call is idempotent and self-healing: whatever the
 * previous state was (stale tab list, stale domains, nothing at all), applying
 * this leaves a correct pair of rules, or none.
 *
 * @param {Object} input
 * @param {readonly string[]} input.patterns  the live denylist
 * @param {readonly number[]} input.tabIds
 * @param {readonly number[]} [input.appTabIds]
 * @param {readonly string[]} [input.initiatorDomains]
 * @param {readonly string[]} [input.exemptDomains]  IdP domains that stay
 *   reachable inside a driven tab — injected, see DENYLIST_ALLOW_RULE_ID.
 * @param {number} [input.ruleId]
 * @param {number} [input.allowRuleId]
 * @param {number} [input.appRuleId]
 * @param {readonly string[]} [input.resourceTypes]
 * @returns {{ removeRuleIds: number[], addRules: object[] }}
 */
export const denylistSessionRuleUpdate = ({
  patterns, tabIds, appTabIds = [],
  initiatorDomains = [],
  exemptDomains = [], ruleId = DENYLIST_RULE_ID,
  allowRuleId = DENYLIST_ALLOW_RULE_ID, appRuleId = APP_EGRESS_RULE_ID,
  resourceTypes = DENYLIST_RESOURCE_TYPES,
}) => {
  const domains = denylistBlockDomains(patterns ?? []);
  const block = buildDenylistBlockRule({
    domains, tabIds, ruleId, resourceTypes,
  });
  const allow = block ? buildIdpAllowRule({
    domains: exemptDomains, tabIds, ruleId: allowRuleId, resourceTypes,
  }) : null;
  const appBlock = buildAppEgressBlockRule({
    tabIds: appTabIds, ruleId: appRuleId, resourceTypes,
  });
  const privateNetworkBlocks = buildPrivateNetworkBlockRules({ tabIds, resourceTypes });
  const privateNetworkInitiatorBlocks = buildPrivateNetworkInitiatorBlockRules({
    initiatorDomains, resourceTypes,
  });
  return {
    removeRuleIds: [
      ruleId, allowRuleId, appRuleId,
      ...PRIVATE_NETWORK_RULE_IDS,
      ...PRIVATE_NETWORK_INITIATOR_RULE_IDS,
    ],
    addRules: [
      block, allow, appBlock,
      ...privateNetworkBlocks,
      ...privateNetworkInitiatorBlocks,
    ].filter((rule) => rule !== null),
  };
};
