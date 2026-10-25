import { describe, test, expect } from 'bun:test';
import { makeWebFetch } from '../../extension/peerd-egress/fetch/web-fetch.js';
import { EgressDeniedError } from '../../extension/peerd-egress/fetch/errors.js';

const setup = (over: any = {}) => {
  const audits: any[] = [];
  let fetched: string | null = null;
  const webFetch = makeWebFetch({
    getDenylist: () => over.denylist ?? ['bank.example.com'],
    matchDenylist: (host: string, patterns: readonly string[]) => patterns.includes(host),
    audit: async (e: any) => { audits.push(e); },
    fetchFn: (async (url: any) => { fetched = String(url); return new Response('ok'); }) as any,
    ...over,
  });
  return { webFetch, audits, fetched: () => fetched };
};

describe('webFetch - request policy', () => {
  test('a denylist provider failure stops the request before fetch', async () => {
    let fetchCalls = 0;
    const policyError = new Error('policy unavailable');
    const webFetch = makeWebFetch({
      getDenylist: () => { throw policyError; },
      matchDenylist: () => false,
      fetchFn: (async () => { fetchCalls += 1; return new Response('unexpected'); }) as any,
    });

    await expect(webFetch('https://example.com/')).rejects.toBe(policyError);
    expect(fetchCalls).toBe(0);
  });

  test('blocks a LAN target, audits private_network, never calls fetch', async () => {
    const { webFetch, audits, fetched } = setup();
    await expect(webFetch('https://192.168.1.1/admin')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(audits.at(-1).details.reason).toBe('private_network');
    expect(fetched()).toBeNull(); // request never went out
  });

  test('blocks the cloud metadata IP and encoded loopback', async () => {
    const { webFetch } = setup();
    await expect(webFetch('http://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(webFetch('http://2130706433/')).rejects.toBeInstanceOf(EgressDeniedError); // decimal 127.0.0.1
    await expect(webFetch('https://[::1]:8443/')).rejects.toBeInstanceOf(EgressDeniedError);
  });

  test('the private block runs BEFORE the denylist (LAN host not on the denylist still blocked)', async () => {
    const { webFetch, audits } = setup({ denylist: [] }); // empty denylist
    await expect(webFetch('https://10.0.0.5/')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(audits.at(-1).details.reason).toBe('private_network');
  });

  test('allows a public Request POST and paces its method', async () => {
    const writes: boolean[] = [];
    const { webFetch, audits } = setup({ pace: {
      reserve: async (_origin: string, opts: { isWrite: boolean }) => { writes.push(opts.isWrite); return { outcome: 'go', waitedMs: 0 }; },
      observe: async () => {}, isWriteMethod: (method: string) => method === 'POST',
      canonicalOrigin: (origin: string) => origin,
    } });
    const res = await webFetch(new Request('https://huggingface.co/model.onnx', { method: 'POST' }));
    expect(res.ok).toBe(true);
    expect(writes).toEqual([true]);
    expect(audits.at(-1).type).toBe('web_fetch');
    // denylist still works on public hosts
    await expect(webFetch('https://bank.example.com/')).rejects.toBeInstanceOf(EgressDeniedError);
  });

  test.each(['denylisted', 'unavailable'])('rechecks %s network policy after a pacing reservation', async (change) => {
    let reserved = false;
    const policyError = new Error('policy changed while waiting');
    const { webFetch, fetched } = setup({
      getDenylist: () => {
        if (reserved && change === 'unavailable') throw policyError;
        return reserved ? ['example.com'] : [];
      },
      pace: {
        reserve: async () => { reserved = true; return { outcome: 'waited', waitedMs: 1 }; },
        observe: async () => {}, isWriteMethod: () => false,
        canonicalOrigin: (origin: string) => origin,
      },
    });
    await expect(webFetch('https://example.com/')).rejects.toBeInstanceOf(
      change === 'denylisted' ? EgressDeniedError : Error,
    );
    expect(fetched()).toBeNull();
  });

  // Exercise the REAL new URL() normalization path (the unit test feeds bare
  // strings; only here does ::ffff:127.0.0.1 become the compressed ::ffff:7f00:1
  // that the old dotted-only regex missed).
  test('blocks IPv4-mapped IPv6 loopback/metadata through the URL parser', async () => {
    const { webFetch, fetched } = setup();
    await expect(webFetch('http://[::ffff:127.0.0.1]/')).rejects.toBeInstanceOf(EgressDeniedError);
    await expect(webFetch('http://[::ffff:169.254.169.254]/')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(fetched()).toBeNull();
  });
});

describe('webFetch - response policy', () => {
  test('refuses a 3xx, audits redirect_blocked, returns no response', async () => {
    const audits: any[] = [];
    const webFetch = makeWebFetch({
      getDenylist: () => [],
      matchDenylist: () => false,
      audit: async (e: any) => { audits.push(e); },
      // A real MV3 SW yields an opaqueredirect (status 0); a mock can't
      // construct one, so emulate the observable surface the guard checks.
      fetchFn: (async () => ({ type: 'opaqueredirect', status: 0, ok: false })) as any,
    });
    await expect(webFetch('https://example.com/r')).rejects.toBeInstanceOf(EgressDeniedError);
    expect(audits.at(-1).details.reason).toBe('redirect_blocked');
  });

  test('also refuses a readable 3xx status (defense in depth)', async () => {
    const webFetch = makeWebFetch({
      getDenylist: () => [],
      matchDenylist: () => false,
      audit: async () => {},
      fetchFn: (async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })) as any,
    });
    await expect(webFetch('https://example.com/r')).rejects.toBeInstanceOf(EgressDeniedError);
  });

  test('a pacing observation must finish before the fetch returns', async () => {
    const { webFetch } = setup({ pace: {
      reserve: async () => ({ outcome: 'go', waitedMs: 0 }),
      observe: async () => { throw new Error('save failed'); },
      isWriteMethod: () => false, canonicalOrigin: (origin: string) => origin,
    } });
    await expect(webFetch('https://example.com/ok')).rejects.toThrow('save failed');
  });

  test('304 Not Modified is NOT treated as a redirect', async () => {
    const webFetch = makeWebFetch({
      getDenylist: () => [],
      matchDenylist: () => false,
      audit: async () => {},
      fetchFn: (async () => new Response(null, { status: 304 })) as any,
    });
    const res = await webFetch('https://example.com/cached');
    expect(res.status).toBe(304); // passes through, not denied
  });

  test('the redirect denial carries an actionable reason', async () => {
    const webFetch = makeWebFetch({
      getDenylist: () => [],
      matchDenylist: () => false,
      audit: async () => {},
      fetchFn: (async () => new Response(null, { status: 301, headers: { location: 'https://example.com/' } })) as any,
    });
    let reason: string | null = null;
    try { await webFetch('http://example.com/'); } catch (e: any) { reason = e?.reason; }
    expect(reason).toBe('redirect_blocked');
  });

  test('the private-network denial carries reason=private_network (so fetch_url can steer to render)', async () => {
    const { webFetch } = setup();
    let reason: string | null = null;
    try { await webFetch('http://127.0.0.1:8080/p'); } catch (e: any) { reason = e?.reason; }
    expect(reason).toBe('private_network');
  });
});

describe('webFetch request attempt audit', () => {
  test.each(['network', 'abort'])('%s failure records only the destination and method, then rethrows the exact cause', async (kind) => {
    const cause = kind === 'abort' ? new DOMException('PRIVATE CAUSE', 'AbortError') : new TypeError('PRIVATE CAUSE');
    let calls = 0;
    const h = setup({ fetchFn: async () => { calls += 1; throw cause; } });
    await expect(h.webFetch('https://collector.example/upload?token=PRIVATE-QUERY', {
      method: 'POST', body: 'PRIVATE-BODY', headers: { authorization: 'PRIVATE-HEADER' },
    })).rejects.toBe(cause);
    expect(calls).toBe(1);
    expect(h.audits).toEqual([{ type: 'web_fetch', details: {
      origin: 'https://collector.example', path: '/upload', method: 'POST', outcome: 'unknown',
      error: kind === 'abort' ? 'AbortError' : 'NetworkError',
    } }]);
    expect(JSON.stringify(h.audits)).not.toContain('PRIVATE');
  });

  test('a response remains audited when pacing observation fails', async () => {
    const cause = new Error('pacing write failed');
    const h = setup({ pace: {
      reserve: async () => ({ outcome: 'go', waitedMs: 0 }), observe: async () => { throw cause; },
      isWriteMethod: () => false, canonicalOrigin: (origin: string) => origin,
    } });
    await expect(h.webFetch('https://collector.example/report')).rejects.toBe(cause);
    expect(h.audits).toEqual([{ type: 'web_fetch', details: {
      origin: 'https://collector.example', path: '/report', method: 'GET',
    } }]);
  });

  test('a pre-aborted request never enters fetch or creates an attempted-request row', async () => {
    const stop = new AbortController(); stop.abort();
    const h = setup();
    await expect(h.webFetch('https://collector.example/report', { signal: stop.signal })).rejects.toBeDefined();
    expect(h.fetched()).toBeNull();
    expect(h.audits).toEqual([]);
  });
});
