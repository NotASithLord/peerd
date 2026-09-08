// @ts-check

import { normalizeDenylistPattern } from './denylist.js';
import {
  PRIVATE_NETWORK_INITIATOR_RULE_IDS,
  PRIVATE_NETWORK_INITIATOR_RULE_ID_OFFSET,
  PRIVATE_NETWORK_RULE_IDS,
} from '../../shared/private-network-rule-ids.js';

export {
  PRIVATE_NETWORK_INITIATOR_RULE_IDS,
  PRIVATE_NETWORK_INITIATOR_RULE_ID_OFFSET,
  PRIVATE_NETWORK_RULE_IDS,
};

export const DENYLIST_RULE_ID = 1;
export const DENYLIST_ALLOW_RULE_ID = 2;
export const APP_EGRESS_RULE_ID = 3;
export const APP_EGRESS_REGEX = '^(?:https?|wss?)://';
export const PRIVATE_NETWORK_HOST_RULE_ID = 4;

export const PRIVATE_NETWORK_HOSTS = Object.freeze([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'local', 'home.arpa', 'metadata.google.internal',
]);

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
  Object.freeze({ id: 20, regex: compatibleIpv4Regex(HTTP_AUTHORITY_REGEX) }),
  Object.freeze({ id: 21, regex: `${WEB_AUTHORITY_REGEX}\\[::[0-9a-f]{1,4}\\](?::[0-9]+)?/` }),
  Object.freeze({ id: 22, regex: `${WEB_AUTHORITY_REGEX}\\[::ffff:[0-9a-f]{1,4}\\](?::[0-9]+)?/` }),
  Object.freeze({ id: 23, regex: `${WEB_AUTHORITY_REGEX}\\[64:ff9b::(?:[0-9a-f]{1,4})?\\](?::[0-9]+)?/` }),
]);
const PRIVATE_NETWORK_IPV6_WEBSOCKET_REGEX_RULES = Object.freeze([
  Object.freeze({ id: 30, regex: compatibleIpv4Regex(WEBSOCKET_AUTHORITY_REGEX) }),
]);
export const PRIVATE_NETWORK_IPV6_REGEX_RULES = Object.freeze([
  ...PRIVATE_NETWORK_IPV6_BASE_REGEX_RULES,
  ...PRIVATE_NETWORK_IPV6_WEBSOCKET_REGEX_RULES,
]);

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
export const PRIVATE_NETWORK_NO_TAB_ID = -1;
export const DENYLIST_RESOURCE_TYPES = Object.freeze([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'xslt', 'ping', 'beacon', 'xml_dtd',
  'csp_report', 'media', 'websocket', 'imageset', 'web_manifest',
  'speculative', 'json', 'other',
]);

export const CHROME_DNR_RESOURCE_TYPES = Object.freeze([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
  'webbundle', 'webtransport', 'other',
]);

/** @param {string} host @param {string} base */
const isUnder = (host, base) => host === base || host.endsWith(`.${base}`);

/** @param {readonly string[]} patterns @returns {string[]} */
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

/** @param {Object} input
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
    priority: 1,
    action: { type: 'block' },
    condition: {
      requestDomains: [...domains],
      tabIds: tabs,
      resourceTypes: [...resourceTypes],
    },
  };
};

/** @param {Object} input
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

/** @param {Object} input
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
      regexFilter: APP_EGRESS_REGEX,
      tabIds: tabs,
      resourceTypes: [...resourceTypes],
    },
  };
};

/** @param {Object} input
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

/** @param {readonly string[]} domains @returns {string[]} */
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

/** @param {Object} input
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

/** @param {Object} input
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
