// @ts-check
// http-bridge — the pure wire codec for the VM↔host HTTP channel.
//
// The WebVM has no sockets (DESIGN.md §8.5; CheerpX networking would mean
// lwIP-over-Tailscale, an out-of-browser dependency we deliberately reject).
// So every byte of network the VM does rides ONE channel: a sentinel line on
// the VM's stdout that the host (vm-tab.js) parses, turns into a denylist-gated
// `webFetch`, and answers by staging response files back through the DataDevice.
//
// DataDevice is host→VM only (writeFile/delete; no host-side read — see
// vm-tab.js), so the request has to travel up INSIDE the sentinel line. This
// module owns that envelope so the framing lives in one tested place instead of
// being smeared across bash string-building and the host's byte scanner.
//
// Two markers, by design:
//   - GET_MARKER  (`___PEERD_HTTP___:<id>:<url>`) — the original fast path:
//     a bare GET, URL inline, body-only response. Untouched for back-compat
//     (peerd-fetch's hot path and every existing caller still works verbatim).
//   - REQ_MARKER  (`___PEERD_REQ___:<id>:<b64json>`) — the rich path: a full
//     request {method, url, headers, body} as base64'd JSON, answered with
//     status + headers + body. This is what unlocks POST/PUT/DELETE, custom
//     headers, REST/GraphQL, auth, real archive-clone, and the pkg shims.
//
// why base64-JSON and not inline fields: a request line must survive a single
// PTY write with no embedded newlines and arbitrary header/body bytes. base64
// of a compact JSON object is the only framing that's binary-safe AND
// single-line. Bodies are capped (MAX_REQ_BODY_BYTES) because the line crosses
// the emulated PTY — multi-MB single lines are slow and risk the host's read
// buffer; large uploads are a documented non-goal of the in-VM bridge.

/** @typedef {{ method: string, url: string, headers: Record<string,string>, body: string|null }} VmHttpRequest */
/** @typedef {{ status: number, statusText: string, headers: Record<string,string> }} VmHttpResponseMeta */

export const GET_MARKER = '___PEERD_HTTP___:';
export const REQ_MARKER = '___PEERD_REQ___:';

// Body cap for a single in-VM request (pre-base64). The SW handler caps the
// RESPONSE at 50MB; this caps the REQUEST, which must fit one PTY line.
export const MAX_REQ_BODY_BYTES = 8 * 1024 * 1024;

// Methods we let through. webFetch applies the denylist + SSRF + audit on every
// one of these (the SW handler notes a POST is not a new egress surface), so the
// gate is the allowed-verb list, not the security boundary.
export const ALLOWED_METHODS = Object.freeze([
  'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS',
]);

// Side-effecting verbs — surfaced so callers/audit can treat them distinctly.
export const WRITE_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);

/** @param {string} [method] @returns {boolean} */
export const isWriteMethod = (method) =>
  WRITE_METHODS.includes(String(method ?? '').toUpperCase());

// Methods that read without transmitting a body — the only ones the anti-exfil
// web-write confirm gate exempts. EVERYTHING else (POST/PUT/PATCH/DELETE AND
// OPTIONS, which can carry a body) is gated. The single source of truth for
// both gate call sites (fetch_url + the WebVM bridge), so they can't drift.
export const NON_GATED_METHODS = Object.freeze(['GET', 'HEAD']);

/** @param {string} [method] @returns {boolean} */
export const needsWebWriteConfirm = (method) =>
  !NON_GATED_METHODS.includes(String(method ?? 'GET').toUpperCase());

/**
 * Normalize + validate a request before it goes on the wire. Throws on a
 * disallowed method, a non-http(s) URL, or an oversized body — fail fast at
 * the encode boundary, not deep in the host handler.
 * @param {Partial<VmHttpRequest>} req
 * @returns {VmHttpRequest}
 */
