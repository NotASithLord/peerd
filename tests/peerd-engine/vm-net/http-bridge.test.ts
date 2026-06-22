import { describe, test, expect } from 'bun:test';
import {
  GET_MARKER,
  REQ_MARKER,
  MAX_REQ_BODY_BYTES,
  isWriteMethod,
  needsWebWriteConfirm,
  normalizeRequest,
  encodeRequest,
  decodeRequest,
  parseMarkerLine,
  findNextMarker,
  partialMarkerHoldIndex,
  encodeResponseMeta,
} from '../../../extension/peerd-engine/vm-net/http-bridge.js';

describe('normalizeRequest', () => {
  test('defaults to GET with empty headers/body', () => {
    const r = normalizeRequest({ url: 'https://api.example.com/x' });
    expect(r.method).toBe('GET');
    expect(r.headers).toEqual({});
    expect(r.body).toBeNull();
    expect((r as any).auth).toBeUndefined(); // no auth field on the VM wire
  });

  test('uppercases method, coerces header values to strings', () => {
    const r = normalizeRequest({
      method: 'post',
      url: 'https://api.example.com',
      headers: { 'Content-Type': 'application/json', 'X-Num': 7 as any },
    });
    expect(r.method).toBe('POST');
    expect(r.headers['X-Num']).toBe('7');
  });

  test('rejects a non-http(s) URL but allows the internal peerd:// scheme', () => {
    expect(() => normalizeRequest({ url: 'file:///etc/passwd' })).toThrow(/http/);
    expect(() => normalizeRequest({ url: 'chrome://settings' })).toThrow();
    expect(normalizeRequest({ url: 'peerd://git-clone' }).url).toBe('peerd://git-clone');
  });

  test('rejects an unsupported method', () => {
    expect(() => normalizeRequest({ method: 'CONNECT', url: 'https://x.example' })).toThrow(/method/);
  });

  test('rejects an oversized body', () => {
    const huge = 'a'.repeat(Math.ceil((MAX_REQ_BODY_BYTES + 16) * 4 / 3));
    expect(() => normalizeRequest({ url: 'https://x.example', body: huge })).toThrow(/cap/);
  });
});

describe('isWriteMethod', () => {
  test('classifies verbs', () => {
    expect(isWriteMethod('post')).toBe(true);
    expect(isWriteMethod('DELETE')).toBe(true);
    expect(isWriteMethod('GET')).toBe(false);
    expect(isWriteMethod('head')).toBe(false);
  });
});

describe('needsWebWriteConfirm — the anti-exfil gate predicate', () => {
  test('only GET/HEAD are exempt; OPTIONS + every write verb are gated', () => {
    expect(needsWebWriteConfirm('GET')).toBe(false);
    expect(needsWebWriteConfirm('head')).toBe(false);
    expect(needsWebWriteConfirm(undefined)).toBe(false); // defaults to GET
    expect(needsWebWriteConfirm('POST')).toBe(true);
    expect(needsWebWriteConfirm('put')).toBe(true);
    expect(needsWebWriteConfirm('PATCH')).toBe(true);
    expect(needsWebWriteConfirm('DELETE')).toBe(true);
    expect(needsWebWriteConfirm('OPTIONS')).toBe(true); // can carry a body — gated
  });
});

describe('encode/decode round-trip', () => {
  test('preserves method, url, headers, body through the wire blob', () => {
    const req = {
      method: 'PUT',
      url: 'https://api.example.com/items/1',
      headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      body: btoa(unescape(encodeURIComponent('{"name":"péerd ☃"}'))), // body rides as base64 already
    };
    const payload = encodeRequest(req);
    expect(payload).not.toContain('\n'); // single PTY line
    const back = decodeRequest(payload);
    expect(back).toEqual(normalizeRequest(req));
  });

  test('drops any caller-supplied auth field — the VM wire has no auth', () => {
    const payload = encodeRequest({ url: 'https://x.example', headers: {}, auth: 'git' } as any);
    const back = decodeRequest(payload) as any;
    expect(back.auth).toBeUndefined();
  });

  test('a forged A-line in the blob is ignored (no auth smuggling)', () => {
    // Simulate a producer that injected an `A\tgit` line via a newline in a value.
    const forged = btoa(unescape(encodeURIComponent('PEERDREQ1\nM\tGET\nU\thttps://x.example\nA\tgit')));
    const back = decodeRequest(forged) as any;
    expect(back.auth).toBeUndefined();
  });

  test('handles unicode in the URL/headers without corrupting the line', () => {
    const payload = encodeRequest({ url: 'https://example.com/søk?q=café' });
    expect(decodeRequest(payload).url).toBe('https://example.com/søk?q=café');
  });
});

describe('parseMarkerLine', () => {
  test('parses a GET marker line', () => {
    const got = parseMarkerLine('get', 'abc123:https://example.com/a');
    expect(got).toEqual({ kind: 'get', id: 'abc123', url: 'https://example.com/a' });
  });

  test('GET line keeps colons in the URL intact', () => {
    const got = parseMarkerLine('get', 'id1:https://example.com:8443/a:b');
    expect(got?.kind === 'get' && got.url).toBe('https://example.com:8443/a:b');
  });

  test('parses a REQ marker line back to a request', () => {
    const payload = encodeRequest({ method: 'POST', url: 'https://x.example/p', body: btoa('hi') });
    const got = parseMarkerLine('req', `xy9:${payload}`);
    expect(got?.kind).toBe('req');
    if (got?.kind === 'req') {
      expect(got.id).toBe('xy9');
      expect(got.request.method).toBe('POST');
      expect(got.request.url).toBe('https://x.example/p');
    }
  });

  test('returns null on a bad id (so the host does not eat stdout)', () => {
    expect(parseMarkerLine('get', 'bad id:https://x')).toBeNull();
    expect(parseMarkerLine('get', 'noColonHere')).toBeNull();
  });

  test('returns null on a corrupt REQ payload', () => {
    expect(parseMarkerLine('req', 'id1:not-valid-base64-json!!')).toBeNull();
  });
});

describe('findNextMarker', () => {
  test('finds the earliest of the two markers', () => {
    const buf = `noise ${REQ_MARKER}x stuff ${GET_MARKER}y`;
    const first = findNextMarker(buf, 0);
    expect(first?.kind).toBe('req');
    const second = findNextMarker(buf, (first?.index ?? 0) + 1);
    expect(second?.kind).toBe('get');
  });

  test('returns null when neither marker is present', () => {
    expect(findNextMarker('just regular output\n', 0)).toBeNull();
  });
});

describe('partialMarkerHoldIndex', () => {
  test('holds back a split marker prefix at the buffer tail', () => {
    const buf = `done\n${GET_MARKER.slice(0, 6)}`; // marker split across chunks
    const hold = partialMarkerHoldIndex(buf);
    expect(buf.slice(hold)).toBe(GET_MARKER.slice(0, 6));
  });

  test('holds nothing when the tail cannot start a marker', () => {
    const buf = 'plain output with no marker tail';
    expect(partialMarkerHoldIndex(buf)).toBe(buf.length);
  });
});

describe('encodeResponseMeta', () => {
  test('lower-cases header keys and includes status', () => {
    const meta = encodeResponseMeta({
      status: 201,
      statusText: 'Created',
      headers: { 'Content-Type': 'application/json', ETag: '"abc"' },
    });
    const parsed = JSON.parse(meta);
    expect(parsed.status).toBe(201);
    expect(parsed.headers['content-type']).toBe('application/json');
    expect(parsed.headers.etag).toBe('"abc"');
  });
});
