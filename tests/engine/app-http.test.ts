import { describe, expect, test } from 'bun:test';
import { parseAppRequest, validateAppHttpRoutes } from '../../extension/peerd-engine/app-http.js';

// The path and size metadata comes from a real large game folder. No game bytes run here.
const origin = 'https://app-release.peerd-game.localhost';
const index = { entry: 'index.html', files: [
  { path: 'index.html', size: 42887 }, { path: 'main.js', size: 1114184 },
  { path: 'game.wasm', size: 40259108 }, { path: 'data/TRACKS/STREAML4RD.BUN', size: 120586240 },
] };
const request = (path: string, options: Partial<Parameters<typeof parseAppRequest>[0]> = {}) =>
  parseAppRequest({ url: origin + path, origin, index, ...options });
const headers = (result: ReturnType<typeof request>) => Object.fromEntries(result.headers.map(({ name, value }) => [name, value]));
const route = { prefix: 'blocks/', targetPrefix: '', blockSize: 1048576,
  query: { offset: 'o', length: 'l', block: 'b', count: 'n', size: 's', modified: 'm' } };
const routed = { ...index, httpRoutes: [route] };

describe('App static HTTP requests', () => {
  test('binds the root entry, static query lookup and fixed headers', () => {
    const root = request('/?path=game.wasm&origin=https://elsewhere.invalid');
    expect(root).toMatchObject({ status: 200, path: 'index.html', offset: 0, length: 42887, head: false });
    expect(headers(root)).toMatchObject({ 'Content-Length': '42887', 'Content-Type': 'text/html; charset=utf-8',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    expect(headers(request('/game.wasm?v=-TcWQcQwV8tGJiGjJ6VPfS'))['Content-Type']).toBe('application/wasm');
    expect(headers(request('/main.js'))['Content-Type']).toBe('text/javascript; charset=utf-8');
    const unknown = { entry: 'constructor', files: [{ path: 'constructor', size: 0 }] };
    expect(headers(request('/', { index: unknown }))['Content-Type']).toBe('application/octet-stream');
  });

  test('does not normalize unsafe paths into an allowed file', () => {
    for (const path of ['/../index.html', '/a/../index.html', '/%2e/index.html', '/%2e%2e/index.html',
      '/data%2fTRACKS/STREAML4RD.BUN', '/data%5cTRACKS/STREAML4RD.BUN', '/a\\index.html',
      '/%00index.html', '/%0aindex.html', '/bad%escape', '//index.html']) {
      expect(request(path).status).toBe(400);
    }
    expect(request('/%252e%252e/index.html').status).toBe(404);
    expect(request('/INDEX.HTML').status).toBe(404);
  });

  test('refuses another origin, credentials, fragments and unsupported methods', () => {
    expect(request('/', { url: 'https://other.peerd-game.localhost/' }).status).toBe(403);
    expect(request('/', { url: 'https://app-release.peerd-game.localhost.evil.invalid/' }).status).toBe(403);
    expect(request('/', { url: 'https://user@app-release.peerd-game.localhost/' }).status).toBe(400);
    expect(request('/#part').status).toBe(400);
    expect(request('/missing').status).toBe(404);
    const post = request('/', { method: 'POST' });
    expect(post).toMatchObject({ status: 405, path: null, length: 0 });
    expect(headers(post).Allow).toBe('GET, HEAD');
  });

  test('bounds response bodies but permits HEAD metadata without a disk read', () => {
    expect(request('/game.wasm')).toMatchObject({ status: 200, length: 40259108 });
    expect(request('/game.wasm', { maxResponseBytes: 8388608 }).status).toBe(413);
    expect(request('/data/TRACKS/STREAML4RD.BUN').status).toBe(413);
    expect(request('/data/TRACKS/STREAML4RD.BUN', { method: 'HEAD', range: 'bytes=0-1' }))
      .toMatchObject({ status: 200, length: 120586240, head: true });
    for (const maxResponseBytes of [0, -1, 50000001, Infinity]) expect(request('/', { maxResponseBytes }).status).toBe(400);
  });
});

describe('App single byte ranges', () => {
  test.each([
    ['bytes=0-0', 0, 1], ['bytes=8-15', 8, 8], ['bytes=40259100-', 40259100, 8],
    ['bytes=-8', 40259100, 8], ['bytes=-999999999999999999999', 0, 40259108],
    ['BYTES=40259100-999999999999999999999', 40259100, 8],
  ])('resolves %s without integer overflow', (range, offset, length) => {
    const result = request('/game.wasm', { range });
    expect(result).toMatchObject({ status: 206, path: 'game.wasm', offset, length });
    expect(headers(result)['Content-Range']).toBe(`bytes ${offset}-${offset + length - 1}/40259108`);
    expect(headers(result)['Content-Length']).toBe(String(length));
  });

  test('rejects malformed, multiple and unsatisfied byte ranges', () => {
    for (const range of ['', 'bytes=-', 'bytes=-0', 'bytes=5-4', 'bytes=40259108-',
      'bytes=999999999999999999999-', 'bytes=0-1,8-9', 'bytes=1.5-2', 'bytes=1-2\r\n']) {
      const result = request('/game.wasm', { range });
      expect(result).toMatchObject({ status: 416, path: null, length: 0 });
      expect(headers(result)['Content-Range']).toBe('bytes */40259108');
    }
    expect(request('/game.wasm', { range: 'items=0-1' })).toMatchObject({ status: 200, length: 40259108 });
    expect(request('/game.wasm', { range: 'bytes=0-8388607', maxResponseBytes: 8388608 }).length).toBe(8388608);
    expect(request('/game.wasm', { range: 'bytes=0-8388608', maxResponseBytes: 8388608 }).status).toBe(413);
  });

  test('serves an empty representation without an invalid Content-Range', () => {
    const empty = { entry: 'empty.bin', files: [{ path: 'empty.bin', size: 0 }] };
    const result = request('/', { index: empty, range: 'bytes=0-' });
    expect(result).toMatchObject({ status: 200, length: 0 });
    expect(headers(result)['Content-Range']).toBeUndefined();
  });
});

describe('App-owned declarative read routes', () => {
  test('maps configured aliases to only indexed files and clamps the final block', () => {
    const result = request('/blocks/game.wasm?b=38&n=8&s=40259108&m=arbitrary&path=main.js', { index: routed });
    expect(result).toMatchObject({ status: 206, path: 'game.wasm', offset: 39845888, length: 413220 });
    expect(headers(result)['Content-Range']).toBe('bytes 39845888-40259107/40259108');
    expect(request('/blocks/data/TRACKS/STREAML4RD.BUN?o=1&l=8388608', { index: routed, maxResponseBytes: 8388608 }))
      .toMatchObject({ status: 206, offset: 1, length: 8388608 });
    expect(request('/blocks/missing?b=0&n=1', { index: routed }).status).toBe(404);
  });

  test('checks size, duplicate aliases, arithmetic, mixed ranges and response limits', () => {
    for (const query of ['b=0', 'b=0&n=0', 'b=-1&n=1', 'b=0&n=1&o=0&l=1',
      'o=0&o=1&l=1', 'b=9007199254740991&n=1', 'o=0&l=9007199254740992', 'unrelated=1']) {
      expect(request('/blocks/game.wasm?' + query, { index: routed }).status).toBe(400);
    }
    expect(request('/blocks/game.wasm?b=0&n=1&s=1', { index: routed }).status).toBe(409);
    expect(request('/blocks/game.wasm?b=39&n=1', { index: routed }).status).toBe(416);
    expect(request('/blocks/game.wasm?b=0&n=9', { index: routed, maxResponseBytes: 8388608 }).status).toBe(413);
    expect(request('/blocks/game.wasm?o=0&l=1', { index: routed, range: 'bytes=0-1' }).status).toBe(400);
    expect(request('/blocks/game.wasm?o=0&l=1', { index: routed, method: 'HEAD', range: 'bytes=0-1' }))
      .toMatchObject({ status: 206, head: true, length: 1 });
  });

  test('rejects unsafe descriptors before using their path or query aliases', () => {
    for (const httpRoutes of [[{ ...route, prefix: '../' }], [{ ...route, targetPrefix: '../' }],
      [{ ...route, query: { offset: 'same', length: 'same' } }], [{ ...route, blockSize: 0 }],
      [{ ...route, headers: { Location: 'https://other.invalid' } }], [route, { ...route, prefix: 'blocks/nested/' }],
      Array(9).fill(route)]) {
      expect(() => validateAppHttpRoutes(httpRoutes)).toThrow();
      expect(request('/', { index: { ...index, httpRoutes } }).status).toBe(400);
    }
    expect(validateAppHttpRoutes(undefined)).toEqual([]);
    expect(validateAppHttpRoutes([route])).toEqual([route]);
    expect(request('/blocks/%2e%2e/game.wasm?b=0&n=1', { index: routed }).status).toBe(400);
  });
});
