// Scenario 07: private-network URL attempts SSRF.
//
// Adversary: a malicious page (or a prompt-injected agent acting on its behalf)
// asks the open-web fetch path to hit an internal target, the cloud metadata
// endpoint (169.254.169.254), a LAN box, a loopback service, often disguised
// as an encoded or IPv4-mapped-IPv6 address to slip past a naive string filter.
//
// Defense: `webFetch` runs `isPrivateOrLocalHost` on the resolved host BEFORE
// any network call, ahead of even the denylist, and fails closed on redirects
// (an opaqueredirect or a readable 3xx both deny) so a public host can't bounce
// the request onto an internal one. The guard normalizes through `new URL()`,
// so decimal/hex/octal/short-form IPv4 and IPv4-mapped IPv6 all resolve to the
// same blocked address a dotted-quad would.

import {
  type Scenario, type Probe, blocked, leaked, summarize,
} from '../harness.ts';
import { makeWebFetch } from '../../../extension/peerd-egress/fetch/web-fetch.js';
import { isPrivateOrLocalHost } from '../../../extension/shared/private-network.js';
import { EgressDeniedError } from '../../../extension/peerd-egress/fetch/errors.js';
import {
  buildPrivateNetworkBlockRules, buildPrivateNetworkInitiatorBlockRules,
  PRIVATE_NETWORK_INITIATOR_RULE_IDS, PRIVATE_NETWORK_RULE_IDS,
} from '../../../extension/peerd-egress/denylist/dnr-rules.js';
import {
  BROWSER_TARGET_STAGES, browserTargetRefusalResult, classifyBrowserAutomationTarget,
} from '../../../extension/peerd-runtime/tools/browser-automation-policy.js';
import { makeStartupPopupNetworkGuard } from '../../../extension/background/startup-popup-network-guard.js';
import {
  classifyDrivenChildRequestTarget,
  makeDrivenChildRequestGuard,
} from '../../../extension/background/driven-child-request-guard.js';

// A webFetch wired so that ANY network call is observable, if fetchFn ever
// fires for a hostile URL, the guard failed open and the probe leaks.
const armWebFetch = () => {
  let networkTouched: string | null = null;
  const webFetch = makeWebFetch({
    getDenylist: () => [], // empty on purpose: prove the SSRF block is independent of the denylist
    matchDenylist: () => false,
    audit: async () => {},
    fetchFn: (async (url: any) => { networkTouched = String(url); return new Response('SHOULD-NOT-HAPPEN'); }) as any,
  });
  return { webFetch, networkTouched: () => networkTouched };
};

