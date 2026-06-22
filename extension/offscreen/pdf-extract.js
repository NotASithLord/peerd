// @ts-check
// offscreen/pdf-extract.js — read a PDF's text in the OFFSCREEN document.
//
// Why here and not the SW: pdf.js parses in a Worker (GlobalWorkerOptions
// .workerSrc), and a service worker cannot host a nested Worker. The
// offscreen document can — the same reason voice (Moonshine) and js_run
// (the sealed worker) live here. The read_pdf tool (SW) calls in via
// background/offscreen-pdf-client.js → a 'pdf/extract' message → here.
//
// Default engine: pdf.js TEXT LAYER — born-digital PDFs, no download. When a
// PDF looks scanned (no usable text layer) AND the opt-in OCR engine is
// installed, 'auto' escalates to OCR: each page is rasterized and its glyphs
// recognized with Tesseract (the driver is vendored in vendor/tesseract/; the
// heavy core WASM + English language model are the opt-in, SRI-pinned runtime
// download wired in peerd-runtime/pdf/ocr-store.js). When OCR isn't installed a
// scanned PDF returns its (empty) text layer plus a clear "looks scanned" note
// so the agent reports the gap honestly. OCR is strictly fail-closed: until the
// driver is vendored AND the asset SRIs are pinned, escalation falls back to the
// text layer rather than crashing the read.
//
// SECURITY: the bytes are UNTRUSTED web content. We never execute the PDF's JS
// (isEvalSupported:false, no form scripting). The text-layer path doesn't render
// at all; the OCR path RASTERIZES pages to an OffscreenCanvas we own and hands
// only the pixels to the recognizer — rasterizing is not script execution. The
// text crosses back wrapped in <untrusted_web_content> by the read_pdf tool.
// pdf.js parses in its own worker; a malformed/hostile PDF can at worst make the
// parse fail, which we surface as an error.

import browser from '/vendor/browser-polyfill.js';
import { base64ToBytes } from '/shared/util.js';
import { isTrustedSender } from '/shared/messaging.js';
import {
  chooseEngine, looksScanned, createOcrStore,
  PdfFetchError, PdfParseError,
} from '/peerd-runtime/index.js';

// pdf.js is loaded LAZILY (dynamic import), not at module top level. The
// offscreen document ALWAYS loads (voice + the SW keepalive port), but most
// sessions never read a PDF — so we keep pdf.js's ~440KB parse + worker setup
// off the offscreen startup path and pay it once, on the first read_pdf.
// workerSrc is an extension URL ('self' under the offscreen CSP); the worker is
// a module worker (v6 ships ESM).
let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise ??= import('/vendor/pdfjs/pdf.min.mjs').then((lib) => {
  lib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');
  return lib;
}));

// Hard caps so a pathological PDF can't wedge the offscreen renderer. The
// text cap is applied later (pure formatter); these bound the PARSE work.
const MAX_PAGES = 500;
const MAX_BYTES = 75 * 1024 * 1024;      // 75 MB — generous; a tab-loaded PDF

/** @type {ReturnType<typeof createOcrStore> | null} */
let ocrStore = null;
const getOcrStore = () => (ocrStore ??= createOcrStore());

// tesseract.js — the OCR driver. VENDORED code (like pdf.js itself), NOT a
// runtime download: extension/vendor/tesseract/{tesseract.esm.min.js,
// worker.min.js}. The two HEAVY assets — the core WASM and the English language
// model — ARE the opt-in, SRI-pinned runtime download (peerd-runtime/pdf/
// ocr-store.js). Lazy like pdf.js: most sessions never OCR, so the driver stays
// off the offscreen startup path and is paid once, on the first scanned PDF.
// The import will REJECT until the driver is vendored — extractViaOcr's caller
// catches that and falls back to the honest "looks scanned" signal.
let tesseractPromise = null;
// why the indirection: the driver isn't vendored yet (see vendor/tesseract/
// SOURCE.txt), so a literal import() specifier wouldn't resolve under tsc.
// Routing the path through a variable keeps this a runtime-only dynamic import
// (Promise<any>) — it resolves the moment the file is committed, and rejects
// (caught by extractViaOcr's caller) until then.
const TESSERACT_DRIVER = '/vendor/tesseract/tesseract.esm.min.js';
const loadTesseract = () => (tesseractPromise ??=
  import(TESSERACT_DRIVER).then((m) => m.default ?? m));

