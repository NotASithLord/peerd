import { describe, test, expect } from 'bun:test';
import {
  requireEngine, chooseEngine, looksScanned, SCANNED_CHARS_PER_PAGE,
} from '../../../extension/peerd-runtime/pdf/engines.js';
import { UnknownPdfEngineError } from '../../../extension/peerd-runtime/pdf/errors.js';

describe('pdf engine catalog', () => {
  test('requireEngine throws on a non-engine value', () => {
    expect(requireEngine('pdfjs')).toBe('pdfjs');
    expect(requireEngine('ocr')).toBe('ocr');
    expect(() => requireEngine('auto')).toThrow(UnknownPdfEngineError);
    expect(() => requireEngine('bogus')).toThrow(UnknownPdfEngineError);
  });
});

describe('looksScanned heuristic', () => {
  test('low chars-per-page → scanned', () => {
    expect(looksScanned({ chars: 0, pages: 10 })).toBe(true);
    expect(looksScanned({ chars: 50, pages: 10 })).toBe(true);   // 5/page < threshold
  });
  test('dense text → not scanned', () => {
    expect(looksScanned({ chars: 10_000, pages: 5 })).toBe(false);
    expect(looksScanned({ chars: SCANNED_CHARS_PER_PAGE * 3, pages: 2 })).toBe(false);
  });
  test('guards divide-by-zero and bad input', () => {
    expect(looksScanned({ chars: 0, pages: 0 })).toBe(true);
    // @ts-expect-error — exercising the coercion path
    expect(looksScanned({})).toBe(true);
  });
});

describe('chooseEngine', () => {
  test('auto runs pdfjs, escalates only when OCR is installed', () => {
    expect(chooseEngine({ engine: 'auto', ocrAvailable: false }))
      .toEqual({ engine: 'pdfjs', mayEscalate: false });
    expect(chooseEngine({ engine: 'auto', ocrAvailable: true }))
      .toEqual({ engine: 'pdfjs', mayEscalate: true });
  });

  test('defaults to auto when no engine given', () => {
    expect(chooseEngine()).toEqual({ engine: 'pdfjs', mayEscalate: false });
  });

  test('pdfjs forces the text layer, never escalates', () => {
    expect(chooseEngine({ engine: 'pdfjs', ocrAvailable: true }))
      .toEqual({ engine: 'pdfjs', mayEscalate: false });
  });

  test('ocr is refused when not installed, chosen when installed', () => {
    expect(chooseEngine({ engine: 'ocr', ocrAvailable: false }))
      .toEqual({ engine: null, mayEscalate: false, reason: 'ocr_not_installed' });
    expect(chooseEngine({ engine: 'ocr', ocrAvailable: true }))
      .toEqual({ engine: 'ocr', mayEscalate: false });
  });
});
