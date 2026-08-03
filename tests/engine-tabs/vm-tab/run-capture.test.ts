import { describe, test, expect } from 'bun:test';
import {
  ERRFILE_PREFIX,
  buildWrappedCommand,
  parseRunCapture,
  scanForMarker,
} from '../../../extension/engine-tabs/vm-tab/run-capture.js';

// The wrapped-run protocol (design 7.1): each vm_boot command runs in a
// `{ cmd\n} 2>'<errfile>'; …` group, then the wrapper line replays the captured
// stderr between -err/-end markers. parseRunCapture turns the raw PTY capture
// (input echoes + output + markers, \r\n endings) back into
// { exitCode, stdout, stderr } — REAL stderr, where the tool result used to
// hardcode ''. These tests build streams the way the PTY actually delivers
// them: every typed line echoed (PS2 `> ` before continuations) BEFORE any
// output, because bash reads the whole compound before executing it.

const MARKER = '___PEERD_p5m46sghpw_mqyj4wy9___';
const ERRFILE = `${ERRFILE_PREFIX}ab12cd34`;

/** Assemble the PTY capture for one wrapped run of `cmd`. */
const stream = (cmd: string, {
  output = '', stderr = '', exitCode = 0, crlf = false,
}: { output?: string; stderr?: string; exitCode?: number; crlf?: boolean } = {}) => {
  const wrapped = buildWrappedCommand(cmd, MARKER, ERRFILE).split('\n');
  const wrapperLine = wrapped[wrapped.length - 2];       // last real line (the template ends \n)
  const cmdEchoLines = wrapped.slice(0, -2);             // `{ cmd` (+ any continuation lines)
  const echo = [
    cmdEchoLines[0],
    ...cmdEchoLines.slice(1).map((l) => `> ${l}`),       // PS2 before every continuation echo
    `> ${wrapperLine}`,
  ].join('\n') + '\n';
  const s = echo
    + output
    + `\n${MARKER}:${exitCode}\n`
    + `${MARKER}-err\n`
    + stderr
    + `\n${MARKER}-end\n`;
  return crlf ? s.replace(/\n/g, '\r\n') : s;
};

describe('buildWrappedCommand — the wire template', () => {
  test('carries the group redirect, all three markers, and the cleanup', () => {
    const w = buildWrappedCommand('echo hi', MARKER, ERRFILE);
    expect(w.startsWith('{ echo hi\n} 2>')).toBe(true);
    expect(w).toContain(`2>'${ERRFILE}'`);
    expect(w).toContain(`'${MARKER}' "$?"`);
    expect(w).toContain(`'${MARKER}-err'`);
    expect(w).toContain(`cat '${ERRFILE}'`);
    // The cleanup is a prefix-glob sweep: an aborted run (Ctrl-C skips the
    // wrapper tail) leaves its errfile behind — the next run's rm collects it.
    expect(w).toContain(`rm -f ${ERRFILE_PREFIX}*`);
    expect(w).toContain(`'${MARKER}-end'`);
    expect(w.endsWith('\n')).toBe(true);
  });

  test('a multi-line cmd stays inside the group (the } line closes it)', () => {
    const w = buildWrappedCommand('a=1\necho $a', MARKER, ERRFILE);
    expect(w.startsWith('{ a=1\necho $a\n} 2>')).toBe(true);
  });
});