// OCR is expensive — a full raster + glyph recognition per page. Cap the page
// count and fix a render scale so a giant scan can't wedge the offscreen
// renderer. 2× ≈ 150–200 DPI: enough for recognition, cheap enough to stream.
const OCR_MAX_PAGES = 50;
const OCR_RENDER_SCALE = 2;

/**
 * Wrap raw bytes in a blob: URL so tesseract's worker can fetch them as if they
 * were a CDN file. Caller revokes when done.
 *
 * @param {ArrayBuffer} bytes
 * @param {string} type
 * @returns {string}
 */
const blobUrlFor = (bytes, type) => URL.createObjectURL(new Blob([bytes], { type }));

/**
 * Rasterize one pdf.js page to an OffscreenCanvas the recognizer can read.
 * Rendering rasterizes; it does NOT execute the PDF's JS (isEvalSupported stays
 * false on the loading task). We own the canvas and pass only its pixels on.
 *
 * @param {any} page   a pdf.js PDFPageProxy
 * @param {number} scale
 * @returns {Promise<OffscreenCanvas>}
 */
const renderPageToCanvas = async (page, scale) => {
  const viewport = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.ceil(viewport.width)),
    Math.max(1, Math.ceil(viewport.height)),
  );
  const canvasContext = canvas.getContext('2d');
  if (!canvasContext) throw new Error('OffscreenCanvas 2D context unavailable');
  await page.render({ canvasContext, viewport }).promise;
  return canvas;
};

/**
 * Render a scanned PDF page-by-page and OCR each page. Returns the SAME shape as
 * extractTextLayer (pages[], pageCount, info, chars) so the caller treats both
 * engines identically.
 *
 * Fail-closed: getEngine throws OcrUnavailableError until the asset SRIs are
 * pinned (production) — the caller catches and falls back to the text layer, so
 * an unpinned/uninstalled engine never crashes a read.
 *
 * VALIDATE LOCALLY (can only be confirmed with the real driver vendored + a
 * browser): the corePath/langPath wiring (blob: URLs standing in for the cached
 * bytes) and the offscreen CSP's worker-src for the tesseract worker. See the
 * ping on PR #76 and docs/PDF-READING.md.
 *
 * @param {Uint8Array} bytes
 * @param {{ dev?: boolean }} [opts]
 * @returns {Promise<{ pages: Array<{page:number,text:string}>, pageCount:number, info:object, chars:number }>}
 */
const extractViaOcr = async (bytes, { dev = false } = {}) => {
  const engine = await getOcrStore().getEngine({ dev });
  const corePath = blobUrlFor(engine.files['core-wasm'], 'application/wasm');
  const langPath = blobUrlFor(engine.files['lang-eng'], 'application/octet-stream');
  const workerPath = browser.runtime.getURL('vendor/tesseract/worker.min.js');

  const pdfjsLib = await loadPdfjs();
  const Tesseract = await loadTesseract();

  const task = pdfjsLib.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableAutoFetch: true,
    disableFontFace: true,
  });
  let pdf;
  let worker;
  try {
    pdf = await task.promise;
    // createWorker spins up vendor/tesseract/worker.min.js, which loads the core
    // WASM (corePath) and the language model (langPath). cacheMethod:'none' — we
    // already cache the bytes in IDB (ocr-store), no second cache layer.
    worker = await Tesseract.createWorker('eng', 1, {
      corePath, langPath, workerPath, gzip: true, cacheMethod: 'none',
    });

    const pageCount = pdf.numPages;
    const limit = Math.min(pageCount, OCR_MAX_PAGES);
    const pages = [];
    let chars = 0;
    for (let n = 1; n <= limit; n += 1) {
      const page = await pdf.getPage(n);
      const canvas = await renderPageToCanvas(page, OCR_RENDER_SCALE);
      page.cleanup();
      const { data } = await worker.recognize(canvas);
      const text = String(data?.text ?? '');
      chars += text.length;
      pages.push({ page: n, text });
    }
    const meta = await pdf.getMetadata().catch(() => null);
    const info = {
      title: meta?.info?.Title || '',
      author: meta?.info?.Author || '',
    };
    return { pages, pageCount, info, chars };
  } finally {
    try { if (worker) await worker.terminate(); } catch { /* best-effort */ }
    try { await task.destroy(); } catch { /* best-effort */ }
    URL.revokeObjectURL(corePath);
    URL.revokeObjectURL(langPath);
  }
};

