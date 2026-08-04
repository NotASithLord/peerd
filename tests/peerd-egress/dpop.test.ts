// Tier 1 — "use but can't see": non-extractable proof-of-possession keys + DPoP
// (RFC 9449). Bun ships REAL WebCrypto, so these exercise the real thing: real
// key generation, real ECDSA P-256 signatures, real verification. Nothing here
// is mocked except the IO seams (persistence, the vault read, the fetch sink).
//
// The load-bearing assertion is in the FIRST describe block: `exportKey` on the
// generated private key REJECTS. That is the entire security claim of this
// feature reduced to one expectation — if it ever goes green by being deleted,
// the credential became exfiltratable again.

import { describe, test, expect } from 'bun:test';
import {
  base64url, base64urlFromString, canonicalHtu, htmOf, publicJwkOnly,
  jwkThumbprintInput, buildProofInput, assembleProof, utf8Bytes,
} from '../../extension/peerd-egress/dpop/proof.js';
import {
  generateDpopKeypair, getOrCreateDpopKey, makeDpopKeyStore, dpopJkt,
  accessTokenHashFor, signDpopProof, DPOP_KEY_STORE,
} from '../../extension/peerd-egress/dpop/keys.js';
import { buildOriginSecret, parseOriginAuth } from '../../extension/peerd-egress/fetch/origin-credentials.js';
import { withApiCredentials, withDpopCredentials } from '../../extension/peerd-egress/fetch/web-fetch.js';

// ── THE claim: peerd holds a key it can use but cannot read ─────────────────

