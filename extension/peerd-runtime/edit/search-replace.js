// @ts-check
// Aider-style SEARCH/REPLACE diff editing — pure functional core.
//
// This is the PRIMARY write mechanism for agent file edits. Instead of
// the model re-emitting an entire file (token-expensive, and it silently
// clobbers concurrent changes), it emits one or more anchored patches:
//
//   <<<<<<< SEARCH
//   the exact text to find
//   =======
//   the text to replace it with
//   >>>>>>> REPLACE
//
// Matching semantics (deliberately strict):
//   • The SEARCH text must appear EXACTLY (byte-for-byte after newline
//     normalization) in the source. We do not fuzzy-match. A miss is a
//     hard error, not a silent no-op: silent no-ops are how agents
//     convince themselves an edit landed when it didn't.
//   • The SEARCH text must be UNIQUE. Two matches is an error, because
//     the model's intent is ambiguous and picking "the first one" is how
//     you corrupt a file. The repair is to widen the search block with
//     surrounding context until it's unique.
//   • An empty SEARCH block means "create / fully replace": the REPLACE
//     text becomes the whole file. This is the insert-new-file path.
//   • Blocks apply IN ORDER against the running text, so a later block
//     can match text a previous block just wrote.
//
// Everything here is pure: (text, blocks) -> text, or throws a typed
// error. No IO. The OPFS/IDB shell lives in checkpoint.js and the tool.

import {
  EditParseError,
  SearchNotFoundError,
  SearchAmbiguousError,
} from './errors.js';

// Fence markers. We match a run of >=5 of the marker char so the parser
// tolerates the model emitting 7 chars (git-conflict style) or exactly 5.
const SEARCH_RE  = /^<{5,9} SEARCH\s*$/;
const DIVIDER_RE = /^={5,9}\s*$/;
const REPLACE_RE = /^>{5,9} REPLACE\s*$/;

/**
 * why: models (and humans) are inconsistent about line endings, and OPFS
 * round-trips can introduce \r\n. We normalize to \n for matching so a
 * CRLF source and an LF search block still align. The applier records
 * whether the source was CRLF and restores it on output, so we don't
 * silently rewrite every line ending of a Windows-authored file.
 *
 * @param {string} s
 */
const normalizeEol = (s) => s.replace(/\r\n/g, '\n');

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 * Empty needle is handled by the caller (it means whole-file replace).
 *
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
const countOccurrences = (haystack, needle) => {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
};

/**
 * @typedef {{ search: string, replace: string }} EditBlock
 */

/**
 * Parse raw SEARCH/REPLACE text into structured blocks. A single string
 * may carry several blocks back-to-back. Throws EditParseError on a
 * malformed fence (the model wrote the markers wrong) so the agent gets
 * a precise complaint instead of a half-applied edit.
 *
 * @param {string} raw
 * @returns {EditBlock[]}
 */
export const parseEditBlocks = (raw) => {
  if (typeof raw !== 'string') {
    throw new EditParseError('edit payload must be a string');
  }
  const lines = normalizeEol(raw).split('\n');
  /** @type {EditBlock[]} */
  const blocks = [];

  // why: a tiny state machine over lines, not a regex over the whole
  // blob. Multi-line search/replace bodies can themselves contain `=`
  // runs or other near-markers; scanning line-by-line and only treating
  // a line as a marker when it matches the anchored RE avoids a body
  // line that merely starts with `=====` being read as a divider.
  let state = 'idle'; // idle -> search -> replace -> idle
  /** @type {string[]} */
  let searchLines = [];
  /** @type {string[]} */
  let replaceLines = [];

  const pushBlock = () => {
    blocks.push({
      search: searchLines.join('\n'),
      replace: replaceLines.join('\n'),
    });
    searchLines = [];
    replaceLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (state === 'idle') {
      if (SEARCH_RE.test(line)) { state = 'search'; continue; }
      // Stray divider/replace markers outside a block are a syntax error.
      if (DIVIDER_RE.test(line) || REPLACE_RE.test(line)) {
        throw new EditParseError(
          `unexpected '${line.trim()}' at line ${i + 1} with no open SEARCH block`,
        );
      }
      // Non-marker lines between blocks (e.g. the model's prose) are
      // ignored — only fenced content matters.
      continue;
    }
    if (state === 'search') {
      if (DIVIDER_RE.test(line)) { state = 'replace'; continue; }
      if (SEARCH_RE.test(line) || REPLACE_RE.test(line)) {
        throw new EditParseError(
          `expected '=======' to close SEARCH but got '${line.trim()}' at line ${i + 1}`,
        );
      }
      searchLines.push(line);
      continue;
    }
    // state === 'replace'
    if (REPLACE_RE.test(line)) { state = 'idle'; pushBlock(); continue; }
    if (SEARCH_RE.test(line) || DIVIDER_RE.test(line)) {
      throw new EditParseError(
        `expected '>>>>>>> REPLACE' to close block but got '${line.trim()}' at line ${i + 1}`,
      );
    }
    replaceLines.push(line);
  }

  if (state !== 'idle') {
    throw new EditParseError('unterminated SEARCH/REPLACE block (missing closing marker)');
  }
  if (blocks.length === 0) {
    throw new EditParseError('no SEARCH/REPLACE blocks found');
  }
  return blocks;
};

/**
 * Apply already-parsed blocks to source text. Pure: returns the new text
 * or throws a typed error. Exposed separately from applyEdit so callers
 * that parse once can apply without re-parsing (and tests can drive the
 * matcher directly).
 *
 * @param {string} source     current file content ('' for a new file)
 * @param {EditBlock[]} blocks
 * @returns {string} the edited content
 */
export const applyBlocks = (source, blocks) => {
  // why: detect CRLF on the original so we can restore it. We match on
  // the normalized form but emit in the source's original convention.
  const wasCrlf = /\r\n/.test(source);
  let text = normalizeEol(source ?? '');

  blocks.forEach((block, blockIndex) => {
    const search = normalizeEol(block.search);
    const replace = normalizeEol(block.replace);

    // Empty SEARCH ⇒ whole-file replace / create. Only valid as the sole
    // block; combining it with anchored edits is meaningless.
    if (search === '') {
      if (blocks.length > 1) {
        throw new EditParseError(
          `block ${blockIndex}: an empty SEARCH (whole-file replace) must be the only block`,
        );
      }
      text = replace;
      return;
    }

    const count = countOccurrences(text, search);
    if (count === 0) {
      throw new SearchNotFoundError(
        `block ${blockIndex}: SEARCH text not found. The file may have changed; re-read it and rebuild the block.`,
        blockIndex,
      );
    }
    if (count > 1) {
      throw new SearchAmbiguousError(
        `block ${blockIndex}: SEARCH text matched ${count} times. Add surrounding lines so it identifies exactly one location.`,
        blockIndex,
        count,
      );
    }
    const idx = text.indexOf(search);
    text = text.slice(0, idx) + replace + text.slice(idx + search.length);
  });

  return wasCrlf ? text.replace(/\n/g, '\r\n') : text;
};

/**
 * Parse + apply in one shot. The canonical entry point for the tool.
 *
 * @param {string} source
 * @param {string} rawBlocks  the SEARCH/REPLACE payload
 * @returns {{ content: string, blocks: number }}
 */
export const applyEdit = (source, rawBlocks) => {
  const blocks = parseEditBlocks(rawBlocks);
  const content = applyBlocks(source, blocks);
  return { content, blocks: blocks.length };
};
