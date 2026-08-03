// read_run_cache — the paging read side of script's value spill. Invariants:
// OWNERSHIP is refused on any session mismatch (a spilled value is pageable
// only by the session whose run produced it); fencing is CONDITIONAL on the
// record's STORED flag (an egress/actors/workspace run's value re-enters
// wrapped under the run's own origin label, a pure-compute value re-enters
// raw); the paging status is tool-authored and rides OUTSIDE any fence;
// bounds are clamped; missing capability / evicted key fail closed.

import { describe, test, expect } from 'bun:test';
import { readRunCacheTool } from '../../../extension/peerd-runtime/tools/defs/read-run-cache.js';

const TAG_OPEN = /<untrusted_web_content origin="[^"]*" tool="([^"]*)" retrieved_at="[^"]*">\n/;
const TAG_CLOSE = /\n<\/untrusted_web_content>/;
const unwrap = (content: string) => {
  expect(content).toMatch(TAG_OPEN);
  expect(content).toMatch(TAG_CLOSE);
  const inner = content.split(TAG_OPEN).pop()!.split(TAG_CLOSE)[0];
  return JSON.parse(inner);
};

const ctxWith = (records: Record<string, any>, sessionId = 'chat-1') => ({
  session: { sessionId },
  runCache: { get: async (key: string) => records[key] },
});

const REC = {
  key: 'run:tu-1', ownerSessionId: 'chat-1', fenced: true,
  originLabel: 'script (workspace files)', text: 'x'.repeat(100),
};

describe('read_run_cache', () => {
  test('a FENCED record\'s slice re-enters wrapped under the run\'s own origin label, status outside', async () => {
    const r = await readRunCacheTool.execute({ key: 'run:tu-1', offset: 10, limit: 20 }, ctxWith({ 'run:tu-1': REC }) as any);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.content).toContain('origin="script (workspace files)"');
    const body = unwrap(r.content!);
    expect(body.value).toBe('x'.repeat(20));
    expect(body).toMatchObject({ key: 'run:tu-1', offset: 10, end: 30, total: 100 });
    const afterFence = r.content!.split('</untrusted_web_content>')[1];
    expect(afterFence).toContain('[paging]');
    expect(afterFence).toContain('"offset": 30');   // the next-call hint continues where this slice ended
    // paged: the loop redacts the slice at the larger paged ceiling, not the 8k
    // backstop, so the page the model asked for survives intact.
    expect((r as { paged?: boolean }).paged).toBe(true);
  });

  test('an UNFENCED record (pure-compute run) re-enters raw — the agent\'s own bytes', async () => {
    const rec = { ...REC, key: 'run:tu-2', fenced: false, originLabel: 'script' };
    const r = await readRunCacheTool.execute({ key: 'run:tu-2' }, ctxWith({ 'run:tu-2': rec }) as any);
    if (!r.ok) throw new Error('expected ok');
    expect(r.content).not.toContain('<untrusted_web_content');
    expect(r.content).toContain('"value": "' + 'x'.repeat(100));
    expect(r.content).toContain('[paging]');
  });

  test('OWNERSHIP: another session\'s key is refused (and a session-less ctx fails closed)', async () => {
    const other = await readRunCacheTool.execute({ key: 'run:tu-1' }, ctxWith({ 'run:tu-1': REC }, 'chat-2') as any);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error).toContain('not_your_key');
    const noSession = await readRunCacheTool.execute(
      { key: 'run:tu-1' },
      { runCache: { get: async () => REC } } as any,
    );
    expect(noSession.ok).toBe(false);
  });

  test('caps the limit at 16k even when asked for more', async () => {
    const big = { ...REC, key: 'run:big', text: 'y'.repeat(40_000) };
    const r = await readRunCacheTool.execute({ key: 'run:big', limit: 999_999 }, ctxWith({ 'run:big': big }) as any);
    if (!r.ok) throw new Error('expected ok');
    expect(unwrap(r.content!).value.length).toBe(16_000);
  });

  test('the final slice says end-of-text instead of a next-call hint', async () => {
    const r = await readRunCacheTool.execute({ key: 'run:tu-1', offset: 90, limit: 50 }, ctxWith({ 'run:tu-1': REC }) as any);
    if (!r.ok) throw new Error('expected ok');
    const afterFence = r.content!.split('</untrusted_web_content>')[1];
    expect(afterFence).toContain('end of stored text');
    expect(afterFence).not.toContain('next:');
  });

  test('fails closed: missing key, evicted entry, absent capability', async () => {
    expect((await readRunCacheTool.execute({}, ctxWith({}) as any)).ok).toBe(false);
    const gone = await readRunCacheTool.execute({ key: 'run:gone' }, ctxWith({}) as any);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error).toContain('re-run the script');
    const noCap = await readRunCacheTool.execute({ key: 'run:tu-1' }, { session: { sessionId: 'chat-1' } } as any);
    expect(noCap.ok).toBe(false);
    if (!noCap.ok) expect(noCap.error).toBe('run_cache_unavailable');
  });
});
