// @ts-check
// Minimal, injection-safe Markdown → HTML renderer.
//
// why: assistant replies read better with real formatting (headings,
// lists, bold, code blocks) than as flat text. We deliberately do NOT
// vendor a third-party Markdown library: this codebase is
// security-sensitive and audits every dependency, and a model reply can
// be influenced by untrusted web content (read_page output, a hostile
// page steering the model). So we ship a tiny, self-contained renderer
// with a HARD security contract:
//
//   1. ALL input is HTML-escaped FIRST. The transforms below only ever
//      ADD a fixed, known set of tags (<strong>, <em>, <code>, <a>, …).
//      Raw HTML in the source can never reach the DOM.
//   2. Link hrefs are scheme-checked — only http/https/mailto and
//      relative/anchor URLs survive. `javascript:` and friends are
//      dropped (the link renders as plain text).
//
// The output is a trusted HTML string the caller hands to Mithril's
// `m.trust(...)`. Keep this module dependency-free and pure.

// Placeholder delimiter for extracted code spans. A NUL byte can never
// occur in real chat text, so the markers can't collide with content
// (or with digits the user actually typed).
const SENTINEL = String.fromCharCode(0);

/** @param {string} s */
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Allow only safe link schemes. Operates on the RAW (pre-escape) url so
// it can parse the scheme, then the url is escaped before it lands in
// the href attribute. Returns null for anything we won't link.
/** @param {string} raw */
const safeHref = (raw) => {
  const url = raw.trim();
  // Relative paths and same-page anchors are fine.
  if (/^(\/|#|\.\/|\.\.\/)/.test(url)) return url;
  // Absolute URLs: only http(s) and mailto.
  if (/^(https?:|mailto:)/i.test(url)) return url;
  return null;
};

// Inline formatting, applied to text that has ALREADY been HTML-escaped.
// Code spans are extracted to placeholders first so their contents don't
// get bold/italic/link processing, then restored last.
/** @param {string} escaped */
const renderInline = (escaped) => {
  /** @type {string[]} */
  const codeSpans = [];
  let s = escaped.replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(code);
    return SENTINEL + (codeSpans.length - 1) + SENTINEL;
  });

  // Bold then italic (bold first so ** isn't eaten by the single-* rule).
  // why: `_` and `__` follow the CommonMark intraword rule - no emphasis
  // when both sides are letters or digits - so identifiers like
  // MAX_RETRY_COUNT and my_config_file.py keep their underscores.
  /** @param {string} t */
  const emphasize = (t) => t
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\p{L}\p{N}_])__([^_]+)__(?![\p{L}\p{N}_])/gu, '$1<strong>$2</strong>')
    .replace(/(^|[^*])\*(?!\s)([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\p{L}\p{N}_])_(?!\s)([^_]+?)_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>');

  // Links: [text](url). `text` is already escaped; sanitize the href.
  // why: the generated opening <a ...> tag is stashed in a placeholder
  // (two NULs, digits, one NUL - still nothing but NUL and digits) so
  // the emphasis pass below never rewrites an underscore inside its href
  // or target="_blank". The link text gets its emphasis pass here instead.
  /** @type {string[]} */
  const linkTags = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text, rawUrl) => {
    // The url arrives HTML-escaped (e.g. &amp;); unescape just enough to
    // scheme-check, then re-escape for the attribute.
    const decoded = rawUrl.replace(/&amp;/g, '&');
    const href = safeHref(decoded);
    if (!href) return whole;
    linkTags.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">`);
    return `${SENTINEL}${SENTINEL}${linkTags.length - 1}${SENTINEL}${emphasize(text)}</a>`;
  });

  s = emphasize(s);

  // Restore link tags, then code spans (a code span can sit inside link
  // text). One pass each, no loop, so a fake marker in the input can't
  // grow; an out-of-range index renders as nothing, never "undefined".
  s = s.replace(new RegExp(`${SENTINEL}${SENTINEL}(\\d+)${SENTINEL}`, 'g'), (_m, i) => linkTags[Number(i)] ?? '');
  const restore = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');
  s = s.replace(restore, (_m, i) => {
    const code = codeSpans[Number(i)];
    return code === undefined ? '' : `<code>${code}</code>`;
  });
  return s;
};

// List item marker: indent, bullet or number, then at least one space.
const LIST_ITEM = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/;

// why: nesting is recursive, so a hostile reply of thousands of indented
// bullets must not build an unbounded tree; past this depth an item's
// body renders as flat text.
const MAX_LIST_DEPTH = 8;

