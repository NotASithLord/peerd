// .peerd artifact export/import (DESIGN-10) — envelope builders,
// inspect-then-apply verification, the 64MB rail, and the traveling
// VM image pin. Pure values in/out; no browser surface touched.

import { describe, test, expect } from 'bun:test';
import {
  buildAppExport,
  buildNotebookExport,
  buildVmRecipeExport,
  openEnvelope,
  inspectEnvelope,
  exportFilename,
  EXPORT_LIMIT_BYTES,
  EXPORT_FILE_LIMIT_BYTES,
} from '../../extension/peerd-engine/export.js';
import { ArtifactTooLargeError } from '../../extension/peerd-engine/errors.js';
import { fromUtf8 } from '../../extension/shared/bundle/bytes.js';

const APP_FILES = {
  'index.html': '<!doctype html><h1>calc</h1><script src="./app.js"></script>',
  'app.js': 'console.log("hi")',
  'style.css': 'h1 { font-weight: 500; }',
};

const textFiles = (files: Record<string, Uint8Array>) =>
  Object.fromEntries(Object.entries(files).map(([p, b]) => [p, fromUtf8(b)]));

describe('.peerd envelope roundtrips', () => {
  test('app: export → inspect → unpack === input', async () => {
    const record = { name: 'My Calc', entryFile: 'index.html', tags: ['tool'] };
    const envelope = await buildAppExport({ record, files: APP_FILES });

    expect(envelope.format).toBe('peerd-bundle');
    expect(envelope.version).toBe(1);
    expect(envelope.manifest.type).toBe('app');
    expect(envelope.manifest.mime).toBe('application/peerd-app');
    // Unsigned by design (DESIGN-10): no publisher, no sig.
    expect('publisher' in envelope.manifest).toBe(false);
    expect('sig' in envelope.manifest).toBe(false);

    const inspected = await inspectEnvelope(envelope);
    if (!inspected.ok) throw new Error(inspected.error);
    expect(inspected.summary.kind).toBe('app');
    expect(inspected.summary.name).toBe('My Calc');
    expect(inspected.summary.fileCount).toBe(3);
    expect(inspected.summary.size).toBe(envelope.manifest.size);

    const opened = await openEnvelope(envelope);
    expect(opened.entry).toBe('index.html');
    expect(textFiles(opened.files)).toEqual(APP_FILES);
    expect(opened.meta.tags).toEqual(['tool']);
  });

  test('app: binary and unknown file types round-trip byte-for-byte', async () => {
    const binary = new Uint8Array([0x00, 0xff, 0xc0, 0x80]);
    const unknown = new Uint8Array([0xfe, 0x01, 0x00]);
    const envelope = await buildAppExport({
      record: { name: 'Binary App', entryFile: 'index.html', tags: [] },
      files: {
        'index.html': new TextEncoder().encode('<h1>x</h1>'),
        'engine.wasm': binary,
        'model.custom': unknown,
      },
    });
    const opened = await openEnvelope(envelope);
    expect(Array.from(opened.files['engine.wasm'])).toEqual(Array.from(binary));
    expect(Array.from(opened.files['model.custom'])).toEqual(Array.from(unknown));
  });

  test('app: explicit binary kind survives for ASCII bytes with an unknown suffix', async () => {
    const bytes = new TextEncoder().encode('valid UTF-8 that is still binary');
    const envelope = await buildAppExport({
      record: {
        name: 'Typed App',
        entryFile: 'index.html',
        fileKinds: { 'index.html': 'text', 'model.custom': 'binary' },
      },
      files: { 'index.html': '<h1>x</h1>', 'model.custom': bytes },
    });
    const opened = await openEnvelope(envelope);
    expect(opened.fileKinds).toEqual({ 'index.html': 'text', 'model.custom': 'binary' });
    expect(Array.from(opened.files['model.custom'])).toEqual(Array.from(bytes));
  });

  test('app: a prototype-looking binary path survives export', async () => {
    const files: Record<string, string | Uint8Array> = Object.fromEntries([
      ['index.html', '<h1>x</h1>'],
      ['__proto__', new TextEncoder().encode('ABC')],
    ]);
    const fileKinds: Record<string, 'text' | 'binary'> = Object.fromEntries([
      ['index.html', 'text'],
      ['__proto__', 'binary'],
    ]);
    const envelope = await buildAppExport({
      record: { name: 'Prototype path', entryFile: 'index.html', fileKinds },
      files,
    });
    const opened = await openEnvelope(envelope);
    expect(Object.hasOwn(opened.files, '__proto__')).toBe(true);
    expect(Array.from(opened.files['__proto__'])).toEqual([65, 66, 67]);
    expect(opened.fileKinds['__proto__']).toBe('binary');
  });

  test('notebook: export → inspect → unpack === input (no entry)', async () => {
    const files = { 'scratch.js': 'export const x = 1;', 'data/notes.txt': 'hello' };
    const envelope = await buildNotebookExport({ record: { name: 'parser bench' }, files });

    expect(envelope.manifest.type).toBe('notebook');
    expect(envelope.manifest.mime).toBe('application/peerd-notebook');
    expect('entry' in envelope.manifest).toBe(false);

    const opened = await openEnvelope(envelope);
    expect(opened.summary).toEqual({ kind: 'notebook', name: 'parser bench', size: envelope.manifest.size, fileCount: 2 });
    expect(opened.entry).toBeUndefined();
    expect(textFiles(opened.files)).toEqual(files);
  });

  test('vm recipe carries the TOFU image pin (and no overlay)', async () => {
    const pin = { totalBytes: 5_044_875_331, headSha256: 'a'.repeat(64) };
    const envelope = await buildVmRecipeExport({
      record: { name: 'dev box' },
      pin,
      imageUrl: 'https://disks.webvm.io/debian_large.ext2',
    });

    expect(envelope.manifest.type).toBe('vm-recipe');
    expect(envelope.manifest.mime).toBe('application/peerd-vm-recipe');
    expect(envelope.manifest.meta.image).toEqual({
      url: 'https://disks.webvm.io/debian_large.ext2',
      pin,
    });
    // pinnedAt is local bookkeeping and must not travel.
    expect('pinnedAt' in envelope.manifest.meta.image.pin).toBe(false);

    const opened = await openEnvelope(envelope);
    expect(opened.kind).toBe('vm');
    expect(opened.summary.fileCount).toBe(0);
    expect(opened.meta.image.pin.headSha256).toBe(pin.headSha256);
  });

  test('identical inputs produce an identical content address', async () => {
    const record = { name: 'My Calc', entryFile: 'index.html', tags: [] };
    const a = await buildAppExport({ record, files: APP_FILES });
    const b = await buildAppExport({ record, files: APP_FILES });
    // `created` differs run to run; everything content-derived matches.
    expect(a.manifest.chunks).toEqual(b.manifest.chunks);
    expect(a.manifest.size).toBe(b.manifest.size);
    expect(a.chunks).toEqual(b.chunks);
  });
});

