// read_page mode:'content' — the rendered DOM's readable core as markdown,
// via the same offscreen extractor + spill-and-page fetch_url uses. The
// invariants: content mode is FAIL-OPEN (non-readerable page, missing
// extractor, extraction error, script failure all fall through to the default
// snapshot), overflow spills with a paging footer OUTSIDE the fence, and the
// default snapshot mode is untouched.

import { describe, test, expect } from 'bun:test';
import { readPageTool } from '../../../extension/peerd-runtime/tools/defs/read-page.js';

const fencedBody = (content: string) =>
  JSON.parse(content.split(/<untrusted_web_content [^>]*>\n/)[1].split('\n</untrusted_web_content>')[0]);

// A ctx whose injected scripts return canned results: the content grabber
// (detected by function name) gets HTML; the snapshot function gets a snapshot.
const ctxWith = (over: any = {}) => ({
  activeTab: { id: 7, url: 'https://site.example/article', origin: 'https://site.example' },
  tabs: { get: async (id: number) => ({ id, url: 'https://site.example/article' }) },
  scripting: {
    executeScript: async ({ func }: any) => {
      if (String(func.name) === 'readOuterHtmlInjected') {
        return [{ result: { html: '<html><body><article>rendered body</article></body></html>', url: 'https://site.example/article', title: 'T' } }];
      }
      return [{ result: { title: 'T', url: 'https://site.example/article', text: 'snapshot text', interactables: [] } }];
    },
  },
  ...over,
});

describe('read_page mode:content', () => {
  test('extracts the rendered DOM to markdown via the offscreen client', async () => {
    let sawHtml = '';
    const ctx = ctxWith({
      webOffscreenClient: {
        extractMarkdown: async ({ html, url }: any) => {
          sawHtml = html;
          expect(url).toBe('https://site.example/article');
          return { readerable: true, markdown: '# T\n\nrendered body as markdown', title: 'T' };
        },
      },
    });
    const r = await readPageTool.execute({ mode: 'content' }, ctx as any);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(sawHtml).toContain('rendered body');
    const body = fencedBody(r.content!);
    expect(body.mode).toBe('content');
    expect(body.format).toBe('markdown');
    expect(body.body).toContain('rendered body as markdown');
  });

  test('overflow spills to the cache with the paging footer OUTSIDE the fence', async () => {
    const stored: any[] = [];
    const big = 'M'.repeat(40_000);
    const ctx = ctxWith({
      webOffscreenClient: { extractMarkdown: async () => ({ readerable: true, markdown: big, title: 'Big' }) },
      webCache: { key: () => 'wc-rp-1', put: async (rec: any) => { stored.push(rec); } },
    });
    const r = await readPageTool.execute({ mode: 'content' }, ctx as any);
    if (!r.ok) throw new Error('expected ok');
    expect(stored).toHaveLength(1);
    expect(stored[0].text.length).toBe(40_000);
    const afterFence = r.content!.split('</untrusted_web_content>')[1];
    expect(afterFence).toContain('read_web_cache');
    expect(afterFence).toContain('"key": "wc-rp-1"');
    expect(fencedBody(r.content!).truncated).toBe(true);
  });

  test('fail-open: non-readerable, extractor error, and missing client all yield the SNAPSHOT', async () => {
    for (const client of [
      { extractMarkdown: async () => ({ readerable: false }) },
      { extractMarkdown: async () => { throw new Error('boom'); } },
      undefined,
    ]) {
      const r = await readPageTool.execute({ mode: 'content' }, ctxWith({ webOffscreenClient: client }) as any);
      if (!r.ok) throw new Error('expected ok');
      expect(r.content).toContain('snapshot text');   // the default path's body
    }
  });

  test('the default mode is untouched (no extractor call)', async () => {
    let called = false;
    const ctx = ctxWith({ webOffscreenClient: { extractMarkdown: async () => { called = true; return { readerable: true, markdown: 'x' }; } } });
    const r = await readPageTool.execute({}, ctx as any);
    if (!r.ok) throw new Error('expected ok');
    expect(called).toBe(false);
    expect(r.content).toContain('snapshot text');
  });
});
