// @ts-check
// .docx → Markdown.
//
// The body is `word/document.xml`; everything else is lookups:
//   word/_rels/document.xml.rels  — hyperlink targets (r:id → URL)
//   word/numbering.xml            — whether a list is bulleted or numbered
//   docProps/core.xml             — title/author
//
// Two structural facts drive the shape of this walker:
//
//   * A "list" in Word is not a container. Each list item is an ordinary
//     paragraph carrying a `w:numPr` (numbering id + indent level), and the
//     list exists only as a run of consecutive such paragraphs. So list
//     detection is a GROUPING pass over the paragraph stream, not a descent.
//   * A table cell contains paragraphs, and those paragraphs can contain
//     tables. We flatten cell content to a single line, because a GFM cell
//     cannot hold a block — nesting a real table would produce broken output.

import { parseXml, findAll, elements, textOf, find } from '../xml.js';
import { readZipIndex, readZipText } from '../zip.js';
import { makeDocument, heading, paragraph, table, inline, finalizeDocument } from '../model.js';
import { loadRelationships, loadCoreProperties, headingLevelForStyle } from './ooxml.js';
import { DocParseError } from '../errors.js';

const MAX_TABLE_ROWS = 500;

/**
 * Numbering id → whether that list level is ordered. Word stores the format on
 * the ABSTRACT numbering definition, reached through an indirection: the
 * paragraph names a `numId`, `w:num` maps that to an `abstractNumId`, and the
 * per-level `w:numFmt` lives there. Missing pieces fall back to "bulleted",
 * which is the safer guess — a wrongly-numbered list invents ordering that the
 * document never claimed.
 *
 * @param {string|null} xml
 * @returns {Map<string, boolean>}   `${numId}:${ilvl}` → ordered
 */
export const parseNumbering = (xml) => {
  /** @type {Map<string, boolean>} */
  const ordered = new Map();
  if (!xml) return ordered;
  try {
    const root = parseXml(xml);
    /** @type {Map<string, Map<string, boolean>>} */
    const abstract = new Map();
    for (const node of findAll(root, 'abstractNum')) {
      const id = node.attrs.abstractNumId;
      if (!id) continue;
      /** @type {Map<string, boolean>} */
      const levels = new Map();
      for (const lvl of findAll(node, 'lvl')) {
        const fmt = find(lvl, 'numFmt')?.attrs.val ?? 'bullet';
        levels.set(lvl.attrs.ilvl ?? '0', fmt !== 'bullet' && fmt !== 'none');
      }
      abstract.set(id, levels);
    }
    for (const num of findAll(root, 'num')) {
      const numId = num.attrs.numId;
      const target = find(num, 'abstractNumId')?.attrs.val;
      if (!numId || target === undefined) continue;
      const levels = abstract.get(target);
      if (!levels) continue;
      for (const [ilvl, isOrdered] of levels) ordered.set(`${numId}:${ilvl}`, isOrdered);
    }
  } catch { /* numbering is a nicety — every list falls back to bulleted */ }
  return ordered;
};

/**
 * The styled runs of one `w:p`, resolving hyperlinks through the rels map.
 *
 * @param {import('../xml.js').XmlNode} node
 * @param {Map<string,string>} rels
 * @returns {import('../model.js').Inline[]}
 */
const runsOf = (node, rels) => {
  /** @type {import('../model.js').Inline[]} */
  const out = [];
  /**
   * @param {import('../xml.js').XmlNode} parent
   * @param {string|undefined} href
   */
  const walk = (parent, href) => {
    for (const child of parent.children) {
      if (typeof child === 'string') continue;
      if (child.local === 'hyperlink') {
        // An external link resolves through rels; an internal one (anchor) has
        // no target and degrades to plain text, which is correct — a bookmark
        // reference means nothing outside the document.
        const id = child.attrs.id ?? child.attrs.embed;
        walk(child, id ? rels.get(id) : undefined);
        continue;
      }
      if (child.local === 'r') {
        const props = find(child, 'rPr');
        // `w:b` with no val is ON; `w:b val="0"` is OFF. Both appear.
        const isOn = (/** @type {string} */ local) => {
          if (!props) return false;
          const el = elements(props, local)[0];
          if (!el) return false;
          const val = el.attrs.val;
          return val !== '0' && val !== 'false';
        };
        const bold = isOn('b');
        const italic = isOn('i');
        for (const piece of child.children) {
          if (typeof piece === 'string') continue;
          if (piece.local === 't') out.push(inline(textOf(piece), { bold: bold || undefined, italic: italic || undefined, href }));
          else if (piece.local === 'tab') out.push(inline(' '));
          else if (piece.local === 'br') out.push(inline('\n'));
        }
        continue;
      }
      // Structured-document tags (content controls) and smart tags wrap runs;
      // descend through them rather than losing their text.
      if (child.local === 'sdt' || child.local === 'sdtContent' || child.local === 'smartTag' || child.local === 'ins') {
        walk(child, href);
      }
    }
  };
  walk(node, undefined);
  return out;
};

