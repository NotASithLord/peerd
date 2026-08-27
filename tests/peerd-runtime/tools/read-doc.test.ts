import { describe, expect, test } from 'bun:test';
import { readDocTool } from '../../../extension/peerd-runtime/tools/defs/read-doc.js';
import { browserProbeResult } from '../../helpers/browser-scripting.ts';

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

describe('read_doc as the one public document reader', () => {
  test('formats sniffed PDF output with page metadata and the read_doc fence', async () => {
    const calls: any[] = [];
    const result = await readDocTool.execute({
      url: 'https://docs.example/report.bin', engine: 'pdfjs',
    }, {
      denylist: [],
      docOffscreenClient: {
        extract: async (...args: any[]) => { calls.push(args); return pdfResult; },
      },
    } as any);

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
    const result = await readDocTool.execute({}, {
      actorType: 'web',
      activeTab: { id: 7, url, origin: 'https://docs.example' },
      denylist: [],
      tabs: { get: async () => ({ id: 7, url }) },
      scripting: {
        executeScript: async (request: any) => browserProbeResult(request, { url }),
      },
      docOffscreenClient: {
        extract: async (...args: any[]) => { calls.push(args); return pdfResult; },
      },
    } as any);

    expect(result.ok).toBe(true);
    expect(calls[0][0]).toEqual({ url });
    expect(result.content).toContain('tool="read_doc"');
  });

  test('refuses private targets before the offscreen reader can fetch', async () => {
    let extracts = 0;
    const result = await readDocTool.execute({ url: 'http://127.0.0.1/report.pdf' }, {
      denylist: [],
      docOffscreenClient: {
        extract: async () => { extracts += 1; return pdfResult; },
      },
    } as any);

    expect(result).toEqual({ ok: false, error: 'private_or_local_target_blocked' });
    expect(extracts).toBe(0);
  });
});
