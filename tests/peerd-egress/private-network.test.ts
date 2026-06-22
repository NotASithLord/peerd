import { describe, test, expect } from 'bun:test';
import { isPrivateOrLocalHost } from '../../extension/peerd-egress/fetch/private-network.js';

describe('isPrivateOrLocalHost — BLOCKS private / loopback / link-local', () => {
  const blocked = [
    // hostnames
    'localhost', 'LOCALHOST', 'foo.localhost', 'printer.local', 'db.LOCAL',
    // IPv4 dotted
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.1.1',
    '169.254.0.1', '169.254.169.254', // ← cloud metadata endpoint
    '0.0.0.0',
    // IPv4 encoded forms (the researcher's second move)
    '2130706433',          // decimal 127.0.0.1
    '0x7f000001',          // hex 127.0.0.1
    '0177.0.0.1',          // octal first octet
    '127.1',               // short form → 127.0.0.1
    '127.0.1',             // short form → 127.0.0.1
    '3232235777',          // decimal 192.168.1.1
    // IPv6
    '::1', '[::1]', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::abcd',
    'fe80::', 'febf::1', '0:0:0:0:0:0:0:1', // link-local edge + fully-expanded loopback
    '::ffff:192.168.1.1',  // IPv4-mapped private (dotted)
    '::ffff:127.0.0.1',
    // IPv4-mapped in the COMPRESSED-HEX form new URL() actually produces —
    // the regression these tests guard. Dotted ::ffff:127.0.0.1 normalizes
    // to ::ffff:7f00:1, which the old dotted-only regex never matched.
    '::ffff:7f00:1',       // = 127.0.0.1 loopback
    '::ffff:a9fe:a9fe',    // = 169.254.169.254 cloud metadata
    '[::ffff:7f00:1]',     // bracketed (as URL.hostname yields it)
    '::ffff:0a00:0001',    // = 10.0.0.1
    '::ffff:c0a8:0101',    // = 192.168.1.1
    '64:ff9b::a9fe:a9fe',  // NAT64 well-known prefix embedding 169.254.169.254
    '::7f00:1',            // IPv4-compatible (deprecated) → 127.0.0.1
  ];
  for (const h of blocked) {
    test(`blocks ${h}`, () => expect(isPrivateOrLocalHost(h)).toBe(true));
  }
});

describe('isPrivateOrLocalHost — ALLOWS public hosts', () => {
  const allowed = [
    'example.com', 'api.anthropic.com', 'huggingface.co', 'en.wikipedia.org',
    '8.8.8.8', '1.1.1.1', '93.184.216.34', // public IPs
    '172.15.255.255', '172.32.0.1',         // just OUTSIDE 172.16/12
    '11.0.0.1', '126.0.0.1', '128.0.0.1',   // adjacent to private ranges, public
    '169.253.0.1', '169.255.0.1',           // adjacent to link-local, public
    '2606:4700:4700::1111',                  // public IPv6 (Cloudflare)
    '2001:4860:4860::8888',                   // public IPv6 (Google DNS)
    '64:ff9b::808:808',                       // NAT64 embedding PUBLIC 8.8.8.8 — must NOT over-block
    '::ffff:808:808',                         // IPv4-mapped PUBLIC 8.8.8.8
    'mylocalshop.com', 'notlocalhost.com', 'local.example.com', // substrings, not suffixes
  ];
  for (const h of allowed) {
    test(`allows ${h}`, () => expect(isPrivateOrLocalHost(h)).toBe(false));
  }
});

describe('isPrivateOrLocalHost — robustness', () => {
  test('handles empty / non-string / trailing dot', () => {
    expect(isPrivateOrLocalHost('')).toBe(false);
    expect(isPrivateOrLocalHost(undefined as any)).toBe(false);
    expect(isPrivateOrLocalHost(null as any)).toBe(false);
    expect(isPrivateOrLocalHost('localhost.')).toBe(true);   // FQDN root dot
    expect(isPrivateOrLocalHost('127.0.0.1.')).toBe(true);
  });
  test('a numeric-looking but invalid host is not treated as a private IP', () => {
    expect(isPrivateOrLocalHost('999.999.999.999')).toBe(false); // out of range → not parsed as IP
    expect(isPrivateOrLocalHost('1e10')).toBe(false);            // not an integer literal
  });
});
