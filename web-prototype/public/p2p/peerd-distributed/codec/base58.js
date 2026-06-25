// peerd-distributed/codec/base58.js — base58btc (Bitcoin alphabet).
//
// why: did:key uses multibase base58btc (the 'z' prefix). This is the
// one encoding the W3C did:key spec mandates and there is no native
// browser primitive for it, so we carry a tiny, audited implementation
// rather than vendor a library (no-build-step / no-npm-runtime rule).
// Apache-clean, in-tree. Big-number long division, byte by byte.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE = 58;

// Reverse lookup table: char code -> digit value (-1 if not in alphabet).
const LOOKUP = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export const base58encode = (bytes) => {
  // Count leading zero bytes — each maps to a leading '1'.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Repeated division of the base-256 number by 58, collecting remainders.
  const input = Array.from(bytes);
  const out = [];
  let start = zeros;
  while (start < input.length) {
    let remainder = 0;
    for (let i = start; i < input.length; i++) {
      const acc = (remainder << 8) + input[i];
      input[i] = Math.floor(acc / BASE);
      remainder = acc % BASE;
    }
    out.push(remainder);
    while (start < input.length && input[start] === 0) start++;
  }

  let str = '1'.repeat(zeros);
  for (let i = out.length - 1; i >= 0; i--) str += ALPHABET[out[i]];
  return str;
};

export const base58decode = (str) => {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;

  // Accumulate into a little-endian base-256 digit array.
  const digits = [];
  for (let i = zeros; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const val = code < 128 ? LOOKUP[code] : -1;
    if (val < 0) throw new Error(`base58decode: invalid character '${str[i]}'`);
    let carry = val;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * BASE;
      digits[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + digits.length);
  for (let i = 0; i < digits.length; i++) {
    out[zeros + digits.length - 1 - i] = digits[i];
  }
  return out;
};