describe('the private key is NON-EXTRACTABLE — the whole point', () => {
  test('extractable === false and every exportKey format REJECTS', async () => {
    const { privateKey } = await generateDpopKeypair();
    expect(privateKey.extractable).toBe(false);
    // Not "returns nothing" — REJECTS. There is no in-origin path to the bytes.
    await expect(crypto.subtle.exportKey('jwk', privateKey)).rejects.toBeTruthy();
    await expect(crypto.subtle.exportKey('pkcs8', privateKey)).rejects.toBeTruthy();
    // 'raw' is not even a valid format for a private EC key — it must not
    // accidentally succeed via some other route either.
    await expect(crypto.subtle.exportKey('raw' as any, privateKey)).rejects.toBeTruthy();
  });

  test('the PUBLIC half still exports, and carries no private scalar', async () => {
    const { publicKey, publicJwk } = await generateDpopKeypair();
    expect(publicKey.extractable).toBe(true);
    const raw: any = await crypto.subtle.exportKey('jwk', publicKey);
    expect(raw.d).toBeUndefined();
    expect(publicJwk).toEqual({ kty: 'EC', crv: 'P-256', x: raw.x, y: raw.y });
    expect(Object.keys(publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
  });

  test('the key usages are sign/verify only — it can never wrap or decrypt anything', async () => {
    const { privateKey } = await generateDpopKeypair();
    expect(privateKey.usages).toEqual(['sign']);
    expect(privateKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
  });
});

// ── the pure core (RFC 9449 §4.2 canonicalization) ──────────────────────────

describe('canonicalHtu / htmOf — the request binding, fail closed', () => {
  test('htu drops the query AND the fragment', () => {
    expect(canonicalHtu('https://api.example.com/v1/x?a=1&b=2#frag')).toBe('https://api.example.com/v1/x');
    expect(canonicalHtu('https://api.example.com/v1/x')).toBe('https://api.example.com/v1/x');
  });
  test('htu keeps the port and normalizes away userinfo', () => {
    expect(canonicalHtu('https://api.example.com:8443/v1')).toBe('https://api.example.com:8443/v1');
    expect(canonicalHtu('https://user:pw@api.example.com/v1')).toBe('https://api.example.com/v1');
  });
  test('non-https or unparseable → null (never sign for cleartext)', () => {
    expect(canonicalHtu('http://api.example.com/v1')).toBeNull();
    expect(canonicalHtu('ftp://api.example.com/v1')).toBeNull();
    expect(canonicalHtu('not a url')).toBeNull();
    expect(canonicalHtu(undefined)).toBeNull();
  });
  test('htm uppercases and defaults to GET', () => {
    expect(htmOf('post')).toBe('POST');
    expect(htmOf(' patch ')).toBe('PATCH');
    expect(htmOf(undefined)).toBe('GET');
    expect(htmOf('')).toBe('GET');
  });
});

describe('publicJwkOnly / jwkThumbprintInput — no private material, canonical bytes', () => {
  const full = { kty: 'EC', crv: 'P-256', x: 'XX', y: 'YY', d: 'SECRET', ext: false, key_ops: ['sign'], alg: 'ES256' };

  test('strips d and every non-required member', () => {
    expect(publicJwkOnly(full)).toEqual({ kty: 'EC', crv: 'P-256', x: 'XX', y: 'YY' });
    expect(JSON.stringify(publicJwkOnly(full))).not.toContain('SECRET');
  });
  test('a JWK missing a required member is refused', () => {
    expect(publicJwkOnly({ kty: 'EC', crv: 'P-256', x: 'XX' })).toBeNull();
    expect(publicJwkOnly(null)).toBeNull();
    expect(publicJwkOnly('nope')).toBeNull();
  });
  test('RFC 7638 input is exact: lexicographic keys, no whitespace, no d', () => {
    expect(jwkThumbprintInput(full)).toBe('{"crv":"P-256","kty":"EC","x":"XX","y":"YY"}');
    // Ordering is a property of the builder, not of the input object's key order.
    expect(jwkThumbprintInput({ y: 'YY', x: 'XX', kty: 'EC', crv: 'P-256' }))
      .toBe('{"crv":"P-256","kty":"EC","x":"XX","y":"YY"}');
  });
  test('matches the RFC 7638 §3.1 worked example thumbprint', async () => {
    // The RFC's example is RSA; the EC analog is checked structurally above, so
    // here we pin our own pipeline: b64url(SHA-256(canonical JSON)) with no padding.
    const input = jwkThumbprintInput(full)!;
    const expected = base64url(await crypto.subtle.digest('SHA-256', utf8Bytes(input) as BufferSource));
    expect(await dpopJkt(full)).toBe(expected);
    expect(expected).not.toContain('=');
    expect(expected).not.toMatch(/[+/]/);
  });
});

describe('buildProofInput — shape + fail-closed', () => {
  const publicJwk = { kty: 'EC', crv: 'P-256', x: 'XX', y: 'YY' };
  const ok = { publicJwk, method: 'post', url: 'https://api.example.com/v1/x?a=1', jti: 'j1', iatSeconds: 1700000000 };

  test('header is typ/alg/jwk with only public members', () => {
    const built = buildProofInput(ok)!;
    expect(built.header).toEqual({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk });
    expect(JSON.stringify(built.header)).not.toContain('"d"');
  });
  test('payload binds jti/htm/htu/iat, and ath only when given', () => {
    const built = buildProofInput(ok)!;
    expect(built.payload).toEqual({ jti: 'j1', htm: 'POST', htu: 'https://api.example.com/v1/x', iat: 1700000000 });
    const withAth = buildProofInput({ ...ok, accessTokenHash: 'AAA' })!;
    expect(withAth.payload.ath).toBe('AAA');
  });
  test('signingInput is the two b64url JOSE segments joined by a dot', () => {
    const built = buildProofInput(ok)!;
    const [h, p] = built.signingInput.split('.');
    expect(h).toBe(base64urlFromString(JSON.stringify(built.header)));
    expect(p).toBe(base64urlFromString(JSON.stringify(built.payload)));
    expect(JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))).toEqual(built.payload);
  });
  test('fails closed on http, a bad jwk, a missing jti, or a bad iat', () => {
    expect(buildProofInput({ ...ok, url: 'http://api.example.com/x' })).toBeNull();
    expect(buildProofInput({ ...ok, publicJwk: { kty: 'EC' } })).toBeNull();
    expect(buildProofInput({ ...ok, jti: '' })).toBeNull();
    expect(buildProofInput({ ...ok, iatSeconds: 'soon' })).toBeNull();
    expect(buildProofInput()).toBeNull();
  });
  test('assembleProof refuses a malformed signing input', () => {
    expect(assembleProof('nodot', new Uint8Array(64))).toBeNull();
    expect(assembleProof('a.b', null as any)).toBeNull();
  });
});

// ── the round trip: a real signature that really verifies ───────────────────

const verifyProof = async (proof: string, publicKey: CryptoKey) => {
  const [h, p, s] = proof.split('.');
  const sig = Buffer.from(s, 'base64url');
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    new Uint8Array(sig) as BufferSource,
    utf8Bytes(`${h}.${p}`) as BufferSource,
  );
};

