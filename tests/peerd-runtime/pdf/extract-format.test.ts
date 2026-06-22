import { describe, test, expect } from 'bun:test';
import {
  tidyPageText, assemblePages, formatPdfBody, DEFAULT_MAX_CHARS,
} from '../../../extension/peerd-runtime/pdf/extract-format.js';

describe('tidyPageText', () => {
  test('collapses whitespace and trims', () => {
    expect(tidyPageText('  hello    world  \n\n\n\n  next  ')).toBe('hello world\n\nnext');
  });
  test('non-string → empty', () => {
    // @ts-expect-error exercising coercion
    expect(tidyPageText(undefined)).toBe('');
  });
});

describe('assemblePages', () => {
  const pages = [
    { page: 1, text: 'alpha' },
    { page: 2, text: 'beta' },
    { page: 3, text: 'gamma' },
  ];

  test('joins pages with [page N] markers', () => {
    const out = assemblePages(pages, { maxChars: 1000 });
    expect(out.truncated).toBe(false);
    expect(out.pagesEmitted).toBe(3);
    expect(out.body).toContain('[page 1]\nalpha');
    expect(out.body).toContain('[page 2]\nbeta');
    expect(out.body).toContain('[page 3]\ngamma');
  });

  test('empty page text gets a placeholder line', () => {
    const out = assemblePages([{ page: 1, text: '   ' }], { maxChars: 1000 });
    expect(out.body).toContain('(no text on this page)');
  });

  test('truncates at a page boundary and reports totals', () => {
    const out = assemblePages(pages, { maxChars: 15 });   // only the first block fits
    expect(out.truncated).toBe(true);
    expect(out.pagesEmitted).toBe(1);
    expect(out.body).toContain('[page 1]');
    expect(out.body).not.toContain('[page 3]');
    // charsTotal sums every page's tidied length regardless of the cap
    expect(out.charsTotal).toBe('alpha'.length + 'beta'.length + 'gamma'.length);
  });

  test('always emits at least the first page even if it blows the cap', () => {
    const out = assemblePages([{ page: 1, text: 'x'.repeat(500) }], { maxChars: 10 });
    expect(out.pagesEmitted).toBe(1);
    expect(out.truncated).toBe(false);   // first block is always allowed
  });
});

describe('formatPdfBody', () => {
  const base = {
    pages: [{ page: 1, text: 'Some real text on the page.' }],
    engine: 'pdfjs' as const,
    pageCount: 1,
    info: { title: 'Report', author: 'Ada' },
  };

  test('header carries page count, title, author, engine', () => {
    const body = formatPdfBody({ ...base });
    expect(body).toContain('PDF — 1 page');
    expect(body).toContain('title: Report');
    expect(body).toContain('author: Ada');
    expect(body).toContain('engine: pdfjs');
    expect(body).toContain('Some real text');
  });

  test('scanned + OCR not installed → explains the gap', () => {
    const body = formatPdfBody({
      pages: [{ page: 1, text: '' }], engine: 'pdfjs', pageCount: 1,
      scanned: true, ocrUsed: false, ocrAvailable: false,
    });
    expect(body).toContain('looks scanned');
    expect(body).toContain('Settings → Voice & OCR');
  });

  test('OCR flagged when it ran', () => {
    const body = formatPdfBody({ ...base, engine: 'ocr', ocrUsed: true });
    expect(body).toContain('engine: ocr (OCR)');
  });

  test('truncation note appears when capped', () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ page: i + 1, text: 'y'.repeat(100) }));
    const body = formatPdfBody({ pages, engine: 'pdfjs', pageCount: 5, maxChars: 120 });
    expect(body).toContain('Output truncated');
  });

  test('default cap constant is exported and positive', () => {
    expect(DEFAULT_MAX_CHARS).toBeGreaterThan(1000);
  });
});
