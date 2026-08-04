// @ts-check
// A small, pure XML reader for OOXML / ODF / EPUB parts.
//
// why not DOMParser: the conversion core must stay PURE so it is bun-testable
// and runnable in ANY context (SW, worker, offscreen) — DOMParser exists in
// only some of those and in none of Bun. This is ~120 lines against the
// machine-generated XML that office writers emit, not a general XML processor:
// no DTDs, no entity declarations, no namespace resolution.
//
// NAMESPACES are handled by ignoring prefixes and matching LOCAL names. Office
// writers are inconsistent about prefixes (`w:p` vs `ns0:p` after a round-trip
// through a converter), and no office part meaningfully reuses a local name
// across two namespaces in a way that would confuse a text extraction. Matching
// locally is both simpler and more robust than resolving xmlns declarations.

import { DocParseError } from './errors.js';

/** @typedef {{ name: string, local: string, attrs: Record<string,string>, children: Array<XmlNode|string> }} XmlNode */

const ENTITIES = /** @type {Record<string,string>} */ ({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
});

/** Expand the XML entity set plus numeric character references. */
export const decodeEntities = (/** @type {string} */ text) => (
  text.includes('&')
    ? text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
        // Reject out-of-range / lone-surrogate references rather than
        // emitting a replacement char that would corrupt the text.
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[body] ?? whole;
    })
    : text
);

/** Local name of a possibly-prefixed tag: `w:tbl` → `tbl`. */
export const localName = (/** @type {string} */ name) => {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
};

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** @param {string} source @returns {Record<string,string>} */
const parseAttrs = (source) => {
  /** @type {Record<string,string>} */
  const attrs = {};
  if (!source || !source.includes('=')) return attrs;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(source)) !== null) {
    attrs[localName(m[1])] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
};

/**
 * Parse an XML document into a tree. Whitespace-only text nodes are kept —
 * `<w:t xml:space="preserve"> </w:t>` is a real space between two words, and
 * dropping it runs sentences together.
 *
 * @param {string} text
 * @returns {XmlNode}
 */
export const parseXml = (text) => {
  if (typeof text !== 'string' || !text.trim()) throw new DocParseError('empty XML part');
  /** @type {XmlNode} */
  const root = { name: '#document', local: '#document', attrs: {}, children: [] };
  /** @type {XmlNode[]} */
  const stack = [root];
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      const tail = text.slice(i);
      if (tail) stack[stack.length - 1].children.push(decodeEntities(tail));
      break;
    }
    if (lt > i) stack[stack.length - 1].children.push(decodeEntities(text.slice(i, lt)));

    // CDATA is verbatim text — no entity expansion inside it.
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      const stop = end === -1 ? text.length : end;
      stack[stack.length - 1].children.push(text.slice(lt + 9, stop));
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    // Comments, declarations, doctypes, processing instructions — skipped.
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    const gt = text.indexOf('>', lt);
    if (gt === -1) break;                       // truncated tag — stop cleanly
    const inner = text.slice(lt + 1, gt);

    if (inner[0] === '/') {
      const name = inner.slice(1).trim();
      // Pop to the matching open tag. Office XML is well-formed, but a
      // truncated part can leave a stray close; popping only when a match
      // exists keeps one bad tag from collapsing the whole tree.
      const depth = stack.findLastIndex((n) => n.name === name);
      if (depth > 0) stack.length = depth;
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/[\s]/);
    const name = (space === -1 ? body : body.slice(0, space)).trim();
    if (!name) { i = gt + 1; continue; }
    /** @type {XmlNode} */
    const node = {
      name,
      local: localName(name),
      attrs: space === -1 ? {} : parseAttrs(body.slice(space)),
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;
};

/** Direct element children with the given local name. */
export const elements = (/** @type {XmlNode} */ node, /** @type {string} */ local) => (
  /** @type {XmlNode[]} */ (node.children.filter((c) => typeof c === 'object' && c.local === local))
);

/**
 * The first descendant (depth-first) with the given local name, or null.
 * @param {XmlNode} node @param {string} local @returns {XmlNode | null}
 */
export const find = (node, local) => {
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.local === local) return child;
    const deeper = find(child, local);
    if (deeper) return deeper;
  }
  return null;
};

/**
 * Every descendant with the given local name, depth-first. Does NOT descend
 * into a match (callers walk matched subtrees themselves), which is what makes
 * nested-table extraction terminate sensibly.
 * @param {XmlNode} node @param {string} local @returns {XmlNode[]}
 */
export const findAll = (node, local) => {
  /** @type {XmlNode[]} */
  const out = [];
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    if (child.local === local) out.push(child);
    else out.push(...findAll(child, local));
  }
  return out;
};

/** Concatenated text of a subtree. */
export const textOf = (/** @type {XmlNode|string} */ node) => {
  if (typeof node === 'string') return node;
  let out = '';
  for (const child of node.children) out += textOf(child);
  return out;
};
