import { describe, expect, test } from 'bun:test';
import {
  checkedWasmerFiles,
  checkedWasmerPath,
  WasmerHostError,
} from '../../../extension/engine-tabs/pod-tab/wasmer-host.js';

describe('Wasmer workspace validation', () => {
  test('accepts relative paths without changing file names', () => {
    for (const path of ['answer.txt', 'src/main.rs', '.git/config', 'data/hello world.txt', 'résultat.json']) {
      expect(checkedWasmerPath(path)).toBe(path);
    }
  });

  test('refuses absolute paths, traversal, separators, and null bytes', () => {
    for (const path of [
      '', '/', '/other-pod/secret', '.', '..', '../secret', 'src/../../secret',
      'src/./file', 'src/../file', 'src//file', 'src/', 'src\\file', 'src/\0file',
      null, undefined, 42, ['file'],
    ]) {
      expect(() => checkedWasmerPath(path)).toThrow(WasmerHostError);
    }
  });

  test('preserves binary bytes and keeps special file names out of the object prototype', () => {
    const input = Object.create(null) as Record<string, Uint8Array>;
    input['binary.dat'] = new Uint8Array([0, 255, 128, 10]);
    input['__proto__'] = new Uint8Array([1]);
    input['constructor'] = new Uint8Array([2]);
    const result = checkedWasmerFiles(input);
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.keys(result)).toEqual(['binary.dat', '__proto__', 'constructor']);
    expect([...result['binary.dat']!]).toEqual([0, 255, 128, 10]);
    expect([...result['__proto__']!]).toEqual([1]);
    expect([...result['constructor']!]).toEqual([2]);
  });

  test('refuses invalid maps, unsafe keys, and non-byte file contents', () => {
    for (const files of [
      null, undefined, [], 'files', new Map(), new Date(), new ArrayBuffer(1), new Uint8Array(),
      Object.create({ file: new Uint8Array([1]) }),
      { '../other-pod/secret': new Uint8Array([1]) },
      { '/absolute.txt': new Uint8Array([1]) },
      { 'text.txt': 'text' },
      { 'array.dat': [1, 2] },
      { 'buffer.dat': new ArrayBuffer(2) },
      { 'wide.dat': new Uint16Array([1]) },
    ]) {
      expect(() => checkedWasmerFiles(files)).toThrow(WasmerHostError);
    }
  });

  test('bounds workspace path depth', () => {
    const path = Array.from({ length: 64 }, () => 'dir').join('/');
    expect(checkedWasmerPath(path)).toBe(path);
    expect(() => checkedWasmerPath(`${path}/file`)).toThrow(WasmerHostError);
    expect(() => checkedWasmerFiles({ [`${path}/file`]: new Uint8Array() })).toThrow(WasmerHostError);
  });

  test('refuses a file that is also an ancestor directory in either order', () => {
    const bytes = new Uint8Array([1]);
    for (const entries of [
      [['src', bytes], ['src/main.rs', bytes]],
      [['src/main.rs', bytes], ['src', bytes]],
      [['src', bytes], ['src/deep/main.rs', bytes]],
    ]) {
      expect(() => checkedWasmerFiles(Object.fromEntries(entries))).toThrow('conflicting workspace paths');
    }
    expect(Object.keys(checkedWasmerFiles({ 'src/main.rs': bytes, 'src/main.rs.bak': bytes }))).toHaveLength(2);
  });

  test('refuses shared file bytes that could change after validation', () => {
    const bytes = new Uint8Array(new SharedArrayBuffer(4));
    bytes.set([0, 1, 2, 3]);
    expect(() => checkedWasmerFiles({ 'shared.dat': bytes })).toThrow('invalid file bytes');
  });

  test('bounds the number of workspace files', () => {
    const files = Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`${index}.txt`, new Uint8Array()]));
    expect(Object.keys(checkedWasmerFiles(files))).toHaveLength(2_000);
    files['overflow.txt'] = new Uint8Array();
    expect(() => checkedWasmerFiles(files)).toThrow('too many files');
  });

  test('bounds each file and the total workspace bytes', () => {
    const bytes = new Uint8Array(16 * 1024 * 1024);
    const files = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`${index}.dat`, bytes]));
    expect(Object.keys(checkedWasmerFiles(files))).toHaveLength(8);
    expect(() => checkedWasmerFiles({ ...files, 'overflow.dat': new Uint8Array([1]) }))
      .toThrow('workspace exceeds its byte limit');
    expect(() => checkedWasmerFiles({ 'large.dat': new Uint8Array(bytes.byteLength + 1) }))
      .toThrow('file exceeds its byte limit');
  });
});
