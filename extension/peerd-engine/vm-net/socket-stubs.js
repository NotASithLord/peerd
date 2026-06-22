// @ts-check
// socket-stubs — turn the WebVM's hard networking ceiling into a clear,
// peerd-branded error instead of a confusing libc failure.
//
// The sandbox has no raw TCP/UDP (no sockets without an out-of-browser relay,
// which we reject — see git-archive.js / DESIGN.md §8.5). So `ssh`, `nc`,
// `ping`, a raw `psql` over the wire, etc. CAN'T work and never will. Today
// they fail deep in the C library with "Network unreachable" or a silent hang,
// which reads like a bug. We replace them with shims that exit non-zero and
// print exactly what's available and why — expectation-setting AS a feature
// (owner request). The agent sees the same message and learns the boundary too.

/**
 * Commands that need raw sockets and therefore can't run, each with a one-line
 * reason and the HTTP-native alternative to point the user/agent at.
 * @type {ReadonlyArray<{ cmd: string, reason: string, instead: string }>}
 */
export const UNSUPPORTED_NET_COMMANDS = Object.freeze([
  { cmd: 'ssh', reason: 'needs a raw TCP socket', instead: 'use git clone over https, or run code locally' },
  { cmd: 'scp', reason: 'needs a raw TCP socket (ssh)', instead: 'fetch files with curl/wget over https' },
  { cmd: 'sftp', reason: 'needs a raw TCP socket (ssh)', instead: 'fetch files with curl/wget over https' },
  { cmd: 'telnet', reason: 'needs a raw TCP socket', instead: 'use curl for http(s) endpoints' },
  { cmd: 'nc', reason: 'raw TCP/UDP is not available', instead: 'use curl/wget for http(s)' },
  { cmd: 'netcat', reason: 'raw TCP/UDP is not available', instead: 'use curl/wget for http(s)' },
  { cmd: 'ping', reason: 'ICMP is not available in the browser sandbox', instead: 'check reachability with curl -sI <url>' },
  { cmd: 'traceroute', reason: 'ICMP/UDP is not available', instead: 'n/a in the sandbox' },
  { cmd: 'dig', reason: 'no DNS socket; name resolution happens host-side', instead: 'just curl the hostname directly' },
  { cmd: 'nslookup', reason: 'no DNS socket; name resolution happens host-side', instead: 'just curl the hostname directly' },
  { cmd: 'host', reason: 'no DNS socket; name resolution happens host-side', instead: 'just curl the hostname directly' },
  { cmd: 'rsync', reason: 'rsync-over-ssh needs a raw socket', instead: 'fetch archives with curl/wget, or git clone' },
]);

const SANDBOX_DOC = 'docs/engine/VM-NETWORKING.md';

/**
 * The peerd error a stubbed command prints (to stderr) before exiting 1.
 * @param {{ cmd: string, reason: string, instead: string }} entry
 * @returns {string}
 */
export const stubMessage = (entry) =>
  `peerd: '${entry.cmd}' is not available in this sandbox — ${entry.reason}. ` +
  `This WebVM is HTTP(S)-native: curl, wget, and git clone work (routed through ` +
  `peerd's audited egress); raw TCP/UDP/ICMP do not. Try: ${entry.instead}. ` +
  `See ${SANDBOX_DOC}.`;

/**
 * Generate the bash that defines every stub as a shell function. Each function
 * prints the peerd error to stderr and returns 1 — no network attempt, no hang.
 * Kept as functions (not files on PATH) so they install with the other wrappers
 * via `source`, and so a deliberately-installed real binary can still be reached
 * by absolute path if a future image ships one.
 * @returns {string}
 */
export const stubsBash = () => {
  const lines = ['# ---- peerd networking stubs (clear errors, no hangs) -------------------'];
  for (const entry of UNSUPPORTED_NET_COMMANDS) {
    // why printf %s with a pre-built message: avoids any shell interpolation of
    // the message text; the function body is intentionally trivial.
    const msg = stubMessage(entry).replace(/'/g, `'\\''`);
    lines.push(
      `${entry.cmd}() { printf '%s\\n' '${msg}' >&2; return 1; }`,
      `export -f ${entry.cmd}`,
    );
  }
  lines.push('# ---- end peerd networking stubs ---------------------------------------');
  return lines.join('\n');
};
