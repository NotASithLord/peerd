// @ts-check
// Document → the body string the read_doc tool returns.
//
// Mirrors pdf/extract-format.js: a pure formatter, so the cap-and-render rules
// are unit-testable without a browser, a network, or a document.
//
// The truncation rule is the interesting one. A model that receives a silently
// cut document will confidently answer questions about the missing half, so a
// cut is ALWAYS announced, and announced with the numbers needed to decide what
// to do next (how much was shown, of how much).

import { toMarkdown } from './markdown.js';

/** Default cap on the returned markdown. Roughly 12k tokens of prose. */
export const DEFAULT_MAX_CHARS = 48_000;

/**
 * A short provenance header. Kept to one line per fact and omitted entirely
 * when there is nothing to say — a header longer than the document is a common
 * converter tax.
 *
 * @param {import('./model.js').Document} doc
 * @returns {string}
 */
export const formatHeader = (doc) => {
  const bits = [`format: ${doc.format}`];
  if (doc.title) bits.push(`title: ${doc.title}`);
  for (const [key, value] of Object.entries(doc.meta)) {
    if (value) bits.push(`${key}: ${value}`);
  }
  return bits.join(' · ');
};

/**
 * The provenance/notes lines that precede the converted text. Shared so the
 * read_doc tool can prepend them to a SPILLED window without re-deriving them.
 *
 * @param {{ doc: import('./model.js').Document, source?: string }} input
 * @returns {string}
 */
export const formatDocHead = ({ doc, source }) => {
  const head = [`[${formatHeader(doc)}]`];
  if (source) head.push(`[source: ${source}]`);
  if (doc.notes.length) head.push(...doc.notes.map((n) => `[note: ${n}]`));
  return head.join('\n');
};

/**
 * Render a converted document for the model, capped. This is the fallback for
 * a context with no spill cache — read_doc prefers windowing + paging, which
 * keeps the whole text reachable instead of discarding the tail.
 *
 * @param {{ doc: import('./model.js').Document, maxChars?: number, source?: string }} input
 * @returns {string}
 */
export const formatDocBody = ({ doc, maxChars = DEFAULT_MAX_CHARS, source }) => {
  const markdown = toMarkdown(doc);
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
  const head = [formatDocHead({ doc, source })];

  let body = markdown;
  if (markdown.length > cap) {
    // Cut at a block boundary when one is near the limit, so the tail is not a
    // half-sentence or a half-table (a truncated GFM table stops parsing as a
    // table at all).
    const window = markdown.slice(0, cap);
    const boundary = window.lastIndexOf('\n\n');
    const cut = boundary > cap * 0.8 ? boundary : cap;
    body = `${markdown.slice(0, cut).trimEnd()}\n\n_… truncated: showing ${cut} of ${markdown.length} characters. `
      + 'Re-read with a larger maxChars, or ask for a specific section._';
  }
  if (!markdown.trim()) {
    body = '_(this document converted to no text — it may be entirely images, or empty)_';
  }
  return `${head.join('\n')}\n\n${body}`;
};
