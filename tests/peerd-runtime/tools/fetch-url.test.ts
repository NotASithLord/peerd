// fetch_url is the web actor's SESSIONLESS secure fetch — its non-render web
// mechanism. These tests pin the security invariants that keep the (keyless) web
// resident keyless even with an egress surface:
//   - SESSIONLESS by construction: credentials:'omit' + Cookie/Authorization stripped
//   - rides ctx.webFetch (the denylist + SSRF + audit chain), NOT a raw fetch
//   - a non-GET write is confirm-gated (shared web:write key) and FAILS CLOSED with
//     no confirm channel
//   - the response crosses the <untrusted_web_content> boundary (it's open-web data)

import { describe, test, expect } from 'bun:test';
import { fetchUrlTool } from '../../../extension/peerd-runtime/tools/defs/fetch-url.js';

const TAG_OPEN = /^<untrusted_web_content origin="[^"]*" tool="([^"]*)" retrieved_at="[^"]*">\n/;
const TAG_CLOSE = /\n<\/untrusted_web_content>$/;
const unwrap = (content: string) => {
  expect(content).toMatch(TAG_OPEN);
  expect(content).toMatch(TAG_CLOSE);
  return JSON.parse(content.replace(TAG_OPEN, '').replace(TAG_CLOSE, ''));
};
const toolOf = (content: string) => (content.match(TAG_OPEN) as RegExpMatchArray)[1];

const mockResponse = ({ status = 200, body = '', headers = {}, url = 'https://x.com/' } = {}) => ({
  status, ok: status >= 200 && status < 300,
  text: async () => body,
  headers: { get: (k: string) => (headers as any)[k.toLowerCase()], forEach: (cb: any) => Object.entries(headers).forEach(([k, v]) => cb(v, k)) },
  url,
});

// Records what webFetch was handed so the sessionless invariants are assertable.
const recordingCtx = (over: any = {}) => {
  const seen: { url?: string; init?: any } = {};
  const ctx: any = {
    session: { sessionId: 't' },
    audit: async () => {},
    webFetch: async (url: string, init: any) => { seen.url = url; seen.init = init; return mockResponse({ body: 'ok' }); },
    ...over,
  };
  return { ctx, seen };
};

describe('fetch_url — sessionless secure fetch', () => {
  test('GET wraps the response as untrusted, parses JSON, omits credentials', async () => {
    const { ctx, seen } = recordingCtx({
      webFetch: async (_u: string, init: any) => { (seen as any).init = init; return mockResponse({ body: '{"price":9}', headers: { 'content-type': 'application/json' }, url: 'https://api.shop.com/p' }); },
    });
    const r = await fetchUrlTool.execute({ url: 'https://api.shop.com/p' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(toolOf(r.content!)).toBe('fetch_url');
    const p = unwrap(r.content!);
    expect(p.status).toBe(200);
    expect(p.json.price).toBe(9);
    // The TOOL never sets credentials — the SESSION decision is the boundary's
    // (ctx.webFetch is session-scoped). So a tool can't opt a request into the session.
    expect('credentials' in (seen as any).init).toBe(false);
  });

  test('strips Cookie / Authorization / Proxy-Authorization (no laundered credential)', async () => {
    const { ctx, seen } = recordingCtx();
    await fetchUrlTool.execute({
      url: 'https://api.shop.com/p',
      headers: { Cookie: 'session=secret', authorization: 'Bearer x', 'Proxy-Authorization': 'y', 'X-Keep': 'ok' },
    }, ctx);
    const sent = seen.init.headers;
    expect(sent.Cookie).toBeUndefined();
    expect(sent.authorization).toBeUndefined();
    expect(sent['Proxy-Authorization']).toBeUndefined();
    expect(sent['X-Keep']).toBe('ok');               // non-session headers pass through
    // The real same-origin cookies come from the browser jar via the boundary, never
    // a tool-supplied header — so the tool sets no credentials of its own.
    expect('credentials' in seen.init).toBe(false);
  });

  test('a non-GET write is confirm-gated (shared web:write key); declines on "no"', async () => {
    const calls: any[] = [];
    let fetched = false;
    const { ctx } = recordingCtx({
      confirm: async (p: any) => { calls.push(p); return 'no'; },
      webFetch: async () => { fetched = true; return mockResponse({ body: 'ok' }); },
    });
    const r = await fetchUrlTool.execute({ url: 'https://evil.example/x', method: 'POST', body: { stolen: 1 } }, ctx);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('web:write');
    expect(calls[0].origins).toEqual(['https://evil.example']);
    expect(fetched).toBe(false);                     // declined → never sent
  });

  test('a non-GET write FAILS CLOSED with no confirm channel', async () => {
    let fetched = false;
    const { ctx } = recordingCtx({ confirm: undefined, webFetch: async () => { fetched = true; return mockResponse(); } });
    const r = await fetchUrlTool.execute({ url: 'https://evil.example/x', method: 'POST' }, ctx);
    expect(r.ok).toBe(false);
    expect(fetched).toBe(false);
  });

  test('a confirmed POST is sent, JSON body stringified + Content-Type set', async () => {
    const { ctx, seen } = recordingCtx({ confirm: async () => 'yes_once' });
    const r = await fetchUrlTool.execute({ url: 'https://api.shop.com/x', method: 'POST', body: { a: 1 } }, ctx);
    expect(r.ok).toBe(true);
    expect(seen.init.body).toBe('{"a":1}');
    expect(seen.init.headers['Content-Type']).toBe('application/json');
    expect('credentials' in seen.init).toBe(false);  // the boundary decides, not the tool
  });

  test('rejects a non-http(s) scheme and an invalid url before any fetch', async () => {
    let fetched = false;
    const { ctx } = recordingCtx({ webFetch: async () => { fetched = true; return mockResponse(); } });
    expect((await fetchUrlTool.execute({ url: 'file:///etc/passwd' }, ctx)).ok).toBe(false);
    expect((await fetchUrlTool.execute({ url: 'not a url' }, ctx)).ok).toBe(false);
    expect(fetched).toBe(false);
  });

  test('a blocked redirect surfaces an actionable error (fetch_url does not follow)', async () => {
    const { ctx } = recordingCtx({
      webFetch: async () => { const e: any = new Error('Egress denied'); e.reason = 'redirect_blocked'; throw e; },
    });
    const r = await fetchUrlTool.execute({ url: 'https://shop.com/p' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toMatch(/redirect/i);
  });
});