export const normalizeRequest = (req) => {
  const method = String(req?.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) {
    throw new RangeError(`vm-http: unsupported method ${method}`);
  }
  const url = String(req?.url ?? '');
  // http(s) for real fetches, plus the internal `peerd://` scheme for host-side
  // control ops (git-clone, pkg installs) that the host orchestrates rather
  // than fetching directly. Everything else (file://, chrome://) is refused.
  if (!/^(https?|peerd):\/\//i.test(url)) {
    throw new RangeError('vm-http: url must be http(s) or peerd://');
  }
  // Header keys/values coerced to strings; empty object when absent. CR/LF/TAB
  // are stripped — they can't legitimately appear in an HTTP header and are the
  // delimiters of this wire format, so scrubbing them here is defense-in-depth
  // against a producer that smuggled a delimiter into a value (the bash wrappers
  // also strip them at the source).
  /** @type {Record<string,string>} */
  const headers = {};
  /** @param {string} s */
  const scrub = (s) => String(s).replace(/[\r\n\t]/g, '');
  if (req?.headers && typeof req.headers === 'object') {
    for (const [k, v] of Object.entries(req.headers)) {
      const name = scrub(k);
      if (name) headers[name] = scrub(v);
    }
  }
  const body = req?.body == null ? null : String(req.body);
  if (body != null) {
    // body is base64 on the wire; measure the decoded length against the cap.
    const approxBytes = Math.floor((body.length * 3) / 4);
    if (approxBytes > MAX_REQ_BODY_BYTES) {
      throw new RangeError(
        `vm-http: request body ${approxBytes}B exceeds ${MAX_REQ_BODY_BYTES}B cap`,
      );
    }
  }
  // why no `auth` field: a VM-supplied request must NEVER be able to request
  // credential injection. Only the host's own control ops (git-clone) attach
  // git auth, on URLs the host derived — see vm-tab.js handleControlOp. The
  // wire format intentionally carries no auth field (removed after a security
  // review found the VM could set it to weaponize the user's token).
  return { method, url, headers, body };
};

// The wire blob is a line-oriented, TAB-delimited format, base64'd as a whole
// for single-line PTY transport. why not JSON: the producer is bash (the VM's
// curl/wget/git wrappers); emitting JSON from bash means escaping quotes and
// backslashes in URLs/header values by hand, which is exactly the fragile thing
// that breaks silently. This format is `printf '%s\t%s\n'`-trivial to emit and
// unambiguous to parse — the only multi-byte/binary field (the body) rides as
// base64, so no field ever contains a tab or newline.
//
//   PEERDREQ1
//   M\t<METHOD>
//   U\t<URL>
//   H\t<HeaderName>\t<HeaderValue>   (zero or more)
//   B\t<base64-body>                 (omitted when there is no body)
export const WIRE_TAG = 'PEERDREQ1';

/** @param {string} s @param {{ btoa?: (s: string) => string }} io */
const b64encodeUtf8 = (s, io) => (io.btoa ?? globalThis.btoa)(unescape(encodeURIComponent(s)));
/** @param {string} s @param {{ atob?: (s: string) => string }} io */
const b64decodeUtf8 = (s, io) => decodeURIComponent(escape((io.atob ?? globalThis.atob)(s)));

/**
 * Encode a request as the REQ_MARKER payload (base64 of the wire blob). Mirrors
 * exactly what the bash wrapper emits, so the round-trip is testable end to end.
 * @param {Partial<VmHttpRequest>} req
 * @param {{ btoa?: (s: string) => string }} [io]
 * @returns {string} the base64 payload (without the marker prefix)
 */
export const encodeRequest = (req, io = {}) => {
  const norm = normalizeRequest(req);
  const lines = [WIRE_TAG, `M\t${norm.method}`, `U\t${norm.url}`];
  for (const [name, value] of Object.entries(norm.headers)) {
    lines.push(`H\t${name}\t${value}`);
  }
  if (norm.body != null) lines.push(`B\t${norm.body}`);
  return b64encodeUtf8(lines.join('\n'), io);
};

/**
 * Decode a REQ_MARKER payload back into a request. Tolerant of unknown line
 * prefixes (forward-compat) but strict on the version tag.
 * @param {string} payload base64 wire blob
 * @param {{ atob?: (s: string) => string }} [io]
 * @returns {VmHttpRequest}
 */