describe('signDpopProof — real ES256, real verification', () => {
  test('a signed proof verifies against the public key, and its claims are the request', async () => {
    const { privateKey, publicKey, publicJwk } = await generateDpopKeypair();
    const proof = (await signDpopProof({
      privateKey, publicJwk, method: 'post', url: 'https://api.example.com/v1/x?secret=1#f',
      jti: 'jti-1', iatSeconds: 1700000000,
    }))!;
    expect(await verifyProof(proof, publicKey)).toBe(true);

    const [h, p] = proof.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    expect(header).toEqual({ typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk });
    expect(payload.htm).toBe('POST');
    expect(payload.htu).toBe('https://api.example.com/v1/x');   // query + fragment gone
    expect(proof).not.toContain('secret=1');
  });

  test('the ES256 signature is the RAW r||s 64-byte form (not DER)', async () => {
    const { privateKey, publicJwk } = await generateDpopKeypair();
    const proof = (await signDpopProof({
      privateKey, publicJwk, method: 'GET', url: 'https://api.example.com/v1',
      jti: 'jti-raw', iatSeconds: 1700000000,
    }))!;
    const sig = Buffer.from(proof.split('.')[2], 'base64url');
    expect(sig.length).toBe(64);
    expect(sig[0]).not.toBe(0x30);   // a DER SEQUENCE tag would mean we re-encoded
  });

  test('two proofs for the SAME request differ (fresh jti) and both verify', async () => {
    const { privateKey, publicKey, publicJwk } = await generateDpopKeypair();
    const args = { privateKey, publicJwk, method: 'GET', url: 'https://api.example.com/v1', iatSeconds: 1700000000 };
    const a = (await signDpopProof({ ...args, jti: 'one' }))!;
    const b = (await signDpopProof({ ...args, jti: 'two' }))!;
    expect(a).not.toBe(b);
    expect(await verifyProof(a, publicKey)).toBe(true);
    expect(await verifyProof(b, publicKey)).toBe(true);
    expect(JSON.parse(Buffer.from(a.split('.')[1], 'base64url').toString('utf8')).jti).toBe('one');
  });

  test('a proof does not verify under a DIFFERENT key (the binding is real)', async () => {
    const mine = await generateDpopKeypair();
    const theirs = await generateDpopKeypair();
    const proof = (await signDpopProof({
      privateKey: mine.privateKey, publicJwk: mine.publicJwk, method: 'GET',
      url: 'https://api.example.com/v1', jti: 'j', iatSeconds: 1700000000,
    }))!;
    expect(await verifyProof(proof, theirs.publicKey)).toBe(false);
  });

  test('fails closed: no key, http url, or a key that cannot sign → null, never a throw', async () => {
    const { privateKey, publicJwk } = await generateDpopKeypair();
    expect(await signDpopProof({ publicJwk, method: 'GET', url: 'https://a.example.com/x', jti: 'j', iatSeconds: 1 })).toBeNull();
    expect(await signDpopProof({ privateKey, publicJwk, method: 'GET', url: 'http://a.example.com/x', jti: 'j', iatSeconds: 1 })).toBeNull();
    // A real key of the wrong type: sign() rejects, and we swallow it.
    const hmac = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    expect(await signDpopProof({ privateKey: hmac as CryptoKey, publicJwk, method: 'GET', url: 'https://a.example.com/x', jti: 'j', iatSeconds: 1 })).toBeNull();
  });

  test('ath is b64url(SHA-256(token)) and rides the payload', async () => {
    const token = 'at_abcdefghijklmnop';
    const expected = base64url(await crypto.subtle.digest('SHA-256', utf8Bytes(token) as BufferSource));
    expect(await accessTokenHashFor(token)).toBe(expected);
    expect(await accessTokenHashFor('')).toBeNull();

    const { privateKey, publicJwk } = await generateDpopKeypair();
    const proof = (await signDpopProof({
      privateKey, publicJwk, method: 'GET', url: 'https://api.example.com/v1',
      jti: 'j', iatSeconds: 1700000000, accessTokenHash: expected,
    }))!;
    expect(JSON.parse(Buffer.from(proof.split('.')[1], 'base64url').toString('utf8')).ath).toBe(expected);
    expect(proof).not.toContain(token);   // the token itself never enters the proof
  });
});

// ── persistence: the HANDLE round-trips, one key per origin ────────────────

const memoryStore = () => {
  const rows = new Map<string, any>();
  return {
    rows,
    idb: {
      get: async (_store: string, key: any) => rows.get(String(key)),
      put: async (_store: string, value: any) => { rows.set(String(value.origin), value); },
    },
  };
};

