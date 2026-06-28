// @ts-check
// capability-info — the VM's self-documenting networking surface.
//
// The socket stubs (socket-stubs.js) turn the HARD ceiling (raw sockets) into
// clear errors. This module covers the SOFTER framing: a one-line boot banner,
// a `peerd-net` command that prints exactly what works and what doesn't, and
// smart shims for the package managers people reach for first (apt) that
// explain themselves instead of hanging. All pure text/bash generation — IO is
// the caller's (vm-tab.js prints the banner, sources the bash).

/** The capability matrix, structured so it can render as text or drive tests. */
export const NET_CAPABILITIES = Object.freeze({
  works: Object.freeze([
    { what: 'curl / wget', detail: 'full HTTP — methods, headers, bodies, -f, -w %{http_code}' },
    { what: 'git clone [-b ref] <https-url>', detail: 'snapshot clone: github / gitlab (+ private via vault)' },
    { what: 'npm / yarn / pnpm add <pkg…>', detail: 'runtime deps, resolved + fetched host-side' },
    { what: 'pip install <pkg…> / -r req.txt', detail: 'pure-python wheels' },
    { what: 'gem install <name…>', detail: 'pure-ruby gems, runtime deps' },
  ]),
  unavailable: Object.freeze([
    { what: 'ssh / scp / sftp / rsync', detail: 'no raw TCP socket' },
    { what: 'nc / telnet', detail: 'no raw TCP/UDP' },
    { what: 'ping / traceroute', detail: 'no ICMP' },
    { what: 'apt-get install / apt update', detail: 'no live repos — bake into a custom image, or use pip/npm' },
    { what: 'native pip builds (numpy, pandas…)', detail: 'no 32-bit toolchain — bake from apt into a custom image' },
  ]),
});

/** The multi-line block `peerd-net` prints. Plain text, no shell metachars. */
export const capabilitiesText = () => {
  /** @param {{ what: string, detail: string }} e */
  const line = (e) => `  ${e.what.padEnd(34)} ${e.detail}`;
  return [
    'peerd WebVM — HTTP(S)-native networking',
    '',
    'This sandbox has no raw sockets. All networking is routed through',
    "peerd's audited, denylist-gated egress as HTTP(S). That means:",
    '',
    'WORKS:',
    ...NET_CAPABILITIES.works.map(line),
    '',
    'NOT AVAILABLE (raw TCP/UDP/ICMP or live package repos):',
    ...NET_CAPABILITIES.unavailable.map(line),
    '',
    'Tips:',
    '  • private git: store a vault secret named  git:<host>  (token stays host-side)',
    '  • slow/large downloads: raise  PEERD_HTTP_TIMEOUT  (seconds, default 120)',
    '  • need a tool preinstalled? build a custom image',
  ].join('\n');
};

/** The one-line banner printed to the terminal once the VM is ready. */
export const bannerText = () =>
  "peerd WebVM · HTTP(S)-native networking (curl/wget/git/npm/pip work; "
  + "raw sockets don't). Run 'peerd-net' for details.";

/**
 * Bash defining `peerd-net` (capabilities) — uses a quoted heredoc so the text
 * needs no escaping. Built as a runtime string (interpolated whole into
 * WRAPPERS_BASH), so real newlines and `$` are safe here.
 * @returns {string}
 */
export const peerdNetBash = () => [
  '# ---- peerd-net: self-documenting networking help ----------------------',
  'peerd-net() {',
  "  cat <<'PEERD_NET_EOF'",
  capabilitiesText(),
  'PEERD_NET_EOF',
  '}',
  'export -f peerd-net',
].join('\n');

// Package-manager subcommands that need live network — intercepted with a
// helpful message; everything else (offline queries like `apt list`,
// `dpkg -l`) passes through to the real binary.
const APT_NETWORK_SUBCOMMANDS = ['update', 'upgrade', 'install', 'remove', 'dist-upgrade', 'full-upgrade', 'download', 'source', 'build-dep'];

/** @param {string} tool */
const aptMessage = (tool) =>
  `peerd: '${tool}' can't reach Debian's repos — this sandbox has no live network `
  + 'for package managers. Options: (1) bake the package into a custom image, '
  + "(2) for language packages use 'pip install' / "
  + "'npm install' (resolved host-side), (3) fetch a .deb with curl and 'dpkg -i' it.";

/**
 * Bash for the apt-family shims: `apt`/`apt-get`/`aptitude` intercept the
 * network subcommands (and pass the rest through), while pure-network helpers
 * (`add-apt-repository`, `apt-key adv`) are full stubs.
 * @returns {string}
 */
export const aptShimsBash = () => {
  const cases = APT_NETWORK_SUBCOMMANDS.join('|');
  const lines = ['# ---- peerd package-manager framing ------------------------------------'];
  for (const tool of ['apt', 'apt-get', 'aptitude']) {
    const msg = aptMessage(tool).replace(/'/g, `'\\''`);
    lines.push(
      `${tool}() {`,
      `  case "$1" in`,
      `    ${cases}) printf '%s\\n' '${msg}' >&2; return 100 ;;`,
      `    *) if [ -x /usr/bin/${tool} ]; then /usr/bin/${tool} "$@"; else printf '%s\\n' '${msg}' >&2; return 100; fi ;;`,
      '  esac',
      '}',
      `export -f ${tool}`,
    );
  }
  for (const tool of ['add-apt-repository', 'apt-key']) {
    const m = aptMessage(tool).replace(/'/g, `'\\''`);
    lines.push(`${tool}() { printf '%s\\n' '${m}' >&2; return 100; }`, `export -f ${tool}`);
  }
  lines.push('# ---- end peerd package-manager framing --------------------------------');
  return lines.join('\n');
};

/**
 * Reframe a raw bridge error into a clearer VM-facing message. Maps the SW's
 * terse `denylisted: <origin>` / `private_network` into actionable text.
 * @param {string} raw
 * @returns {string}
 */
export const friendlyFetchError = (raw) => {
  const s = String(raw || '').trim();
  if (/denylist/i.test(s)) {
    const origin = s.replace(/^.*denylisted:\s*/i, '').trim();
    return `blocked by your denylist${origin ? ` (${origin})` : ''} — edit it in the side panel's denylist settings`;
  }
  if (/private_network|loopback|link-local|SSRF/i.test(s)) {
    return 'blocked: LAN / localhost targets are not reachable from the sandbox (SSRF guard)';
  }
  return s;
};
