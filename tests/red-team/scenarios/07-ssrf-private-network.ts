// Scenario 07 — private-network URL attempts SSRF.
//
// Adversary: a malicious page (or a prompt-injected agent acting on its behalf)
// asks the open-web fetch path to hit an internal target — the cloud metadata
// endpoint (169.254.169.254), a LAN box, a loopback service — often disguised
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
import { isPrivateOrLocalHost } from '../../../extension/peerd-egress/fetch/private-network.js';
import { EgressDeniedError } from '../../../extension/peerd-egress/fetch/errors.js';

// A webFetch wired so that ANY network call is observable — if fetchFn ever
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
];

export const scenario: Scenario = {
  id: '07-ssrf-private-network',
  title: 'Private-network / metadata SSRF',
  adversary: 'malicious webpage',
  asset: 'internal network + cloud metadata credentials',
  claim: 'webFetch refuses private / loopback / link-local / metadata hosts (including encoded and IPv4-mapped forms) before any network call, and fails closed on redirects.',
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
        : leaked(`disguise internal host as "${h}"`, 'isPrivateOrLocalHost() = false — evasion slipped through'));
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

    return summarize(probes, ['isPrivateOrLocalHost (SSRF guard)', 'webFetch pre-flight host check', 'redirect fail-closed']);
  },
};
