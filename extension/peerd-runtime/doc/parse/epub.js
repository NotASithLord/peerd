// @ts-check
// .epub → Markdown.
//
// An EPUB is a ZIP of XHTML, so the work is mostly navigation, not parsing:
//
//   META-INF/container.xml  → the path of the OPF package document
//   the OPF                 → metadata, a manifest of parts, and the SPINE
//   each spine item         → XHTML
//
// The spine is the load-bearing piece. The manifest lists every file in the
// book including CSS, fonts, and cover images; the spine lists the content
// documents IN READING ORDER. Converting the manifest instead of the spine is
// the classic epub-reader bug — it produces the right words in the wrong order,
// with the copyright page in the middle.
//
// why an XHTML walker here rather than the vendored Readability+Turndown that
// fetch_url uses: those need a DOM, which pins the conversion to the offscreen
// document. EPUB content is spec-required XHTML, so the pure XML reader handles
// it — and keeping it pure means the whole doc pipeline stays testable and
// context-agnostic.

import { parseXml, elements, textOf, find, findAll } from '../xml.js';
import { readZipIndex, readZipText } from '../zip.js';
import { makeDocument, heading, paragraph, table, inline, finalizeDocument } from '../model.js';
import { DocParseError } from '../errors.js';

/** Spine items past this are not read — a reference work can carry thousands. */
const MAX_SPINE_ITEMS = 300;

const BLOCK_SKIP = new Set(['script', 'style', 'head', 'nav', 'svg', 'audio', 'video', 'iframe']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Resolve an OPF-relative href against the package document's directory. */
export const resolveHref = (/** @type {string} */ base, /** @type {string} */ href) => {
  const clean = href.split('#')[0];
  if (!clean) return '';
  if (clean.startsWith('/')) return clean.slice(1);
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  const parts = `${dir}${clean}`.split('/');
  /** @type {string[]} */
  const out = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
};

/** Inline runs of an XHTML element, carrying emphasis and links. */
const runsOf = (/** @type {import('../xml.js').XmlNode} */ node, /** @type {{bold?:boolean,italic?:boolean,code?:boolean,href?:string}} */ style = {}) => {
  /** @type {import('../model.js').Inline[]} */
  const out = [];
  for (const child of node.children) {
    if (typeof child === 'string') {
      // XHTML collapses whitespace; keeping the raw newlines would break
      // paragraphs into ragged lines.
      out.push(inline(child.replace(/\s+/g, ' '), style));
      continue;
    }
    const tag = child.local.toLowerCase();
    if (BLOCK_SKIP.has(tag)) continue;
    if (tag === 'br') { out.push(inline(' ', style)); continue; }
    if (tag === 'img') {
      const alt = child.attrs.alt?.trim();
      if (alt) out.push(inline(`[image: ${alt}]`, style));
      continue;
    }
    const next = { ...style };
    if (tag === 'strong' || tag === 'b') next.bold = true;
    if (tag === 'em' || tag === 'i') next.italic = true;
    if (tag === 'code' || tag === 'tt' || tag === 'kbd') next.code = true;
    if (tag === 'a' && child.attrs.href && !child.attrs.href.startsWith('#')) next.href = child.attrs.href;
    out.push(...runsOf(child, next));
  }
  return out;
};

/**
 * Flatten a `<ul>`/`<ol>` into ONE list block, nested items carrying a deeper
 * level. Markdown expresses nesting as indentation inside a single list, so
 * this matches the output format exactly.
 *
 * why it is worth its own function: the obvious version — take runsOf(li), then
 * recurse for sublists — emits every nested item TWICE, because runsOf walks
 * the whole subtree and a nested <ul> lives *inside* its parent <li>. So the
 * item's own text must be read from its non-list children only.
 *
 * @param {import('../xml.js').XmlNode} listNode
 * @param {import('../model.js').ListBlock} list
 * @param {number} level
 */
const collectListItems = (listNode, list, level) => {
  for (const li of elements(listNode, 'li')) {
    const nested = /** @type {import('../xml.js').XmlNode[]} */ (
      li.children.filter((c) => typeof c !== 'string' && (c.local === 'ul' || c.local === 'ol')));
    const own = { ...li, children: li.children.filter((c) => !nested.includes(/** @type {any} */ (c))) };
    const inlines = runsOf(own);
    if (inlines.some((r) => r.text.trim())) list.items.push({ level, inlines });
    // Depth is capped: a hostile or generated document can nest arbitrarily,
    // and past a few levels the indentation stops meaning anything anyway.
    if (level < 6) for (const sub of nested) collectListItems(sub, list, level + 1);
  }
};

/**
 * Walk an XHTML subtree into blocks.
 * @param {import('../xml.js').XmlNode} node
 * @param {import('../model.js').Block[]} out
 * @param {number} listLevel
 */
export const walkHtml = (node, out, listLevel = 0) => {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    const tag = child.local.toLowerCase();
    if (BLOCK_SKIP.has(tag)) continue;

    if (HEADINGS.has(tag)) { out.push(heading(Number(tag[1]), runsOf(child))); continue; }
    if (tag === 'p') { out.push(paragraph(runsOf(child))); continue; }
    if (tag === 'blockquote') { out.push({ type: 'quote', inlines: runsOf(child) }); continue; }
    if (tag === 'pre') { out.push({ type: 'code', text: textOf(child).replace(/\s+$/, '') }); continue; }
    if (tag === 'hr') { out.push({ type: 'divider' }); continue; }
    if (tag === 'ul' || tag === 'ol') {
      /** @type {import('../model.js').ListBlock} */
      const list = { type: 'list', ordered: tag === 'ol', items: [] };
      out.push(list);
      collectListItems(child, list, listLevel);
      continue;
    }
    if (tag === 'table') {
      const rows = findAll(child, 'tr').map((tr) => (
        [...findAll(tr, 'td'), ...findAll(tr, 'th')].map((cell) => textOf(cell).replace(/\s+/g, ' ').trim())
      ));
      const useful = rows.filter((r) => r.length);
      if (useful.length) out.push(table(useful, { header: true }));
      continue;
    }
    // Any other element (div, section, article, body…) is a container.
    walkHtml(child, out, listLevel);
  }
};

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<import('../model.js').Document>}
 */
