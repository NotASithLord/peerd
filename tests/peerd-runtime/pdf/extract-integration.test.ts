// Integration test: the VENDORED pdf.js artifacts actually parse a PDF and our
// extraction loop (the one in offscreen/pdf-extract.js) yields the right text.
//
// This guards the real shipped files — extension/vendor/pdfjs/pdf.min.mjs and
// pdf.worker.min.mjs — plus our str+hasEOL join, against a re-vendor that bumps
// or breaks them. It runs the SAME path the offscreen uses: import the main
// build, point GlobalWorkerOptions.workerSrc at the vendored worker, getDocument
// → getTextContent. bun isn't a DOM, so we shim the one browser global pdf.js
// touches at load (DOMMatrix); the offscreen document has it for real.
//
// If this ever fails after `bun test` was green, the vendored pdf.js changed —
// re-check extension/vendor/pdfjs/SOURCE.txt and the extraction loop.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const VENDOR = `${import.meta.dir}/../../../extension/vendor/pdfjs`;

// Minimal DOMMatrix shim — enough for pdf.js to LOAD under bun (it constructs a
// default matrix at module scope). Text extraction uses pdf.js's own matrix
// math, not this; the offscreen has the real DOMMatrix.
class MatrixShim {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  constructor(init?: number[]) {
    if (Array.isArray(init)) [this.a, this.b, this.c, this.d, this.e, this.f] = init;
  }
  multiply() { return this; }
  translate() { return this; }
  scale() { return this; }
  inverse() { return this; }
  transformPoint(p: unknown) { return p; }
}

// A tiny born-digital PDF with one text run. pdf.js recovers the (absent) xref.
const SAMPLE_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 46>>stream
BT /F1 24 Tf 20 100 Td (Hello peerd PDF) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

const pdfBytes = () => new Uint8Array([...SAMPLE_PDF].map((c) => c.charCodeAt(0)));

let pdfjs: any;

beforeAll(() => {
  (globalThis as any).DOMMatrix ??= MatrixShim;
});

describe('vendored pdf.js extracts a real PDF', () => {
  test('loads the vendored main build and reports its version', async () => {
    pdfjs = await import(`${VENDOR}/pdf.min.mjs`);
    expect(typeof pdfjs.getDocument).toBe('function');
    expect(pdfjs.version).toBe('6.0.227');   // keep in sync with SOURCE.txt
  });

  test('parses the document and extracts its text via the worker', async () => {
    pdfjs ??= await import(`${VENDOR}/pdf.min.mjs`);
    // Same wiring as offscreen/pdf-extract.js: configured worker, no eval/fonts.
    pdfjs.GlobalWorkerOptions.workerSrc = `${VENDOR}/pdf.worker.min.mjs`;

    // getDocument returns a LOADING TASK; teardown is task.destroy() (v6 has no
    // doc.destroy()) — the same fix applied in offscreen/pdf-extract.js.
    const task = pdfjs.getDocument({
      data: pdfBytes(), isEvalSupported: false, disableFontFace: true, disableAutoFetch: true,
    });
    const doc = await task.promise;
    try {
      expect(doc.numPages).toBe(1);
      const tc = await (await doc.getPage(1)).getTextContent();
      // The exact loop from offscreen/pdf-extract.js extractTextLayer().
      let text = '';
      for (const item of tc.items) {
        if (typeof item.str === 'string') text += item.str;
        if (item.hasEOL) text += '\n';
      }
      expect(text.trim()).toBe('Hello peerd PDF');
    } finally {
      await task.destroy();   // terminate the worker so the test runner exits
    }
  });
});

afterAll(() => {
  if ((globalThis as any).DOMMatrix === MatrixShim) delete (globalThis as any).DOMMatrix;
});
