import { describe, expect, test } from 'bun:test';
import {
  extractBoundedPdfTextLayer,
  PDF_INFO_FIELD_CHARS,
} from '../../extension/offscreen/pdf-text-layer.js';

const textPage = (chunks: any[], calls: string[], pageNumber: number) => ({
  streamTextContent: () => {
    let index = 0;
    return {
      getReader: () => ({
        read: async () => index < chunks.length
          ? { done: false, value: chunks[index++] }
          : { done: true, value: undefined },
        cancel: async () => { calls.push(`cancel:${pageNumber}`); },
        releaseLock: () => { calls.push(`release:${pageNumber}`); },
      }),
    };
  },
  cleanup: () => { calls.push(`cleanup:${pageNumber}`); },
});

describe('bounded offscreen PDF text extraction', () => {
  test('stops inside the incoming stream before pages or clone payload exceed the cap', async () => {
    const calls: string[] = [];
    const pdf = {
      numPages: 2,
      getPage: async (page: number) => {
        calls.push(`page:${page}`);
        if (page === 2) throw new Error('page two must never allocate');
        return textPage([{ items: [
          { str: '1234', hasEOL: true },
          { str: '567890', hasEOL: false },
        ] }], calls, page);
      },
      getMetadata: async () => ({ info: { Title: 'Bounded' } }),
    };
    const result = await extractBoundedPdfTextLayer(pdf, { maxPages: 10, maxChars: 7 });
    expect(result).toEqual({
      pages: [{ page: 1, text: '1234\n56' }],
      pageCount: 2,
      info: { title: 'Bounded', author: '' },
      chars: 7,
      textCapped: true,
    });
    expect(calls).toEqual(['page:1', 'cancel:1', 'release:1', 'cleanup:1']);
    expect(structuredClone(result).pages[0].text.length).toBe(7);
  });

  test('reports an exact uncapped result when the final stream ends at the limit', async () => {
    const calls: string[] = [];
    const pdf = {
      numPages: 1,
      getPage: async () => textPage([{ items: [{ str: 'exact', hasEOL: false }] }], calls, 1),
      getMetadata: async () => null,
    };
    const result = await extractBoundedPdfTextLayer(pdf, { maxPages: 1, maxChars: 5 });
    expect(result.textCapped).toBe(false);
    expect(result.chars).toBe(5);
  });

  test('marks pages omitted by the parser work cap as capped', async () => {
    const calls: string[] = [];
    const pdf = {
      numPages: 3,
      getPage: async (page: number) => textPage([{ items: [{ str: String(page) }] }], calls, page),
      getMetadata: async () => null,
    };
    const result = await extractBoundedPdfTextLayer(pdf, { maxPages: 1, maxChars: 100 });
    expect(result.pages).toEqual([{ page: 1, text: '1' }]);
    expect(result.textCapped).toBe(true);
  });

  test('bounds producer-controlled metadata before structured clone', async () => {
    const calls: string[] = [];
    const oversized = 'x'.repeat(PDF_INFO_FIELD_CHARS + 10_000);
    const pdf = {
      numPages: 0,
      getPage: async (page: number) => textPage([], calls, page),
      getMetadata: async () => ({ info: { Title: oversized, Author: oversized } }),
    };
    const result = await extractBoundedPdfTextLayer(pdf, { maxPages: 1, maxChars: 10 });
    expect(result.info).toEqual({
      title: 'x'.repeat(PDF_INFO_FIELD_CHARS),
      author: 'x'.repeat(PDF_INFO_FIELD_CHARS),
    });
    expect(structuredClone(result).info).toEqual(result.info);
  });
});
