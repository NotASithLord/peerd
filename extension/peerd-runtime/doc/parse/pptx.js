// @ts-check
// .pptx → Markdown (one section per slide).
//
// Slide XML is a drawing tree: shapes (`p:sp`) positioned on a canvas, each
// holding a text body of paragraphs (`a:p`) of runs (`a:r`/`a:t`). There is no
// reading order in the markup — order is GEOMETRY, which we do not reconstruct;
// document order is the writer's shape order and is right often enough.
//
// The two things worth doing beyond dumping text:
//   * TITLE detection. A shape whose placeholder type is `title`/`ctrTitle` is
//     the slide's heading, which turns a flat text dump into an outline.
//   * SPEAKER NOTES, from the sibling notesSlideN.xml. Notes routinely carry
//     the actual argument while the slide carries three words, so dropping them
//     loses most of the document's content.

import { parseXml, findAll, elements, textOf, find } from '../xml.js';
import { readZipIndex, readZipText } from '../zip.js';
import { makeDocument, heading, paragraph, table, inline, finalizeDocument } from '../model.js';
import { loadRelationships, loadCoreProperties } from './ooxml.js';
import { DocParseError } from '../errors.js';

/** Slide part paths in presentation order. */
const slidePathsOf = (/** @type {Map<string,string>} */ rels, /** @type {import('../xml.js').XmlNode} */ presentation) => {
  /** @type {string[]} */
  const paths = [];
  // p:sldIdLst is the authoritative ORDER; the rels map alone is unordered.
  const list = find(presentation, 'sldIdLst');
  for (const slideId of list ? elements(list, 'sldId') : []) {
    const target = slideId.attrs.id ? rels.get(slideId.attrs.id) : undefined;
    if (target) paths.push(target.startsWith('/') ? target.slice(1) : `ppt/${target.replace(/^\.\.\//, '').replace(/^\.\//, '')}`);
  }
  return paths;
};

/** The runs of one `a:p`, carrying bold/italic from `a:rPr`. */
const runsOfParagraph = (/** @type {import('../xml.js').XmlNode} */ node) => {
  /** @type {import('../model.js').Inline[]} */
  const out = [];
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.local === 'br') { out.push(inline(' ')); continue; }
    if (child.local !== 'r' && child.local !== 'fld') continue;
    const props = find(child, 'rPr');
    const on = (/** @type {string} */ attr) => props?.attrs[attr] === '1' || props?.attrs[attr] === 'true';
    const text = elements(child, 't').map(textOf).join('');
    if (text) out.push(inline(text, { bold: on('b') || undefined, italic: on('i') || undefined }));
  }
  return out;
};

/** Is this shape the slide's title placeholder? */
const isTitleShape = (/** @type {import('../xml.js').XmlNode} */ shape) => {
  const ph = find(shape, 'ph');
  const type = ph?.attrs.type ?? '';
  return type === 'title' || type === 'ctrTitle';
};

/**
 * @param {string} xml
 * @param {number} number
 * @returns {import('../model.js').Block[]}
 */
export const parseSlide = (xml, number) => {
  const root = parseXml(xml);
  /** @type {import('../model.js').Block[]} */
  const blocks = [];
  /** @type {import('../model.js').Block[]} */
  const body = [];
  let title = '';

  for (const shape of findAll(root, 'sp')) {
    const paragraphs = findAll(shape, 'p').map(runsOfParagraph).filter((runs) => runs.some((r) => r.text.trim()));
    if (!paragraphs.length) continue;
    if (!title && isTitleShape(shape)) {
      title = paragraphs.map((runs) => runs.map((r) => r.text).join('')).join(' ').trim();
      continue;
    }
    for (const runs of paragraphs) body.push(paragraph(runs));
  }

  // Tables live in graphicFrames, not shapes, so they are walked separately.
  for (const tbl of findAll(root, 'tbl')) {
    const rows = elements(tbl, 'tr').map((tr) => elements(tr, 'tc').map((tc) => textOf(tc).trim()));
    if (rows.length) body.push(table(rows, { header: true }));
  }

  blocks.push(heading(2, title ? `Slide ${number}: ${title}` : `Slide ${number}`));
  blocks.push(...body);
  return blocks;
};

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<import('../model.js').Document>}
 */
export const parsePptx = async (bytes) => {
  const index = readZipIndex(bytes);
  const presentationXml = await readZipText(bytes, index, 'ppt/presentation.xml');
  if (!presentationXml) throw new DocParseError('ppt/presentation.xml is missing — not a PowerPoint file', { format: 'pptx' });

  const [rels, core] = await Promise.all([
    loadRelationships(bytes, index, 'ppt/presentation.xml'),
    loadCoreProperties(bytes, index),
  ]);

  const doc = makeDocument({ format: 'pptx', title: core.title, meta: core.meta });
  const paths = slidePathsOf(rels, parseXml(presentationXml));

  let number = 0;
  for (const path of paths) {
    number += 1;
    const xml = await readZipText(bytes, index, path).catch(() => null);
    if (!xml) { doc.notes.push(`Slide ${number} could not be read.`); continue; }
    try {
      doc.blocks.push(...parseSlide(xml, number));
    } catch {
      doc.notes.push(`Slide ${number} is malformed and was skipped.`);
      continue;
    }
    // Speaker notes: reached through the SLIDE's own rels, not the deck's.
    const slideRels = await loadRelationships(bytes, index, path);
    const notesTarget = [...slideRels.values()].find((t) => t.includes('notesSlide'));
    if (!notesTarget) continue;
    const notesPath = notesTarget.startsWith('/')
      ? notesTarget.slice(1)
      : `ppt/slides/${notesTarget}`.replace(/\/[^/]+\/\.\.\//g, '/');
    const notesXml = await readZipText(bytes, index, notesPath).catch(() => null);
    if (!notesXml) continue;
    try {
      const text = findAll(parseXml(notesXml), 'p')
        .map((p) => runsOfParagraph(p).map((r) => r.text).join('').trim())
        .filter(Boolean)
        // The notes placeholder repeats the slide number as its own shape;
        // a bare integer line is that artifact, not content.
        .filter((line) => !/^\d+$/.test(line));
      if (text.length) {
        doc.blocks.push(heading(3, 'Speaker notes'));
        for (const line of text) doc.blocks.push(paragraph(line));
      }
    } catch { /* notes are a bonus */ }
  }

  if (!paths.length) doc.notes.push('The presentation contains no slides.');
  doc.meta.slides = String(paths.length);
  return finalizeDocument(doc);
};
