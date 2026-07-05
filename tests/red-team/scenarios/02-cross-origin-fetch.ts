// Scenario 02 — malicious page tries to induce a cross-origin fetch.
//
// Adversary: a malicious page (or an injected agent) tries to make peerd reach a
// sensitive origin it should never touch — the user's bank, webmail, or a cloud
// console where the browser already holds a logged-in cookie — or to smuggle an
// origin-bound API key onto a DIFFERENT origin so the attacker collects it.
//
// Defenses:
//   - The sensitive-origin denylist gates every open-web fetch, and its matcher
//     is boundary-safe: `evilchase.com` does NOT match `chase.com`, a trailing
//     dot or an off-origin port can't slip past, and `*.bank.example` matches
//     subdomains only. Wired here END-TO-END through the real webFetch.
//   - Origin-bound credentials authenticate ONLY when the request's URL.origin
//     exactly equals the actor's owned origin over https — cross-origin, http,
//     or a look-alike/userinfo spoof all send anonymously (the key stays home).

import {
  type Scenario, type Probe, blocked, leaked, summarize,
} from '../harness.ts';
import { makeWebFetch } from '../../../extension/peerd-egress/fetch/web-fetch.js';
import { matchesDenylist, findDenylistMatch } from '../../../extension/peerd-egress/denylist/denylist.js';
import { authOriginForRequestUrl } from '../../../extension/peerd-egress/fetch/origin-credentials.js';
import { EgressDeniedError } from '../../../extension/peerd-egress/fetch/errors.js';

// A representative slice of the kind of sensitive origins a user's denylist holds
// (the shipped seed lists apex + subdomain wildcard separately per site).
const DENYLIST = ['chase.com', '*.chase.com', 'mail.proton.me', '*.proton.me', 'console.aws.amazon.com'];

// Sensitive targets an attacker might induce a fetch toward — including evasions
// of a naive substring / endsWith matcher.
const DENIED_TARGETS = [
  { label: 'the bank apex', host: 'chase.com' },
  { label: 'a bank subdomain', host: 'secure.chase.com' },
  { label: 'the bank with a trailing FQDN dot', host: 'chase.com.' },
  { label: 'the bank on an off-origin port', host: 'chase.com:8443' },
  { label: 'uppercase host (case-fold evasion)', host: 'SECURE.CHASE.COM' },
  { label: 'webmail subdomain', host: 'mail.proton.me' },
  { label: 'cloud console (live cookie)', host: 'console.aws.amazon.com' },
];

// Look-alikes that MUST NOT be over-blocked (boundary correctness) — proving the
// matcher is exact, not a substring hack that would also be trivially bypassable.
const ALLOWED_LOOKALIKES = ['evilchase.com', 'protonmail.com', 'chase.com.evil.example', 'notchase.com'];

export const scenario: Scenario = {
  id: '02-cross-origin-fetch',
  title: 'Induced cross-origin fetch to sensitive sites',
  adversary: 'malicious webpage',
  asset: 'logged-in cookies + origin-bound credentials on sensitive sites',
  claim: 'The sensitive-origin denylist gates open-web fetches with a boundary-safe matcher, and origin-bound credentials are never sent cross-origin, over http, or to a spoofed origin.',
  threatModelRef: 'INV-2',
  tier: 'unit',
  async run() {
    const probes: Probe[] = [];

    // A) End-to-end: webFetch wired with the REAL denylist matcher refuses each
    //    sensitive target and never touches the wire.
    for (const t of DENIED_TARGETS) {
      let wire: string | null = null;
      const webFetch = makeWebFetch({
        getDenylist: () => DENYLIST,
        matchDenylist: matchesDenylist, // the production matcher, not a stub
        audit: async () => {},
        fetchFn: (async (u: any) => { wire = String(u); return new Response('SHOULD-NOT-HAPPEN'); }) as any,
      });
      let denied: unknown = null;
      try { await webFetch(`https://${t.host}/account`); } catch (e) { denied = e; }
      const ok = denied instanceof EgressDeniedError && wire === null;
      probes.push(ok
        ? blocked(`induce fetch to ${t.label} (${t.host})`, `EgressDeniedError (matched "${findDenylistMatch(t.host, DENYLIST)}"); wire untouched`)
        : leaked(`induce fetch to ${t.label} (${t.host})`, denied ? `denied but wire touched: ${wire}` : `NOT denied: ${String(denied)}`));
    }

    // B) Boundary correctness: look-alikes are NOT matched (an over-broad matcher
    //    would be a bypass in disguise — attacker registers evilchase.com).
    for (const h of ALLOWED_LOOKALIKES) {
      const matched = matchesDenylist(h, DENYLIST);
      probes.push(!matched
        ? blocked(`confirm matcher is exact, not substring: "${h}"`, 'not matched — no false-positive to hide a bypass behind')
        : leaked(`confirm matcher is exact, not substring: "${h}"`, `over-matched "${h}" → boundary bug`));
    }

    // C) Origin-bound credential never crosses origins. Actor owns https://api.acme.com.
    {
      const owned = 'https://api.acme.com';
      const crossOriginLeaks: { url: string; note: string }[] = [
        { url: 'https://evil.example/collect', note: 'attacker origin' },
        { url: 'https://api.acme.com.evil.example/x', note: 'suffix look-alike' },
        { url: 'https://acme.com/x', note: 'sibling origin' },
        { url: 'http://api.acme.com/x', note: 'http downgrade of the owned origin' },
        { url: 'https://user:pw@evil.example/@api.acme.com/', note: 'userinfo spoof' },
      ];
      for (const c of crossOriginLeaks) {
        const auth = authOriginForRequestUrl(c.url, owned);
        probes.push(auth === null
          ? blocked(`send acme key to ${c.note} (${c.url})`, 'authOriginForRequestUrl → null (anonymous; key stays home)')
          : leaked(`send acme key to ${c.note} (${c.url})`, `would attach key for origin ${auth}`));
      }
      // Control: the owned origin over https DOES authenticate (not deny-all).
      const authSelf = authOriginForRequestUrl('https://api.acme.com/v1/data', owned);
      probes.push(authSelf === owned
        ? blocked('control: the key still works on its OWN origin', `authOriginForRequestUrl → ${authSelf}`)
        : leaked('control: the key still works on its OWN origin', `unexpected: ${authSelf}`));
    }

    return summarize(probes, ['sensitive-origin denylist (boundary-safe matcher)', 'webFetch denylist gate', 'authOriginForRequestUrl (URL.origin equality)']);
  },
};
