// DESIGN-18 P1 — the keyless, origin-bound API-key injection. These pin the 8 normative
// security rules (the origin:<origin> analog of the shipped git:<host> shape). The actor
// never holds the key: the vault read lives inside the boundary closure (withApiCredentials),
// the value rides ONLY the wire, and injection happens same-origin + https only, single-shot.

import { describe, test, expect } from 'bun:test';
import {
  normalizeKeyedOrigin, authOriginForRequestUrl, originSecretName, originFromSecretName,
  isPlausibleApiKey, buildOriginSecret, parseOriginAuth,
} from '../../extension/peerd-egress/fetch/origin-credentials.js';
import { withApiCredentials } from '../../extension/peerd-egress/fetch/web-fetch.js';
import { makeOriginCredentialRoutes } from '../../extension/peerd-egress/fetch/origin-credential-routes.js';

describe('normalizeKeyedOrigin — https-ONLY at grant (rule 2)', () => {
  test('a bare host becomes an https origin', () => {
    expect(normalizeKeyedOrigin('api.stripe.com')).toBe('https://api.stripe.com');
  });
  test('a full https URL reduces to its origin; port kept', () => {
    expect(normalizeKeyedOrigin('https://api.github.com/x?y=1')).toBe('https://api.github.com');
    expect(normalizeKeyedOrigin('https://api.github.com:8443/x')).toBe('https://api.github.com:8443');
  });
  test('http is REJECTED — a key must never bind to a cleartext origin', () => {
    expect(normalizeKeyedOrigin('http://api.stripe.com')).toBeNull();
  });
  test('rejects non-public / spoof-ish hosts and junk', () => {
    expect(normalizeKeyedOrigin('localhost')).toBeNull();
    expect(normalizeKeyedOrigin('42')).toBeNull();
    expect(normalizeKeyedOrigin('ftp://x.com')).toBeNull();
    expect(normalizeKeyedOrigin('')).toBeNull();
  });
});

describe('authOriginForRequestUrl — the send-time binding gate (rules 2 + 3)', () => {
  const owned = 'https://api.stripe.com';
  test('same-origin https → authenticates', () => {
    expect(authOriginForRequestUrl('https://api.stripe.com/v1/charges', owned)).toBe(owned);
  });
  test('cross-origin → null (sessionless/keyless)', () => {
    expect(authOriginForRequestUrl('https://evil.com/x', owned)).toBeNull();
  });
  test('a host-suffix / userinfo spoof lands on a DIFFERENT origin → null', () => {
    expect(authOriginForRequestUrl('https://api.stripe.com.evil.com/x', owned)).toBeNull();
    expect(authOriginForRequestUrl('https://api.stripe.com@evil.com/x', owned)).toBeNull();
  });
  test('http to the owned host → null (never the key over cleartext)', () => {
    expect(authOriginForRequestUrl('http://api.stripe.com/x', owned)).toBeNull();
  });
  test('no owned origin (a tab actor / mis-mint) → null', () => {
    expect(authOriginForRequestUrl('https://api.stripe.com/x', undefined)).toBeNull();
  });
});

describe('secret naming + build/parse', () => {
  test('name round-trips', () => {
    expect(originSecretName('https://api.x.com')).toBe('origin:https://api.x.com');
    expect(originFromSecretName('origin:https://api.x.com')).toBe('https://api.x.com');
    expect(originFromSecretName('git:github.com')).toBeNull();
  });
  test('bearer (default) builds an Authorization: Bearer secret', () => {
    const s = buildOriginSecret({ key: 'sk_live_abcdefgh' });
    expect(parseOriginAuth(s!)).toEqual({ header: 'Authorization', value: 'Bearer sk_live_abcdefgh' });
  });
  test('raw scheme puts the key verbatim in a custom header (X-API-Key)', () => {
    const s = buildOriginSecret({ key: 'abcdefgh', header: 'X-API-Key', scheme: 'raw' });
    expect(parseOriginAuth(s!)).toEqual({ header: 'X-API-Key', value: 'abcdefgh' });
  });
  test('an implausible key is refused', () => {
    expect(buildOriginSecret({ key: 'short' })).toBeNull();
    expect(buildOriginSecret({ key: 'has space inside' })).toBeNull();
    expect(isPlausibleApiKey('sk_live_abcdefgh')).toBe(true);
  });
  test('a legacy bare-token secret parses as Authorization: Bearer', () => {
    expect(parseOriginAuth('sk_raw_token')).toEqual({ header: 'Authorization', value: 'Bearer sk_raw_token' });
    expect(parseOriginAuth('')).toBeNull();
    expect(parseOriginAuth(undefined)).toBeNull();
  });
  test('a bare token that is also a valid JSON primitive still falls back to Bearer (not dropped)', () => {
    // all-digit / true / array / quoted — JSON.parse accepts these, but they are bare
    // hand-entered tokens, not our {header,value} shape → Bearer, never null.
    expect(parseOriginAuth('12345678')).toEqual({ header: 'Authorization', value: 'Bearer 12345678' });
    expect(parseOriginAuth('true')).toEqual({ header: 'Authorization', value: 'Bearer true' });
    // A structured-but-malformed JSON object is "no usable secret" → null (not a token).
    expect(parseOriginAuth('{"foo":1}')).toBeNull();
  });
});

