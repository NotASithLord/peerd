// @ts-check
// Composer parsing — pure functions, no IO.
//
// The composer is the chat textarea. Before a user message becomes an
// agent turn, we scan it for two kinds of authored token:
//
//   /command        a leading slash command (Claude Code style). Resolves
//                   to a markdown body from the commands store. Only the
//                   FIRST token of the message, mirroring Claude Code and
//                   shells — `/foo` mid-sentence is just text.
//
//   @reference      an inline mention (Cursor style). Two flavors:
//                     @file:<path>   inline a stored App/Notebook file
//                     @tab           inline the live DOM of a browser tab
//                                    (optionally @tab:<id> for a specific
//                                    tab; bare @tab = active tab)
//                   @-references may appear anywhere in the message.
//
// Why a parser instead of regex-at-call-site: the palette UI, the
// resolver, and the tests all need to agree on EXACTLY what counts as a
// token and where its boundaries are. One pure tokenizer is the single
// source of truth. IO (reading files/tabs/commands) lives elsewhere —
// this file only turns a string into a structure.

// A reference token kind. `file` and `tab` are the V1 surfaces; the
// union is closed so the resolver can switch exhaustively.
/** @typedef {'file' | 'tab'} RefKind */

/**
 * @typedef {Object} RefToken
 * @property {RefKind} kind        'file' | 'tab'
 * @property {string}  arg         the path (file) or tab id string (tab); '' for a bare `@tab`
 * @property {string}  raw         the exact source substring, e.g. `@file:notes.md`
 * @property {number}  start       index into the source string (inclusive)
 * @property {number}  end         index into the source string (exclusive)
 */

/**
 * @typedef {Object} ParsedComposer
 * @property {string|null} command   the slash command name (no slash), or null
 * @property {string}      commandArgs  text after the command on the first line (trimmed)
 * @property {RefToken[]}  refs      every at-reference found, in source order
 * @property {string}      text      the original, unmodified source
 */

// A reference looks like:  @tab  |  @tab:123  |  @file:some/path.md
//   - kind: word chars (tab|file)
//   - optional :arg — arg runs until whitespace. Paths can contain dots,
//     slashes, dashes; we stop at whitespace or a second '@'. A trailing
//     punctuation char (.,;) commonly ends a sentence — strip it so
//     "see @file:notes.md." doesn't fold the period into the path.
// why: anchored with a (^|\s) lookbehind-equivalent so an email address
// like "a@tab.com" is never mistaken for a reference. We match the
// preceding boundary explicitly and re-emit it.
const REF_RE = /(^|\s)@(tab|file)(?::([^\s@]+))?/g;

/**
 * Parse a composer string into its command + references.
 *
 * Pure. Same input → same output. No IO, no clock, no randomness.
 *
 * @param {string} text
 * @returns {ParsedComposer}
 */
export const parseComposer = (text) => {
  const src = typeof text === 'string' ? text : '';
  return {
    command: parseCommandName(src),
    commandArgs: parseCommandArgs(src),
    refs: parseRefs(src),
    text: src,
  };
};

// The command is only recognised at the very start of the message
// (ignoring leading whitespace), and only if it's `/word`. `/` alone, or
// `//`, or `/ foo` is not a command — it's text (or a path the user is
// pasting). Command names are word chars + dash (kebab) to match the
// `.peerd/commands/<name>.md` file convention.
const COMMAND_RE = /^\s*\/([a-zA-Z0-9][a-zA-Z0-9_-]*)(?=\s|$)/;

/** @param {string} src @returns {string|null} */
export const parseCommandName = (src) => {
  const m = COMMAND_RE.exec(src);
  return m ? m[1] : null;
};

/**
 * Everything after the command token on its line, trimmed. This is the
 * user's free-text argument to the command (e.g. `/review the auth flow`
 * → 'the auth flow'). Empty string when there's no argument.
 *
 * @param {string} src @returns {string}
 */
export const parseCommandArgs = (src) => {
  const m = COMMAND_RE.exec(src);
  if (!m) return '';
  // Slice from the end of the matched command token to end-of-line.
  const after = src.slice(m.index + m[0].length);
  const firstLine = after.split('\n')[0];
  return firstLine.trim();
};

/**
 * Extract every at-reference, in source order, with exact byte offsets so
 * the resolver can splice replacements back into the message.
 *
 * @param {string} src @returns {RefToken[]}
 */
export const parseRefs = (src) => {
  /** @type {RefToken[]} */
  const out = [];
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(src)) !== null) {
    const lead = m[1];                 // '' or the whitespace boundary
    const kind = /** @type {RefKind} */ (m[2]);
    let arg = m[3] ?? '';
    // Strip a single trailing sentence-punctuation char from a file arg
    // so "@file:notes.md." resolves notes.md, not notes.md.
    let trimmed = 0;
    if (arg && /[.,;:!?)]$/.test(arg)) { arg = arg.slice(0, -1); trimmed = 1; }
    const start = m.index + lead.length;            // first char of '@'
    const end = m.index + m[0].length - trimmed;    // exclusive
    out.push({ kind, arg, raw: src.slice(start, end), start, end });
  }
  return out;
};

/**
 * Detect an IN-PROGRESS token at the caret for live palette triggering.
 * Given the full text and the caret offset, return what the user is
 * currently typing — a command or a reference — so the palette can open
 * and filter. Returns null when the caret isn't inside a trigger.
 *
 * Mirrors the parser's rules: a command trigger only fires when the `/`
 * is the first non-space char of the message; a reference trigger fires
 * on `@` at a word boundary anywhere.
 *
 * @param {string} text
 * @param {number} caret      caret offset (selectionStart)
 * @returns {{ type: 'command'|'ref', query: string, kind?: RefKind, from: number, to: number }|null}
 */
export const activeTrigger = (text, caret) => {
  const src = typeof text === 'string' ? text : '';
  const pos = Math.max(0, Math.min(caret ?? src.length, src.length));
  const before = src.slice(0, pos);

  // Command trigger: '/' at start-of-message, no whitespace since.
  const cmd = /^(\s*)\/([a-zA-Z0-9_-]*)$/.exec(before);
  if (cmd) {
    return { type: 'command', query: cmd[2], from: cmd[1].length, to: pos };
  }

  // Reference trigger: the nearest '@' at a word boundary with no
  // whitespace between it and the caret. Find the last '@' in `before`.
  const at = before.lastIndexOf('@');
  if (at !== -1) {
    const boundaryOk = at === 0 || /\s/.test(before[at - 1]);
    const frag = before.slice(at + 1);          // text after '@'
    // No whitespace in the fragment (still inside the token).
    if (boundaryOk && !/\s/.test(frag)) {
      // Two shapes:
      //   no colon yet  → the user is still typing the KIND (or a bare
      //                   '@'). query = the whole fragment, kind unknown.
      //                   Palette lists kinds (@) and filters them.
      //   has colon     → kind is committed (`tab`/`file`); query is the
      //                   text after the colon (a tab/file filter).
      const colon = frag.indexOf(':');
      if (colon === -1) {
        return { type: 'ref', kind: undefined, query: frag, from: at, to: pos };
      }
      const head = frag.slice(0, colon);
      if (head === 'tab' || head === 'file') {
        return { type: 'ref', kind: head, query: frag.slice(colon + 1), from: at, to: pos };
      }
      // `@junk:...` — not a real kind. Treat the whole fragment as a
      // query against the kind list (palette will show nothing useful,
      // but we don't crash and the trigger still closes on whitespace).
      return { type: 'ref', kind: undefined, query: frag, from: at, to: pos };
    }
  }
  return null;
};