// Hostile targets, each an SSRF classic or an evasion of a string-only filter.
const SSRF_TARGETS: { label: string; url: string }[] = [
  { label: 'cloud metadata endpoint', url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
  { label: 'RFC1918 LAN admin panel', url: 'https://192.168.1.1/admin' },
  { label: 'private 10.0.0.0/8 host', url: 'https://10.0.0.5/internal' },
  { label: 'loopback service', url: 'https://[::1]:8443/' },
  { label: 'decimal-encoded loopback (2130706433 = 127.0.0.1)', url: 'http://2130706433/' },
  { label: 'IPv4-mapped IPv6 loopback via URL parser', url: 'http://[::ffff:127.0.0.1]/' },
  { label: 'IPv4-mapped IPv6 metadata via URL parser', url: 'http://[::ffff:169.254.169.254]/' },
];

// Host strings fed straight to the guard, covering the encoded/compressed forms
// that a dotted-quad-only regex would miss.
const EVASION_HOSTS = [
  '169.254.169.254', '0x7f000001', '0177.0.0.1', '127.1',
  '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', 'foo.localhost',
  // Non-routable / internal-use ranges an SSRF guard must also refuse (RFC 6598
  // shared/CGNAT is real internal LAN space on mobile/ISP deployments).
  '100.64.0.1', '100.127.255.255', '198.18.0.5', '255.255.255.255', '240.0.0.1',
];

export const scenario: Scenario = {
  id: '07-ssrf-private-network',
  title: 'Private-network / metadata SSRF',
  adversary: 'malicious webpage',
  asset: 'internal network + cloud metadata credentials',
  claim: 'Open-web and browser entry points refuse private targets, no-tab worker fetch rules require a custodied page domain, and child guards require exact source identity.',
  threatModelRef: 'INV-7',
  tier: 'unit',
  async run() {
    const probes: Probe[] = [];

    // 1) Each hostile URL must be denied AND must never reach the network.
    for (const t of SSRF_TARGETS) {
      const { webFetch, networkTouched } = armWebFetch();
      let denied: unknown = null;
      try { await webFetch(t.url); } catch (e) { denied = e; }
      const isDenied = denied instanceof EgressDeniedError;
      const reason = (denied as any)?.reason ?? (denied as any)?.details?.reason;
      const noNetwork = networkTouched() === null;
      probes.push(isDenied && noNetwork
        ? blocked(`fetch ${t.label} (${t.url})`, `EgressDeniedError (reason=${reason ?? 'private_network'}); fetchFn never fired`)
        : leaked(`fetch ${t.label} (${t.url})`, isDenied ? `denied but network touched: ${networkTouched()}` : `NOT denied: ${String(denied)}`));
    }

    // 2) The pure guard must classify every evasion form as private.
    for (const h of EVASION_HOSTS) {
      const isPrivate = isPrivateOrLocalHost(h);
      probes.push(isPrivate
        ? blocked(`disguise internal host as "${h}"`, 'isPrivateOrLocalHost() = true')
        : leaked(`disguise internal host as "${h}"`, 'isPrivateOrLocalHost() = false, evasion slipped through'));
    }

    // 3) A public host that 3xx-redirects toward metadata must fail closed.
    {
      const auditReasons: string[] = [];
      const webFetch = makeWebFetch({
        getDenylist: () => [], matchDenylist: () => false,
        audit: async (e: any) => { auditReasons.push(e?.details?.reason); },
        // A real MV3 SW yields an opaqueredirect (status 0) under redirect:'manual'.
        fetchFn: (async () => ({ type: 'opaqueredirect', status: 0, ok: false })) as any,
      });
      let denied: unknown = null;
      try { await webFetch('https://public.example/bounce'); } catch (e) { denied = e; }
      probes.push(denied instanceof EgressDeniedError
        ? blocked('public host 3xx-redirects toward an internal target', `redirect refused (reason=${auditReasons.at(-1)})`)
        : leaked('public host 3xx-redirects toward an internal target', `redirect NOT refused: ${String(denied)}`));
    }

    // 4) Browser automation uses the same classifier both before navigation
    // and after a committed landing. Its model-facing refusal is host-stamped
    // and does not repeat the target URL.
    for (const t of SSRF_TARGETS) {
      for (const stage of [
        BROWSER_TARGET_STAGES.PRE_NAVIGATION,
        BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
      ]) {
        const verdict = classifyBrowserAutomationTarget(t.url, { stage });
        const result = verdict.allowed
          ? null
          : browserTargetRefusalResult(verdict, {
            effectCompleted: stage === BROWSER_TARGET_STAGES.COMMITTED_ORIGIN,
          });
        const urlFree = result != null && !JSON.stringify(result).includes(t.url);
        probes.push(!verdict.allowed && urlFree
          ? blocked(
            `automate ${t.label} at ${stage}`,
            `browser target refused as ${verdict.reason}; result contains no target URL`,
          )
          : leaked(
            `automate ${t.label} at ${stage}`,
            verdict.allowed ? 'browser target allowed' : 'browser refusal repeated the target URL',
          ));
      }
    }

    // 5) The browser-network floor is block-only and exact-tab scoped. An
    // empty tab set must produce no rule, which prevents a browser-wide floor.
    {
      const drivenTabId = 73;
      const rules = buildPrivateNetworkBlockRules({ tabIds: [drivenTabId] }) as any[];
      const exactRuleSet = rules.length === PRIVATE_NETWORK_RULE_IDS.length
        && PRIVATE_NETWORK_RULE_IDS.every((id) => rules.some((rule) => rule.id === id));
      const exactScope = rules.every((rule) => rule.action?.type === 'block'
        && JSON.stringify(rule.condition?.tabIds) === JSON.stringify([drivenTabId]));
      probes.push(exactRuleSet && exactScope
        ? blocked('turn the private-network floor into a browser-wide rule', 'every tab-family rule is block-only and scoped to the driven tab')
        : leaked('turn the private-network floor into a browser-wide rule', 'a rule was missing, non-blocking, or not exact-tab scoped'));
      probes.push(buildPrivateNetworkBlockRules({ tabIds: [] }).length === 0
        ? blocked('install the private-network floor with no driven tab', 'the rule builder returned no rules')
        : leaked('install the private-network floor with no driven tab', 'an unscoped rule was produced'));
    }

    // 6) A page worker loses tab identity, so its companion must require BOTH
    // TAB_ID_NONE and the currently custodied public initiator domain. Either
    // condition missing would turn a narrow worker backstop into browser-wide
    // interception.
    {
      const rules = buildPrivateNetworkInitiatorBlockRules({
        initiatorDomains: ['shop.example'],
      }) as any[];
      const exactRuleSet = rules.length === PRIVATE_NETWORK_INITIATOR_RULE_IDS.length
        && PRIVATE_NETWORK_INITIATOR_RULE_IDS.every((id) =>
          rules.some((rule) => rule.id === id));
      const exactScope = rules.every((rule) => rule.action?.type === 'block'
        && JSON.stringify(rule.condition?.tabIds) === JSON.stringify([-1])
        && JSON.stringify(rule.condition?.initiatorDomains) === JSON.stringify(['shop.example']));
      probes.push(exactRuleSet && exactScope
        ? blocked('use a page service worker to bypass tab custody', 'every no-tab private-target rule requires no-tab attribution and the custodied initiator domain')
        : leaked('use a page service worker to bypass tab custody', 'the worker rule family was missing or overbroad'));
      probes.push(buildPrivateNetworkInitiatorBlockRules({ initiatorDomains: [] }).length === 0
        ? blocked('install a no-tab private-network rule without page custody', 'no initiator domain produced no rule')
        : leaked('install a no-tab private-network rule without page custody', 'a browser-wide no-tab rule was produced'));
    }

    // 7) Cold-start child copying is limited to a complete surviving rule set
    // on the exact source. The service worker separately requires restored
    // custody or an actor binding before it calls this pure browser-rule core.
    {
      const sourceTabId = 73;
      const ordinaryTabId = 74;
      const childTabId = 75;
      let rules = buildPrivateNetworkBlockRules({ tabIds: [sourceTabId] }) as any[];
      let updateCount = 0;
      const startupGuard = makeStartupPopupNetworkGuard({
        getSessionRules: async () => rules,
        updateSessionRules: async (update) => {
          updateCount += 1;
          rules = [
            ...rules.filter((rule) => !update.removeRuleIds.includes(rule.id)),
            ...update.addRules,
          ];
        },
      }, PRIVATE_NETWORK_RULE_IDS);
      const unrelatedAdopted = await startupGuard.adopt(ordinaryTabId, childTabId);
      probes.push(!unrelatedAdopted && updateCount === 0
        ? blocked('use an ordinary source tab to acquire its child during startup', 'no browser rule changed without the complete exact-source rule set')
        : leaked('use an ordinary source tab to acquire its child during startup', 'the unrelated child changed'));

      const exactAdopted = await startupGuard.adopt(sourceTabId, childTabId);
      const copiedOnlyToChild = exactAdopted && rules.every((rule) =>
        rule.condition.tabIds.includes(sourceTabId)
        && rule.condition.tabIds.includes(childTabId)
        && !rule.condition.tabIds.includes(ordinaryTabId));
      probes.push(copiedOnlyToChild
        ? blocked('redirect startup protection onto an unrelated tab', 'the complete rule set was copied only from the exact source to the exact child')
        : leaked('redirect startup protection onto an unrelated tab', 'startup rules escaped the exact source and child'));

      const incompleteRules = rules.filter((rule) => rule.id !== PRIVATE_NETWORK_RULE_IDS[0]);
      let incompleteUpdates = 0;
      const incompleteGuard = makeStartupPopupNetworkGuard({
        getSessionRules: async () => incompleteRules,
        updateSessionRules: async () => { incompleteUpdates += 1; },
      }, PRIVATE_NETWORK_RULE_IDS);
      const incompleteAdopted = await incompleteGuard.adopt(sourceTabId, childTabId + 1);
      probes.push(!incompleteAdopted && incompleteUpdates === 0
        ? blocked('claim startup child custody from a partial surviving rule set', 'partial browser evidence changed no rule')
        : leaked('claim startup child custody from a partial surviving rule set', 'partial browser evidence was accepted'));
    }

    // 8) Firefox's synchronous first-request stop is exact-child scoped. It
    // does not infer ownership from an ordinary opener and it does not block a
    // public request from the adopted child.
    {
      const stopped: Array<{ sourceTabId: number, tabId: number, reason: string }> = [];
      let policyReady = true;
      const guard = makeDrivenChildRequestGuard({
        isDrivenSource: (tabId) => tabId === 73,
        classifyTarget: (url) => classifyDrivenChildRequestTarget(
          url,
          (hostname) => hostname === 'vault.example',
          policyReady,
        ),
        onBlocked: (event) => { stopped.push(event); },
      });
      guard.onNavigationTarget({ tabId: 75, sourceTabId: 73 });
      guard.onNavigationTarget({ tabId: 76, sourceTabId: 74 });
      guard.onNavigationTarget({ tabId: 77, sourceTabId: 73 });
      guard.onNavigationTarget({ tabId: 78, sourceTabId: 73 });
      const drivenPrivate = guard.onBeforeRequest({ tabId: 75, url: 'http://127.0.0.1/' });
      const drivenSocket = guard.onBeforeRequest({
        tabId: 75, url: 'ws://127.0.0.1/socket', type: 'websocket',
      });
      const drivenPublic = guard.onBeforeRequest({ tabId: 75, url: 'https://public.example/' });
      const ordinaryPrivate = guard.onBeforeRequest({ tabId: 76, url: 'http://127.0.0.1/' });
      const drivenSensitive = guard.onBeforeRequest({
        tabId: 77, url: 'https://vault.example/account', type: 'xmlhttprequest',
      });
      policyReady = false;
      const drivenCold = guard.onBeforeRequest({
        tabId: 78, url: 'https://public.example/', type: 'xmlhttprequest',
      });
      const ordinaryCold = guard.onBeforeRequest({
        tabId: 76, url: 'https://public.example/', type: 'xmlhttprequest',
      });
      policyReady = true;
      const hydratedPublic = guard.onBeforeRequest({
        tabId: 78, url: 'https://public.example/', type: 'xmlhttprequest',
      });
      probes.push(drivenPrivate.cancel === true
          && drivenSocket.cancel === true
          && drivenSensitive.cancel === true
          && drivenCold.cancel === true
          && ordinaryCold.cancel !== true
          && hydratedPublic.cancel !== true
          && drivenPublic.cancel !== true
          && ordinaryPrivate.cancel !== true
          && stopped.length === 3
        ? blocked('race a protected request through a newly opened child', 'private HTTP, WebSocket, denylisted, and cold-policy requests were cancelled only for exact children, with source-bound receipts')
        : leaked('race a protected request through a newly opened child', 'the synchronous child scope was missing or overbroad'));
    }

    return {
      ...summarize(probes, [
        'isPrivateOrLocalHost (SSRF guard)',
        'webFetch pre-flight host check',
        'browser automation target classifier',
        'tab-scoped private-network DNR rules',
        'origin-scoped no-tab worker fetch DNR rules',
        'exact-child synchronous Firefox request stop',
        'exact-source startup child rule copy',
        'redirect fail-closed',
      ]),
      verifiedBy: 'scripts/cdp/states.mjs (browser network floor); scripts/firefox/run-runtime-tests.mjs (Firefox private-network and child navigation probes)',
    };
  },
};