describe('.peerd envelope verification fails closed', () => {
  test('detects chunk tampering', async () => {
    const envelope = await buildAppExport({
      record: { name: 'x', entryFile: 'index.html' },
      files: APP_FILES,
    });
    // Flip one chunk's payload — same length, different bytes.
    const bytes = Buffer.from(envelope.chunks[0], 'base64');
    bytes[0] = bytes[0] ^ 0xff;
    envelope.chunks[0] = bytes.toString('base64');

    const inspected = await inspectEnvelope(envelope);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.error).toContain('chunk-hash-mismatch');
    await expect(openEnvelope(envelope)).rejects.toThrow('chunk-hash-mismatch');
  });

  test('detects manifest size tampering', async () => {
    const envelope = await buildNotebookExport({
      record: { name: 'x' }, files: { 'a.js': '1' },
    });
    envelope.manifest.size += 1;
    const inspected = await inspectEnvelope(envelope);
    expect(inspected.ok).toBe(false);
  });

  test('rejects oversized encoded chunks before decoding them', async () => {
    const envelope = await buildNotebookExport({
      record: { name: 'x' }, files: { 'a.js': '1' },
    });
    envelope.chunks[0] = 'A'.repeat(4 * 1024 * 1024);
    await expect(openEnvelope(envelope)).rejects.toThrow('chunk-size-mismatch:0');
  });

  test('rejects malformed envelopes with normalized errors', async () => {
    for (const bad of [null, 42, {}, { format: 'peerd-bundle' },
      { format: 'peerd-bundle', version: 2, manifest: {}, chunks: [] },
      { format: 'zip', version: 1, manifest: {}, chunks: [] }]) {
      const inspected = await inspectEnvelope(bad);
      expect(inspected.ok).toBe(false);
    }
  });

  test('rejects an unknown artifact kind', async () => {
    const envelope = await buildNotebookExport({ record: { name: 'x' }, files: { 'a.js': '1' } });
    envelope.manifest.meta = { ...envelope.manifest.meta, kind: 'rootkit' };
    const inspected = await inspectEnvelope(envelope);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.error).toContain('unknown artifact kind');
  });
});

describe('the 64MB export rail', () => {
  test('export refuses oversize payloads with the typed error', async () => {
    // A sparse 65MB buffer packs (base64) to >64MB of payload; the rail
    // fires on the PACKED size before any hashing happens.
    const big = new Uint8Array(65 * 1024 * 1024);
    await expect(
      buildNotebookExport({ record: { name: 'big' }, files: { 'blob.bin': big } }),
    ).rejects.toBeInstanceOf(ArtifactTooLargeError);
    // why the explicit timeout: building + base64-packing a 65MB payload to
    // exercise the real rail takes ~5s, which flirts with bun's 5s default
    // and flakes on loaded CI runners. The assertion is the point, not speed.
  }, 30000);

  test('import refuses an oversize manifest claim before decoding', async () => {
    const envelope = await buildNotebookExport({ record: { name: 'x' }, files: { 'a.js': '1' } });
    envelope.manifest.size = EXPORT_LIMIT_BYTES + 1;
    const inspected = await inspectEnvelope(envelope);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.error).toContain('64 MB');
  });

  test('the options page rejects an oversized .peerd file before reading it', async () => {
    expect(EXPORT_FILE_LIMIT_BYTES).toBeGreaterThan(Math.ceil(EXPORT_LIMIT_BYTES / 3) * 4);
    const source = await Bun.file('extension/options/sections/transfer.js').text();
    const demandLoad = source.indexOf("await import('/peerd-engine/artifact.js')");
    const sizeCheck = source.indexOf('file.size > exportFileLimitBytes');
    const read = source.indexOf('envelope = JSON.parse(await file.text())');
    expect(demandLoad).toBeGreaterThan(-1);
    expect(sizeCheck).toBeGreaterThan(demandLoad);
    expect(read).toBeGreaterThan(sizeCheck);
  });
});

describe('export filenames', () => {
  test('sanitizes to <name>-<kind>.peerd', () => {
    expect(exportFilename('My Calc!', 'app')).toBe('my-calc-app.peerd');
    expect(exportFilename('  ', 'vm')).toBe('artifact-vm.peerd');
    expect(exportFilename('a/b\\c', 'notebook')).toBe('a-b-c-notebook.peerd');
  });
});
