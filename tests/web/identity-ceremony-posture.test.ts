// The id.peerd.ai ceremony page is the ONE hosted component in the whole
// portable-identity arc, and PR #360 was closed over exactly the mistakes a
// ceremony page can make. These are the static, browser-free guards that
// keep this page a dumb, origin-bound authenticator front-end — the
// invariants a live WebAuthn test can't cheaply assert on every commit.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dir, '..', '..', 'web-identity');
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const js = readFileSync(join(dir, 'ceremony.js'), 'utf8');

describe('ceremony page CSP + isolation', () => {
  test('strict CSP: no network egress, no external/inline resource surface', () => {
    const csp = html.match(/Content-Security-Policy"\s*content="([^"]+)"/)?.[1] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'"); // no exfiltration path
    expect(csp).toContain("frame-ancestors 'none'"); // cannot be embedded
    expect(csp).toContain("script-src 'self'"); // no inline/remote scripts
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  test('no inline event handlers or inline scripts (all logic external)', () => {
    expect(html).not.toMatch(/\son[a-z]+=/i); // no onclick= etc.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[^<]/); // no inline <script>body
  });

  test('the page runs no model and has no general API surface', () => {
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'eval(', 'localStorage', 'indexedDB']) {
      expect(js).not.toContain(forbidden);
    }
  });
});

describe('ceremony transport is origin-bound and one-shot (the #360 fixes)', () => {
  test('the RESULT is posted to the recorded request origin, NEVER a wildcard', () => {
    // replyTo posts to `origin`; only the harmless "ready" ping may use '*'.
    expect(js).toMatch(/replyTo\s*=\s*\(origin,\s*message\)\s*=>\s*\{[^}]*postMessage\(message,\s*origin\)/s);
    // The only '*' postMessage is the readiness announcement, which carries
    // no secret — assert there is exactly one '*' target in the file.
    const wildcardTargets = js.match(/postMessage\([^)]*,\s*'\*'\)/g) ?? [];
    expect(wildcardTargets.length).toBe(1);
    expect(js).toMatch(/ceremony-ready[\s\S]*?'\*'/); // and it's the ready ping
  });

  test('requests are accepted ONLY from an extension origin', () => {
    expect(js).toMatch(/EXTENSION_ORIGIN\s*=\s*\/\^\(chrome-extension\|moz-extension/);
    expect(js).toMatch(/if\s*\(!EXTENSION_ORIGIN\.test\(event\.origin\)\)\s*return/);
  });

  test('the ceremony is one-shot: a page load answers exactly one request', () => {
    expect(js).toContain('let consumed = false');
    expect(js).toMatch(/if\s*\(!pending\s*\|\|\s*consumed\)\s*return/);
    expect(js).toContain('consumed = true');
    // A second request is ignored while one is pending.
    expect(js).toMatch(/onMessage\s*=\s*\(event\)\s*=>\s*\{\s*[^}]*if\s*\(pending\)\s*return/s);
  });

  test('refuses to run when framed, and requires a user gesture', () => {
    expect(js).toMatch(/window\.top\s*!==\s*window\.self/); // framed → refuse
    expect(js).toMatch(/runButton\.addEventListener\('click',\s*runCeremony\)/); // gesture-gated
  });

  test('user verification is REQUIRED on both create and get', () => {
    const uvRequired = js.match(/userVerification:\s*'required'/g) ?? [];
    expect(uvRequired.length).toBeGreaterThanOrEqual(2); // enroll + assert
  });

  test('the RP id comes from the page host, not a caller-supplied value', () => {
    expect(js).toContain('const RP_ID = location.hostname');
    // A request naming a different rpId is refused (no cross-RP minting).
    expect(js).toMatch(/if\s*\(data\.rpId\s*&&\s*data\.rpId\s*!==\s*RP_ID\)\s*return/);
  });

  test('the page returns raw authenticator output only — it derives no secret', () => {
    // No key derivation / encryption in the page: the reviewer\'s core #360
    // objection was the page encrypting a PRF output to a caller key.
    for (const forbidden of ['deriveBits', 'deriveKey', 'encrypt(', 'importKey', 'HKDF']) {
      expect(js).not.toContain(forbidden);
    }
  });
});
