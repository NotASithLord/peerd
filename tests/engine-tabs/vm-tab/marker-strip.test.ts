import { describe, test, expect } from 'bun:test';
import { stripChunk, peerdTailLen, stripPeerdMarkers } from '../../../extension/engine-tabs/vm-tab/marker-strip.js';
import { buildWrappedCommand } from '../../../extension/engine-tabs/vm-tab/run-capture.js';

// The WebVM terminal must show clean command output: peerd's wrapped-run
// machinery (run-capture.js) types a `{ cmd\n} 2>'<errfile>'; printf …` block —
// the wrapper line's ECHO (with its PS2 `> ` prompt) and the three marker
// OUTPUT lines (`<marker>:<exit>`, `<marker>-err`, `<marker>-end`) are stripped
// before xterm draws the stream; the command, its stdout and its replayed
// stderr stay. The PTY arrives in arbitrary chunks, so a marker can straddle a
// boundary — a boundary landing inside the machinery used to leak crumbs into
// the terminal (and eat the real output line with them). These pin that down.

const MARKER = '___PEERD_p5m46sghpw_mqyj4wy9___';
const ERRFILE = '/tmp/.peerd-stderr-ab12cd34';
const CMD = 'python3 -c "print(sum(range(1,101)))"';
// The echoed input: line 1 is `{ cmd`, line 2 the wrapper (echoed behind the
// PS2 `> ` continuation prompt the open group makes bash draw). Derive it from
// the REAL template so the strip regex can never drift from the wire format.
const wrapped = buildWrappedCommand(CMD, MARKER, ERRFILE).split('\n');
const CMD_ECHO = `${wrapped[0]}\n`;                 // `{ python3 …`
const WRAP_ECHO = `> ${wrapped[1]}\n`;              // `> } 2>'…'; printf …`
const OUTPUT = '5050\n';
const STDERR = 'boom: warning\n';
const MARKER_OUT = `\n${MARKER}:0\n`;
const ERR_OPEN = `${MARKER}-err\n`;
const ERR_CLOSE = `\n${MARKER}-end\n`;
const STREAM = CMD_ECHO + WRAP_ECHO + OUTPUT + MARKER_OUT + ERR_OPEN + STDERR + ERR_CLOSE;
// What the terminal should display: the typed command (its `{ ` group prefix is
// honest), the output, then the replayed stderr. No machinery.
const CLEAN = CMD_ECHO + OUTPUT + STDERR;

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
  expect(s.includes('.peerd-stderr-')).toBe(false);
};

// The marker lines' LEADING newlines are ambiguous with real line-ending
// newlines when streamed byte-at-a-time, so an adversarial split landing
// exactly between one and `___PEERD_` can leave a cosmetic blank line (a real
// PTY delivers each printf whole, so this never happens in practice — and
// holding trailing newlines to kill it would lag live output). The marker
// MACHINERY never leaks; only a blank line might.
const collapseBlankRuns = (s: string) => s.replace(/\n\n+/g, '\n');

describe('marker-strip — whole-buffer', () => {
  test('strips the wrapper echo (PS2 included) + all three marker lines, keeps output and stderr', () => {
    expect(stripPeerdMarkers(STREAM)).toBe(CLEAN);
  });

  test('a single chunk is stripped clean', () => {
    expect(feed([STREAM])).toBe(CLEAN);
  });

  test('\\r\\n line endings strip the same', () => {
    const crlf = STREAM.replace(/\n/g, '\r\n');
    expect(stripPeerdMarkers(crlf)).toBe(CLEAN.replace(/\n/g, '\r\n'));
  });

  test('empty stderr leaves just the command + output', () => {
    const stream = CMD_ECHO + WRAP_ECHO + OUTPUT + MARKER_OUT + ERR_OPEN + ERR_CLOSE;
    expect(stripPeerdMarkers(stream)).toBe(CMD_ECHO + OUTPUT);
  });
});

