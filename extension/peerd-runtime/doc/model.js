// @ts-check
// The unified Document model — the middle of the pipeline.
//
//   bytes → sniff → per-format parser → THIS → Markdown
//
// why a shared model rather than each parser emitting Markdown directly: it is
// the only thing that makes the output CONSISTENT across formats. A table is a
// table whether it came from a .docx, a sheet in a .xlsx, or a .csv, so the
// escaping, the column padding, and the truncation rules are written once and
// every format inherits them. It also keeps the parsers honest — a parser's job
// is to describe structure, not to make formatting decisions.
//
// Deliberately small. This is a model for READING a document as text, not for
// round-tripping one: styling, geometry, colors, and revision history are
// dropped on the floor because the consumer is a language model.

/**
 * @typedef {{ text: string, bold?: boolean, italic?: boolean, code?: boolean, href?: string }} Inline
 * @typedef {{ type: 'heading', level: number, inlines: Inline[] }} HeadingBlock
 * @typedef {{ type: 'paragraph', inlines: Inline[] }} ParagraphBlock
 * @typedef {{ type: 'list', ordered: boolean, items: Array<{ level: number, inlines: Inline[] }> }} ListBlock
 * @typedef {{ type: 'table', rows: string[][], header: boolean, truncatedRows?: number }} TableBlock
 * @typedef {{ type: 'code', text: string, lang?: string }} CodeBlock
 * @typedef {{ type: 'quote', inlines: Inline[] }} QuoteBlock
 * @typedef {{ type: 'divider' }} DividerBlock
 * @typedef {HeadingBlock|ParagraphBlock|ListBlock|TableBlock|CodeBlock|QuoteBlock|DividerBlock} Block
 * @typedef {{
 *   format: string,
 *   title: string | null,
 *   meta: Record<string, string>,
 *   blocks: Block[],
 *   notes: string[],
 * }} Document
 */

/**
 * @param {Partial<Document>} [init]
 * @returns {Document}
 */
export const makeDocument = (init = {}) => ({
  format: init.format ?? 'unknown',
  title: init.title ?? null,
  meta: init.meta ?? {},
  blocks: init.blocks ?? [],
  notes: init.notes ?? [],
});

/** @param {string} text @param {Omit<Inline,'text'>} [style] @returns {Inline} */
export const inline = (text, style = {}) => ({ text, ...style });

/** @param {string} text @returns {Inline[]} */
export const plain = (text) => (text ? [{ text }] : []);

/** @param {number} level @param {Inline[]|string} content @returns {HeadingBlock} */
export const heading = (level, content) => ({
  type: 'heading',
  // Clamp: a .docx can carry outline level 9, and `#########` is not a heading
  // in any Markdown renderer.
  level: Math.min(6, Math.max(1, level)),
  inlines: typeof content === 'string' ? plain(content) : content,
});

/** @param {Inline[]|string} content @returns {ParagraphBlock} */
export const paragraph = (content) => ({
  type: 'paragraph',
  inlines: typeof content === 'string' ? plain(content) : content,
});

/** @param {string[][]} rows @param {{ header?: boolean, truncatedRows?: number }} [opts] @returns {TableBlock} */
export const table = (rows, opts = {}) => ({
  type: 'table',
  rows,
  header: opts.header ?? true,
  ...(opts.truncatedRows ? { truncatedRows: opts.truncatedRows } : {}),
});

/**
 * Merge adjacent inlines that carry identical styling. Parsers emit one inline
 * per source run, and office writers split runs on things that do not survive
 * conversion at all — a spellcheck boundary, a language tag, a tracked-change
 * marker. Without this pass, `**Hello**` routinely serializes as
 * `**Hel****lo**`, which renders wrong AND costs extra tokens.
 *
 * @param {Inline[]} inlines
 * @returns {Inline[]}
 */
export const mergeInlines = (inlines) => {
  /** @type {Inline[]} */
  const out = [];
  for (const run of inlines) {
    if (!run || !run.text) continue;
    const prev = out[out.length - 1];
    if (prev
      && !!prev.bold === !!run.bold
      && !!prev.italic === !!run.italic
      && !!prev.code === !!run.code
      && prev.href === run.href) {
      prev.text += run.text;
    } else {
      out.push({ ...run });
    }
  }
  return out;
};

/**
 * Drop blocks that carry no content. Every format produces these in bulk —
 * spacer paragraphs in Word, empty rows in a sheet, blank slide placeholders —
 * and they are pure token cost with no information.
 *
 * A table is NOT emptied by a blank cell (that is data: "this field is
 * missing"), only by having no non-empty cell at all.
 *
 * @param {Block[]} blocks
 * @returns {Block[]}
 */
export const compactBlocks = (blocks) => {
  const kept = blocks.filter((block) => {
    switch (block.type) {
      case 'paragraph':
      case 'quote':
        return block.inlines.some((r) => r.text.trim());
      case 'heading':
        return block.inlines.some((r) => r.text.trim());
      case 'list':
        return block.items.some((it) => it.inlines.some((r) => r.text.trim()));
      case 'table':
        return block.rows.some((row) => row.some((cell) => cell.trim()));
      case 'code':
        return Boolean(block.text.trim());
      default:
        return true;
    }
  });
  // Collapse runs of dividers and strip leading/trailing ones — an artifact of
  // section breaks in Word and of empty slides in PowerPoint.
  /** @type {Block[]} */
  const out = [];
  for (const block of kept) {
    if (block.type === 'divider' && (out.length === 0 || out[out.length - 1].type === 'divider')) continue;
    out.push(block);
  }
  while (out.length && out[out.length - 1].type === 'divider') out.pop();
  return out;
};

/**
 * Normalize a finished document: merge runs, drop empties, and lift a title
 * out of the first heading when the container gave us no metadata title.
 * Every parser ends with this so the invariants hold in one place.
 *
 * @param {Document} doc
 * @returns {Document}
 */
export const finalizeDocument = (doc) => {
  const blocks = compactBlocks(doc.blocks.map((block) => {
    if (block.type === 'paragraph' || block.type === 'heading' || block.type === 'quote') {
      return { ...block, inlines: mergeInlines(block.inlines) };
    }
    if (block.type === 'list') {
      return { ...block, items: block.items.map((it) => ({ ...it, inlines: mergeInlines(it.inlines) })) };
    }
    return block;
  }));
  let { title } = doc;
  if (!title) {
    const first = blocks.find((b) => b.type === 'heading');
    if (first && first.type === 'heading') {
      title = first.inlines.map((r) => r.text).join('').trim() || null;
    }
  }
  return { ...doc, blocks, title };
};
