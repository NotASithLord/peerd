// @ts-check
// Private-network egress guard — SSRF defense for webFetch (the open-web path).
//
// webFetch is allowlist-FREE by design (the open web is open). But "open web"
// must NOT include the user's LAN, loopback, or link-local space: a
// prompt-injected agent calling call_api / read_article / vm_import with a
// private URL could scan the LAN or hit localhost services. The denylist can't
// express this — it matches host strings / *.suffix, not IP ranges — so we
// block private + loopback + link-local hosts here, ahead of the denylist.
//
// SCOPE (honest, so the copy doesn't over-claim):
//   - This blocks DIRECT private-IP / localhost targets, including the classic
//     encoded forms (decimal 2130706433, hex 0x7f000001, octal 0177.0.0.1,
//     short 127.1) that a researcher tries right after 127.0.0.1.
//   - It does NOT defend DNS REBINDING (a public domain resolving to a private
//     IP) — fetch never exposes the resolved IP, so that isn't blockable
//     client-side.
//   - It is NOT the defense against exfil to arbitrary PUBLIC domains. That's
//     inherent to open-web access; the architectural defense is that the
//     do/get/check runner has NO web tools, so an injected runner can't exfil.
//
// Pure — table-tested. No imports.

// URL.hostname keeps the [] around IPv6 literals; strip them.
/** @param {string} h */
const unbracket = (h) => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h);

// Parse one inet_aton part: decimal, 0x-hex, or 0-prefixed octal. NaN if not numeric.
/** @param {string} s @returns {number} */
const parsePart = (s) => {
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^0[0-7]+$/.test(s)) return parseInt(s, 8);
  if (s === '0') return 0;
  if (/^[1-9]\d*$/.test(s)) return parseInt(s, 10);
  return NaN;
};

// inet_aton-style IPv4 parse: 1–4 dotted parts, each decimal/hex/octal. The
// last part fills the remaining low bytes (so 127.1 === 127.0.0.1,
// 2130706433 === 127.0.0.1). Returns 4 octets [a,b,c,d] or null if not an IPv4.
/** @param {string} host @returns {number[] | null} */
const looseIpv4ToOctets = (host) => {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = parts.map(parsePart);
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  let value;
  if (parts.length === 1) { if (nums[0] > 0xffffffff) return null; value = nums[0]; }
  else if (parts.length === 2) { if (nums[0] > 0xff || nums[1] > 0xffffff) return null; value = nums[0] * 0x1000000 + nums[1]; }
  else if (parts.length === 3) { if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null; value = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2]; }
  else { if (nums.some((n) => n > 0xff)) return null; value = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2] * 0x100 + nums[3]; }
  value = value >>> 0; // to unsigned 32-bit
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
};

/** @param {number[]} octets */
const isPrivateIpv4 = ([a, b]) =>
  a === 0          // 0.0.0.0/8 "this network" (routes to localhost on some stacks)
  || a === 10      // 10.0.0.0/8
  || a === 127     // 127.0.0.0/8 loopback
  || (a === 169 && b === 254)            // 169.254.0.0/16 link-local
  || (a === 172 && b >= 16 && b <= 31)   // 172.16.0.0/12
  || (a === 192 && b === 168);           // 192.168.0.0/16

// Expand an IPv6 string into its 8 16-bit hextets. Handles `::` zero-run
// compression and an optional trailing dotted-IPv4 tail (IPv4-in-IPv6).
// Returns an array of 8 integers, or null if it doesn't parse as IPv6.
//
// why structural, not regex: `new URL()` re-serializes IPv4-mapped IPv6 to
// COMPRESSED HEX (`::ffff:127.0.0.1` → `::ffff:7f00:1`,
// `::ffff:169.254.169.254` → `::ffff:a9fe:a9fe`), so a regex on the dotted
// form never matches real input — letting loopback/LAN/cloud-metadata slip
// through. Expanding to hextets and checking the low 32 bits closes that.
/** @param {string} input @returns {number[] | null} */
const expandIpv6 = (input) => {
  if (typeof input !== 'string' || input.indexOf(':') === -1) return null;
  let s = input;
  // A trailing dotted-quad (e.g. `::ffff:127.0.0.1`) → two hex hextets, so
  // the dotted unit-test inputs keep working alongside the hex form.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.indexOf('.') !== -1) {
    const o = looseIpv4ToOctets(tail);
    if (!o) return null;
    s = `${s.slice(0, lastColon + 1)
      + ((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;                  // more than one `::`
  const head = halves[0] ? halves[0].split(':') : [];
  const back = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - back.length;
    if (fill < 1) return null;                         // `::` must cover ≥1 zero group
    groups = [...head, ...Array(fill).fill('0'), ...back];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const hextets = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    hextets.push(parseInt(g, 16));
  }
  return hextets;
};

// Low 32 bits of an expanded IPv6 → the 4 embedded IPv4 octets.
/** @param {number[]} x @returns {number[]} */
const embeddedV4 = (x) => [(x[6] >> 8) & 0xff, x[6] & 0xff, (x[7] >> 8) & 0xff, x[7] & 0xff];

/** @param {string} h */
const isPrivateIpv6 = (h) => {
  const x = expandIpv6(h);
  if (!x) return false;
  const hiZero = x[0] === 0 && x[1] === 0 && x[2] === 0 && x[3] === 0 && x[4] === 0;
  // ::, ::1, and ::a.b.c.d (IPv4-compatible, deprecated) — high bits zero.
  if (hiZero && x[5] === 0) {
    if (x[6] === 0 && x[7] === 0) return true;          // :: unspecified
    if (x[6] === 0 && x[7] === 1) return true;          // ::1 loopback
    return isPrivateIpv4(embeddedV4(x));                // ::a.b.c.d
  }
  // ::ffff:a.b.c.d IPv4-mapped (dotted OR compressed-hex) — check the v4.
  if (hiZero && x[5] === 0xffff) return isPrivateIpv4(embeddedV4(x));
  // 64:ff9b::/96 well-known NAT64 prefix embeds a v4 in the low 32 bits.
  if (x[0] === 0x64 && x[1] === 0xff9b && x[2] === 0 && x[3] === 0 && x[4] === 0 && x[5] === 0) {
    return isPrivateIpv4(embeddedV4(x));
  }
  if ((x[0] & 0xfe00) === 0xfc00) return true;          // fc00::/7 unique-local
  if ((x[0] & 0xffc0) === 0xfe80) return true;          // fe80::/10 link-local
  return false;
};

/**
 * Is this host a private / loopback / link-local target that open-web egress
 * must refuse? Covers `localhost`, `*.localhost`, `*.local` (mDNS), IPv4 (incl.
 * decimal/hex/octal/short encodings), and IPv6 (loopback, ULA, link-local,
 * IPv4-mapped).
 *
 * @param {string} host  a URL.hostname (may include [] for IPv6)
 * @returns {boolean}
 */
export const isPrivateOrLocalHost = (host) => {
  if (!host || typeof host !== 'string') return false;
  const h = unbracket(host.trim().toLowerCase()).replace(/\.$/, ''); // drop FQDN trailing dot
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;               // mDNS / Bonjour
  if (h.includes(':')) return isPrivateIpv6(h);        // IPv6 literal
  const octets = looseIpv4ToOctets(h);                 // IPv4 (any encoding)
  if (octets) return isPrivateIpv4(octets);
  return false;                                        // ordinary public hostname
};
