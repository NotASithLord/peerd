// @ts-check
// Pure peerd-marker stripping for the WebVM terminal display.
//
// peerd drives the persistent bash through the wrapped-run protocol built in
// run-capture.js: the command runs in a `{ …\n} 2>'<errfile>'; …` group whose
// wrapper line emits an exit-code marker plus a -err/-end stderr section. That
// wrapper line's ECHO (as echoed by the PTY — including the PS2 `> ` the open
// group makes bash draw before it) and the marker OUTPUT lines are plumbing,
// not output — we strip both before xterm draws the stream, so the user sees
// the command, its output and its (replayed) stderr, no machinery. The PTY
// arrives in chunks and a marker can straddle a chunk boundary, so stripChunk
// holds back any trailing partial that could still grow into one, to combine
// with the next chunk.
//
// Pure (value-in / value-out), no browser deps — so the fiddly boundary cases
// are bun-tested without a live tab. vm-tab.js imports stripChunk.

import { ERRFILE_PREFIX } from './run-capture.js';

const escapeRe = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The echoed wrapper line: `} 2>'<errfile>'; printf … '<marker>-end'` — one
// whole line, anchored on the redirect head AND the final quoted -end token so
// a template tweak in the middle can't silently unanchor it. `(?:> )?` eats
// the PS2 prompt the open group makes bash draw before the echo.
const PEERD_WRAP_ECHO_RE = new RegExp(
  `(?:> )?\\} 2>'${escapeRe(ERRFILE_PREFIX)}[^'\\n]*'[^\\n]*'___PEERD_[A-Za-z0-9_]+___-end'\\r?\\n`,
  'g',
);
// Complete marker OUTPUT lines: the exit code, the stderr-section open, the
// stderr-section close. The exit and -end printfs emit a leading newline (to
// terminate unterminated output) — the \n? consumes it. -err's printf does NOT
// (it follows the exit line's own newline), so its alternative must not eat a
// preceding \n: at a chunk boundary that \n can be the real output's
// terminator, and consuming it would glue output to stderr.
const PEERD_MARKER_RE =
  /(?:\r?\n)?___PEERD_[A-Za-z0-9_]+___(?::\d+|-end)\r?\n|___PEERD_[A-Za-z0-9_]+___-err\r?\n/g;

/** Strip every COMPLETE wrapper echo + marker line. @param {string} text */
export const stripPeerdMarkers = (text) =>
  text.replace(PEERD_WRAP_ECHO_RE, '').replace(PEERD_MARKER_RE, '');

// Both stripped forms are whole, line-anchored lines we inject, so an
// incomplete one can only sit in the trailing partial LINE; hold it iff it's a
// prefix of one of these.
const WRAP_ECHO_HEAD = `} 2>'${ERRFILE_PREFIX}`;  // fixed echo head, up to the minted suffix
const MARKER_OUT_HEAD = '___PEERD_';              // marker-output line head

/** Could `s` still grow into the wrapper-line echo? @param {string} s */
const isWrapEchoPrefix = (s) => {
  // A bare PS2 is held too: bash writes the `> ` prompt as its own PTY write
  // before the echo of the wrapper line, so a chunk boundary lands between
  // them and a flushed `> ` would leak as a stray prompt. A diverging next
  // char releases it, so a user typing at a real continuation lags one
  // keystroke at most.
  if (s === '>' || s === '> ') return true;
  const t = s.startsWith('> ') ? s.slice(2) : s;
  if (t.length <= WRAP_ECHO_HEAD.length) return WRAP_ECHO_HEAD.startsWith(t);
  // Past the fixed head this is all but certainly our own echo: hold until the
  // terminating newline releases the complete line into the strip regex.
  return t.startsWith(WRAP_ECHO_HEAD);
};

/** Could `s` still grow into a marker OUTPUT line (`:<exit>` / -err / -end)? @param {string} s */
const isMarkerOutPrefix = (s) => {
  if (s.length <= MARKER_OUT_HEAD.length) return MARKER_OUT_HEAD.startsWith(s);
  if (!s.startsWith(MARKER_OUT_HEAD)) return false;
  // id+closing ___ (the greedy word class eats them), then `:<digits>` or a
  // prefix of -err / -end. The trailing \r? matters on the real wire: the PTY
  // is ONLCR so every marker line ends \r\n, and a chunk boundary between the
  // \r and the \n must still hold the line (the strip regexes accept \r?\n).
  return /^[A-Za-z0-9_]*(?::\d*|-(?:e(?:rr?|nd?)?)?)?\r?$/.test(s.slice(MARKER_OUT_HEAD.length));
};

/**
 * Number of trailing chars to hold back from xterm because they could still
 * grow into peerd plumbing on the next chunk. A marker is always a whole,
 * line-anchored line, so the only place a partial one can sit is the trailing
 * partial line (everything after the last newline). Hold that line iff it's a
 * prefix of the wrapper echo or a marker-output line — never plain output.
 * Without this a boundary mid-marker leaks crumbs into the terminal and can
 * eat the real output line with them.
 * @param {string} text @returns {number}
 */
export const peerdTailLen = (text) => {
  if (!text) return 0;
  const nl = text.lastIndexOf('\n');
  const lastLine = text.slice(nl + 1);                 // after the last newline (or the whole text)
  if (lastLine.length === 0) return 0;
  // A lone \r right after a newline can be the first half of a marker line's
  // leading \r\n separator (CRLF wire) — hold the byte; real output diverges
  // it on the next chunk (a bare-\r progress rewrite lags one chunk at most).
  if (lastLine === '\r') return 1;
  if (isWrapEchoPrefix(lastLine)) return lastLine.length;
  // The marker-output regex consumes a preceding \r?\n, so hold that too.
  if (isMarkerOutPrefix(lastLine)) {
    if (nl < 0) return lastLine.length;
    return lastLine.length + (text[nl - 1] === '\r' ? 2 : 1);
  }
  return 0;
};

/**
 * Strip peerd markers from one PTY chunk, holding back a trailing partial marker to
 * combine with the next chunk. `pending` is the held tail from the previous call.
 * @param {string} pending @param {string} text
 * @returns {{ out: string, pending: string }} text to draw + the new held tail
 */
export const stripChunk = (pending, text) => {
  const combined = stripPeerdMarkers(pending + text);
  const holdLen = peerdTailLen(combined);
  return holdLen > 0
    ? { out: combined.slice(0, combined.length - holdLen), pending: combined.slice(combined.length - holdLen) }
    : { out: combined, pending: '' };
};
