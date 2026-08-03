// read_web_cache — the paging read side of fetch_url's spill. The invariants:
// the slice comes back FENCED (it is fetched page content), the paging status
// is tool-authored and rides OUTSIDE the fence, bounds are clamped, and a
// missing capability / evicted key fails closed with an actionable error.

import { describe, test, expect } from 'bun:test';
import { readWebCacheTool } from '../../../extension/peerd-runtime/tools/defs/read-web-cache.js';

const TAG_OPEN = /<untrusted_web_content origin="[^"]*" tool="([^"]*)" retrieved_at="[^"]*">\n/;
const TAG_CLOSE = /\n<\/untrusted_web_content>/;
const unwrap = (content: string) => {
  expect(content).toMatch(TAG_OPEN);
  expect(content).toMatch(TAG_CLOSE);
  const inner = content.split(TAG_OPEN).pop()!.split(TAG_CLOSE)[0];
  return JSON.parse(inner);
};

const ctxWith = (records: Record<string, any>) => ({
  webCache: { get: async (key: string) => records[key] },
});

describe('read_web_cache', () => {
  const REC = { key: 'wc-1', url: 'https://site.example/article', format: 'markdown', text: 'x'.repeat(100) };

  test('slices the stored text, fenced, with the paging status OUTSIDE the fence', async () => {
    const r = await readWebCacheTool.execute({ key: 'wc-1', offset: 10, limit: 20 }, ctxWith({ 'wc-1': REC }) as any);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const body = unwrap(r.content!);
    expect(body.body).toBe('x'.repeat(20));
    expect(body).toMatchObject({ key: 'wc-1', offset: 10, end: 30, total: 100, format: 'markdown' });
    // The tool-authored status is AFTER the close tag — outside the fence.
    const afterFence = r.content!.split('</untrusted_web_content>')[1];
    expect(afterFence).toContain('[paging]');
    expect(afterFence).toContain('"offset": 30');   // the next-call hint continues where this slice ended
    // paged: redacted at the larger paged ceiling so the requested slice survives.
    expect((r as { paged?: boolean }).paged).toBe(true);
  });

  test('the final slice says end-of-text instead of a next-call hint', async () => {
    const r = await readWebCacheTool.execute({ key: 'wc-1', offset: 90, limit: 50 }, ctxWith({ 'wc-1': REC }) as any);
    if (!r.ok) throw new Error('expected ok');
    const afterFence = r.content!.split('</untrusted_web_content>')[1];
    expect(afterFence).toContain('end of stored text');
    expect(afterFence).not.toContain('next:');
  });

  test('caps the limit at 16k even when asked for more', async () => {
    const big = { key: 'wc-2', text: 'y'.repeat(40_000) };
    const r = await readWebCacheTool.execute({ key: 'wc-2', limit: 999_999 }, ctxWith({ 'wc-2': big }) as any);
    if (!r.ok) throw new Error('expected ok');
    expect(unwrap(r.content!).body.length).toBe(16_000);
  });

  test('fails closed: missing key, evicted entry, absent capability', async () => {
    expect((await readWebCacheTool.execute({}, ctxWith({}) as any)).ok).toBe(false);
    const gone = await readWebCacheTool.execute({ key: 'wc-gone' }, ctxWith({}) as any);
    expect(gone.ok).toBe(false);
    // the recovery hint is source-aware now (a read_page spill must NOT be told
    // to fetch_url the rendered page it came from) — it says "re-run the read".
    if (!gone.ok) expect(gone.error).toContain('re-run the read');
    const noCap = await readWebCacheTool.execute({ key: 'wc-1' }, {} as any);
    expect(noCap.ok).toBe(false);
    if (!noCap.ok) expect(noCap.error).toBe('web_cache_unavailable');
  });
});