export const parseEpub = async (bytes) => {
  const index = readZipIndex(bytes);
  const containerXml = await readZipText(bytes, index, 'META-INF/container.xml');
  if (!containerXml) throw new DocParseError('META-INF/container.xml is missing — not an EPUB', { format: 'epub' });

  const rootfile = findAll(parseXml(containerXml), 'rootfile')[0];
  const opfPath = rootfile?.attrs['full-path'];
  if (!opfPath) throw new DocParseError('the EPUB container names no package document', { format: 'epub' });

  const opfXml = await readZipText(bytes, index, opfPath);
  if (!opfXml) throw new DocParseError(`the EPUB package document (${opfPath}) is missing`, { format: 'epub' });
  const opf = parseXml(opfXml);

  const doc = makeDocument({ format: 'epub' });
  const metadata = find(opf, 'metadata');
  if (metadata) {
    const title = find(metadata, 'title');
    if (title) doc.title = textOf(title).trim() || null;
    const creator = find(metadata, 'creator');
    if (creator) doc.meta.author = textOf(creator).trim();
    const language = find(metadata, 'language');
    if (language) doc.meta.language = textOf(language).trim();
  }

  // manifest id → href, then the spine's idrefs in reading order.
  /** @type {Map<string,{href:string,type:string}>} */
  const manifest = new Map();
  const manifestNode = find(opf, 'manifest');
  for (const item of manifestNode ? elements(manifestNode, 'item') : []) {
    if (item.attrs.id && item.attrs.href) {
      manifest.set(item.attrs.id, { href: item.attrs.href, type: item.attrs['media-type'] ?? '' });
    }
  }
  const spineNode = find(opf, 'spine');
  const spine = (spineNode ? elements(spineNode, 'itemref') : [])
    .map((ref) => manifest.get(ref.attrs.idref ?? ''))
    .filter(/** @returns {item is {href:string,type:string}} */ (item) => item !== undefined)
    // Only content documents: the spine can also reference an SVG cover.
    .filter((item) => /xhtml|html/i.test(item.type || item.href));

  if (!spine.length) {
    doc.notes.push('The EPUB spine lists no readable content documents.');
    return finalizeDocument(doc);
  }

  const read = spine.slice(0, MAX_SPINE_ITEMS);
  for (const item of read) {
    const path = resolveHref(opfPath, item.href);
    const xhtml = path ? await readZipText(bytes, index, path).catch(() => null) : null;
    if (!xhtml) continue;
    try {
      const root = parseXml(xhtml);
      walkHtml(find(root, 'body') ?? root, doc.blocks);
    } catch {
      doc.notes.push(`A chapter (${item.href}) could not be parsed and was skipped.`);
    }
  }
  if (spine.length > read.length) {
    doc.notes.push(`Only the first ${read.length} of ${spine.length} sections were read.`);
  }
  doc.meta.sections = String(spine.length);
  return finalizeDocument(doc);
};
