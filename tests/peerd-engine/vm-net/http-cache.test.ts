import { describe, test, expect } from 'bun:test';
import {
  isRequestCacheable,
  isResponseStorable,
  cacheKey,
  revalidationHeaders,
  isFresh,
  MAX_CACHE_ENTRY_BYTES,
} from '../../../extension/peerd-engine/vm-net/http-cache.js';
import { stubMessage, stubsBash, UNSUPPORTED_NET_COMMANDS } from '../../../extension/peerd-engine/vm-net/socket-stubs.js';

describe('isRequestCacheable', () => {
  test('plain GET is cacheable', () => {
    expect(isRequestCacheable({ method: 'GET', url: 'https://x/y' })).toBe(true);
  });
  test('POST / bodied / ranged / authed requests are not', () => {
    expect(isRequestCacheable({ method: 'POST', url: 'https://x' })).toBe(false);
    expect(isRequestCacheable({ method: 'GET', url: 'https://x', body: 'z' })).toBe(false);
    expect(isRequestCacheable({ method: 'GET', url: 'https://x', headers: { Range: 'bytes=0-1' } })).toBe(false);
    expect(isRequestCacheable({ method: 'GET', url: 'https://x', headers: { Authorization: 'Bearer t' } })).toBe(false);
  });
  test('every injected auth header bypasses the cache (incl. GitLab PRIVATE-TOKEN)', () => {
    expect(isRequestCacheable({ method: 'GET', url: 'https://gitlab.com/x', headers: { 'PRIVATE-TOKEN': 't' } })).toBe(false);
    expect(isRequestCacheable({ method: 'GET', url: 'https://x', headers: { Cookie: 'a=b' } })).toBe(false);
    expect(isRequestCacheable({ method: 'GET', url: 'https://x', headers: { 'Proxy-Authorization': 'Basic z' } })).toBe(false);
  });
});

describe('isResponseStorable', () => {
  test('stores a 200 under the size cap', () => {
    expect(isResponseStorable({ status: 200, headers: {} }, 1024)).toBe(true);
  });
  test('skips non-200, oversize, no-store, private', () => {
    expect(isResponseStorable({ status: 404, headers: {} }, 1)).toBe(false);
    expect(isResponseStorable({ status: 200, headers: {} }, MAX_CACHE_ENTRY_BYTES + 1)).toBe(false);
    expect(isResponseStorable({ status: 200, headers: { 'Cache-Control': 'no-store' } }, 1)).toBe(false);
    expect(isResponseStorable({ status: 200, headers: { 'cache-control': 'private, max-age=60' } }, 1)).toBe(false);
  });
});

describe('cacheKey', () => {
  test('drops the fragment, keeps query', () => {
    expect(cacheKey('https://x/y?a=1#frag')).toBe('https://x/y?a=1');
  });
});

describe('revalidationHeaders', () => {
  test('replays etag and last-modified as conditional headers', () => {
    expect(revalidationHeaders({ status: 200, headers: { ETag: '"v1"', 'Last-Modified': 'Mon' } }))
      .toEqual({ 'If-None-Match': '"v1"', 'If-Modified-Since': 'Mon' });
  });
  test('empty when no validators', () => {
    expect(revalidationHeaders({ status: 200, headers: {} })).toEqual({});
  });
});

describe('isFresh', () => {
  test('fresh within max-age, stale past it, never without max-age', () => {
    const meta = { status: 200, headers: { 'cache-control': 'max-age=60' } };
    expect(isFresh(meta, 1_000_000, 1_030_000)).toBe(true);   // 30s < 60s
    expect(isFresh(meta, 1_000_000, 1_120_000)).toBe(false);  // 120s > 60s
    expect(isFresh({ status: 200, headers: {} }, 0, 1)).toBe(false);
  });

  test('clamps an absurd max-age so a hostile header can not make an entry immortal', () => {
    const evil = { status: 200, headers: { 'cache-control': `max-age=${'9'.repeat(400)}` } };
    const TWO_YEARS = 2 * 365 * 24 * 60 * 60 * 1000;
    expect(isFresh(evil, 0, TWO_YEARS)).toBe(false); // past the 1-year clamp → stale
    expect(isFresh(evil, 0, 1000)).toBe(true);       // still fresh moments after storing
  });
});

describe('socket-stubs', () => {
  test('every entry produces a peerd-branded message naming the command', () => {
    for (const entry of UNSUPPORTED_NET_COMMANDS) {
      const msg = stubMessage(entry);
      expect(msg).toContain('peerd:');
      expect(msg).toContain(`'${entry.cmd}'`);
      expect(msg).toContain('HTTP(S)-native');
    }
  });
  test('stubsBash defines and exports a function per command, quoting-safe', () => {
    const bash = stubsBash();
    for (const entry of UNSUPPORTED_NET_COMMANDS) {
      expect(bash).toContain(`${entry.cmd}() {`);
      expect(bash).toContain(`export -f ${entry.cmd}`);
    }
    // no raw unescaped single-quote breaks out of the message literal
    expect(bash).not.toMatch(/[^\\]''[^\\]/);
  });
});
