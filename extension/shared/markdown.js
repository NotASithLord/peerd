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

/**
 * Render a Markdown string to a trusted HTML string. Block-level parse
 * is line-based and intentionally small — it covers the constructs a
 * chat model actually emits (headings, fenced + inline code, bold/em,
 * links, ordered/unordered lists, blockquotes, paragraphs).
 *
 * @param {string} src
 * @returns {string} HTML (safe to pass to m.trust)
 */
export const renderMarkdown = (src) => {
  if (typeof src !== 'string' || src.length === 0) return '';
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  /**
   * @param {string[]} items
   * @param {boolean} ordered
   */
  const flushList = (items, ordered) => {
    const tag = ordered ? 'ol' : 'ul';
    out.push(`<${tag}>${items.map((it) => `<li>${renderInline(escapeHtml(it))}</li>`).join('')}</${tag}>`);
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

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      flushList(items, false);
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      flushList(items, true);
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
    while (
      i < lines.length
      && !/^\s*$/.test(lines[i])
      && !/^```/.test(lines[i])
      && !/^(#{1,6})\s+/.test(lines[i])
      && !/^\s*[-*+]\s+/.test(lines[i])
      && !/^\s*\d+\.\s+/.test(lines[i])
      && !/^\s*>\s?/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${para.map((l) => renderInline(escapeHtml(l))).join('<br>')}</p>`);
  }

  return out.join('\n');
};
