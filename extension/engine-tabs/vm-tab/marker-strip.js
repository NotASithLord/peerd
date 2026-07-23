// @ts-check
// Pure peerd-marker stripping for the WebVM terminal display.
//
// peerd drives the persistent bash through a marker protocol: after each command it
// writes `printf '\n%s:%s\n' '___PEERD_<id>___' "$?"` so it can detect completion and
// capture the exit code. That printf ECHO (the command line, echoed by the PTY) and
// the marker OUTPUT line are plumbing, not output — we strip both before xterm draws
// the stream, so the user sees clean command output. The PTY arrives in chunks and a
// marker can straddle a chunk boundary, so stripChunk holds back any trailing partial
// that could still grow into a marker, to combine with the next chunk.
//
// Pure (value-in / value-out), no browser deps — so the fiddly boundary cases are
// bun-tested without a live tab. vm-tab.js imports stripChunk + PEERD_PRINTF_RE.

// Complete printf echo: `printf '\n%s:%s\n' '___PEERD_<id>___' "$?"` (the format-string
// newlines are LITERAL `\n` here — it's the echoed command line, not its output).
// why the trailing \n is REQUIRED (not \n?): the echo/marker is a whole line, and if we
// stripped it before its newline arrived, that newline would orphan and leak as a blank
// line. peerdTailLen holds a complete-but-newline-less marker until the \n lands.
export const PEERD_PRINTF_RE = /printf '\\n%s:%s\\n' '___PEERD_[A-Za-z0-9_]+___' "\$\?"\r?\n/g;
// Complete marker output line: an optional leading newline, the id, `:`, the exit code.
export const PEERD_MARKER_RE = /\n?___PEERD_[A-Za-z0-9_]+___:\d+\r?\n/g;

/** Strip every COMPLETE printf echo + marker line. @param {string} text */
export const stripPeerdMarkers = (text) =>
  text.replace(PEERD_PRINTF_RE, '').replace(PEERD_MARKER_RE, '');

// Both marker forms are whole, line-anchored lines we inject — the printf echo's
// format-string newlines are LITERAL `\n` (so the echo is one actual line), and the
// marker output is its own line. So an incomplete marker can only sit in the trailing
// partial LINE, and we hold it iff it's a prefix of one of these.
const PRINTF_LITERAL_PREFIX = `printf '\\n%s:%s\\n' '___PEERD_`;  // fixed echo head, up to the id
const ECHO_TAIL = `' "$?"`;                                      // echo tail after the id+closing ___
const MARKER_OUT_HEAD = '___PEERD_';                             // marker-output line head

/** Could `s` still grow into a full printf echo line? @param {string} s */
const isPrintfEchoPrefix = (s) => {
  if (s.length <= PRINTF_LITERAL_PREFIX.length) return PRINTF_LITERAL_PREFIX.startsWith(s);
  if (!s.startsWith(PRINTF_LITERAL_PREFIX)) return false;
  // After the fixed head: the id + its closing `___` (all word chars, greedily matched),
  // then a prefix of `' "$?"`. why ECHO_TAIL excludes the `___`: the greedy class eats it.
  const m = /^([A-Za-z0-9_]*)(.*)$/.exec(s.slice(PRINTF_LITERAL_PREFIX.length));
  return !!(m && ECHO_TAIL.startsWith(m[2]));
};

/** Could `s` still grow into a `___PEERD_<id>___:<exit>` output line? @param {string} s */
const isMarkerOutPrefix = (s) => {
  if (s.length <= MARKER_OUT_HEAD.length) return MARKER_OUT_HEAD.startsWith(s);
  if (!s.startsWith(MARKER_OUT_HEAD)) return false;
  return /^[A-Za-z0-9_]*(:\d*)?$/.test(s.slice(MARKER_OUT_HEAD.length));  // id+closing, then :<digits>
};

/**
 * Number of trailing chars to hold back from xterm because they could still grow into a
 * peerd marker on the next chunk. A marker is always a whole, line-anchored line, so the
 * only place a partial one can sit is the trailing partial line (everything after the
 * last newline). Hold that line iff it's a prefix of a printf echo or a marker-output
 * line — never plain output. Without this a boundary mid-marker leaks crumbs into the
 * terminal (e.g. `…%s:%s\n' '`) and can eat the real output line with them.
 * @param {string} text @returns {number}
 */
export const peerdTailLen = (text) => {
  if (!text) return 0;
  const nl = text.lastIndexOf('\n');
  const lastLine = text.slice(nl + 1);                 // after the last newline (or the whole text)
  if (lastLine.length === 0) return 0;
  if (isPrintfEchoPrefix(lastLine)) return lastLine.length;
  // The marker-output regex consumes a preceding \n, so hold it too when present.
  if (isMarkerOutPrefix(lastLine)) return nl >= 0 ? lastLine.length + 1 : lastLine.length;
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
