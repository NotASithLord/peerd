// @ts-check
// run-capture.js — the wrapped-run wire protocol for the WebVM's persistent
// shell, plus the pure parser that turns one run's raw PTY capture back into
// { exitCode, stdout, stderr }.
//
// why a wrapper at all: the PTY merges the two streams, so a bare command can
// never report real stderr — the tool result's [STDERR] section was hardcoded
// empty (actively misleading for an agent debugging a failing command). Each
// agent-issued run is therefore typed into the shell as
//
//     { <cmd>
//     } 2>'<errfile>'; printf '\n%s:%s\n' '<marker>' "$?"; \
//       printf '%s\n' '<marker>-err'; cat '<errfile>'; rm -f <errfile-prefix>*; \
//       printf '\n%s\n' '<marker>-end'
//
// — the brace group redirects fd 2 to a per-call file under /tmp (a group, not
// a subshell, so cd/env/function state still persists in the shell), the first
// printf emits the exit-code marker, then the file is replayed between the
// -err/-end section markers (so stderr still SHOWS in the terminal — after the
// run instead of interleaved) and removed. The user's own `2>&1` inside cmd
// wins on the inner scope, exactly like a real shell.
//
// why the parser can slice the echo structurally: bash reads the WHOLE compound
// command (echoing every input line, PS2 prompts included) before executing any
// of it, so every echoed input byte precedes all output. The wrapper line's
// echo carries the QUOTED '<marker>-end' token — output markers are unquoted —
// making it an unambiguous end-of-echo sentinel.
//
// Pure (value-in / value-out), no browser deps — bun-tested without a live tab.
// vm-tab.js imports buildWrappedCommand + parseRunCapture; marker-strip.js (the
// terminal-display twin) imports ERRFILE_PREFIX to recognize the echo.

// Per-call stderr capture file prefix inside the VM. Dot-file under /tmp so a
// user ls-ing mid-run doesn't trip over plumbing.
export const ERRFILE_PREFIX = '/tmp/.peerd-stderr-';

/**
 * The text typed into the persistent shell for one wrapped run (sans the
 * leading kill-line control byte — tty plumbing, not protocol).
 * @param {string} cmd @param {string} marker @param {string} errFile
 * @returns {string}
 */
export const buildWrappedCommand = (cmd, marker, errFile) =>
  // why the glob rm: an aborted run (Ctrl-C on timeout) makes interactive bash
  // drop the rest of the wrapper list, so THAT run's errfile survives — the
  // next completed run sweeps every stale capture file along with its own.
  // (`rm -f` with an unmatched glob is silent: the literal falls through.)
  `{ ${cmd}\n} 2>'${errFile}'; printf '\\n%s:%s\\n' '${marker}' "$?"; `
  + `printf '%s\\n' '${marker}-err'; cat '${errFile}'; rm -f ${ERRFILE_PREFIX}*; `
  + `printf '\\n%s\\n' '${marker}-end'\n`;

/**
 * Find `<marker>:<digits>\n` in buf, walking past non-matching occurrences
 * (the wrapper line's echo quotes the marker — `'<marker>'` — so the `:`
 * check skips it).
 * @param {string} buf @param {string} marker
 * @returns {{ startIdx: number, afterIdx: number, exitCode: number } | null}
 *   startIdx backs over one preceding newline (the printf's own separator).
 */
// why exported: only parseRunCapture calls it in production; the export exists
// for the direct boundary tests (run-capture.test.ts) on the quoted-echo walk.
export const scanForMarker = (buf, marker) => {
  let from = 0;
  while (from <= buf.length) {
    const idx = buf.indexOf(marker, from);
    if (idx < 0) return null;
    const colonIdx = idx + marker.length;
    if (buf[colonIdx] !== ':') { from = idx + 1; continue; }
    const nlIdx = buf.indexOf('\n', colonIdx);
    if (nlIdx < 0) return null;
    const codeStr = buf.slice(colonIdx + 1, nlIdx);
    const exitCode = Number.parseInt(codeStr, 10);
    if (!Number.isFinite(exitCode)) { from = idx + 1; continue; }
    const startIdx = idx > 0 && buf[idx - 1] === '\n' ? idx - 1 : idx;
    return { startIdx, afterIdx: nlIdx + 1, exitCode };
  }
  return null;
};

/**
 * Find a `<token>\r?\n` OUTPUT line at a line start. The echo's occurrence of
 * the token is quoted (`'<token>'` — preceded by `'`, followed by `'`), so it
 * fails both anchors and is walked past.
 * @param {string} buf @param {string} token @param {number} from
 * @returns {{ start: number, after: number } | null}
 */
const findMarkerLine = (buf, token, from) => {
  let i = from;
  while (i <= buf.length) {
    const idx = buf.indexOf(token, i);
    if (idx < 0) return null;
    let end = idx + token.length;
    if (buf[end] === '\r') end += 1;
    if ((idx === 0 || buf[idx - 1] === '\n') && buf[end] === '\n') {
      return { start: idx, after: end + 1 };
    }
    i = idx + 1;
  }
  return null;
};

/**
 * Parse one wrapped run's accumulated PTY capture. Returns null until the
 * FULL structure (exit marker + -err line + -end line) has arrived — the
 * caller keeps buffering; completion is the -end marker, so stderr is whole.
 * stdout/stderr come back \r-free.
 * @param {string} buf @param {string} marker
 * @returns {{ exitCode: number, stdout: string, stderr: string } | null}
 */
export const parseRunCapture = (buf, marker) => {
  const exit = scanForMarker(buf, marker);
  if (!exit) return null;
  const err = findMarkerLine(buf, `${marker}-err`, exit.afterIdx);
  if (!err) return null;
  const end = findMarkerLine(buf, `${marker}-end`, err.after);
  if (!end) return null;
  // Everything through the wrapper line's echo is input plumbing (the `{ cmd`
  // echo, PS2 continuations, the wrapper line itself) — stdout starts after
  // it. Quoted-token sentinel: see the header. Lenient on a miss (start at 0)
  // so an exotic echo mode degrades to extra echo text, never a lost result.
  const echoToken = `'${marker}-end'`;
  const echoIdx = buf.indexOf(echoToken);
  let stdoutStart = 0;
  if (echoIdx !== -1 && echoIdx < exit.startIdx) {
    const echoNl = buf.indexOf('\n', echoIdx + echoToken.length);
    if (echoNl !== -1 && echoNl < exit.startIdx) stdoutStart = echoNl + 1;
  }
  // The -end printf's leading newline exists to terminate unterminated stderr;
  // it is separator, not content — drop exactly one (plus its \r half).
  let stderrEnd = end.start;
  if (buf[stderrEnd - 1] === '\n') stderrEnd -= 1;
  if (buf[stderrEnd - 1] === '\r') stderrEnd -= 1;
  const clean = (/** @type {string} */ s) => s.replace(/\r/g, '');
  return {
    exitCode: exit.exitCode,
    stdout: clean(buf.slice(stdoutStart, exit.startIdx)),
    stderr: clean(buf.slice(err.after, Math.max(err.after, stderrEnd))),
  };
};