export const decodeRequest = (payload, io = {}) => {
  const blob = b64decodeUtf8(payload, io);
  const lines = blob.split('\n');
  if (lines[0] !== WIRE_TAG) throw new RangeError('vm-http: bad wire tag');
  let method = 'GET';
  let url = '';
  let body = null;
  /** @type {Record<string,string>} */
  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const t1 = line.indexOf('\t');
    if (t1 < 0) continue;
    const kind = line.slice(0, t1);
    const rest = line.slice(t1 + 1);
    switch (kind) {
      case 'M': method = rest; break;
      case 'U': url = rest; break;
      // No 'A' (auth) case: a VM request can never request credential injection.
      case 'B': body = rest; break;
      case 'H': {
        const t2 = rest.indexOf('\t');
        if (t2 >= 0) headers[rest.slice(0, t2)] = rest.slice(t2 + 1);
        break;
      }
      default: break; // unknown prefix — ignore for forward-compat
    }
  }
  return normalizeRequest({ method, url, headers, body });
};

/**
 * Parse a single sentinel line (the text BETWEEN a marker prefix and its
 * trailing newline) into a structured request descriptor. Returns null when
 * the line is malformed — the host then treats those bytes as ordinary stdout
 * rather than swallowing them (a corrupt marker must never eat terminal output).
 *
 * @param {'get'|'req'} kind which marker matched
 * @param {string} line the bytes after the marker prefix, up to (not incl.) '\n'
 * @param {{ atob?: (s: string) => string }} [io]
 * @returns {{ id: string } & ({ kind: 'get', url: string } | { kind: 'req', request: VmHttpRequest }) | null}
 */
export const parseMarkerLine = (kind, line, io = {}) => {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const id = line.slice(0, colon);
  const rest = line.slice(colon + 1);
  if (!/^[A-Za-z0-9]+$/.test(id)) return null;
  if (kind === 'get') {
    if (!/^https?:\/\//i.test(rest)) return null;
    return { kind: 'get', id, url: rest };
  }
  try {
    const request = decodeRequest(rest, io);
    return { kind: 'req', id, request };
  } catch {
    return null;
  }
};

/**
 * Find the next marker (either kind) at or after `from` in a buffer. Used by
 * the host's streaming byte scanner. Returns the earliest match so the two
 * markers can coexist without the scanner missing one behind the other.
 * @param {string} buf
 * @param {number} from
 * @returns {{ index: number, kind: 'get'|'req', marker: string } | null}
 */
export const findNextMarker = (buf, from) => {
  const g = buf.indexOf(GET_MARKER, from);
  const r = buf.indexOf(REQ_MARKER, from);
  if (g < 0 && r < 0) return null;
  if (r < 0 || (g >= 0 && g <= r)) return { index: g, kind: 'get', marker: GET_MARKER };
  return { index: r, kind: 'req', marker: REQ_MARKER };
};

/**
 * How many trailing bytes of `buf` could be the prefix of a (possibly split)
 * marker, so the scanner can hold them back until the next chunk arrives.
 * Considers BOTH markers and returns the longest partial.
 * @param {string} buf
 * @returns {number} index from which to hold; buf.length if nothing to hold
 */
export const partialMarkerHoldIndex = (buf) => {
  let hold = buf.length;
  for (const marker of [GET_MARKER, REQ_MARKER]) {
    const tailLen = Math.min(marker.length - 1, buf.length);
    for (let h = tailLen; h >= 1; h--) {
      if (marker.startsWith(buf.slice(buf.length - h))) {
        hold = Math.min(hold, buf.length - h);
        break;
      }
    }
  }
  return hold;
};

/**
 * Serialize response metadata for the `/peerdmeta<id>` staging file the rich
 * path reads. Small, JSON, header keys lower-cased for predictable lookup.
 * @param {VmHttpResponseMeta} meta
 * @returns {string}
 */
export const encodeResponseMeta = (meta) => JSON.stringify({
  status: meta.status ?? 0,
  statusText: meta.statusText ?? '',
  headers: Object.fromEntries(
    Object.entries(meta.headers ?? {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]),
  ),
});
