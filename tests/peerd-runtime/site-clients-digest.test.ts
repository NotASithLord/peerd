// DESIGN-19 — the capture DIGESTER. The security-critical property is REDACTION:
// credentials in headers / params / bodies never survive into the inventory. Also
// pins URL templatization (id collapsing), shape sketching, origin scoping, and
// auth-posture inference.

import { describe, test, expect } from 'bun:test';
import {
  redactHeaders,
  redactParamValue,
  templatizeUrl,
  shapeSketch,
  inScope,
  digestCapture,
} from '../../extension/peerd-runtime/site-clients/digest.js';

describe('redactHeaders — credentials stripped (the inbound twin of fetch_url)', () => {
  test('drops Cookie / Authorization / CSRF / api-key, case-insensitive', () => {
    const out = redactHeaders({ Cookie: 'x', authorization: 'Bearer y', 'X-CSRF-Token': 'z', 'X-Api-Key': 'k', Accept: 'application/json' });
    expect(out).toEqual({ Accept: 'application/json' });
  });
  test('non-object → {}', () => {
    expect(redactHeaders(undefined)).toEqual({});
  });
});

describe('redactParamValue — secret-ish names AND values', () => {
  test('secret-named param value is redacted', () => {
    expect(redactParamValue('access_token', 'abc')).toBe('<redacted>');
    expect(redactParamValue('csrf', 'x')).toBe('<redacted>');
  });
  test('long opaque value redacted even under a benign name', () => {
    // A long high-entropy-ish opaque string (NOT a real key shape) — the value
    // heuristic redacts it regardless of the benign param name.
    expect(redactParamValue('q', 'AAAA1111bbbb2222cccc3333dddd')).toBe('<redacted>');
  });
  test('a normal short value passes', () => {
    expect(redactParamValue('page', '2')).toBe('2');
  });
});

describe('templatizeUrl — id collapsing + query redaction', () => {
  test('numeric / uuid / opaque segments become :id', () => {
    expect(templatizeUrl('https://api.x.com/v1/charges/12345').path).toBe('/v1/charges/:id');
    expect(templatizeUrl('https://api.x.com/u/550e8400-e29b-41d4-a716-446655440000').path).toBe('/u/:id');
    expect(templatizeUrl('https://api.x.com/o/ch_1a2b3c4d5e6f').path).toBe('/o/:id');
  });
  test('query keys kept, secret values redacted', () => {
    const { query } = templatizeUrl('https://api.x.com/s?page=2&token=deadbeefdeadbeefdeadbeef');
    expect(query.page).toBe('2');
    expect(query.token).toBe('<redacted>');
  });
  test('a bad URL degrades to the raw string, no throw', () => {
    expect(templatizeUrl('::::').path).toBe('::::');
  });
});

describe('shapeSketch — structure, never verbatim payload', () => {
  test('keeps keys + types, redacts secret keys, samples arrays', () => {
    const s = shapeSketch({ id: 5, name: 'short', token: 'anything', items: [{ a: 1 }, { a: 2 }] }) as Record<string, unknown>;
    expect(s.id).toBe('number');
    expect(s.name).toBe('string');
    expect(s.token).toBe('<redacted>');
    expect(Array.isArray(s.items)).toBe(true);
  });
  test('long strings collapse to the type', () => {
    expect(shapeSketch('x'.repeat(50))).toBe('string');
  });

  test('short PII strings never enter the model-facing shape', () => {
    const shape = shapeSketch({
      email: 'alice@example.com',
      name: 'Jane Doe',
      city: 'Rome',
    });
    const serialized = JSON.stringify(shape);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('Jane Doe');
    expect(serialized).not.toContain('Rome');
    expect(shape).toEqual({ email: 'string', name: 'string', city: 'string' });
  });
});

describe('inScope — same-origin only (analytics noise dropped)', () => {
  test('same origin kept, third-party dropped', () => {
    expect(inScope({ method: 'GET', url: 'https://api.x.com/a' }, { origins: ['https://api.x.com'] })).toBe(true);
    expect(inScope({ method: 'GET', url: 'https://analytics.evil.com/t' }, { origins: ['https://api.x.com'] })).toBe(false);
  });
});

describe('digestCapture — redacted inventory + inferred posture', () => {
  test('dedupes by templatized endpoint, infers bearer, never keeps credentials', () => {
    const events = [
      { method: 'GET', url: 'https://api.x.com/v1/charges/1', status: 200, reqHeaders: { Authorization: 'Bearer secret', Cookie: 'sid=abc' }, resSample: { id: 1, amount: 100 } },
      { method: 'GET', url: 'https://api.x.com/v1/charges/2', status: 200, reqHeaders: { Authorization: 'Bearer secret' } },
      { method: 'POST', url: 'https://api.x.com/v1/refunds', status: 201 },
      { method: 'GET', url: 'https://tracker.evil.com/p', status: 200 },
    ];
    const d = digestCapture(events as any, { origins: ['https://api.x.com'], deriver: 'capture-tap' });
    // /v1/charges/1 and /2 collapse to one endpoint
    const paths = d.endpoints.map((e) => `${e.method} ${e.path}`);
    expect(paths).toContain('GET /v1/charges/:id');
    expect(paths).toContain('POST /v1/refunds');
    expect(d.endpoints.length).toBe(2);       // third-party dropped
    expect(d.auth).toBe('bearer');
    expect(d.dropped).toBe(1);
    // the whole serialized digest must not contain the secret
    expect(JSON.stringify(d)).not.toContain('secret');
    expect(JSON.stringify(d)).not.toContain('sid=abc');
  });

  test('cookie-only traffic → session posture', () => {
    const d = digestCapture([{ method: 'GET', url: 'https://api.x.com/me', reqHeaders: { Cookie: 'sid=1' } }], { origins: ['https://api.x.com'] });
    expect(d.auth).toBe('session');
  });

  test('no observed in-scope traffic → unknown posture', () => {
    const d = digestCapture([], { origins: ['https://api.x.com'] });
    expect(d.auth).toBe('unknown');
    expect(d.endpoints).toEqual([]);
  });
});