describe('marker-strip — chunk boundaries (the leak)', () => {
  test('every two-way split of the stream: no marker crumbs, content clean', () => {
    for (let i = 0; i <= STREAM.length; i++) {
      const result = feed([STREAM.slice(0, i), STREAM.slice(i)]);
      noCrumbs(result);                                    // never any wrapper/marker garbage
      expect(collapseBlankRuns(result)).toBe(CLEAN);       // exactly the right output
    }
  });

  test('byte-by-byte delivery (worst-case chunking): no crumbs, content clean', () => {
    const result = feed([...STREAM]);
    noCrumbs(result);
    expect(collapseBlankRuns(result)).toBe(CLEAN);
  });

  test('a boundary INSIDE the wrapper echo holds the whole line, PS2 prefix included', () => {
    // tail ends mid-errfile: `> } 2>'/tmp/.peerd-s` — the echo is incomplete.
    const buf = CMD_ECHO + `> } 2>'/tmp/.peerd-s`;
    const hold = peerdTailLen(buf);
    const heldTail = buf.slice(buf.length - hold);
    // The whole echo (PS2 included) is held — NOT just from `}`, which would
    // flush the `> ` and leak it as a stray prompt.
    expect(heldTail.startsWith('> } 2>')).toBe(true);
    // And what's flushed before the hold is exactly the command echo.
    expect(buf.slice(0, buf.length - hold)).toBe(CMD_ECHO);
  });

  test('a boundary INSIDE a section marker holds it (-err and -end forms)', () => {
    for (const partial of [`${MARKER}-e`, `${MARKER}-err`, `${MARKER}-en`, `${MARKER}-end`]) {
      const buf = OUTPUT + partial;
      const hold = peerdTailLen(buf);
      expect(buf.slice(0, buf.length - hold)).toBe(OUTPUT.slice(0, -1)); // trailing \n held with the marker
    }
  });
});

// The REAL wire format: the PTY is ONLCR, so every \n the shell writes arrives
// as \r\n. A boundary landing between a marker line's \r and \n (or inside its
// leading \r\n separator) used to flush the whole marker line visibly — the
// LF-only loops above can't see that, so the same guarantees are pinned on the
// CRLF stream too.
describe('marker-strip — chunk boundaries on the CRLF wire (tty ONLCR)', () => {
  const STREAM_CRLF = STREAM.replace(/\n/g, '\r\n');
  const CLEAN_CRLF = CLEAN.replace(/\n/g, '\r\n');
  // The CRLF analog of collapseBlankRuns: a split inside a marker's leading
  // \r\n separator can leave a cosmetic blank line (or a stray \r that pairs
  // with a later \n) — machinery never leaks, only blank-line cosmetics.
  const collapseCrlf = (s: string) => s.replace(/(\r\n)+/g, '\r\n').replace(/\r+\n/g, '\r\n');

  test('every two-way split of the CRLF stream: no marker crumbs, content clean', () => {
    for (let i = 0; i <= STREAM_CRLF.length; i++) {
      const result = feed([STREAM_CRLF.slice(0, i), STREAM_CRLF.slice(i)]);
      noCrumbs(result);
      expect(collapseCrlf(result)).toBe(CLEAN_CRLF);
    }
  });

  test('byte-by-byte CRLF delivery (worst-case chunking): no crumbs, content clean', () => {
    const result = feed([...STREAM_CRLF]);
    noCrumbs(result);
    expect(collapseCrlf(result)).toBe(CLEAN_CRLF);
  });

  test('a boundary between a marker line\'s \\r and \\n holds the line', () => {
    // Pre-fix, `<marker>:0\r` was NOT held (the prefix matcher rejected the
    // trailing \r) and the whole marker line leaked into the terminal.
    const buf = `${OUTPUT.replace(/\n/g, '\r\n')}\r\n${MARKER}:0\r`;
    const hold = peerdTailLen(buf);
    expect(buf.slice(buf.length - hold)).toBe(`\r\n${MARKER}:0\r`);
  });
});

describe('marker-strip — does not over-hold', () => {
  test('plain output with no marker is passed straight through', () => {
    expect(feed(['hello\n', 'world\n'])).toBe('hello\nworld\n');
  });

  // bash writes the PS2 `> ` as its own PTY write before the wrapper echo, so
  // it must be held (a flushed one would leak as a stray prompt) — but a
  // diverging next char releases it, so a user typing at a real continuation
  // lags one keystroke at most.
  test('a bare PS2 is held, then released as soon as the line diverges', () => {
    expect(peerdTailLen('> ')).toBe(2);
    expect(feed(['> ', 'ls\n'])).toBe('> ls\n');
  });

  test('a line that merely starts with } is released as soon as it diverges', () => {
    expect(feed(['} not ours\n'])).toBe('} not ours\n');
  });

  test('a line that merely mentions printf is not held', () => {
    expect(feed(['$ man printf\n'])).toBe('$ man printf\n');
  });
});
