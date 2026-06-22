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

describe('webFetch — private-network SSRF block', () => {
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

  test('allows a public host (and still audits + denylists)', async () => {
    const { webFetch, audits, fetched } = setup();
    const res = await webFetch('https://huggingface.co/model.onnx');
    expect(res.ok).toBe(true);
    expect(fetched()).toBe('https://huggingface.co/model.onnx');
    expect(audits.at(-1).type).toBe('web_fetch');
    // denylist still works on public hosts
    await expect(webFetch('https://bank.example.com/')).rejects.toBeInstanceOf(EgressDeniedError);
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

describe('webFetch — redirects fail closed', () => {
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

  test('a normal 200 passes straight through', async () => {
    const webFetch = makeWebFetch({
      getDenylist: () => [],
      matchDenylist: () => false,
      audit: async () => {},
      fetchFn: (async () => new Response('ok', { status: 200 })) as any,
    });
    const res = await webFetch('https://example.com/ok');
    expect(res.status).toBe(200);
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
});
