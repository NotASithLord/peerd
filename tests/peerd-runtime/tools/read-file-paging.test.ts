// js_read_file / app_read_file self-paging (design 4b, item 1 — the infinite-
// reread trap). Before this a >window file came back WHOLE, got 8k-redacted by
// the loop, and every re-read returned the identical truncation — a guaranteed
// wasted-turn loop. Now the read is bounded (offset/limit), the slice stays
// FENCED (an instance file is not reliably agent-authored), the tool-authored
// paging status rides OUTSIDE the fence, and the footer points back at the SAME
// tool with a new offset (the OPFS file IS the durable backing — no store, and
// no main-agent reader the instance actor could not reach). result.paged lets
// the loop keep the slice at the larger paged ceiling instead of re-cutting it.

import { describe, test, expect } from 'bun:test';
import { jsReadFileTool } from '../../../extension/peerd-runtime/tools/defs/js-read-file.js';
import { appReadFileTool } from '../../../extension/peerd-runtime/tools/defs/app-read-file.js';
import { SPILL_PAGE_CHARS } from '../../../extension/peerd-runtime/tools/web/spill.js';

const TAG_OPEN = /<untrusted_web_content origin="([^"]*)" tool="([^"]*)" retrieved_at="[^"]*">\n/;
const TAG_CLOSE = /\n<\/untrusted_web_content>/;
const split = (content: string) => {
  expect(content).toMatch(TAG_OPEN);
  expect(content).toMatch(TAG_CLOSE);
  const body = content.split(TAG_OPEN).pop()!.split(TAG_CLOSE)[0];
  const afterFence = content.split('</untrusted_web_content>')[1] ?? '';
  return { body, afterFence };
};

const jsCtx = (file: string) => ({
  session: { sessionId: 'chat-1' },
  notebookAuthority: { readFile: async (_path: string) => file },
});
const appCtx = (file: string) => ({
  session: { sessionId: 'chat-1' },
  appClient: { readFile: async (_opts: unknown) => file },
});

describe('js_read_file self-paging', () => {
  test('a file within one window returns whole, fenced, with NO paging footer', async () => {
    const r = await jsReadFileTool.execute({ path: 'notes.txt' }, jsCtx('x'.repeat(200)) as any);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const { body, afterFence } = split(r.content!);
    expect(body).toBe('x'.repeat(200));
    expect(afterFence).not.toContain('[paging]');
    // A bounded read is always flagged paged (its slice is ≤ SPILL_PAGE_CHARS),
    // so the loop's paged ceiling applies uniformly.
    expect((r as { paged?: boolean }).paged).toBe(true);
  });

  test('an oversized file returns a bounded head slice + a self-paging footer', async () => {
    const big = 'A'.repeat(SPILL_PAGE_CHARS + 5000);
    const r = await jsReadFileTool.execute({ path: 'big.json' }, jsCtx(big) as any);
    if (!r.ok) throw new Error('expected ok');
    const { body, afterFence } = split(r.content!);
    expect(body.length).toBe(SPILL_PAGE_CHARS);                 // capped at one page
    expect(afterFence).toContain('[paging]');
    expect(afterFence).toContain(`chars 0–${SPILL_PAGE_CHARS} of ${big.length}`);
    // the footer re-calls THIS tool at the next offset — not a separate reader
    expect(afterFence).toContain(`{"path":"big.json","offset":${SPILL_PAGE_CHARS}}`);
    expect(afterFence).not.toContain('read_run_cache');
  });

  test('offset pages the tail — a re-read continues instead of re-truncating', async () => {
    const big = 'A'.repeat(SPILL_PAGE_CHARS) + 'TAILMARK';
    const r = await jsReadFileTool.execute(
      { path: 'big.txt', offset: SPILL_PAGE_CHARS }, jsCtx(big) as any);
    if (!r.ok) throw new Error('expected ok');
    const { body, afterFence } = split(r.content!);
    expect(body).toBe('TAILMARK');
    expect(afterFence).toContain('end of stored text');         // reached the end
  });

  test('the limit is capped at one page even when asked for more', async () => {
    const big = 'A'.repeat(40_000);
    const r = await jsReadFileTool.execute({ path: 'big', limit: 999_999 }, jsCtx(big) as any);
    if (!r.ok) throw new Error('expected ok');
    expect(split(r.content!).body.length).toBe(SPILL_PAGE_CHARS);
  });

  test('a specified notebook rides into the next-call hint so paging stays targeted', async () => {
    const big = 'A'.repeat(SPILL_PAGE_CHARS + 100);
    const r = await jsReadFileTool.execute({ path: 'f', notebook: 'nb-2' }, jsCtx(big) as any);
    if (!r.ok) throw new Error('expected ok');
    expect(split(r.content!).afterFence).toContain('"notebook":"nb-2"');
  });

  test('a path with a quote stays a VALID JSON next-call hint (JSON.stringify escaping)', async () => {
    const big = 'A'.repeat(SPILL_PAGE_CHARS + 100);
    const r = await jsReadFileTool.execute({ path: 'we"ird.json' }, jsCtx(big) as any);
    if (!r.ok) throw new Error('expected ok');
    // A raw interpolation would emit `"path": "we"ird.json"` — unparseable. The
    // hint must round-trip through JSON.parse.
    const hint = split(r.content!).afterFence.match(/next: (\{.*\})\./)![1];
    expect(JSON.parse(hint)).toMatchObject({ path: 'we"ird.json', offset: SPILL_PAGE_CHARS });
  });

  test('the slice is fenced under the file\'s origin (untrusted instance bytes)', async () => {
    const r = await jsReadFileTool.execute({ path: 'data.json' }, jsCtx('x'.repeat(10)) as any);
    if (!r.ok) throw new Error('expected ok');
    expect(r.content).toContain('notebook:current/data.json');
  });

  test('fails closed on a missing path or absent capability', async () => {
    expect((await jsReadFileTool.execute({}, jsCtx('x') as any)).ok).toBe(false);
    const noCap = await jsReadFileTool.execute({ path: 'f' }, { session: { sessionId: 'c' } } as any);
    expect(noCap.ok).toBe(false);
    if (!noCap.ok) expect(noCap.error).toBe('js_not_available');
  });
});

describe('app_read_file self-paging', () => {
  test('finds exact anchors and offsets inside a large generated file', async () => {
    const text = `${'x'.repeat(SPILL_PAGE_CHARS + 10)}function handleLobbyPacket(message) {}`;
    const r = await appReadFileTool.execute(
      { path: 'bundle.js', query: 'function handleLobbyPacket' }, appCtx(text) as any);
    if (!r.ok) throw new Error('expected ok');
    expect(r.content).toContain(`"offset": ${SPILL_PAGE_CHARS + 10}`);
    expect(r.content).toContain('function handleLobbyPacket(message)');
  });

  test('an oversized file returns a bounded slice + a footer re-calling THIS tool', async () => {
    const big = 'B'.repeat(SPILL_PAGE_CHARS + 2000);
    const r = await appReadFileTool.execute({ path: 'index.html', appId: 'app-9' }, appCtx(big) as any);
    if (!r.ok) throw new Error('expected ok');
    const { body, afterFence } = split(r.content!);
    expect(body.length).toBe(SPILL_PAGE_CHARS);
    expect(afterFence).toContain('[paging]');
    expect(afterFence).toContain(`{"appId":"app-9","path":"index.html","offset":${SPILL_PAGE_CHARS}}`);
    expect((r as { paged?: boolean }).paged).toBe(true);
  });

  test('offset pages the tail to completion', async () => {
    const big = 'B'.repeat(SPILL_PAGE_CHARS) + 'END';
    const r = await appReadFileTool.execute(
      { path: 'a.txt', offset: SPILL_PAGE_CHARS }, appCtx(big) as any);
    if (!r.ok) throw new Error('expected ok');
    const { body, afterFence } = split(r.content!);
    expect(body).toBe('END');
    expect(afterFence).toContain('end of stored text');
  });

  test('fails closed on a missing path or absent capability', async () => {
    expect((await appReadFileTool.execute({}, appCtx('x') as any)).ok).toBe(false);
    const noCap = await appReadFileTool.execute({ path: 'f' }, { session: { sessionId: 'c' } } as any);
    expect(noCap.ok).toBe(false);
    if (!noCap.ok) expect(noCap.error).toBe('app_not_available');
  });
});