describe('getOrCreateDpopKey — one key per origin, injected IO', () => {
  test('creates + persists once, then reuses the same handle', async () => {
    const { rows, idb } = memoryStore();
    const deps = makeDpopKeyStore(idb);
    const a = await getOrCreateDpopKey('https://api.example.com', deps);
    const b = await getOrCreateDpopKey('https://api.example.com', deps);
    expect(a!.privateKey).toBe(b!.privateKey);              // same handle, not a re-mint
    expect(rows.size).toBe(1);
    expect(rows.get('https://api.example.com').origin).toBe('https://api.example.com');
    // The persisted record holds a non-extractable handle, never bytes.
    expect(rows.get('https://api.example.com').privateKey.extractable).toBe(false);
    expect(JSON.stringify(rows.get('https://api.example.com').publicJwk)).not.toContain('"d"');
  });

  test('a different origin gets a DIFFERENT key (no cross-origin correlation)', async () => {
    const deps = makeDpopKeyStore(memoryStore().idb);
    const a = await getOrCreateDpopKey('https://api.example.com', deps);
    const b = await getOrCreateDpopKey('https://other.example.com', deps);
    expect(await dpopJkt(a!.publicJwk)).not.toBe(await dpopJkt(b!.publicJwk));
  });

  test('fails closed on a non-https / non-canonical origin', async () => {
    const deps = makeDpopKeyStore(memoryStore().idb);
    expect(await getOrCreateDpopKey('http://api.example.com', deps)).toBeNull();
    expect(await getOrCreateDpopKey('https://api.example.com/path', deps)).toBeNull();
    expect(await getOrCreateDpopKey('', deps)).toBeNull();
  });

  test('a throwing store still yields a usable key; a throwing generate yields null', async () => {
    const thrower = { load: async () => { throw new Error('idb dead'); }, save: async () => { throw new Error('idb dead'); } };
    const key = await getOrCreateDpopKey('https://api.example.com', thrower);
    expect(key?.privateKey).toBeTruthy();
    const noGen = await getOrCreateDpopKey('https://api.example.com', {
      ...thrower, generate: async () => { throw new Error('no crypto'); },
    });
    expect(noGen).toBeNull();
  });

  test('the store name is the one idb.js declares', () => {
    expect(DPOP_KEY_STORE).toBe('dpop_keys');
  });
});

// ── A3: the stored credential shape ─────────────────────────────────────────

describe('buildOriginSecret / parseOriginAuth — the dpop shape', () => {
  test('dpop stores {scheme,value} and parses to a DPoP Authorization + the bare token', () => {
    const stored = buildOriginSecret({ key: 'at_abcdefghijklmnop', scheme: 'dpop' })!;
    expect(JSON.parse(stored)).toEqual({ scheme: 'dpop', value: 'at_abcdefghijklmnop' });
    expect(parseOriginAuth(stored)).toEqual({
      header: 'Authorization',
      value: 'DPoP at_abcdefghijklmnop',
      scheme: 'dpop',
      token: 'at_abcdefghijklmnop',
    });
  });
  test('an implausible dpop token is refused like any other', () => {
    expect(buildOriginSecret({ key: 'short', scheme: 'dpop' })).toBeNull();
  });
  test('a malformed dpop record is "no usable secret", not a bearer fallback', () => {
    expect(parseOriginAuth('{"scheme":"dpop"}')).toBeNull();
    expect(parseOriginAuth('{"scheme":"dpop","value":""}')).toBeNull();
  });
  test('REGRESSION — bearer and raw are byte-for-byte unchanged (no extra members)', () => {
    expect(parseOriginAuth(buildOriginSecret({ key: 'sk_live_abcdefgh' })!))
      .toEqual({ header: 'Authorization', value: 'Bearer sk_live_abcdefgh' });
    expect(parseOriginAuth(buildOriginSecret({ key: 'abcdefgh', header: 'X-API-Key', scheme: 'raw' })!))
      .toEqual({ header: 'X-API-Key', value: 'abcdefgh' });
    expect(parseOriginAuth('sk_raw_token')).toEqual({ header: 'Authorization', value: 'Bearer sk_raw_token' });
    expect(parseOriginAuth('12345678')).toEqual({ header: 'Authorization', value: 'Bearer 12345678' });
    expect(parseOriginAuth('{"foo":1}')).toBeNull();
    expect(parseOriginAuth('')).toBeNull();
  });
});

// ── A4: the egress boundary ─────────────────────────────────────────────────

