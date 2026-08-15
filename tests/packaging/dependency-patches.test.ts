import { describe, expect, test } from 'bun:test';
import imageSize from 'image-size';

const ascii = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0));

const uint32be = (value: number) => Uint8Array.of(
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
);

const join = (...parts: Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const box = (name: string, payload = new Uint8Array()) =>
  join(uint32be(8 + payload.length), ascii(name), payload);

describe('build-tool dependency patches', () => {
  test.each([
    [
      'icns',
      join(ascii('icns'), uint32be(16), ascii('ic07'), uint32be(8)),
    ],
    [
      'heif',
      box('ftyp', ascii('heic')),
    ],
    [
      'jxl',
      join(box('JXL ', Uint8Array.of(0x0d, 0x0a, 0x87, 0x0a)), box('ftyp', ascii('jxl '))),
    ],
  ] as const)('disables the vulnerable %s parser in image-size', (type, input) => {
    expect(() => imageSize(input)).toThrow(`disabled file type: ${type}`);
  });
});
