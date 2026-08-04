// @ts-check
// .xlsx → Markdown (one table per sheet).
//
// The parts:
//   xl/workbook.xml            — sheet names, in tab order
//   xl/_rels/workbook.xml.rels — sheet name → worksheet part path
//   xl/sharedStrings.xml       — the string pool
//   xl/worksheets/sheetN.xml   — the cells
//
// Three things a naive reader gets wrong, all of which silently corrupt the
// grid rather than failing:
//
//   * Cells are SPARSE. An empty cell is simply absent, so reading cells in
//     document order shifts every value left. The cell's `r` ("C7") is the
//     authority for its column, not its position among its siblings.
//   * Strings are POOLED. `t="s"` means the value is an INDEX into
//     sharedStrings, so an unresolved pool renders a spreadsheet of integers.
//   * Formula cells carry both the formula and its last cached result. The
//     cached value is what the user sees, so that is what we read.

import { parseXml, findAll, elements, textOf, find } from '../xml.js';
import { readZipIndex, readZipText } from '../zip.js';
import { makeDocument, heading, table, finalizeDocument } from '../model.js';
import { loadRelationships, loadCoreProperties } from './ooxml.js';
import { DocParseError } from '../errors.js';

const MAX_ROWS_PER_SHEET = 500;
const MAX_COLUMNS = 64;

/**
 * Column index from a cell reference: A→0, Z→25, AA→26. Base-26 with no zero
 * digit, so it is not quite positional arithmetic.
 * @param {string} ref
 */
export const columnIndex = (ref) => {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;             // hit the row digits
    n = n * 26 + (code - 64);
  }
  return n - 1;
};

/**
 * The shared string pool. Each `si` may be a single `t`, or a set of styled
 * runs (`r`) that concatenate into one string.
 * @param {string|null} xml
 * @returns {string[]}
 */
export const parseSharedStrings = (xml) => {
  if (!xml) return [];
  try {
    return findAll(parseXml(xml), 'si').map((si) => {
      const runs = elements(si, 'r');
      if (runs.length) return runs.map((r) => elements(r, 't').map(textOf).join('')).join('');
      return elements(si, 't').map(textOf).join('');
    });
  } catch { return []; }
};

/**
 * One worksheet's cells as a dense grid.
 *
 * @param {string} xml
 * @param {string[]} strings
 * @returns {{ rows: string[][], totalRows: number, truncatedColumns: boolean }}
 */
export const parseSheet = (xml, strings) => {
  const root = parseXml(xml);
  const sheetData = find(root, 'sheetData');
  /** @type {string[][]} */
  const rows = [];
  let totalRows = 0;
  let truncatedColumns = false;
  if (!sheetData) return { rows, totalRows, truncatedColumns };

  for (const row of elements(sheetData, 'row')) {
    totalRows += 1;
    if (rows.length >= MAX_ROWS_PER_SHEET) continue;   // keep counting for the honest "N more rows"
    /** @type {string[]} */
    const cells = [];
    for (const cell of elements(row, 'c')) {
      const at = cell.attrs.r ? columnIndex(cell.attrs.r) : cells.length;
      if (at >= MAX_COLUMNS) { truncatedColumns = true; continue; }
      const type = cell.attrs.t;
      let value = '';
      if (type === 'inlineStr') {
        value = elements(find(cell, 'is') ?? cell, 't').map(textOf).join('') || textOf(find(cell, 'is') ?? cell);
      } else {
        const v = find(cell, 'v');
        const raw = v ? textOf(v) : '';
        if (type === 's') {
          const idx = Number.parseInt(raw, 10);
          value = Number.isInteger(idx) ? (strings[idx] ?? '') : '';
        } else if (type === 'b') {
          value = raw === '1' ? 'TRUE' : 'FALSE';
        } else if (type === 'e') {
          value = raw;                                  // an error literal: #REF!, #DIV/0!
        } else {
          // Numeric (or a date, which Excel stores as a number plus a display
          // format we do not read — see the note the parser attaches).
          value = raw;
        }
      }
      // Pad the gap left by absent cells so the column position is preserved.
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    rows.push(cells);
  }
  return { rows, totalRows, truncatedColumns };
};

/** Trim wholly-empty trailing rows and columns — sheets are padded with them. */
const trimGrid = (/** @type {string[][]} */ rows) => {
  const out = rows.slice();
  while (out.length && out[out.length - 1].every((c) => !c.trim())) out.pop();
  const width = out.reduce((n, r) => Math.max(n, r.length), 0);
  let last = -1;
  for (let col = 0; col < width; col += 1) {
    if (out.some((r) => (r[col] ?? '').trim())) last = col;
  }
  return out.map((r) => Array.from({ length: last + 1 }, (_, i) => r[i] ?? ''));
};

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<import('../model.js').Document>}
 */