describe('parseRunCapture — the complete structure', () => {
  test('splits stdout and stderr, slices every echo line off', () => {
    const r = parseRunCapture(
      stream('ls /etc', { output: 'passwd\nhosts\n', stderr: 'ls: warning\n' }), MARKER);
    expect(r).toEqual({ exitCode: 0, stdout: 'passwd\nhosts\n', stderr: 'ls: warning\n' });
  });

  test('empty stderr parses to the empty string (not a phantom section)', () => {
    const r = parseRunCapture(stream('true', { output: 'ok\n' }), MARKER);
    expect(r).toEqual({ exitCode: 0, stdout: 'ok\n', stderr: '' });
  });

  test('non-zero exit code comes through', () => {
    const r = parseRunCapture(stream('false', { exitCode: 127, stderr: 'boom\n' }), MARKER);
    expect(r?.exitCode).toBe(127);
    expect(r?.stderr).toBe('boom\n');
  });

  test('\\r\\n PTY endings are normalized away', () => {
    const r = parseRunCapture(
      stream('ls', { output: 'a\nb\n', stderr: 'warn\n', crlf: true }), MARKER);
    expect(r).toEqual({ exitCode: 0, stdout: 'a\nb\n', stderr: 'warn\n' });
  });

  test('unterminated stderr keeps its content; the -end printf separator is dropped', () => {
    // stderr 'oops' with no trailing newline: the -end printf's leading \n
    // terminates it on the wire — separator, not content.
    const r = parseRunCapture(stream('x', { stderr: 'oops' }), MARKER);
    expect(r?.stderr).toBe('oops');
  });

  test('a multi-line cmd: PS2 continuation echoes are sliced off with the rest', () => {
    const r = parseRunCapture(stream('a=1\necho $a', { output: '1\n' }), MARKER);
    expect(r).toEqual({ exitCode: 0, stdout: '1\n', stderr: '' });
  });

  test("the user's own 2>&1 wins on the inner scope: stderr lands in stdout", () => {
    // The redirect applies to the group; a cmd-level 2>&1 already merged.
    const r = parseRunCapture(
      stream('cc file.c 2>&1', { output: 'file.c: error: x\n' }), MARKER);
    expect(r?.stdout).toBe('file.c: error: x\n');
    expect(r?.stderr).toBe('');
  });
});

describe('parseRunCapture — incompleteness and false anchors', () => {
  const full = stream('ls', { output: 'a\n', stderr: 'w\n' });

  test('null until the FULL structure arrives (exit, -err, -end)', () => {
    // Truncate before each marker in turn — the parser must keep waiting, so a
    // partial stderr can never resolve as complete.
    for (const cut of [`${MARKER}:`, `${MARKER}-err`, `${MARKER}-end`]) {
      const idx = full.lastIndexOf(cut);
      expect(parseRunCapture(full.slice(0, idx), MARKER)).toBeNull();
    }
    expect(parseRunCapture(full, MARKER)).not.toBeNull();
  });

  test('the echoed (quoted) marker occurrences never anchor the parse', () => {
    // The echo alone contains '<marker>' "$?", '<marker>-err' and
    // '<marker>-end' — all quoted, none line-anchored output.
    const echoOnly = full.slice(0, full.indexOf('a\n'));
    expect(parseRunCapture(echoOnly, MARKER)).toBeNull();
  });

  test('marker-lookalike text in stdout is walked past, not misparsed', () => {
    // Output that MENTIONS the -err token mid-line (not line-anchored + not
    // followed by newline-only) must not open the stderr section early.
    const r = parseRunCapture(
      stream('grep x log', { output: `saw ${MARKER}-err in a log\n`, stderr: 'real\n' }), MARKER);
    expect(r?.stdout).toBe(`saw ${MARKER}-err in a log\n`);
    expect(r?.stderr).toBe('real\n');
  });
});

describe('scanForMarker', () => {
  test('finds the exit line and reports the index past it', () => {
    const buf = `out\n${MARKER}:42\nrest`;
    const m = scanForMarker(buf, MARKER);
    expect(m?.exitCode).toBe(42);
    expect(buf.slice(m!.afterIdx)).toBe('rest');
    expect(buf.slice(m!.startIdx, m!.startIdx + 1)).toBe('\n'); // backs over the printf's separator
  });

  test("walks past the echo's quoted marker (no colon after it)", () => {
    const buf = `printf '${MARKER}' "$?"\n${MARKER}:0\n`;
    expect(scanForMarker(buf, MARKER)?.exitCode).toBe(0);
  });
});
