// @ts-check
// OpenDocument (.odt / .ods / .odp) → Markdown.
//
// One walker for all three, because ODF really is one format with three body
// elements: `office:text`, `office:spreadsheet`, `office:presentation`. That is
// the opposite of OOXML, where the three formats share only a ZIP container.
//
// The trap that makes or breaks an ODS reader is REPEAT COUNTS. ODF compresses
// runs of identical cells and rows with `table:number-columns-repeated` — and
// LibreOffice pads every sheet to its full grid, so a 3-column sheet ends with
// a cell carrying `number-columns-repeated="16381"`. Expanding that naively
// allocates a 16384-column row per row; ignoring it shifts every column after
// a repeat. Both are wrong, so we expand with a cap and trim the padding after.

import { parseXml, elements, textOf, find } from '../xml.js';
import { readZipIndex, readZipText } from '../zip.js';
import { makeDocument, heading, paragraph, table, inline, finalizeDocument } from '../model.js';
import { DocParseError } from '../errors.js';

const MAX_TABLE_ROWS = 500;
const MAX_COLUMNS = 64;

/** Inline runs of a text:p / text:h, following text:span and text:a. */
const runsOf = (/** @type {import('../xml.js').XmlNode} */ node, /** @type {{bold?:boolean, italic?:boolean, href?:string}} */ style = {}) => {
  /** @type {import('../model.js').Inline[]} */
  const out = [];
  for (const child of node.children) {
    if (typeof child === 'string') { out.push(inline(child, style)); continue; }
    if (child.local === 'a') {
      out.push(...runsOf(child, { ...style, href: child.attrs.href }));
      continue;
    }
    if (child.local === 's') {
      // An explicit space run: `<text:s text:c="4"/>` is four spaces.
      out.push(inline(' '.repeat(Number.parseInt(child.attrs.c ?? '1', 10) || 1), style));
      continue;
    }
    if (child.local === 'tab') { out.push(inline(' ', style)); continue; }
    if (child.local === 'line-break') { out.push(inline('\n', style)); continue; }
    // span carries the styling, but the style NAME points into styles.xml,
    // which we do not resolve — ODF has no direct bold attribute. So spans
    // contribute text, not emphasis. (Losing bold is cheap; losing the text
    // inside every span would not be.)
    out.push(...runsOf(child, style));
  }
  return out;
};

/** Expand a repeated cell/row count, capped so a padded sheet cannot blow up. */
const repeatOf = (/** @type {string|undefined} */ raw, /** @type {number} */ cap) => {
  const n = Number.parseInt(raw ?? '1', 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, cap);
};

/** One table:table → rows of cell text. */
const rowsOfTable = (/** @type {import('../xml.js').XmlNode} */ node) => {
  /** @type {string[][]} */
  const rows = [];
  let total = 0;
  for (const rowNode of elements(node, 'table-row')) {
    const rowRepeat = repeatOf(rowNode.attrs['number-rows-repeated'], MAX_TABLE_ROWS);
    /** @type {string[]} */
    const cells = [];
    for (const cell of rowNode.children) {
      if (typeof cell === 'string') continue;
      if (cell.local !== 'table-cell' && cell.local !== 'covered-table-cell') continue;
      const text = elements(cell, 'p').map((p) => textOf(p).trim()).filter(Boolean).join(' ');
      const repeat = repeatOf(cell.attrs['number-columns-repeated'], MAX_COLUMNS);
      for (let i = 0; i < repeat && cells.length < MAX_COLUMNS; i += 1) cells.push(text);
    }
    // An all-empty repeated row is LibreOffice's grid padding, not data.
    const empty = cells.every((c) => !c.trim());
    for (let i = 0; i < rowRepeat; i += 1) {
      total += 1;
      if (empty && rows.length === 0) break;               // leading padding
      if (rows.length < MAX_TABLE_ROWS) rows.push(cells.slice());
      if (empty) break;                                    // never repeat a blank row
    }
  }
  while (rows.length && rows[rows.length - 1].every((c) => !c.trim())) rows.pop();
  // Trim the trailing all-empty columns the padding left behind.
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  let last = -1;
  for (let col = 0; col < width; col += 1) {
    if (rows.some((r) => (r[col] ?? '').trim())) last = col;
  }
  const trimmed = rows.map((r) => Array.from({ length: last + 1 }, (_, i) => r[i] ?? ''));
  return { rows: trimmed, truncated: Math.max(0, total - trimmed.length) };
};