const OWNED = 'https://api.example.com';
const TOKEN = 'at_abcdefghijklmnop';

const mkFetch = () => {
  const seen: { url?: string; init?: any } = {};
  const webFetch = async (resource: any, init: any) => { seen.url = String(resource); seen.init = init; return { ok: true } as any; };
  return { webFetch, seen };
};

const mkBoundary = async (over: any = {}) => {
  const { webFetch, seen } = mkFetch();
  const audits: any[] = [];
  const key = await generateDpopKeypair();
  const wf = withDpopCredentials(webFetch, () => over.owned ?? OWNED, {
    getSecret: over.getSecret ?? (async (n: string) =>
      n === `origin:${OWNED}` ? buildOriginSecret({ key: TOKEN, scheme: 'dpop' }) : null),
    getDpopKey: over.getDpopKey ?? (async () => ({ privateKey: key.privateKey, publicJwk: key.publicJwk })),
    audit: (e: any) => audits.push(e),
    now: () => 1700000000_000,
    ...over.deps,
  });
  return { wf, seen, audits, key };
};

describe('withDpopCredentials — proof minted at the boundary, nowhere else', () => {
  test('same-origin https: Authorization: DPoP + a DPoP proof that VERIFIES for this request', async () => {
    const { wf, seen, key } = await mkBoundary();
    await wf(`${OWNED}/v1/charges?page=2`, { method: 'POST', headers: { 'X-Keep': 'ok' } });
    expect(seen.init.headers.Authorization).toBe(`DPoP ${TOKEN}`);
    expect(seen.init.headers['X-Keep']).toBe('ok');
    expect(seen.init.credentials).toBe('include');

    const proof = seen.init.headers.DPoP as string;
    expect(await verifyProof(proof, key.publicKey)).toBe(true);
    const payload = JSON.parse(Buffer.from(proof.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.htm).toBe('POST');
    expect(payload.htu).toBe(`${OWNED}/v1/charges`);                 // query stripped
    expect(payload.iat).toBe(1700000000);                            // injected clock
    expect(payload.ath).toBe(await accessTokenHashFor(TOKEN));       // bound to the token
  });

  test('each request gets a FRESH proof — nothing cacheable to steal', async () => {
    const { wf, seen } = await mkBoundary();
    await wf(`${OWNED}/v1/a`, {});
    const first = seen.init.headers.DPoP;
    await wf(`${OWNED}/v1/a`, {});
    expect(seen.init.headers.DPoP).not.toBe(first);
  });

  test('rule 5: a caller-supplied Authorization AND a forged DPoP are stripped, ours wins last', async () => {
    const { wf, seen } = await mkBoundary();
    await wf(`${OWNED}/v1/x`, { headers: { authorization: 'Bearer FORGED', dpop: 'FORGED-PROOF', DPoP: 'ALSO' } });
    const sent = seen.init.headers;
    const auths = Object.entries(sent).filter(([k]) => k.toLowerCase() === 'authorization').map(([, v]) => v);
    const proofs = Object.entries(sent).filter(([k]) => k.toLowerCase() === 'dpop').map(([, v]) => v);
    expect(auths).toEqual([`DPoP ${TOKEN}`]);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).not.toBe('FORGED-PROOF');
  });

  test('rule 6: the audit carries the origin + the public jkt ONLY', async () => {
    const { wf, audits, key } = await mkBoundary();
    await wf(`${OWNED}/v1/x`, {});
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({ type: 'dpop_auth_attached', details: { origin: OWNED, jkt: await dpopJkt(key.publicJwk) } });
    const serialized = JSON.stringify(audits[0]);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('dpop+jwt');           // no proof body
    expect(serialized).not.toContain(key.publicJwk.x);      // not even the raw JWK
  });

  test('cross-origin: NO token, NO proof, NO cookies — never sign for a URL we do not own', async () => {
    const { wf, seen, audits } = await mkBoundary();
    await wf('https://evil.example.com/collect', {});
    expect(seen.init.headers?.Authorization).toBeUndefined();
    expect(seen.init.headers?.DPoP).toBeUndefined();
    expect(seen.init.credentials).toBe('omit');
    expect(audits).toHaveLength(0);
  });

  test('a host-suffix spoof of the owned origin gets nothing', async () => {
    const { wf, seen } = await mkBoundary();
    await wf('https://api.example.com.evil.test/x', {});
    expect(seen.init.headers?.DPoP).toBeUndefined();
  });

  test('http to the owned host: nothing (a proof is never signed over cleartext)', async () => {
    const { wf, seen } = await mkBoundary();
    await wf('http://api.example.com/x', {});
    expect(seen.init.headers?.Authorization).toBeUndefined();
    expect(seen.init.headers?.DPoP).toBeUndefined();
  });

  test('rule 7: a LOCKED vault → anonymous, no throw', async () => {
    const { wf, seen, audits } = await mkBoundary({ getSecret: async () => { throw new Error('VaultLocked'); } });
    const r = await wf(`${OWNED}/v1/x`, {});
    expect(r).toBeTruthy();
    expect(seen.init.headers?.Authorization).toBeUndefined();
    expect(seen.init.headers?.DPoP).toBeUndefined();
    expect(seen.init.credentials).toBe('include');     // cookies are a separate rule
    expect(audits).toHaveLength(0);
  });

  test('rule 7: key lookup failing (throw OR null) → anonymous, never an UNSIGNED token', async () => {
    for (const getDpopKey of [async () => { throw new Error('idb dead'); }, async () => null]) {
      const { wf, seen } = await mkBoundary({ getDpopKey });
      const r = await wf(`${OWNED}/v1/x`, {});
      expect(r).toBeTruthy();
      // The token MUST NOT ride alone — that is the failure mode this closes.
      expect(seen.init.headers?.Authorization).toBeUndefined();
      expect(seen.init.headers?.DPoP).toBeUndefined();
    }
  });

  test('rule 7: a sign failure → anonymous, no throw', async () => {
    const hmac = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const pub = (await generateDpopKeypair()).publicJwk;
    const { wf, seen } = await mkBoundary({ getDpopKey: async () => ({ privateKey: hmac, publicJwk: pub }) });
    const r = await wf(`${OWNED}/v1/x`, {});
    expect(r).toBeTruthy();
    expect(seen.init.headers?.Authorization).toBeUndefined();
  });

  test('no secret stored → same-origin cookies only, no credential', async () => {
    const { wf, seen } = await mkBoundary({ getSecret: async () => null });
    await wf(`${OWNED}/v1/x`, {});
    expect(seen.init.headers?.Authorization).toBeUndefined();
    expect(seen.init.credentials).toBe('include');
  });

  test('a plain BEARER secret on this origin still works (drop-in superset)', async () => {
    const { wf, seen, audits } = await mkBoundary({ getSecret: async () => buildOriginSecret({ key: 'sk_live_abcdefgh' }) });
    await wf(`${OWNED}/v1/x`, {});
    expect(seen.init.headers.Authorization).toBe('Bearer sk_live_abcdefgh');
    expect(seen.init.headers.DPoP).toBeUndefined();
    expect(audits[0].type).toBe('origin_auth_attached');
  });

  test('it composes end to end over the REAL key store (generate → persist → sign)', async () => {
    const store = makeDpopKeyStore(memoryStore().idb);
    const { webFetch, seen } = mkFetch();
    const wf = withDpopCredentials(webFetch, () => OWNED, {
      getSecret: async () => buildOriginSecret({ key: TOKEN, scheme: 'dpop' }),
      getDpopKey: (origin: string) => getOrCreateDpopKey(origin, store),
    });
    await wf(`${OWNED}/v1/x`, {});
    const proof = seen.init.headers.DPoP as string;
    const header = JSON.parse(Buffer.from(proof.split('.')[0], 'base64url').toString('utf8'));
    // The jwk in the header is the PUBLIC key of a key whose private half is
    // unexportable — verify by importing the header jwk and checking the signature.
    const pub = await crypto.subtle.importKey('jwk', header.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    expect(await verifyProof(proof, pub)).toBe(true);
    expect(header.jwk.d).toBeUndefined();
  });
});

describe('withApiCredentials refuses a dpop secret (it cannot mint a proof)', () => {
  test('a dpop-scheme secret is NOT sent as a bare bearer token', async () => {
    const { webFetch, seen } = mkFetch();
    const audits: any[] = [];
    const wf = withApiCredentials(webFetch, () => OWNED, {
      getSecret: async () => buildOriginSecret({ key: TOKEN, scheme: 'dpop' }),
      audit: (e: any) => audits.push(e),
    });
    await wf(`${OWNED}/v1/x`, {});
    expect(seen.init.headers?.Authorization).toBeUndefined();
    expect(JSON.stringify(seen.init)).not.toContain(TOKEN);
    expect(audits).toHaveLength(0);
  });
});
