// @ts-check
// CSV / TSV → a single table.
//
// A real RFC 4180 reader, not a `split(',')`: quoted fields containing the
// delimiter, embedded newlines, and doubled quotes ("" for a literal ") are all
// routine in exported data, and getting any of them wrong silently shifts every
// column after the offending row — the worst kind of failure, because the
// output still looks like a table.

import { makeDocument, table, finalizeDocument } from '../model.js';

/** Rows past this are summarized rather than rendered — see MAX_TABLE_ROWS. */
export const MAX_TABLE_ROWS = 500;

/**
 * Split delimited text into rows of fields.
 *
 * @param {string} text
 * @param {string} delimiter
 * @returns {string[][]}
 */
export const parseDelimited = (text, delimiter) => {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let quoted = false;
  // A BOM at the head of a Windows-exported CSV would otherwise become part of
  // the first column's name.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch !== '"') { field += ch; continue; }
      // A doubled quote inside a quoted field is one literal quote.
      if (source[i + 1] === '"') { field += '"'; i += 1; continue; }
      quoted = false;
      continue;
    }
    if (ch === '"' && !field) { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;                    // CRLF — the \n does the work
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  // A file with no trailing newline still has a final row.
  if (field || row.length) { row.push(field); rows.push(row); }
  // Drop wholly-empty trailing rows (a trailing newline produces one).
  while (rows.length && rows[rows.length - 1].every((c) => !c.trim())) rows.pop();
  return rows;
};

/**
 * @param {string} text
 * @param {{ format?: 'csv'|'tsv', name?: string }} [opts]
 * @returns {import('../model.js').Document}
 */
export const parseCsv = (text, opts = {}) => {
  const format = opts.format ?? 'csv';
  const rows = parseDelimited(text, format === 'tsv' ? '\t' : ',');
  const doc = makeDocument({ format, title: opts.name ?? null });
  if (!rows.length) {
    doc.notes.push('The file contained no rows.');
    return finalizeDocument(doc);
  }
  const shown = rows.slice(0, MAX_TABLE_ROWS + 1);       // +1 for the header row
  const dropped = rows.length - shown.length;
  doc.blocks.push(table(shown, { header: true, truncatedRows: dropped > 0 ? dropped : undefined }));
  doc.meta.rows = String(rows.length - 1);
  doc.meta.columns = String(rows[0]?.length ?? 0);
  return finalizeDocument(doc);
};