// A recording webFetch + a vault stub to assert the boundary behavior end to end.
const mkFetch = () => {
  const seen: { url?: string; init?: any } = {};
  const webFetch = async (resource: any, init: any) => { seen.url = String(resource); seen.init = init; return { ok: true } as any; };
  return { webFetch, seen };
};

describe('withApiCredentials — the keyless credentialed boundary fetch', () => {
  const owned = 'https://api.stripe.com';
  const vault = (m: Record<string, string>) => ({ getSecret: async (n: string) => m[n] ?? null });

  test('same-origin https: injects the vault key, session-scopes cookies, audits NAME only (rules 3,5,6)', async () => {
    const { webFetch, seen } = mkFetch();
    const audits: any[] = [];
    const wf = withApiCredentials(webFetch, () => owned, {
      getSecret: vault({ 'origin:https://api.stripe.com': buildOriginSecret({ key: 'sk_live_abcdefgh' })! }).getSecret,
      audit: (e) => audits.push(e),
    });
    await wf('https://api.stripe.com/v1/charges', { headers: { 'X-Keep': 'ok' } });
    expect(seen.init.headers.Authorization).toBe('Bearer sk_live_abcdefgh');
    expect(seen.init.headers['X-Keep']).toBe('ok');          // non-auth headers survive
    expect(seen.init.credentials).toBe('include');           // same-origin → cookies
    // rule 6: the audit carries origin + header NAME, NEVER the value.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({ type: 'origin_auth_attached', details: { origin: owned, header: 'Authorization' } });
    expect(JSON.stringify(audits[0])).not.toContain('sk_live_abcdefgh');
  });

  test('cross-origin: NO key, NO cookies (sessionless) even with a stored secret', async () => {
    const { webFetch, seen } = mkFetch();
    const wf = withApiCredentials(webFetch, () => owned, {
      getSecret: vault({ 'origin:https://api.stripe.com': buildOriginSecret({ key: 'sk_live_abcdefgh' })! }).getSecret,
    });
    await wf('https://other.example.com/x', {});
    expect(seen.init.headers?.Authorization).toBeUndefined();
    expect(seen.init.credentials).toBe('omit');
  });

  test('rule 5: an actor-supplied Authorization is STRIPPED then overwritten last-wins', async () => {
    const { webFetch, seen } = mkFetch();
    const wf = withApiCredentials(webFetch, () => owned, {
      getSecret: vault({ 'origin:https://api.stripe.com': buildOriginSecret({ key: 'sk_live_abcdefgh' })! }).getSecret,
    });
    await wf('https://api.stripe.com/x', { headers: { authorization: 'Bearer FORGED', Authorization: 'Bearer ALSO' } });
    // The forged values (any case) are gone; only the vault value rides.
    const sent = seen.init.headers;
    const authVals = Object.entries(sent).filter(([k]) => k.toLowerCase() === 'authorization').map(([, v]) => v);
    expect(authVals).toEqual(['Bearer sk_live_abcdefgh']);
  });

  test('rule 5 (custom header): a forged X-API-Key is stripped, the vault value wins last', async () => {
    const { webFetch, seen } = mkFetch();
    const wf = withApiCredentials(webFetch, () => owned, {
      getSecret: vault({ 'origin:https://api.stripe.com': buildOriginSecret({ key: 'abcdefgh12', header: 'X-API-Key', scheme: 'raw' })! }).getSecret,
    });
    await wf('https://api.stripe.com/v1/charges', { headers: { 'x-api-key': 'FORGED', 'X-API-Key': 'ALSO' } });
    const sent = seen.init.headers;
    // The CONFIGURED header name (not just Authorization) is stripped case-insensitively
    // then injected last-wins — exactly one X-API-Key survives, with the vault value.
    const keyVals = Object.entries(sent).filter(([k]) => k.toLowerCase() === 'x-api-key').map(([, v]) => v);
    expect(keyVals).toEqual(['abcdefgh12']);
    expect(sent.Authorization).toBeUndefined();   // a non-configured auth scheme isn't added
  });

  test('rule 7: a locked vault → NO header, NO throw (request proceeds anonymous)', async () => {
    const { webFetch, seen } = mkFetch();
    const wf = withApiCredentials(webFetch, () => owned, {
      getSecret: async () => { throw new Error('VaultLocked'); },
    });
    const r = await wf('https://api.stripe.com/x', {});
    expect(r).toBeTruthy();                                   // didn't throw
    expect(seen.init.headers?.Authorization).toBeUndefined(); // no key
    expect(seen.init.credentials).toBe('include');            // cookies still same-origin
  });

  test('no secret stored → same-origin cookies only, no auth header', async () => {
    const { webFetch, seen } = mkFetch();
    const wf = withApiCredentials(webFetch, () => owned, { getSecret: async () => null });
    await wf('https://api.stripe.com/x', {});
    expect(seen.init.headers?.Authorization).toBeUndefined();
    expect(seen.init.credentials).toBe('include');
  });
});