/**
 * Fetch the PDF bytes for a source. http(s) and data: URLs are supported.
 * blob: URLs created in another tab are not reachable from here (documented
 * limitation — the agent should download the PDF into a sandbox instead).
 *
 * @param {{ url?: string, bytesB64?: string }} source
 * @returns {Promise<Uint8Array>}
 */
const fetchPdfBytes = async (/** @type {{ url?: string, bytesB64?: string }} */ { url, bytesB64 } = {}) => {
  if (bytesB64) return base64ToBytes(bytesB64);
  if (!url || typeof url !== 'string') throw new PdfFetchError('no PDF url provided');
  if (url.startsWith('blob:')) {
    throw new PdfFetchError('blob: PDFs are not reachable from the extension; download the PDF first');
  }
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new PdfFetchError(`could not fetch PDF: ${(/** @type {{ message?: string }} */ (e))?.message ?? e}`);
  }
  if (!res.ok) throw new PdfFetchError(`HTTP ${res.status} fetching PDF`, { status: res.status });
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    throw new PdfFetchError(`PDF too large: ${buf.byteLength} bytes (limit ${MAX_BYTES})`);
  }
  return new Uint8Array(buf);
};

/**
 * Extract every page's text via pdf.js's text layer. Returns structured page
 * data + document info; the pure formatter (formatPdfBody) caps + renders it.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<{ pages: Array<{page:number,text:string}>, pageCount:number, info:object, chars:number }>}
 */
const extractTextLayer = async (bytes) => {
  const pdfjsLib = await loadPdfjs();
  // getDocument returns a LOADING TASK; teardown is task.destroy() (NOT
  // pdf.destroy(), which doesn't exist in pdf.js v6 — calling it leaks the
  // worker). We keep the task to destroy it in finally.
  const task = pdfjsLib.getDocument({
    data: bytes,
    // Hostile-content posture: no PDF JS, no eval, no auto font fetch.
    isEvalSupported: false,
    disableAutoFetch: true,
    disableFontFace: true,
  });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    // why surface workerSrc: the most common real failure is the worker not
    // loading (CSP, missing file, bad URL) — pdf.js then reports a generic
    // parse error. Naming the configured worker makes that diagnosable from
    // the offscreen DevTools console without guesswork.
    try { await task.destroy(); } catch { /* best-effort */ }
    throw new PdfParseError(
      `pdf.js could not parse the document (pdf.js ${pdfjsLib.version}, `
      + `worker=${pdfjsLib.GlobalWorkerOptions.workerSrc || '(unset)'}): ${(/** @type {{ name?: string, message?: string }} */ (e))?.name ?? 'Error'}: ${(/** @type {{ message?: string }} */ (e))?.message ?? e}`,
    );
  }

  const pageCount = pdf.numPages;
  const limit = Math.min(pageCount, MAX_PAGES);
  const pages = [];
  let chars = 0;
  try {
    for (let n = 1; n <= limit; n += 1) {
      const page = await pdf.getPage(n);
      const tc = await page.getTextContent();
      let text = '';
      for (const item of tc.items) {
        if (typeof item.str === 'string') text += item.str;
        if (item.hasEOL) text += '\n';
      }
      page.cleanup();
      chars += text.length;
      pages.push({ page: n, text });
    }
    const meta = await pdf.getMetadata().catch(() => null);
    const info = {
      title: meta?.info?.Title || '',
      author: meta?.info?.Author || '',
    };
    return { pages, pageCount, info, chars };
  } finally {
    try { await task.destroy(); } catch { /* best-effort */ }
  }
};

/**
 * Top-level extract: fetch → text layer → (scanned detection → OCR escalation).
 * Returns the structured result the read_pdf tool formats. In 'auto', a PDF that
 * looks scanned AND has the opt-in OCR engine installed escalates to OCR; a
 * forced engine:'ocr' OCRs unconditionally. OCR is fail-closed: any failure
 * (driver not vendored, SRIs unpinned, recognizer error) falls back to the text
 * layer with a clear scanned note rather than crashing the read.
 *
 * @param {{ source: object, opts?: { engine?: string, dev?: boolean } }} msg
 */
