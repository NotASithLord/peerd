// @ts-check
// Document → GitHub-Flavored Markdown. The one place formatting is decided.
//
// Two rules govern everything here, and they pull in opposite directions:
//
//   1. The output is read by a MODEL, so structure must survive. Headings,
//      table shape, and list nesting are the document's meaning; losing them
//      turns a spreadsheet into a word salad.
//   2. The output costs TOKENS. So no decorative padding, no alignment
//      whitespace, no empty emphasis markers.
//
// Where they conflict, structure wins but pays the minimum: table cells are
// separated, not aligned into columns (alignment can double a wide table's
// size for zero information).

/** @typedef {import('./model.js').Document} Document */
/** @typedef {import('./model.js').Block} Block */
/** @typedef {import('./model.js').Inline} Inline */

// Characters that would change the STRUCTURE of the markdown if left raw.
// Deliberately narrow: escaping every `*` and `_` in prose is a common
// converter mistake that litters the output with backslashes and misleads the
// reader about what the document actually said.
const escapeText = (/** @type {string} */ text) => text.replace(/([\\`])/g, '\\$1');

// A pipe inside a cell ends the cell; a newline ends the row. Both must go.
//
// BACKSLASH FIRST, and the order is the whole point: escaping the pipe alone
// turns a cell containing `a\|b` into `a\\|b`, where the doubled backslash is
// itself an escaped backslash — leaving the pipe bare, so the cell splits and
// every column after it shifts. Escaping backslashes first makes each escape
// independent. (CodeQL flags exactly this as incomplete string escaping.)
const escapeCell = (/** @type {string} */ text) => text
  .replace(/\\/g, '\\\\')
  .replace(/\|/g, '\\|')
  .replace(/\s*\r?\n\s*/g, ' ')
  .trim();

/**
 * Render styled runs. Emphasis markers are placed INSIDE the run's whitespace
 * (`**bold** ` not `**bold **`) because a marker adjacent to a space does not
 * bind in CommonMark — the asterisks would render literally.
 *
 * @param {Inline[]} inlines
 * @returns {string}
 */
export const renderInlines = (inlines) => inlines.map((run) => {
  if (!run.text) return '';
  if (run.code) {
    // A run containing a backtick needs a longer fence than the longest run
    // inside it — the CommonMark rule.
    const longest = (run.text.match(/`+/g) ?? []).reduce((n, s) => Math.max(n, s.length), 0);
    const fence = '`'.repeat(longest + 1);
    const pad = run.text.startsWith('`') || run.text.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${run.text}${pad}${fence}`;
  }
  const leading = run.text.match(/^\s*/)?.[0] ?? '';
  const trailing = run.text.length > leading.length ? (run.text.match(/\s*$/)?.[0] ?? '') : '';
  const core = run.text.slice(leading.length, run.text.length - trailing.length);
  if (!core) return run.text;

  let body = escapeText(core);
  if (run.bold) body = `**${body}**`;
  if (run.italic) body = `*${body}*`;
  if (run.href) {
    // A link whose text IS its target renders as a bare autolink — shorter and
    // clearer than the duplicated `[url](url)` most converters emit.
    body = run.href === core ? `<${run.href}>` : `[${body}](${run.href.replace(/[()\s]/g, encodeURIComponent)})`;
  }
  return `${leading}${body}${trailing}`;
}).join('');

/**
 * A GFM table. Columns are NOT padded to equal width — see the token rule
 * above. Ragged rows are squared off, because a table with a 3-cell header and
 * a 5-cell body row does not parse as a table at all.
 *
 * @param {string[][]} rows
 * @param {boolean} header
 * @returns {string}
 */
export const renderTable = (rows, header) => {
  if (!rows.length) return '';
  const width = rows.reduce((n, row) => Math.max(n, row.length), 0);
  if (!width) return '';
  const square = rows.map((row) => {
    const cells = Array.from({ length: width }, (_, i) => escapeCell(row[i] ?? ''));
    return `| ${cells.join(' | ')} |`;
  });
  const rule = `|${' --- |'.repeat(width)}`;
  // GFM has no headerless table: without a header row the body is not
  // recognized as a table at all. So when the source had none, emit an empty
  // header rather than silently degrading the structure to paragraphs.
  return header
    ? [square[0], rule, ...square.slice(1)].join('\n')
    : [`|${'  |'.repeat(width)}`, rule, ...square].join('\n');
};

/**
 * @param {Block} block
 * @returns {string}
 */
const renderBlock = (block) => {
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${renderInlines(block.inlines)}`;
    case 'paragraph':
      return renderInlines(block.inlines);
    case 'quote':
      return renderInlines(block.inlines).split('\n').map((l) => `> ${l}`).join('\n');
    case 'divider':
      return '---';
    case 'code': {
      // Fence longer than any backtick run inside, so embedded code fences in
      // the source cannot break out of the block.
      const longest = (block.text.match(/`{3,}/g) ?? []).reduce((n, s) => Math.max(n, s.length), 2);
      const fence = '`'.repeat(longest + 1);
      return `${fence}${block.lang ?? ''}\n${block.text}\n${fence}`;
    }
    case 'list':
      return block.items.map((item) => {
        const indent = '  '.repeat(Math.max(0, item.level));
        const marker = block.ordered ? '1.' : '-';
        return `${indent}${marker} ${renderInlines(item.inlines)}`;
      }).join('\n');
    case 'table': {
      const body = renderTable(block.rows, block.header);
      return block.truncatedRows
        ? `${body}\n\n_… ${block.truncatedRows} more row${block.truncatedRows === 1 ? '' : 's'} not shown._`
        : body;
    }
    default:
      return '';
  }
};

/**
 * Serialize a document to Markdown. Blocks are separated by a blank line
 * (which is what makes them separate blocks in Markdown at all).
 *
 * @param {Document} doc
 * @returns {string}
 */
export const toMarkdown = (doc) => doc.blocks
  .map(renderBlock)
  .filter((s) => s.trim())
  .join('\n\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();