/**
 * A `text:list` and everything nested under it, as ONE list block.
 * @param {import('../xml.js').XmlNode} listNode
 * @param {number} level
 * @returns {import('../model.js').ListBlock}
 */
const collectList = (listNode, level) => {
  /** @type {import('../model.js').ListBlock} */
  const list = { type: 'list', ordered: false, items: [] };
  /** @param {import('../xml.js').XmlNode} node @param {number} depth */
  const walk = (node, depth) => {
    for (const item of elements(node, 'list-item')) {
      for (const p of elements(item, 'p')) list.items.push({ level: depth, inlines: runsOf(p) });
      // Capped like the EPUB walker: past a few levels the indentation carries
      // no more meaning, and the depth is attacker-controlled.
      if (depth < 6) for (const sub of elements(item, 'list')) walk(sub, depth + 1);
    }
  };
  walk(listNode, level);
  return list;
};

/** @param {import('../xml.js').XmlNode} node @param {import('../model.js').Block[]} out @param {number} listLevel */
const walkText = (node, out, listLevel = 0) => {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    switch (child.local) {
      case 'h': {
        const level = Number.parseInt(child.attrs['outline-level'] ?? '1', 10) || 1;
        out.push(heading(level, runsOf(child)));
        break;
      }
      case 'p':
        out.push(paragraph(runsOf(child)));
        break;
      case 'list':
        // ODF nests a sublist INSIDE the parent's list-item, so depth is the
        // recursion depth — there is no per-item level attribute. Everything
        // lands in ONE list block: recursing into `out` instead would append
        // the sublist as a sibling block while the parent list is still
        // collecting items, so a sublist would render BEFORE the parent items
        // that follow it.
        out.push(collectList(child, listLevel));
        break;
      case 'table': {
        const { rows, truncated } = rowsOfTable(child);
        if (rows.length) out.push(table(rows, { header: true, truncatedRows: truncated || undefined }));
        break;
      }
      case 'section': case 'frame': case 'text-box': case 'a':
        walkText(child, out, listLevel);
        break;
      default:
        break;
    }
  }
};

/**
 * @param {Uint8Array} bytes
 * @param {'odt'|'ods'|'odp'} format
 * @returns {Promise<import('../model.js').Document>}
 */
export const parseOdf = async (bytes, format) => {
  const index = readZipIndex(bytes);
  const xml = await readZipText(bytes, index, 'content.xml');
  if (!xml) throw new DocParseError('content.xml is missing — not an OpenDocument file', { format });

  const doc = makeDocument({ format });
  // meta.xml is a separate part in ODF (unlike OOXML's docProps).
  const metaXml = await readZipText(bytes, index, 'meta.xml').catch(() => null);
  if (metaXml) {
    try {
      const meta = parseXml(metaXml);
      doc.title = find(meta, 'title') ? textOf(/** @type {any} */ (find(meta, 'title'))).trim() || null : null;
      const creator = find(meta, 'creator');
      if (creator) doc.meta.author = textOf(creator).trim();
    } catch { /* metadata is a nicety */ }
  }

  const root = parseXml(xml);
  const body = find(root, 'body');
  if (!body) throw new DocParseError('the OpenDocument file has no body', { format });

  if (format === 'ods') {
    const sheet = find(body, 'spreadsheet') ?? body;
    for (const tbl of elements(sheet, 'table')) {
      const name = tbl.attrs.name ?? 'Sheet';
      const { rows, truncated } = rowsOfTable(tbl);
      doc.blocks.push(heading(2, name));
      if (!rows.length) {
        doc.blocks.push(paragraph([inline('_(empty sheet)_')]));
        continue;
      }
      doc.blocks.push(table(rows, { header: true, truncatedRows: truncated || undefined }));
    }
  } else if (format === 'odp') {
    const presentation = find(body, 'presentation') ?? body;
    let number = 0;
    for (const page of elements(presentation, 'page')) {
      number += 1;
      /** @type {import('../model.js').Block[]} */
      const slide = [];
      walkText(page, slide);
      doc.blocks.push(heading(2, page.attrs.name ? `Slide ${number}: ${page.attrs.name}` : `Slide ${number}`));
      doc.blocks.push(...slide);
    }
    doc.meta.slides = String(number);
  } else {
    walkText(find(body, 'text') ?? body, doc.blocks);
  }

  if (!doc.blocks.length) doc.notes.push('The document contained no readable text.');
  return finalizeDocument(doc);
};