/** @param {string} line */
const startsBlock = (line) => /^\s*$/.test(line)
  || /^```/.test(line)
  || /^(#{1,6})\s+/.test(line)
  || LIST_ITEM.test(line)
  || /^\s*>\s?/.test(line);

/** @param {string} line */
const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Block-level parse of `lines` into HTML chunks. `depth` counts the list
 * levels already open around these lines.
 *
 * @param {string[]} lines
 * @param {number} depth
 * @returns {string[]}
 */
const renderBlocks = (lines, depth) => {
  /** @type {string[]} */
  const out = [];
  let i = 0;

  /**
   * One list item: its first line plus dedented continuation lines. The
   * leading plain lines render inline (a tight item stays `<li>text</li>`);
   * anything after them (sub-lists, fences, paragraphs) recurses.
   * @param {string[]} body
   */
  const renderItem = (body) => {
    let lead = 0;
    while (lead < body.length && (lead === 0 || !startsBlock(body[lead]))) lead++;
    const head = body.slice(0, lead).map((l) => renderInline(escapeHtml(l.trim()))).join('<br>');
    const rest = body.slice(lead);
    if (!rest.some((l) => !/^\s*$/.test(l))) return `<li>${head}</li>`;
    const nested = depth + 1 < MAX_LIST_DEPTH
      ? renderBlocks(rest, depth + 1).join('\n')
      : `<br>${rest.filter((l) => !/^\s*$/.test(l)).map((l) => renderInline(escapeHtml(l.trim()))).join('<br>')}`;
    return `<li>${head}${nested}</li>`;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (/^```/.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // consume closing fence (if present)
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i++;
      continue;
    }

    // Blank line — block boundary.
    if (/^\s*$/.test(line)) { i++; continue; }

    // List (ordered or unordered). Items are siblings at the first item's
    // indent; a deeper-indented line continues the current item (nested
    // list, fence, more text) with its indent stripped up to the item's
    // content column. why: models emit loose lists (blank line between
    // steps) and indent sub-bullets and fences under a step; ending the
    // list at either restarts the numbering at 1.
    const first = line.match(LIST_ITEM);
    if (first) {
      const baseIndent = first[1].length;
      const ordered = /\d/.test(first[2]);
      /** @type {string[][]} */
      const items = [];
      let contentIndent = 0;
      /** @param {string} candidate */
      const isSibling = (candidate) => {
        const item = candidate.match(LIST_ITEM);
        return item !== null && item[1].length === baseIndent && /\d/.test(item[2]) === ordered ? item : null;
      };
      while (i < lines.length) {
        const current = lines[i];
        const indent = indentOf(current);
        // why: a deeper line (the common case inside a nested list) is a
        // continuation without running the item regex at all, which keeps
        // re-scanning each nesting level cheap.
        if (indent > baseIndent && indent < current.length) {
          items[items.length - 1].push(current.slice(Math.min(indent, contentIndent)));
          i++;
          continue;
        }
        if (indent === current.length) {
          // Blank: keep the list open only if what follows is a sibling
          // item or an indented continuation.
          let next = i;
          while (next < lines.length && lines[next].trim() === '') next++;
          if (next >= lines.length) break;
          if (isSibling(lines[next])) { i = next; continue; }
          if (indentOf(lines[next]) <= baseIndent) break;
          for (; i < next; i++) items[items.length - 1].push('');
          continue;
        }
        const item = isSibling(current);
        if (!item) break;
        items.push([item[4]]);
        contentIndent = item[1].length + item[2].length + item[3].length;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      // why: the start number is digits only (from the marker regex), so it
      // can't carry markup into the attribute; 1 is the default, omitted.
      const startNumber = ordered ? first[2].slice(0, -1).replace(/^0+(?=\d)/, '') : '1';
      const startAttr = startNumber === '1' ? '' : ` start="${startNumber}"`;
      out.push(`<${tag}${startAttr}>${items.map(renderItem).join('')}</${tag}>`);
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderInline(escapeHtml(body.join(' ')))}</blockquote>`);
      continue;
    }

    // Paragraph — gather consecutive plain lines, join with <br>.
    const para = [];
    while (i < lines.length && !startsBlock(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${para.map((l) => renderInline(escapeHtml(l))).join('<br>')}</p>`);
  }

  return out;
};

/**
 * Render a Markdown string to a trusted HTML string. Block-level parse
 * is line-based and intentionally small - it covers the constructs a
 * chat model actually emits (headings, fenced + inline code, bold/em,
 * links, ordered/unordered lists, blockquotes, paragraphs).
 *
 * @param {string} src
 * @returns {string} HTML (safe to pass to m.trust)
 */
export const renderMarkdown = (src) => {
  if (typeof src !== 'string' || src.length === 0) return '';
  return renderBlocks(src.replace(/\r\n?/g, '\n').split('\n'), 0).join('\n');
};
