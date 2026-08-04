// @ts-check
// Pieces shared by the three OOXML walkers (docx / xlsx / pptx).
//
// The one genuinely shared mechanism is RELATIONSHIPS. OOXML never puts a
// hyperlink's URL in the body markup — the body carries an opaque `r:id` and
// the target lives in a sibling `_rels/<part>.rels` file. Resolving it is what
// makes links survive conversion instead of becoming bare text.

import { parseXml, findAll } from '../xml.js';
import { readZipText } from '../zip.js';

/**
 * The `_rels` path for a part: `word/document.xml` → `word/_rels/document.xml.rels`.
 * @param {string} partPath
 */
export const relsPathFor = (partPath) => {
  const slash = partPath.lastIndexOf('/');
  const dir = slash === -1 ? '' : partPath.slice(0, slash + 1);
  const file = partPath.slice(slash + 1);
  return `${dir}_rels/${file}.rels`;
};

/**
 * Load a part's relationships as id → target.
 *
 * @param {Uint8Array} bytes
 * @param {Map<string, import('../zip.js').ZipEntry>} index
 * @param {string} partPath
 * @returns {Promise<Map<string,string>>}
 */
export const loadRelationships = async (bytes, index, partPath) => {
  /** @type {Map<string,string>} */
  const rels = new Map();
  const xml = await readZipText(bytes, index, relsPathFor(partPath)).catch(() => null);
  if (!xml) return rels;
  try {
    for (const rel of findAll(parseXml(xml), 'Relationship')) {
      const id = rel.attrs.Id ?? rel.attrs.id;
      const target = rel.attrs.Target ?? rel.attrs.target;
      if (id && target) rels.set(id, target);
    }
  } catch { /* a malformed rels part costs links, not the document */ }
  return rels;
};

/**
 * Document properties from `docProps/core.xml` (title/author/subject), which
 * all three OOXML formats share. Absent in files written by non-Microsoft
 * tools, so every field is optional.
 *
 * @param {Uint8Array} bytes
 * @param {Map<string, import('../zip.js').ZipEntry>} index
 * @returns {Promise<{ title: string|null, meta: Record<string,string> }>}
 */
export const loadCoreProperties = async (bytes, index) => {
  /** @type {Record<string,string>} */
  const meta = {};
  let title = null;
  const xml = await readZipText(bytes, index, 'docProps/core.xml').catch(() => null);
  if (!xml) return { title, meta };
  try {
    const root = parseXml(xml);
    /** @param {string} local */
    const value = (local) => {
      const node = findAll(root, local)[0];
      if (!node) return '';
      return node.children.filter((c) => typeof c === 'string').join('').trim();
    };
    title = value('title') || null;
    for (const [key, local] of /** @type {Array<[string,string]>} */ ([
      ['author', 'creator'], ['subject', 'subject'], ['modified', 'modified'],
    ])) {
      const v = value(local);
      if (v) meta[key] = v;
    }
  } catch { /* metadata is a nicety */ }
  return { title, meta };
};

/**
 * Is this style id a heading, and at what level? Matches the built-in
 * `Heading1`…`Heading9` and `Title`/`Subtitle` ids that every Word-family
 * writer emits, plus the localized-with-a-digit variants (`Ttulo2`) by falling
 * back to the trailing number.
 *
 * @param {string} [styleId]
 * @returns {number}   1-6, or 0 for "not a heading"
 */
export const headingLevelForStyle = (styleId) => {
  if (!styleId) return 0;
  const id = styleId.toLowerCase();
  if (id === 'title') return 1;
  if (id === 'subtitle') return 2;
  const m = /^(?:heading|hd|berschrift|titre|ttulo|kop|rubrik)[\s_-]?(\d)$/.exec(id) ?? /heading(\d)/.exec(id);
  return m ? Math.min(6, Number.parseInt(m[1], 10)) : 0;
};
