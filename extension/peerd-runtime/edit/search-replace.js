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
// Matching semantics (deliberately strict — see DESIGN.md §2):
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

// Caps/thresholds for the diagnostics below — named + local so the shape is
// legible rather than magic. Bounded work: each runs at most once per block.
const MAX_RENDERED_LOCATIONS = 5;
const PREVIEW_CAP = 100;
// why: a trivially short REPLACE (";", "}", a lone common token) can be present
// by coincidence, so calling a miss "already applied" on it would lie about a
// real edit having landed. Require a distinctive replacement first (3b guard).
const MIN_ALREADY_APPLIED_REPLACE_CHARS = 8;

/**
 * 1-based line number containing `offset` in `text`. Pure.
 * why: the matcher works on offsets; the agent thinks in lines.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
const lineOf = (text, offset) =>
  text.slice(0, Math.max(0, offset)).split('\n').length;

/**
 * Per-line trim (leading/trailing whitespace) that preserves line count, so a
 * whitespace-insensitive probe's match offset still maps to a real line (3d).
 *
 * @param {string} s
 * @returns {string}
 */
const trimPerLine = (s) => s.split('\n').map((line) => line.trim()).join('\n');

/**
 * A short, trimmed context window around a 1-based line, for a match preview.
 *
 * @param {string[]} lines      source split on '\n'
 * @param {number}   lineNumber 1-based
 * @returns {string}
 */
const previewAround = (lines, lineNumber) => {
  const idx = lineNumber - 1;
  const window = lines.slice(Math.max(0, idx - 1), idx + 2)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' / ');
  return window.length > PREVIEW_CAP ? `${window.slice(0, PREVIEW_CAP)}…` : window;
};

/**
 * Non-overlapping offsets of `needle` in `haystack`, capped at `cap`.
 *
 * @param {string} haystack
 * @param {string} needle
 * @param {number} cap
 * @returns {number[]}
 */
const offsetsOf = (haystack, needle, cap) => {
  /** @type {number[]} */
  const offsets = [];
  if (needle === '') return offsets;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1 || offsets.length >= cap) break;
    offsets.push(idx);
    from = idx + needle.length;
  }
  return offsets;
};

/**
 * 3b: is a MISSED anchored block already applied? True only when the REPLACE
 * text is provably present, distinct from the SEARCH, and distinctive enough
 * that a coincidental match is implausible. Deliberately conservative — a
 * false positive would silently skip a real edit, so on any doubt we fall
 * through to the normal not-found error. (Only reached when SEARCH is absent,
 * so a SEARCH that is a substring of REPLACE can't get here.)
 *
 * @param {string} text    current (normalized) content
 * @param {string} search  normalized SEARCH, already known absent
 * @param {string} replace normalized REPLACE
 * @returns {boolean}
 */
const isAlreadyApplied = (text, search, replace) => {
  if (replace === '' || replace === search) return false;
  const distinctive = replace.includes('\n')
    || replace.trim().length >= MIN_ALREADY_APPLIED_REPLACE_CHARS;
  if (!distinctive) return false;
  return countOccurrences(text, replace) >= 1;
};

/**
 * 3d: if the SEARCH matches after a per-line trim, return the 1-based line of
 * that whitespace-insensitive match; otherwise null. DIAGNOSTIC only — no
 * fuzzy apply ever follows (peerd policy: a miss is a hard error).
 *
 * @param {string} text
 * @param {string} search  normalized SEARCH, already known absent exactly
 * @returns {number | null}
 */
const whitespaceMissLine = (text, search) => {
  const trimmedSearch = trimPerLine(search);
  // A degenerate all-whitespace SEARCH trims to nothing and would "match"
  // everywhere; don't claim a whitespace difference for it.
  if (trimmedSearch.trim() === '') return null;
  const trimmedText = trimPerLine(text);
  const idx = trimmedText.indexOf(trimmedSearch);
  return idx === -1 ? null : lineOf(trimmedText, idx);
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
 * @returns {{ text: string, alreadyApplied: number[] }} edited content and the
 *   0-based indices of blocks that were skipped because they were already
 *   applied (3b) — a REPORTED no-op, never a silent one.
 */
export const applyBlocks = (source, blocks) => {
  // why: detect CRLF on the original so we can restore it. We match on
  // the normalized form but emit in the source's original convention.
  const wasCrlf = /\r\n/.test(source);
  let text = normalizeEol(source ?? '');
  /** @type {number[]} */
  const alreadyApplied = [];

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
      // 3b: a re-issued edit whose REPLACE already landed is not a typo — if
      // it's provably in place, skip it and report the no-op rather than
      // firing a misleading search_not_found.
      if (isAlreadyApplied(text, search, replace)) {
        alreadyApplied.push(blockIndex);
        return;
      }
      // 3d: diagnose the most common real cause — an indentation/whitespace
      // mismatch — by name, instead of the misdirecting "the file changed".
      const wsLine = whitespaceMissLine(text, search);
      if (wsLine !== null) {
        throw new SearchNotFoundError(
          `block ${blockIndex}: SEARCH text not found, but a whitespace-only difference matched at L${wsLine} — your indentation, tabs, or trailing spaces differ from the file. Re-read the exact bytes and rebuild the block.`,
          blockIndex,
          { whitespace: true, line: wsLine },
        );
      }
      throw new SearchNotFoundError(
        `block ${blockIndex}: SEARCH text not found. The file may have changed; re-read it and rebuild the block.`,
        blockIndex,
      );
    }
    if (count > 1) {
      // 3c: report WHERE the matches are so the agent widens the anchor
      // without re-reading the file to find them.
      const lines = text.split('\n');
      const locations = offsetsOf(text, search, MAX_RENDERED_LOCATIONS).map((offset) => {
        const line = lineOf(text, offset);
        return { line, preview: previewAround(lines, line) };
      });
      const rendered = locations.map((loc) => `L${loc.line}`).join(', ');
      throw new SearchAmbiguousError(
        `block ${blockIndex}: SEARCH text matched ${count} times: ${rendered} — add surrounding lines so it identifies exactly one location.`,
        blockIndex,
        count,
        locations,
      );
    }
    const idx = text.indexOf(search);
    text = text.slice(0, idx) + replace + text.slice(idx + search.length);
  });

  return { text: wasCrlf ? text.replace(/\n/g, '\r\n') : text, alreadyApplied };
};

/**
 * Is this payload a whole-file create/replace — a single empty-SEARCH block?
 * why: the tool shell (3a) must decide, BEFORE touching IO, whether a
 * not-found target is a legitimate create or a typo'd path.
 *
 * @param {EditBlock[]} blocks
 * @returns {boolean}
 */
export const isWholeFileCreate = (blocks) =>
  blocks.length === 1 && normalizeEol(blocks[0].search) === '';

/**
 * Parse + apply in one shot. The canonical entry point for the tool.
 *
 * @param {string} source
 * @param {string} rawBlocks  the SEARCH/REPLACE payload
 * @returns {{ content: string, blocks: number, alreadyApplied: number[] }}
 */
export const applyEdit = (source, rawBlocks) => {
  const blocks = parseEditBlocks(rawBlocks);
  const { text, alreadyApplied } = applyBlocks(source, blocks);
  return { content: text, blocks: blocks.length, alreadyApplied };
};
