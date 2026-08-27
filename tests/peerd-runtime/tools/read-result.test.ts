import { describe, expect, test } from 'bun:test';
import { readResultTool } from '../../../extension/peerd-runtime/tools/defs/read-result.js';
import { PAGED_MAX_CHARS, redactToolResult } from '../../../extension/peerd-runtime/loop/redact.js';

const TAG_OPEN = /<untrusted_web_content origin="[^"]*" tool="([^"]*)" retrieved_at="[^"]*">\n/;
const TAG_CLOSE = /\n<\/untrusted_web_content>/;
const unwrap = (content: string) => {
  expect(content).toMatch(TAG_OPEN);
  expect(content).toMatch(TAG_CLOSE);
  return JSON.parse(content.split(TAG_OPEN).pop()!.split(TAG_CLOSE)[0]);
};

const record = (overrides: Record<string, unknown> = {}) => ({
  key: 'result:opaque-1',
  ownerSessionId: 'chat-1',
  producer: 'fetch_url',
  fenced: true,
  originLabel: 'https://site.example',
  url: 'https://site.example/article',
  format: 'markdown',
  text: 'x'.repeat(100),
  ...overrides,
});

const context = (records: Record<string, any>, sessionId = 'chat-1') => ({
  resourceAuthority: {
    readResult: async (key: string) => {
      const found = records[key];
      if (found && found.ownerSessionId !== sessionId) {
        return { ok: false, error: `not_your_result: ${key} was spilled by another session.` };
      }
      return { ok: true, record: found };
    },
  },
});

describe('read_result', () => {
  test('pages fenced web results with provenance and trusted status outside the fence', async () => {
    const result = await readResultTool.execute(
      { key: 'result:opaque-1', offset: 10, limit: 20 },
      context({ 'result:opaque-1': record() }) as any,
    );
    if (!result.ok) throw new Error('expected ok');
    const body = unwrap(result.content!);
    expect(body).toMatchObject({
      key: 'result:opaque-1',
      producer: 'fetch_url',
      origin: 'https://site.example',
      url: 'https://site.example/article',
      format: 'markdown',
      offset: 10,
      end: 30,
      total: 100,
      body: 'x'.repeat(20),
    });
    expect(result.content!.split('</untrusted_web_content>')[1]).toContain('"offset": 30');
    expect((result as { paged?: boolean }).paged).toBe(true);
  });

  test('returns trusted pure-compute results without a fence', async () => {
    const trusted = record({ producer: 'script', fenced: false, originLabel: 'script' });
    const result = await readResultTool.execute(
      { key: 'result:opaque-1' },
      context({ 'result:opaque-1': trusted }) as any,
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.content).not.toContain('<untrusted_web_content');
    expect(result.content).toContain('"producer": "script"');
  });

  test('refuses cross-session, sessionless, missing, and absent-store reads', async () => {
    const records = { 'result:opaque-1': record() };
    const foreign = await readResultTool.execute(
      { key: 'result:opaque-1' },
      context(records, 'chat-2') as any,
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error).toContain('not_your_result');
    expect(JSON.stringify(foreign)).not.toContain('x'.repeat(20));

    expect((await readResultTool.execute(
      { key: 'result:opaque-1' },
      { resourceAuthority: { readResult: async () => ({ ok: false, error: 'not_your_result' }) } } as any,
    )).ok).toBe(false);
    expect((await readResultTool.execute(
      { key: 'result:missing' },
      context({}) as any,
    )).ok).toBe(false);
    expect((await readResultTool.execute(
      { key: 'result:opaque-1' },
      {} as any,
    )).ok).toBe(false);
  });

  test('caps and frames quote-dense pages within the paged ceiling', async () => {
    const unit = `${JSON.stringify({ a: 'x"y\\z"w', n: 1 })}\n`;
    let text = '';
    while (text.length < 60_000) text += unit;
    const result = await readResultTool.execute(
      { key: 'result:dense', limit: 999_999 },
      context({ 'result:dense': record({ key: 'result:dense', text }) }) as any,
    );
    if (!result.ok) throw new Error('expected ok');
    expect(result.content!.length).toBeLessThanOrEqual(PAGED_MAX_CHARS);
    expect(redactToolResult(result.content!, { maxChars: PAGED_MAX_CHARS })).toBe(result.content);
    expect(result.content).not.toContain('chars elided');
    expect(unwrap(result.content!).body.length).toBeLessThanOrEqual(16_000);
  });

  test('the final slice has no next-call hint', async () => {
    const result = await readResultTool.execute(
      { key: 'result:opaque-1', offset: 90, limit: 50 },
      context({ 'result:opaque-1': record() }) as any,
    );
    if (!result.ok) throw new Error('expected ok');
    const status = result.content!.split('</untrusted_web_content>')[1];
    expect(status).toContain('end of stored text');
    expect(status).not.toContain('next:');
  });
});