export const parseXlsx = async (bytes) => {
  const index = readZipIndex(bytes);
  const workbookXml = await readZipText(bytes, index, 'xl/workbook.xml');
  if (!workbookXml) throw new DocParseError('xl/workbook.xml is missing — not an Excel workbook', { format: 'xlsx' });

  const [rels, strings, core] = await Promise.all([
    loadRelationships(bytes, index, 'xl/workbook.xml'),
    readZipText(bytes, index, 'xl/sharedStrings.xml').catch(() => null).then(parseSharedStrings),
    loadCoreProperties(bytes, index),
  ]);

  const doc = makeDocument({ format: 'xlsx', title: core.title, meta: core.meta });
  const sheets = findAll(parseXml(workbookXml), 'sheet');
  let anyDates = false;

  for (const sheet of sheets) {
    const name = sheet.attrs.name ?? 'Sheet';
    // A hidden sheet is hidden from the USER, so reading it would report data
    // the document does not present. Skipped, and counted in the notes.
    if (sheet.attrs.state === 'hidden' || sheet.attrs.state === 'veryHidden') {
      doc.notes.push(`Sheet "${name}" is hidden and was not read.`);
      continue;
    }
    const relId = sheet.attrs.id;
    const target = relId ? rels.get(relId) : undefined;
    // Rel targets are relative to the part's directory (xl/), and some writers
    // emit them absolute (/xl/worksheets/...).
    const path = target
      ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
      : '';
    const sheetXml = path ? await readZipText(bytes, index, path).catch(() => null) : null;
    if (!sheetXml) {
      doc.notes.push(`Sheet "${name}" could not be read.`);
      continue;
    }
    let parsed;
    try { parsed = parseSheet(sheetXml, strings); }
    catch { doc.notes.push(`Sheet "${name}" is malformed and was skipped.`); continue; }

    const rows = trimGrid(parsed.rows);
    doc.blocks.push(heading(2, name));
    if (!rows.length) {
      doc.blocks.push({ type: 'paragraph', inlines: [{ text: '_(empty sheet)_' }] });
      continue;
    }
    if (rows.some((r) => r.some((c) => /^\d{5}(\.\d+)?$/.test(c)))) anyDates = true;
    const dropped = parsed.totalRows - rows.length;
    doc.blocks.push(table(rows, { header: true, truncatedRows: dropped > 0 ? dropped : undefined }));
    if (parsed.truncatedColumns) doc.notes.push(`Sheet "${name}" has more than ${MAX_COLUMNS} columns; the rest were omitted.`);
  }

  if (!sheets.length) doc.notes.push('The workbook contains no sheets.');
  if (anyDates) {
    // why say this rather than guess: Excel stores a date as a day count and
    // the human-readable form lives in a number FORMAT we do not read. Silently
    // rendering 45000 as a date would be a guess presented as a fact; saying so
    // lets the reader convert it deliberately.
    doc.notes.push('Dates are stored as serial numbers in .xlsx and appear here as numbers (day count from 1899-12-30).');
  }
  return finalizeDocument(doc);
};
