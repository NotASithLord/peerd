import { describe, expect, test } from 'bun:test';
import { readDocTool } from '../../../extension/peerd-runtime/tools/defs/read-doc.js';
import { readResultTool } from '../../../extension/peerd-runtime/tools/defs/read-result.js';
import { isPrivateOrLocalHost } from '../../../extension/shared/private-network.js';
import { MAX_SPILL_TEXT_CHARS } from '../../../extension/peerd-runtime/tools/result-store-policy.js';

const pdfResult = {
  format: 'pdf',
  bytes: 128,
  sniffedVia: 'magic',
  pdf: {
    engine: 'pdfjs',
    pages: [{ page: 1, text: 'Quarterly result' }],
    pageCount: 1,
    info: { title: 'Report', author: 'Peerd' },
    scanned: false,
    ocrUsed: false,
    ocrAvailable: true,
  },
};

const docContext = (context: any): any => ({
  resourceAuthority: {
    extractDocument: async (request: any) => {
      const target = request.url ?? context.activeTab?.url;
      if (!target) return { ok: false, error: 'no_target_tab' };
      if (isPrivateOrLocalHost(new URL(target).hostname)) {
        return { ok: false, error: 'private_or_local_target_blocked' };
      }
      if (!context.docOffscreenClient?.extract) {
        return { ok: false, error: 'doc_reader_unavailable' };
      }
      const result = await context.docOffscreenClient.extract(
        { url: target }, { format: request.format, engine: request.engine },
      );
      return { ok: true, target, result };
    },
    ...(context.spillResult ? { spillResult: context.spillResult } : {}),
  },
});

describe('read_doc as the one public document reader', () => {
  test('formats sniffed PDF output with page metadata and the read_doc fence', async () => {
    const calls: any[] = [];
    const result = await readDocTool.execute({
      url: 'https://docs.example/report.bin', engine: 'pdfjs',
    }, docContext({
      denylist: [],
      docOffscreenClient: {
        extract: async (...args: any[]) => { calls.push(args); return pdfResult; },
      },
    }));

    expect(result.ok).toBe(true);
    expect(calls).toEqual([[
      { url: 'https://docs.example/report.bin' },
      { format: undefined, engine: 'pdfjs' },
    ]]);
    expect(result.content).toContain('tool="read_doc"');
    expect(result.content).toContain('PDF');
    expect(result.content).toContain('1 page');
    expect(result.content).toContain('title: Report');
    expect(result.content).toContain('[page 1]');
    expect(result.content).toContain('Quarterly result');
    expect(result.content).not.toContain('tool="read_pdf"');
  });

  test('omitted URL reads the active PDF tab through the same path', async () => {
    const calls: any[] = [];
    const url = 'https://docs.example/report.pdf';
    const result = await readDocTool.execute({}, docContext({
      actorType: 'web',
      activeTab: { id: 7, url, origin: 'https://docs.example' },
      denylist: [],
      docOffscreenClient: {
        extract: async (...args: any[]) => { calls.push(args); return pdfResult; },
      },
    }));

    expect(result.ok).toBe(true);
    expect(calls[0][0]).toEqual({ url });
    expect(result.content).toContain('tool="read_doc"');
  });

  test('queries the complete bounded PDF text and pages the same session-owned spill', async () => {
    const middle = 'needle clause: renewal requires thirty days notice';
    const longPdf = {
      ...pdfResult,
      pdf: {
        ...pdfResult.pdf,
        pages: [
          { page: 1, text: 'opening '.repeat(3_000) },
          { page: 2, text: `${'middle '.repeat(2_000)}${middle}${' middle'.repeat(2_000)}` },
          { page: 3, text: 'closing '.repeat(3_000) },
        ],
        pageCount: 3,
      },
    };
    let spilled: any = null;
    const result = await readDocTool.execute({
      url: 'https://docs.example/long.pdf', query: 'renewal thirty days', maxChars: 2_000,
    }, docContext({
      docOffscreenClient: { extract: async () => longPdf },
      spillResult: async (record: any) => { spilled = { key: 'result:pdf-1', ...record }; return spilled.key; },
    }));

    expect(result.ok).toBe(true);
    expect(result.content).toContain(middle);
    expect(result.content).toContain('read_result');
    expect(spilled).toMatchObject({
      key: 'result:pdf-1', producer: 'read_doc', format: 'pdf-text', fenced: true,
      originLabel: 'https://docs.example', url: 'https://docs.example/long.pdf',
    });
    expect(spilled.text.length).toBeLessThanOrEqual(MAX_SPILL_TEXT_CHARS);
    expect(spilled.text).toContain('[page 3]');

    const page = await readResultTool.execute(
      { key: spilled.key, offset: spilled.text.indexOf(middle), limit: middle.length },
      { resourceAuthority: { readResult: async () => ({ ok: true, record: spilled }) } } as any,
    );
    expect(page.ok).toBe(true);
    expect(page.content).toContain(middle);
    expect(page.content).toContain('"format": "pdf-text"');
  });

  test('uses the PDF query even when paging authority is unavailable', async () => {
    const middle = 'needle clause: keep this exact passage';
    const result = await readDocTool.execute({
      url: 'https://docs.example/no-spill.pdf', query: 'needle exact passage', maxChars: 1_000,
    }, docContext({
      docOffscreenClient: { extract: async () => ({
        ...pdfResult,
        pdf: {
          ...pdfResult.pdf,
          pages: [
            { page: 1, text: 'opening '.repeat(2_000) },
            { page: 2, text: `${'middle '.repeat(1_000)}${middle}${' middle'.repeat(1_000)}` },
            { page: 3, text: 'closing '.repeat(2_000) },
          ],
          pageCount: 3,
        },
      }) },
    }));

    expect(result.ok).toBe(true);
    expect(result.content).toContain(middle);
    expect(result.content).not.toContain('read_result');
  });

  test('caps the stored PDF text at the shared spill limit', async () => {
    let spilled: any = null;
    const result = await readDocTool.execute({
      url: 'https://docs.example/huge.pdf', maxChars: 1_000,
    }, docContext({
      docOffscreenClient: { extract: async () => ({
        ...pdfResult,
        pdf: {
          ...pdfResult.pdf,
          pages: [{ page: 1, text: 'x'.repeat(MAX_SPILL_TEXT_CHARS + 10_000) }],
        },
      }) },
      spillResult: async (record: any) => { spilled = record; return 'result:pdf-cap'; },
    }));

    expect(result.ok).toBe(true);
    expect(spilled.text.length).toBe(MAX_SPILL_TEXT_CHARS);
    expect(spilled.text).toEndWith(`[note] Stored PDF text capped at ${MAX_SPILL_TEXT_CHARS} characters.`);
  });

  test('refuses private targets before the offscreen reader can fetch', async () => {
    let extracts = 0;
    const result = await readDocTool.execute({ url: 'http://127.0.0.1/report.pdf' }, docContext({
      denylist: [],
      docOffscreenClient: {
        extract: async () => { extracts += 1; return pdfResult; },
      },
    }));

    expect(result).toEqual({ ok: false, error: 'private_or_local_target_blocked' });
    expect(extracts).toBe(0);
  });
});