describe('makeOriginCredentialRoutes — set/list/delete (write-only keys)', () => {
  const mkVault = () => {
    const store: Record<string, string> = {};
    return {
      store,
      listSecretNames: async () => Object.keys(store),
      getSecret: async (n: string) => store[n] ?? null,
      setSecret: async (n: string, v: string) => { store[n] = v; },
      deleteSecret: async (n: string) => { delete store[n]; },
    };
  };
  const routes = (v: any) => makeOriginCredentialRoutes({ vault: v, isLockedError: (e: any) => /lock/i.test(String(e?.message)), audit: () => {} });

  test('set canonicalizes (https), stores a {header,value} secret; list never returns the value', async () => {
    const v = mkVault();
    const r = routes(v);
    const set = await r['origin-cred/set']({ origin: 'api.stripe.com', key: 'sk_live_abcdefgh' });
    expect(set).toEqual({ ok: true, origin: 'https://api.stripe.com' });
    expect(v.store['origin:https://api.stripe.com']).toContain('Bearer sk_live_abcdefgh');
    const list = await r['origin-cred/list']({});
    expect(list.integrations).toEqual([{ origin: 'https://api.stripe.com', header: 'Authorization' }]);
    expect(JSON.stringify(list)).not.toContain('sk_live_abcdefgh');   // value never surfaced
  });

  test('set rejects http origin (rule 2) and an implausible key', async () => {
    const r = routes(mkVault());
    expect((await r['origin-cred/set']({ origin: 'http://api.stripe.com', key: 'sk_live_abcdefgh' })).error).toBe('bad-origin');
    expect((await r['origin-cred/set']({ origin: 'api.stripe.com', key: 'short' })).error).toBe('bad-key');
  });

  test('delete removes it', async () => {
    const v = mkVault();
    const r = routes(v);
    await r['origin-cred/set']({ origin: 'api.stripe.com', key: 'sk_live_abcdefgh' });
    await r['origin-cred/delete']({ origin: 'api.stripe.com' });
    expect(v.store['origin:https://api.stripe.com']).toBeUndefined();
  });

  test('a locked vault maps to a soft locked result', async () => {
    const v = { ...mkVault(), setSecret: async () => { throw new Error('vault is locked'); } };
    const r = routes(v);
    expect(await r['origin-cred/set']({ origin: 'api.stripe.com', key: 'sk_live_abcdefgh' })).toEqual({ ok: false, error: 'locked' });
  });
});