const extractPdf = async (/** @type {{ source: any, opts?: { engine?: string, dev?: boolean } }} */ { source, opts = {} }) => {
  // Stage label rides every failure so a manual run (offscreen DevTools, or the
  // error returned to read_pdf) pinpoints WHERE it broke: plan / fetch / parse / ocr.
  let stage = 'plan';
  const dev = !!opts.dev;
  const where = source?.url ? source.url.slice(0, 120) : '(inline bytes)';
  try {
    const ocrAvailable = await getOcrStore().isInstalled({ dev }).catch(() => false);
    const plan = chooseEngine({ engine: opts.engine ?? 'auto', ocrAvailable });
    if (plan.engine === null) {
      // Explicit engine:'ocr' but not installed.
      return { ok: false, error: 'ocr_not_installed', stage };
    }

    stage = 'fetch';
    const bytes = await fetchPdfBytes(source);

    // Forced engine:'ocr' (installed): OCR the whole document, no text-layer pass.
    if (plan.engine === 'ocr') {
      stage = 'ocr';
      const ocr = await extractViaOcr(bytes, { dev });
      const scanned = looksScanned({ chars: ocr.chars, pages: ocr.pageCount });
      console.debug(`[offscreen/pdf-extract] ${where}: forced OCR, ${ocr.pageCount}p, ${ocr.chars} chars`);
      return {
        ok: true,
        result: {
          engine: 'ocr', pages: ocr.pages, pageCount: ocr.pageCount,
          info: ocr.info, scanned, ocrUsed: true, ocrAvailable,
        },
      };
    }

    stage = 'parse';
    const layer = await extractTextLayer(bytes);
    const scanned = looksScanned({ chars: layer.chars, pages: layer.pageCount });
    console.debug(
      `[offscreen/pdf-extract] ${where}: ${layer.pageCount}p, ${layer.chars} chars, `
      + `engine=${plan.engine}, scanned=${scanned}, ocrAvailable=${ocrAvailable}, mayEscalate=${plan.mayEscalate}`,
    );

    // 'auto' + scanned + OCR installed → escalate to OCR. Fail-closed: if the
    // recognizer can't run (driver absent, SRIs unpinned, worker/CSP error) we
    // KEEP the text-layer result and let the formatter surface the scanned note,
    // rather than failing the whole read.
    if (plan.mayEscalate && scanned) {
      stage = 'ocr';
      try {
        const ocr = await extractViaOcr(bytes, { dev });
        const ocrScanned = looksScanned({ chars: ocr.chars, pages: ocr.pageCount });
        console.debug(`[offscreen/pdf-extract] ${where}: OCR escalation recovered ${ocr.chars} chars`);
        return {
          ok: true,
          result: {
            engine: 'ocr', pages: ocr.pages, pageCount: ocr.pageCount,
            info: ocr.info, scanned: ocrScanned, ocrUsed: true, ocrAvailable,
          },
        };
      } catch (ocrErr) {
        console.warn(`[offscreen/pdf-extract] ${where}: OCR escalation failed, keeping text layer:`, ocrErr);
      }
    }

    return {
      ok: true,
      result: {
        engine: plan.engine,
        pages: layer.pages,
        pageCount: layer.pageCount,
        info: layer.info,
        scanned,
        ocrUsed: false,
        ocrAvailable,
      },
    };
  } catch (e) {
    // Robust, debuggable failure: stage + typed name + message + the target.
    const detail = `${(/** @type {{ name?: string, message?: string }} */ (e))?.name ?? 'Error'}: ${(/** @type {{ message?: string }} */ (e))?.message ?? String(e)}`;
    console.error(`[offscreen/pdf-extract] FAILED at stage=${stage} for ${where}:`, e);
    return { ok: false, error: `pdf_extract_failed[${stage}]: ${detail}`, stage };
  }
};

// Message route: SW → offscreen. A dedicated listener (mirrors job/run) so
// voice and local-model handlers are untouched. Gated on isTrustedSender like
// every sibling handler (job/run, local-model/*, voice) — fail-closed posture:
// externally_connectable is unset today, so this is defense-in-depth, but the
// gate is what keeps this from being an open fetch proxy if it's ever enabled.
// why cast: the polyfill's OnMessageListener return-type is stricter than this
// fire-and-respond handler (mirrors offscreen.js's job/voice listeners).
browser.runtime.onMessage.addListener(/** @type {any} */ ((/** @type {any} */ msg, /** @type {any} */ sender, /** @type {any} */ sendResponse) => {
  if (msg?.type !== 'pdf/extract') return undefined;
  if (!isTrustedSender(sender)) { sendResponse({ ok: false, error: 'untrusted-sender' }); return true; }
  extractPdf(msg)
    .then((out) => sendResponse(out))
    .catch((e) => sendResponse({ ok: false, error: e?.name ? `${e.name}: ${e.message}` : (e?.message ?? String(e)) }));
  return true;     // async sendResponse contract
}));
