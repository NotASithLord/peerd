// @ts-check
// Physical scanned-PDF lane: the upstream fixture contains a real JBIG2 image
// and no useful text layer. read_doc must render it through pdf.js's packaged
// decoder before the OCR recognizer receives pixels.

import { describe, it, expect } from '../../framework.js';
import { bytesToBase64 } from '/shared/cold-util.js';
import { handleDocExtract } from '/offscreen/doc-extract.js';
import { extractPdfBytes } from '/offscreen/pdf-extract.js';

describe('read_doc scanned PDF decoding', () => {
  it('decodes a physical JBIG2 page through the forced OCR path', async () => {
    // why bare fetch is acceptable: this reads one packaged extension fixture,
    // never a network resource or caller-controlled URL.
    // eslint-disable-next-line no-restricted-globals
    const fixtureResponse = await fetch('/tests/fixtures/pdf/jbig2_symbol_offset.pdf');
    expect(fixtureResponse.ok).toBe(true);
    const fixtureBytes = new Uint8Array(await fixtureResponse.arrayBuffer());
    expect(new TextDecoder('latin1').decode(fixtureBytes)).toContain('/JBIG2Decode');
    let inkPixels = 0;
    let recognitions = 0;
    let terminated = false;

    const ocrStore = Object.freeze({
      isInstalled: async () => true,
      getEngine: async () => ({
        files: {
          'core-wasm': new Uint8Array([0]).buffer,
          'lang-eng': new Uint8Array([0]).buffer,
        },
      }),
    });
    /** @param {OffscreenCanvas} canvas */
    const recognize = async (canvas) => {
      recognitions += 1;
      const context = canvas.getContext('2d');
      expect(context).toBeTruthy();
      const pixels = /** @type {OffscreenCanvasRenderingContext2D} */ (context)
        .getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 0
          && pixels[index] + pixels[index + 1] + pixels[index + 2] < 720) {
          inkPixels += 1;
        }
      }
      return { data: { text: 'decoded JBIG2 pixels' } };
    };
    /** @param {string} _language @param {number} _oem @param {{workerPath:string}} options */
    const createWorker = async (_language, _oem, options) => {
      expect(options.workerPath).toContain('/vendor/tesseract/worker.min.js');
      return {
        recognize,
        terminate: async () => { terminated = true; },
      };
    };
    const loadRecognizer = async () => ({ createWorker });
    /**
     * @param {Uint8Array} bytes
     * @param {{ engine?: string, dev?: boolean, sourceLabel?: string, signal?:AbortSignal }} opts
     */
    const extractPdf = (bytes, opts) => extractPdfBytes(
      bytes, opts, { ocrStore, loadRecognizer },
    );

    // The HTTP CI harness supplies a deliberately synthetic extension URL for
    // import-time code. Map packaged decoder URLs to the current test origin
    // while this physical load runs; under a real extension origin this is the
    // same mapping native runtime.getURL provides.
    const runtime = /** @type {{getURL:(path:string)=>string}} */ (
      /** @type {unknown} */ (chrome.runtime)
    );
    const originalGetUrl = runtime.getURL;
    runtime.getURL = (path) => new URL(`/${path.replace(/^\//, '')}`, location.href).href;
    let extraction;
    try {
      extraction = await handleDocExtract({
        source: {
          bytesB64: bytesToBase64(fixtureBytes),
          name: 'jbig2_symbol_offset.pdf',
          contentType: 'application/pdf',
        },
        opts: { engine: 'ocr' },
      }, { extractPdf });
    } finally {
      runtime.getURL = originalGetUrl;
    }

    const result = /** @type {any} */ (extraction);
    expect(result.ok).toBe(true);
    expect(result.result.format).toBe('pdf');
    expect(result.result.pdf.engine).toBe('ocr');
    expect(result.result.pdf.pages).toEqual([
      { page: 1, text: 'decoded JBIG2 pixels' },
    ]);
    expect(recognitions).toBe(1);
    expect(inkPixels).toBeGreaterThan(0);
    expect(terminated).toBe(true);
  });
});
