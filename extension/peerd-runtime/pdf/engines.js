// @ts-check
// PDF engine catalog + selection — PURE.
//
// peerd reads PDFs with one of two engines:
//
//   pdfjs  — Mozilla pdf.js text-layer extraction. The DEFAULT. Vendored
//            (no download), fast, born-digital PDFs only: it reads the
//            text the PDF already carries. A scanned/photographed PDF has
//            NO text layer, so pdfjs returns (near-)nothing for it.
//   ocr    — render each page to a bitmap and recognize the glyphs. The
//            HEAVY path: an OPT-IN runtime download (the Moonshine-voice
//            pattern), needed only for scanned/image-only PDFs. Off by
//            default; the agent never silently pulls a multi-MB engine.
//
// "auto" is the agent-facing default: use pdfjs; if the page yielded
// almost no text AND OCR is installed, fall back to OCR. This module owns
// the pure decisions — the catalog, name normalization, and the
// "does this look scanned?" threshold. The IO (fetch + pdf.js + recognize)
// lives in offscreen/pdf-extract.js.

import { UnknownPdfEngineError } from './errors.js';

/** @typedef {'pdfjs'|'ocr'} PdfEngine */

// The default engine. pdfjs ships in the box; OCR is the upgrade.
export const DEFAULT_ENGINE = 'pdfjs';

export const PDF_ENGINES = Object.freeze({
  pdfjs: Object.freeze({
    id: 'pdfjs',
    label: 'pdf.js (text layer)',
    requiresDownload: false,
    // why: born-digital only — reads the embedded text, can't see glyphs
    // baked into a scanned image.
    handlesScanned: false,
  }),
  ocr: Object.freeze({
    id: 'ocr',
    label: 'OCR (on-device)',
    requiresDownload: true,
    handlesScanned: true,
  }),
});

/**
 * Validate an EXPLICIT engine request (the tool's `engine` arg when not
 * 'auto'). Throws on a value that isn't a real engine, so a typo surfaces
 * instead of silently reading with the wrong one.
 *
 * @param {string} engine
 * @returns {PdfEngine}
 */
export const requireEngine = (engine) => {
  const e = String(engine ?? '').toLowerCase().trim();
  if (e !== 'pdfjs' && e !== 'ocr') throw new UnknownPdfEngineError(engine);
  return e;
};

// A page that yields fewer than this many extracted characters PER PAGE (on
// average) is treated as having no usable text layer — i.e. probably scanned.
// Deliberately low: a near-empty text layer (page numbers, a watermark) on an
// otherwise image-only document still trips it, while a sparse but real
// born-digital page (a title page, a chart caption) clears it.
export const SCANNED_CHARS_PER_PAGE = 16;

/**
 * Heuristic: does this pdf.js extraction look like a scanned/image-only PDF
 * (so OCR would help)? Pure — values in, boolean out.
 *
 * @param {{ chars: number, pages: number }} stats  chars extracted, page count
 * @returns {boolean}
 */
export const looksScanned = ({ chars, pages }) => {
  const p = Math.max(1, Number(pages) || 0);
  const c = Math.max(0, Number(chars) || 0);
  return (c / p) < SCANNED_CHARS_PER_PAGE;
};

/**
 * Decide which engine to ACTUALLY run, given the caller's request and what's
 * installed. Returns the resolved engine plus whether an OCR fallback is
 * WANTED but unavailable (so the caller can tell the agent to enable it).
 *
 * Modes:
 *   'auto' (default) — run pdfjs first; the offscreen extractor decides at
 *                      runtime whether to escalate to OCR (looksScanned +
 *                      ocrAvailable). chooseEngine returns 'pdfjs' with
 *                      mayEscalate = ocrAvailable.
 *   'pdfjs'          — force the text layer, never OCR.
 *   'ocr'            — force OCR; refused (engine === null) when not installed.
 *
 * @param {Object} args
 * @param {string} [args.engine]        'auto' | 'pdfjs' | 'ocr'
 * @param {boolean} [args.ocrAvailable] is the OCR engine downloaded?
 * @returns {{ engine: PdfEngine|null, mayEscalate: boolean, reason?: string }}
 */
export const chooseEngine = ({ engine = 'auto', ocrAvailable = false } = {}) => {
  const mode = String(engine ?? 'auto').toLowerCase().trim() || 'auto';
  if (mode === 'ocr') {
    if (!ocrAvailable) {
      return { engine: null, mayEscalate: false, reason: 'ocr_not_installed' };
    }
    return { engine: 'ocr', mayEscalate: false };
  }
  if (mode === 'pdfjs') {
    return { engine: 'pdfjs', mayEscalate: false };
  }
  // 'auto' (and anything unrecognized) → text layer first, OCR-escalate only
  // when it's actually installed.
  return { engine: 'pdfjs', mayEscalate: ocrAvailable };
};
