// The post-fetch `extract` step for code mode's bridged fetch (design 02, 2a).
// Pure decide/decode/reshape with the extraction pipeline injected — shared by
// both bridge hosts (offscreen job runner, SW sw/web-fetch route), so its
// semantics are pinned here once: no-flag passthrough is byte-for-byte, every
// degraded case fails OPEN (extracted:false, body unchanged), and a successful
// extraction rewrites body + content-type together.

import { describe, test, expect } from 'bun:test';
import { applyFetchExtract } from '../../extension/shared/fetch-extract.js';

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const fromB64 = (s: string) => decodeURIComponent(escape(atob(s)));

const htmlResp = (over: any = {}) => ({
  ok: true, status: 200, statusText: 'OK',
  headers: { 'content-type': 'text/html; charset=utf-8', etag: '"abc"' },
  bodyB64: b64('<html><body><article>Hello</article></body></html>'),
  ...over,
});

const extractor = async ({ html }: { html: string; url?: string }) => ({
  readerable: true, markdown: `# Extracted\n\n${html.length} chars`, title: 'T',
});

describe('applyFetchExtract', () => {
  test('no extract flag — or an unknown mode — → the exact same response object (byte-for-byte raw path)', async () => {
    const resp = htmlResp();
    const out = await applyFetchExtract(resp, { extract: undefined, url: 'https://x', extractMarkdown: extractor });
    expect(out).toBe(resp);   // not even a copy — the raw path is untouched
    expect((out as any).extracted).toBeUndefined();
    // Only 'markdown' is a mode: a future value must never change bytes on a
    // build that doesn't know it (v1 ships markdown only; 'text' included).
    for (const mode of ['text', 'MARKDOWN', 1]) {
      expect(await applyFetchExtract(resp, { extract: mode, url: 'https://x', extractMarkdown: extractor })).toBe(resp);
    }
  });

  test('HTML + markdown extraction → markdown body, content-type rewritten, extracted:true', async () => {
    let seen: any = null;
    const out: any = await applyFetchExtract(htmlResp(), {
      extract: 'markdown', url: 'https://site.example/post',
      extractMarkdown: async (s) => { seen = s; return extractor(s); },
    });
    expect(out.extracted).toBe(true);
    expect(fromB64(out.bodyB64)).toStartWith('# Extracted');
    expect(out.headers['content-type']).toBe('text/markdown');
    expect(out.headers.etag).toBe('"abc"');        // other headers survive
    expect(out.status).toBe(200);
    expect(seen.url).toBe('https://site.example/post');   // base for relative links
    expect(seen.html).toContain('<article>');
  });

  test('non-HTML content with extract set → body unchanged, extracted:false (mixed-URL fan-outs must not throw)', async () => {
    const resp = htmlResp({ headers: { 'content-type': 'application/json' }, bodyB64: b64('{"a":1}') });
    const out: any = await applyFetchExtract(resp, { extract: 'markdown', url: 'https://x', extractMarkdown: extractor });
    expect(out.extracted).toBe(false);
    expect(out.bodyB64).toBe(resp.bodyB64);
    expect(out.headers['content-type']).toBe('application/json');
  });

  test('non-article page (readerable:false) → passthrough, extracted:false', async () => {
    const out: any = await applyFetchExtract(htmlResp(), {
      extract: 'markdown', url: 'https://x',
      extractMarkdown: async () => ({ readerable: false }),
    });
    expect(out.extracted).toBe(false);
    expect(fromB64(out.bodyB64)).toContain('<article>');
  });

  test('extraction throwing → passthrough, extracted:false (fail-open, the fetch_url posture)', async () => {
    const out: any = await applyFetchExtract(htmlResp(), {
      extract: 'markdown', url: 'https://x',
      extractMarkdown: async () => { throw new Error('offscreen died'); },
    });
    expect(out.extracted).toBe(false);
    expect(fromB64(out.bodyB64)).toContain('<article>');
  });

  test('no extractor (Firefox: no offscreen doc) → passthrough, extracted:false', async () => {
    const out: any = await applyFetchExtract(htmlResp(), { extract: 'markdown', url: 'https://x', extractMarkdown: null });
    expect(out.extracted).toBe(false);
    expect(fromB64(out.bodyB64)).toContain('<article>');
  });

  test('failed fetch or empty body → passthrough, never calls the extractor', async () => {
    let called = false;
    const spy = async (s: { html: string }) => { called = true; return extractor(s); };
    const failed: any = await applyFetchExtract(htmlResp({ ok: false, status: 500 }), { extract: 'markdown', url: 'https://x', extractMarkdown: spy });
    expect(failed.extracted).toBe(false);
    const empty: any = await applyFetchExtract(htmlResp({ bodyB64: null }), { extract: 'markdown', url: 'https://x', extractMarkdown: spy });
    expect(empty.extracted).toBe(false);
    expect(called).toBe(false);
  });

  test('a Content-Type header in any casing is recognized and rewritten without duplication', async () => {
    const resp = htmlResp({ headers: { 'Content-Type': 'text/html' } });
    const out: any = await applyFetchExtract(resp, { extract: 'markdown', url: 'https://x', extractMarkdown: extractor });
    expect(out.extracted).toBe(true);
    expect(Object.keys(out.headers)).toEqual(['content-type']);
    expect(out.headers['content-type']).toBe('text/markdown');
  });

  test('a whitespace-only markdown result is treated as a miss (raw fallback)', async () => {
    const out: any = await applyFetchExtract(htmlResp(), {
      extract: 'markdown', url: 'https://x',
      extractMarkdown: async () => ({ readerable: true, markdown: '   \n ' }),
    });
    expect(out.extracted).toBe(false);
    expect(fromB64(out.bodyB64)).toContain('<article>');
  });
});
