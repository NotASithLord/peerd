// @ts-check
// RTF → Markdown.
//
// RTF is a control-word stream, not a tree, so this is a tokenizer with a
// group stack rather than a document walker. The parts that matter for text
// extraction and the traps in each:
//
//   \b \i          — character formatting, and it is GROUP-SCOPED: `{\b x} y`
//                    leaves y unbolded. Hence the state stack.
//   \par \line     — paragraph and line breaks.
//   \u<N>?         — a Unicode codepoint followed by a fallback character that
//                    must be SKIPPED, or every non-ASCII character arrives with
//                    a `?` glued to it.
//   \'hh           — a byte in the current codepage.
//   \*\<dest>      — an ignorable destination (fonts, colors, stylesheets,
//                    embedded objects). Skipping these is what separates
//                    readable output from a wall of table definitions.
//   \fonttbl etc.  — non-ignorable destinations that are still not prose.

import { makeDocument, paragraph, heading, inline, finalizeDocument } from '../model.js';

// Destinations whose contents are never body text. \pict is here because an
// embedded image is megabytes of hex that would otherwise be emitted verbatim.
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'listtable', 'listoverridetable',
  'info', 'pict', 'object', 'themedata', 'colorschememapping', 'datastore',
  'latentstyles', 'rsidtbl', 'generator', 'xmlnstbl', 'filetbl', 'revtbl',
  'upr', 'header', 'footer', 'footnote', 'annotation',
]);

/**
 * @param {string} source
 * @param {{ name?: string }} [opts]
 * @returns {import('../model.js').Document}
 */
export const parseRtf = (source, opts = {}) => {
  const doc = makeDocument({ format: 'rtf', title: opts.name ?? null });
  /** @type {Array<{ bold: boolean, italic: boolean, skip: boolean, outline: number }>} */
  const stack = [{ bold: false, italic: false, skip: false, outline: 0 }];
  /** @type {import('../model.js').Inline[]} */
  let runs = [];
  let buffer = '';
  let state = stack[0];
  // \uN emits a fallback the reader must swallow; \uc sets how many.
  let skipFallback = 0;
  let unicodeSkip = 1;

  const flushRun = () => {
    if (buffer) {
      runs.push(inline(buffer, { bold: state.bold || undefined, italic: state.italic || undefined }));
      buffer = '';
    }
  };
  const endParagraph = () => {
    flushRun();
    if (runs.length) {
      // \outlinelevelN is Word's heading marker in RTF; 0 is Heading 1.
      doc.blocks.push(state.outline > 0 ? heading(state.outline, runs) : paragraph(runs));
    }
    runs = [];
  };
  const emit = (/** @type {string} */ text) => {
    if (state.skip) return;
    if (skipFallback > 0) { skipFallback -= 1; return; }
    buffer += text;
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === '{') {
      flushRun();
      state = { ...state };
      stack.push(state);
      continue;
    }
    if (ch === '}') {
      flushRun();
      stack.pop();
      state = stack[stack.length - 1] ?? stack[0];
      continue;
    }
    if (ch !== '\\') {
      if (ch === '\r' || ch === '\n') continue;    // raw newlines are not text in RTF
      emit(ch);
      continue;
    }

    // --- a control sequence ---
    const next = source[i + 1];
    if (next === undefined) break;
    // Escaped literals.
    if (next === '\\' || next === '{' || next === '}') { emit(next); i += 1; continue; }
    // \'hh — a raw byte. Decoded as latin-1: without reading \ansicpg and
    // carrying a full codepage table, latin-1 is right for Western text and
    // wrong-but-harmless elsewhere (\u is what modern writers emit anyway).
    if (next === "'") {
      const hex = source.slice(i + 2, i + 4);
      const code = Number.parseInt(hex, 16);
      if (Number.isFinite(code)) emit(String.fromCharCode(code));
      i += 3;
      continue;
    }
    // \* — the ignorable-destination marker: skip this whole group.
    if (next === '*') { state.skip = true; i += 1; continue; }
    // A control SYMBOL (non-alphabetic), e.g. `\~` (non-breaking space).
    if (!/[a-zA-Z]/.test(next)) {
      if (next === '~') emit(' ');
      if (next === '-' || next === '_') emit('');
      i += 1;
      continue;
    }

    // A control WORD: letters, an optional signed numeric parameter, and an
    // optional single trailing space that is part of the delimiter, not text.
    const match = /^([a-zA-Z]+)(-?\d+)? ?/.exec(source.slice(i + 1));
    if (!match) { i += 1; continue; }
    const word = match[1];
    const param = match[2] === undefined ? null : Number.parseInt(match[2], 10);
    i += match[0].length;

    if (SKIP_DESTINATIONS.has(word)) { state.skip = true; continue; }
    if (state.skip) continue;

    switch (word) {
      case 'par': case 'sect': endParagraph(); break;
      case 'line': flushRun(); buffer = '\n'; break;
      case 'tab': emit('\t'); break;
      case 'b': flushRun(); state.bold = param !== 0; break;
      case 'i': flushRun(); state.italic = param !== 0; break;
      case 'plain': flushRun(); state.bold = false; state.italic = false; break;
      case 'outlinelevel': state.outline = (param ?? 0) + 1; break;
      case 'pard': state.outline = 0; break;
      case 'uc': unicodeSkip = param ?? 1; break;
      case 'u': {
        if (param === null) break;
        // RTF writes codepoints above 32767 as a negative 16-bit value.
        const code = param < 0 ? param + 65536 : param;
        emit(String.fromCodePoint(code));
        skipFallback = unicodeSkip;
        break;
      }
      case 'emdash': emit('—'); break;
      case 'endash': emit('–'); break;
      case 'lquote': emit('‘'); break;
      case 'rquote': emit('’'); break;
      case 'ldblquote': emit('“'); break;
      case 'rdblquote': emit('”'); break;
      case 'bullet': emit('•'); break;
      default: break;                              // every other control word is formatting we drop
    }
  }
  endParagraph();
  if (!doc.blocks.length) doc.notes.push('No readable text was found in this RTF file.');
  return finalizeDocument(doc);
};
