// The source-hygiene gate (packaging/check-source-hygiene.ts) fails CI on the
// two defect classes that slipped through the multi-agent batches and that no
// other check saw: a raw NUL in a text-source file (git treats it as binary ->
// unreviewable) and a tracked symlink (dangles on other clones). These pin the
// pure classifier; the shell is just git enumeration.
//
// NB: the NUL below is built PROGRAMMATICALLY (Uint8Array.from) — a raw NUL in
// this test's own source would (correctly) trip the very gate under test.

import { describe, test, expect } from 'bun:test';
import {
  firstNulByte, isSourcePath, classifyEntry, SYMLINK_MODE,
} from '../../packaging/check-source-hygiene.ts';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
/** ASCII "x" + one raw byte + "y", so the byte's offset is deterministically 1. */
const withByte = (b: number): Uint8Array => Uint8Array.from([0x78, b, 0x79]);

describe('firstNulByte', () => {
  test('clean text (tabs / newlines / CRLF / unicode) -> null', () => {
    expect(firstNulByte(bytes('const x = 1;\n\tconst y = 2;\r\n'))).toBeNull();
    expect(firstNulByte(bytes(''))).toBeNull();
    expect(firstNulByte(bytes('const s = "cafe — 日本語 🎯";'))).toBeNull();
  });

  test('a raw NUL is flagged with its offset (the recurred bug)', () => {
    const hit = firstNulByte(withByte(0x00));
    expect(hit).not.toBeNull();
    expect(hit!.offset).toBe(1);
  });

  test('other control bytes are NOT flagged — only NUL makes git binary', () => {
    // ESC / US used as intentional delimiters do not trip git's binary
    // detection, so the gate leaves them alone (targets the exact harm).
    expect(firstNulByte(withByte(0x1b))).toBeNull(); // ESC
    expect(firstNulByte(withByte(0x1f))).toBeNull(); // US
    // The FIX for the bug — a literal backslash-u-0000 in the SOURCE text — is
    // ordinary printable ASCII and must pass.
    expect(firstNulByte(bytes('const SEP = "\\u0000";'))).toBeNull();
  });
});

describe('isSourcePath', () => {
  test('text-source extensions are scanned', () => {
    for (const p of ['a.ts', 'b.js', 'c.mjs', 'd.json', 'e.md', 'f.html', 'g.css', 'h.svg', 'i.yml']) {
      expect(isSourcePath(p)).toBe(true);
    }
  });
  test('binary/extensionless are left alone', () => {
    for (const p of ['a.png', 'b.ico', 'c.wasm', 'd.zip', 'e.woff2', 'LICENSE', 'f']) {
      expect(isSourcePath(p)).toBe(false);
    }
  });
});

describe('classifyEntry', () => {
  const clean = (): Uint8Array => bytes('ok\n');
  const dirty = (): Uint8Array => withByte(0x00);

  test('a tracked symlink is flagged by MODE, regardless of extension', () => {
    const v = classifyEntry(SYMLINK_MODE, 'node_modules', clean);
    expect(v).not.toBeNull();
    expect(v!.kind).toBe('symlink');
    expect(classifyEntry(SYMLINK_MODE, 'link.js', dirty)!.kind).toBe('symlink');
  });

  test('a raw NUL in a regular source file is flagged', () => {
    const v = classifyEntry('100644', 'extension/x.js', dirty);
    expect(v).not.toBeNull();
    expect(v!.kind).toBe('nul-byte');
    expect(v!.detail).toContain('NUL');
  });

  test('clean source, a binary asset, and vendored code all pass', () => {
    expect(classifyEntry('100644', 'extension/x.ts', clean)).toBeNull();
    // a NUL in a .png is expected — not scanned (never read)
    expect(classifyEntry('100644', 'icons/logo.png', dirty)).toBeNull();
    // vendored third-party (incl. minified bundles with control bytes) is
    // reviewed at vendoring time, not by this gate.
    expect(classifyEntry('100644', 'extension/vendor/xterm/xterm.js', dirty)).toBeNull();
  });
});
