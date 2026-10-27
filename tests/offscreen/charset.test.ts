import { describe, expect, test } from 'bun:test';
import { readBoundedResponseText } from '../../extension/shared/abort.js';
import { applyFetchExtract } from '../../extension/shared/fetch-extract.js';

const cp1251 = (s: string) => Uint8Array.from([...s].map((ch) => {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x80) return cp;
  if (cp >= 0x410 && cp <= 0x44f) return 0xc0 + (cp - 0x410);
  return 0x3f;
}));
const latin1 = (s: string) => Uint8Array.from([...s].map((ch) => ch.codePointAt(0)! & 0xff));
const sjisNews = Uint8Array.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x82, 0xcc, 0x83, 0x6a, 0x83, 0x85, 0x81, 0x5b, 0x83, 0x58]);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const res = (chunks: Uint8Array[], contentType: string | null) => new Response(new ReadableStream({
  start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); },
}), { headers: contentType ? { 'content-type': contentType } : {} });
const enc = new TextEncoder();

describe('charset-aware bounded text', () => {
  test('header charset windows-1251', async () => {
    const { text } = await readBoundedResponseText(res([cp1251('<p>Сегодня в Москве</p>')], 'text/html; charset=windows-1251'), 1000);
    expect(text).toBe('<p>Сегодня в Москве</p>');
  });
  test('quoted, upper-case header label', async () => {
    const { text } = await readBoundedResponseText(res([cp1251('Москва')], 'text/plain; charset="WINDOWS-1251"'), 1000);
    expect(text).toBe('Москва');
  });
  test('header charset latin-1', async () => {
    const { text } = await readBoundedResponseText(res([latin1('<p>Café déjà</p>')], 'text/html; charset=iso-8859-1'), 1000);
    expect(text).toContain('Café déjà');
  });
  test('header Shift_JIS keeps a multibyte character split across chunks', async () => {
    const head = enc.encode('<h1>');
    const body = cat(head, sjisNews, enc.encode('</h1>'));
    const cut = head.length + 3; // inside a 2-byte sequence
    const { text } = await readBoundedResponseText(res([body.slice(0, cut), body.slice(cut)], 'text/html; charset=Shift_JIS'), 1000);
    expect(text).toContain('<h1>日本語のニュース</h1>');
  });
  test('UTF-8 pages unchanged (header, meta, none)', async () => {
    const s = '<meta charset="utf-8"><p>Привет - 日本 ✓</p>';
    for (const ct of ['text/html; charset=utf-8', 'text/html', null, 'application/json']) {
      const { text } = await readBoundedResponseText(res([enc.encode(s)], ct), 1000);
      expect(text).toBe(s);
    }
  });
  test('UTF-8 BOM wins over a wrong header label', async () => {
    const { text } = await readBoundedResponseText(res([cat(Uint8Array.from([0xef, 0xbb, 0xbf]), enc.encode('Привет'))], 'text/html; charset=windows-1251'), 1000);
    expect(text).toBe('Привет');
  });
  test('unknown / replacement labels fall back to UTF-8', async () => {
    for (const label of ['bogus', 'iso-2022-kr', 'utf-7']) {
      const { text } = await readBoundedResponseText(res([enc.encode('Привет')], `text/html; charset=${label}`), 1000);
      expect(text).toBe('Привет');
    }
  });
  test('markup does not select a text decoder', async () => {
    for (const source of [
      '<!-- <meta charset=windows-1252> --><meta charset=utf-8><p>café</p>',
      '<div title="<meta charset=windows-1252>"></div><p>café</p>',
      '<meta charset=utf-8 title="charset=windows-1252"><p>café</p>',
      '<meta data-charset=windows-1252><p>café</p>',
      '<meta name=description content="charset=windows-1252"><p>café</p>',
    ]) {
      const bytes = enc.encode(source);
      expect((await readBoundedResponseText(res([bytes], 'text/html'), 1000)).text).toBe(source);
      const extracted = await applyFetchExtract({ ok: true, headers: { 'content-type': 'text/html' }, bodyB64: Buffer.from(bytes).toString('base64') }, {
        extract: 'markdown', extractMarkdown: async ({ html }) => ({ readerable: true, markdown: html }),
      });
      expect(Buffer.from(extracted?.bodyB64 ?? '', 'base64').toString()).toBe(source);
    }
  });
  test('only a charset parameter selects the HTTP encoding', async () => {
    for (const contentType of [
      'text/html; x-charset=windows-1252; charset=utf-8',
      'text/html; profile="charset=windows-1252"; charset=utf-8',
      'text/html; profile="x; charset=windows-1252"; charset=utf-8',
      'text/html; profile="x\\\"; charset=windows-1252"; charset=utf-8',
      'text/html; profile="x; charset=windows-1252; trailing=\\',
      'text/html; charset=utf-8; charset=windows-1252',
    ]) {
      expect((await readBoundedResponseText(res([enc.encode('café')], contentType), 1000)).text).toBe('café');
    }
    expect((await readBoundedResponseText(res([latin1('café')], 'text/html; charset = "WINDOWS-1252"'), 1000)).text).toBe('café');
  });
  test('both extraction paths use the same declared encoding and keep raw bytes', async () => {
    const bytes = cp1251('<p>Москва</p>');
    const source = { ok: true, headers: { 'Content-Type': 'text/html; charset=windows-1251' }, bodyB64: Buffer.from(bytes).toString('base64') };
    const raw = await applyFetchExtract(source, { extract: undefined, extractMarkdown: null });
    expect(raw).toBe(source);
    const result = await applyFetchExtract(source, { extract: 'markdown', extractMarkdown: async ({ html }) => ({ readerable: true, markdown: html }) });
    expect(result?.extracted).toBe(true);
    expect(Buffer.from(result?.bodyB64 ?? '', 'base64').toString()).toBe('<p>Москва</p>');
    const json = '<meta charset=windows-1251>Москва';
    expect((await readBoundedResponseText(res([enc.encode(json)], 'application/json'), 1000)).text).toBe(json);
  });
  test('UTF-16 byte marks win over a wrong header', async () => {
    for (const bytes of [Uint8Array.from([0xff, 0xfe, 0x43, 0x04]), Uint8Array.from([0xfe, 0xff, 0x04, 0x43])]) {
      expect((await readBoundedResponseText(res([bytes], 'text/plain; charset=windows-1251'), 10)).text).toBe('у');
    }
  });
  test('split byte order marks win before the decoder starts', async () => {
    for (const bytes of [
      cat(Uint8Array.of(0xef, 0xbb, 0xbf), enc.encode('café')),
      Uint8Array.of(0xff, 0xfe, 0x63, 0, 0x61, 0, 0x66, 0, 0xe9, 0),
      Uint8Array.of(0xfe, 0xff, 0, 0x63, 0, 0x61, 0, 0x66, 0, 0xe9),
    ]) {
      for (const chunks of [[bytes.slice(0, 1), bytes.slice(1)], [bytes.slice(0, 2), bytes.slice(2)], [new Uint8Array(), bytes], [...bytes].map((byte) => Uint8Array.of(byte))]) {
        for (const limit of [0, 1, 3, 4, 5]) {
          const result = await readBoundedResponseText(res(chunks, 'text/plain; charset=windows-1252'), limit);
          expect(result).toEqual({ text: 'café'.slice(0, limit), truncated: limit < 4 });
        }
      }
    }
  });
  test('a zero text cap cancels an ASCII stream before its stalled tail', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { if (++pulls === 1) controller.enqueue(Uint8Array.of(0x61)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      expect(await readBoundedResponseText(new Response(stream), 0, { signal: controller.signal })).toEqual({ text: '', truncated: true });
      expect(pulls).toBe(1);
      expect(cancelled).toBe(true);
    } finally { clearTimeout(timer); }
  });
  test('truncation still counts decoded code units', async () => {
    const r = await readBoundedResponseText(res([cp1251('Москва'), cp1251('Москва')], 'text/plain; charset=windows-1251'), 8);
    expect(r).toEqual({ text: 'МоскваМо', truncated: true });
  });
});
