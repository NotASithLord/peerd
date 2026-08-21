import { describe, expect, test } from 'bun:test';
import * as cold from '../../extension/shared/cold-util.js';
import * as util from '../../extension/shared/util.js';

describe('cold utility leaf', () => {
  test('the broad utility API re-exports the exact cold implementations', () => {
    expect(util.bytesToBase64).toBe(cold.bytesToBase64);
    expect(util.base64ToBytes).toBe(cold.base64ToBytes);
    expect(util.uuidv7).toBe(cold.uuidv7);
  });

  test('binary transport is exact across chunk boundaries', () => {
    for (const size of [0, 1, 32_767, 32_768, 32_769, 70_000]) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 31 + 7) & 0xff);
      expect(cold.base64ToBytes(cold.bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  test('UUIDv7 preserves its deterministic timestamp/version/variant layout', () => {
    const uuid = cold.uuidv7(
      () => 0x0123456789ab,
      () => Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 1, 2, 3, 4]),
    );
    expect(uuid).toBe('01234567-89ab-7abb-8cdd-eeff01020304');
  });
});
