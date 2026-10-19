import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import browser from '../../extension/shared/browser-api.js';
import { extractPdfBytes } from '../../extension/offscreen/pdf-extract.js';

test.serial('real pdf.js separates an open password from restrictions and corrupt bytes', async () => {
  const globals = globalThis as any;
  const matrix = globals.DOMMatrix;
  const getURL = browser.runtime.getURL;
  // Bun needs the matrix identity at library load. This path does not render.
  globals.DOMMatrix ??= class { a = 1; b = 0; c = 0; d = 1; e = 0; f = 0; };
  browser.runtime.getURL = (path) => new URL(`../../extension/${path}`, import.meta.url).href;
  try {
    for (const name of ['plain', 'owner-only', 'locked']) {
      const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/document-${name}.pdf`, import.meta.url)));
      const result = await extractPdfBytes(bytes, { engine: 'pdfjs' });
      if (name === 'locked') expect(result).toMatchObject({ ok: false, error: 'pdf_password_required' });
      else {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.result?.pages[0].text).not.toBe('');
      }
    }
    const corrupt = await extractPdfBytes(new TextEncoder().encode('not a PDF'), { engine: 'pdfjs' });
    expect(corrupt).toMatchObject({ ok: false, error: 'pdf_extract_failed' });
  } finally {
    browser.runtime.getURL = getURL;
    if (matrix === undefined) delete globals.DOMMatrix; else globals.DOMMatrix = matrix;
  }
});
