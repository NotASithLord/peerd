import { describe, test, expect } from 'bun:test';
import { stripChunk, peerdTailLen, stripPeerdMarkers } from '../../extension/vm-tab/marker-strip.js';

// The WebVM terminal must show clean command output: peerd's completion-marker
// machinery (the `printf '\n%s:%s\n' '___PEERD_<id>___' "$?"` echo and the
// `___PEERD_<id>___:<exit>` output line) is stripped before xterm draws it. The PTY
// arrives in arbitrary chunks, so a marker can straddle a boundary — and a boundary
// landing INSIDE the id used to flush the printf echo's prefix, leaking `…%s:%s\n' '`
// into the terminal (and eating the real output line with it). These pin that down.

const MARKER = '___PEERD_p5m46sghpw_mqyj4wy9___';
const CMD = 'python3 -c "print(sum(range(1,101)))"\n';
// The echoed printf command line: the format-string newlines are LITERAL `\n`, the
// line terminator is a real newline.
const PRINTF_ECHO = `printf '\\n%s:%s\\n' '${MARKER}' "$?"\n`;
const OUTPUT = '5050\n';
const MARKER_OUT = `\n${MARKER}:0\n`;
const STREAM = CMD + PRINTF_ECHO + OUTPUT + MARKER_OUT;
const CLEAN = CMD + OUTPUT;          // exactly what the terminal should display

/** Feed `chunks` through stripChunk in order; return everything drawn + any held tail. */
const feed = (chunks: string[]): string => {
  let pending = '';
  let out = '';
  for (const c of chunks) {
    const r = stripChunk(pending, c);
    out += r.out;
    pending = r.pending;
  }
  return out + pending;            // a complete stream leaves pending empty
};

const noCrumbs = (s: string) => {
  expect(s.includes('PEERD')).toBe(false);
  expect(s.includes("printf '")).toBe(false);
  expect(s.includes('%s:%s')).toBe(false);
  expect(s.includes('"$?"')).toBe(false);
};

// The marker output's LEADING newline is ambiguous with a real line-ending newline when
// streamed byte-at-a-time, so an adversarial split landing exactly between it and
// `___PEERD_` can leave one cosmetic blank line (a real PTY delivers the whole printf at
// once, so this never happens in practice — and holding trailing newlines to kill it
// would lag live output). The marker MACHINERY never leaks; only a trailing blank might.
const collapseTrailingBlanks = (s: string) => s.replace(/\n+$/, '\n');

describe('marker-strip — whole-buffer', () => {
  test('strips the printf echo + marker line, keeps the real output', () => {
    expect(stripPeerdMarkers(STREAM)).toBe(CLEAN);
  });

  test('a single chunk is stripped clean', () => {
    expect(feed([STREAM])).toBe(CLEAN);
  });
});

describe('marker-strip — chunk boundaries (the leak)', () => {
  test('every two-way split of the stream: no marker crumbs, content clean', () => {
    for (let i = 0; i <= STREAM.length; i++) {
      const result = feed([STREAM.slice(0, i), STREAM.slice(i)]);
      noCrumbs(result);                                   // never any printf/marker garbage
      expect(collapseTrailingBlanks(result)).toBe(CLEAN); // exactly the right output
    }
  });

  test('byte-by-byte delivery (worst-case chunking): no crumbs, content clean', () => {
    const result = feed([...STREAM]);
    noCrumbs(result);
    expect(collapseTrailingBlanks(result)).toBe(CLEAN);
  });

  test('the specific regression: a boundary INSIDE the marker id holds the printf prefix', () => {
    // tail ends `…printf '\n%s:%s\n' '___PEERD_p5m` — the id is incomplete.
    const buf = CMD + `printf '\\n%s:%s\\n' '___PEERD_p5m`;
    const hold = peerdTailLen(buf);
    const heldTail = buf.slice(buf.length - hold);
    // The whole printf echo (prefix included) is held — NOT just from ___PEERD_, which
    // would flush `printf '\n%s:%s\n' '` and leak it.
    expect(heldTail.startsWith(`printf '\\n%s:%s\\n' '`)).toBe(true);
    // And what's flushed before the hold is exactly the real command echo.
    expect(buf.slice(0, buf.length - hold)).toBe(CMD);
  });
});

describe('marker-strip — does not over-hold', () => {
  test('plain output with no marker is passed straight through', () => {
    expect(feed(['hello\n', 'world\n'])).toBe('hello\nworld\n');
  });

  test('a line that merely mentions "printf" is not held forever', () => {
    expect(feed(['$ man printf\n'])).toBe('$ man printf\n');
  });
});
