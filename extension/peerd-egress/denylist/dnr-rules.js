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
// rules are SESSION-scoped and TAB-scoped: they apply only to tabs peerd is
// currently driving, never to the user's own browsing. Blocking the user's bank
// tab would be a bug, not a feature — the denylist says "the agent may not go
// here", not "this browser may not go here".
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
 * Resource types the block rule covers. Enumerated EXPLICITLY rather than left
 * to the default: implementations differ on whether an omitted `resourceTypes`
 * includes `main_frame`, and main_frame is the one that matters most here. The
 * set is restricted to types that predate DNR (the MV2 webRequest enum) so a
 * strict validator on either browser can't reject the whole rule over a value
 * it doesn't know.
 */
export const DENYLIST_RESOURCE_TYPES = Object.freeze([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
  'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other',
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
 * @returns {object | null}
 */
export const buildDenylistBlockRule = ({ domains, tabIds, ruleId = DENYLIST_RULE_ID }) => {
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
      resourceTypes: [...DENYLIST_RESOURCE_TYPES],
    },
  };
};

/**
 * The full `updateSessionRules` argument for the current state. Always removes
 * the rule id first so the call is idempotent and self-healing: whatever the
 * previous state was (stale tab list, stale domains, nothing at all), applying
 * this leaves exactly one correct rule, or none.
 *
 * @param {Object} input
 * @param {readonly string[]} input.patterns  the live denylist
 * @param {readonly number[]} input.tabIds
 * @param {number} [input.ruleId]
 * @returns {{ removeRuleIds: number[], addRules: object[] }}
 */
export const denylistSessionRuleUpdate = ({ patterns, tabIds, ruleId = DENYLIST_RULE_ID }) => {
  const rule = buildDenylistBlockRule({
    domains: denylistBlockDomains(patterns ?? []), tabIds, ruleId,
  });
  return { removeRuleIds: [ruleId], addRules: rule ? [rule] : [] };
};
