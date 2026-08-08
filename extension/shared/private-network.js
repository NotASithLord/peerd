// @ts-check
// Pure private-network and cloud-metadata hostname policy.
//
// Browser automation and open-web fetches both need the same lexical check.
// Keep it in shared/ so neither policy reaches through another module's private
// files. This does not resolve DNS, so a public hostname that later resolves or
// rebinds to a private address remains outside this client-side check.

// URL.hostname keeps brackets around IPv6 literals.
/** @param {string} hostname */
const unbracket = (hostname) => hostname.startsWith('[') && hostname.endsWith(']')
  ? hostname.slice(1, -1)
  : hostname;

/** @param {string} hostname */
const normalizeHostname = (hostname) => unbracket(
  hostname.trim().toLowerCase().replace(/\.$/, ''),
);

const CLOUD_METADATA_HOSTS = new Set([
  '169.254.169.254',
  '100.100.100.200',
  '168.63.129.16',
  'fd00:ec2::254',
  'metadata.google.internal',
]);

/** @param {string} hostname */
export const isCloudMetadataHost = (hostname) => typeof hostname === 'string'
  && CLOUD_METADATA_HOSTS.has(normalizeHostname(hostname));

// Parse one inet_aton part: decimal, 0x hex, or 0-prefixed octal.
/** @param {string} part @returns {number} */
const parsePart = (part) => {
  if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part, 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part, 8);
  if (part === '0') return 0;
  if (/^[1-9]\d*$/.test(part)) return parseInt(part, 10);
  return NaN;
};

// inet_aton-style IPv4 parse. The final part fills the remaining low bytes.
/** @param {string} host @returns {number[] | null} */
const looseIpv4ToOctets = (host) => {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const numbers = parts.map(parsePart);
  if (numbers.some((number) => !Number.isInteger(number) || number < 0)) return null;
  let value;
  if (parts.length === 1) {
    if (numbers[0] > 0xffffffff) return null;
    value = numbers[0];
  } else if (parts.length === 2) {
    if (numbers[0] > 0xff || numbers[1] > 0xffffff) return null;
    value = numbers[0] * 0x1000000 + numbers[1];
  } else if (parts.length === 3) {
    if (numbers[0] > 0xff || numbers[1] > 0xff || numbers[2] > 0xffff) return null;
    value = numbers[0] * 0x1000000 + numbers[1] * 0x10000 + numbers[2];
  } else {
    if (numbers.some((number) => number > 0xff)) return null;
    value = numbers[0] * 0x1000000 + numbers[1] * 0x10000 + numbers[2] * 0x100 + numbers[3];
  }
  value >>>= 0;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
};

/** @param {number[]} octets */
const isPrivateIpv4 = ([first, second]) =>
  first === 0
  || first === 10
  || first === 127
  || (first === 100 && second >= 64 && second <= 127)
  || (first === 169 && second === 254)
  || (first === 172 && second >= 16 && second <= 31)
  || (first === 192 && second === 168)
  || (first === 198 && (second === 18 || second === 19))
  || first >= 224;

// Expand IPv6 into eight hextets, including an optional dotted IPv4 tail.
/** @param {string} input @returns {number[] | null} */
const expandIpv6 = (input) => {
  if (typeof input !== 'string' || !input.includes(':')) return null;
  let source = input;
  const lastColon = source.lastIndexOf(':');
  const tail = source.slice(lastColon + 1);
  if (tail.includes('.')) {
    const octets = looseIpv4ToOctets(tail);
    if (!octets) return null;
    source = `${source.slice(0, lastColon + 1)
      + ((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const back = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - back.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...back];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const hextets = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    hextets.push(parseInt(group, 16));
  }
  return hextets;
};

/** @param {number[]} hextets */
const embeddedIpv4 = (hextets) => [
  (hextets[6] >> 8) & 0xff,
  hextets[6] & 0xff,
  (hextets[7] >> 8) & 0xff,
  hextets[7] & 0xff,
];

/** @param {string} host */
const isPrivateIpv6 = (host) => {
  const hextets = expandIpv6(host);
  if (!hextets) return false;
  const highZero = hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0
    && hextets[3] === 0 && hextets[4] === 0;
  if (highZero && hextets[5] === 0) {
    if (hextets[6] === 0 && hextets[7] <= 1) return true;
    return isPrivateIpv4(embeddedIpv4(hextets));
  }
  if (highZero && hextets[5] === 0xffff) return isPrivateIpv4(embeddedIpv4(hextets));
  if (hextets[0] === 0x64 && hextets[1] === 0xff9b
    && hextets[2] === 0 && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0) {
    return isPrivateIpv4(embeddedIpv4(hextets));
  }
  // RFC 8215 leaves the translation layout inside 64:ff9b:1::/48 to the
  // operator, so the whole local-use prefix is out of scope for open-web work.
  if (hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets[2] === 1) return true;
  if ((hextets[0] & 0xfe00) === 0xfc00) return true;
  if ((hextets[0] & 0xffc0) === 0xfe80) return true;
  if ((hextets[0] & 0xffc0) === 0xfec0) return true;
  if ((hextets[0] & 0xff00) === 0xff00) return true;
  return false;
};

/**
 * Return true for lexical local, private, special-use, or cloud-metadata hosts.
 * This function does not resolve DNS.
 *
 * @param {string} host
 * @returns {boolean}
 */
export const isPrivateOrLocalHost = (host) => {
  if (typeof host !== 'string' || !host) return false;
  const hostname = normalizeHostname(host);
  if (!hostname) return false;
  if (isCloudMetadataHost(hostname)) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === 'localhost.localdomain' || hostname.endsWith('.localhost.localdomain')) return true;
  if (hostname === 'ip6-localhost' || hostname === 'ip6-loopback') return true;
  if (hostname === 'local' || hostname.endsWith('.local')) return true;
  if (hostname === 'home.arpa' || hostname.endsWith('.home.arpa')) return true;
  if (hostname.includes(':')) return isPrivateIpv6(hostname);
  const octets = looseIpv4ToOctets(hostname);
  return octets ? isPrivateIpv4(octets) : false;
};