/**
 * @param {import('../xml.js').XmlNode} node
 * @returns {{ styleId: string|undefined, numId: string|undefined, ilvl: string, outline: number }}
 */
const paragraphProps = (node) => {
  const props = find(node, 'pPr');
  if (!props) return { styleId: undefined, numId: undefined, ilvl: '0', outline: 0 };
  const numPr = find(props, 'numPr');
  const outlineVal = find(props, 'outlineLvl')?.attrs.val;
  return {
    styleId: find(props, 'pStyle')?.attrs.val,
    // numId 0 is Word's explicit "this paragraph is NOT in a list" — a
    // formatting removal, not list membership. Treating it as a list produces
    // stray bullets on ordinary paragraphs.
    numId: (() => {
      const id = numPr ? find(numPr, 'numId')?.attrs.val : undefined;
      return id && id !== '0' ? id : undefined;
    })(),
    ilvl: (numPr ? find(numPr, 'ilvl')?.attrs.val : undefined) ?? '0',
    // outlineLvl is 0-based; 9 means "body text".
    outline: outlineVal !== undefined && Number(outlineVal) < 9 ? Number(outlineVal) + 1 : 0,
  };
};

/** Flatten a table cell to one line — GFM cells cannot hold blocks. */
const cellText = (/** @type {import('../xml.js').XmlNode} */ cell) => (
  elements(cell, 'p').map((p) => textOf(p).trim()).filter(Boolean).join(' ')
  || textOf(cell).trim()
);

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<import('../model.js').Document>}
 */
export const parseDocx = async (bytes) => {
  const index = readZipIndex(bytes);
  const xml = await readZipText(bytes, index, 'word/document.xml');
  if (!xml) throw new DocParseError('word/document.xml is missing — not a Word document', { format: 'docx' });

  const [rels, numbering, core] = await Promise.all([
    loadRelationships(bytes, index, 'word/document.xml'),
    readZipText(bytes, index, 'word/numbering.xml').catch(() => null).then(parseNumbering),
    loadCoreProperties(bytes, index),
  ]);

  const root = parseXml(xml);
  const body = find(root, 'body');
  if (!body) throw new DocParseError('the Word document has no body', { format: 'docx' });

  const doc = makeDocument({ format: 'docx', title: core.title, meta: core.meta });
  /** @type {import('../model.js').ListBlock | null} */
  let openList = null;

  // Only DIRECT children of the body are the document flow — findAll would
  // also return the paragraphs nested inside table cells and emit them twice.
  for (const node of body.children) {
    if (typeof node === 'string') continue;

    if (node.local === 'p') {
      const props = paragraphProps(node);
      const inlines = runsOf(node, rels);
      if (props.numId) {
        const level = Number.parseInt(props.ilvl, 10) || 0;
        const ordered = numbering.get(`${props.numId}:${props.ilvl}`) ?? false;
        // A change of marker kind ends the list — `1. / - / 1.` is three lists,
        // not one, and merging them would renumber the source's meaning.
        if (!openList || openList.ordered !== ordered) {
          openList = { type: 'list', ordered, items: [] };
          doc.blocks.push(openList);
        }
        openList.items.push({ level, inlines });
        continue;
      }
      openList = null;
      const level = headingLevelForStyle(props.styleId) || props.outline;
      doc.blocks.push(level ? heading(level, inlines) : paragraph(inlines));
      continue;
    }

    if (node.local === 'tbl') {
      openList = null;
      const rows = elements(node, 'tr').map((tr) => elements(tr, 'tc').map(cellText));
      if (!rows.length) continue;
      const shown = rows.slice(0, MAX_TABLE_ROWS + 1);
      const dropped = rows.length - shown.length;
      doc.blocks.push(table(shown, { header: true, truncatedRows: dropped > 0 ? dropped : undefined }));
      continue;
    }

    if (node.local === 'sectPr') continue;         // section properties are layout, not content
  }

  if (!doc.blocks.length) doc.notes.push('The document contained no readable text.');
  return finalizeDocument(doc);
};
