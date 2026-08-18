// Unit tests for the shared artifact-bundle codec (pack/unpack).
//
// packBundle/unpackBundle are the pure byte<->file-map primitives that back
// both dweb content transfer and .peerd artifact export. They get incidental
// coverage from the peerd-distributed transfer e2e tests, but nothing pins
// their invariants directly:
//   - round-trip fidelity (arbitrary bytes survive base64 there-and-back),
//   - deterministic output regardless of file insertion order — the property
//     the module exists for, since the payload hash IS the content address,
//   - the optional `entry` key is omitted entirely (not serialized as a hole),
//   - the text variant decodes UTF-8 back to strings.
// Pure functions, no browser needed.

import { describe, it, expect } from 'bun:test';
import {
	packBundle,
	unpackBundle,
	unpackBundleText,
} from '../../extension/shared/bundle/bundle.js';
import {
	utf8, fromUtf8, bytesEqual, base64ByteLength,
} from '../../extension/shared/bundle/bytes.js';

describe('bundle codec', () => {
	it('round-trips files through pack/unpack with bytes preserved', () => {
		const files = {
			'index.html': utf8('<h1>hi</h1>'),
			'app.js': new Uint8Array([0, 1, 2, 127, 128, 255]),
		};
		const { entry, files: out } = unpackBundle(packBundle({ entry: 'index.html', files }));

		expect(entry).toBe('index.html');
		expect(Object.keys(out).sort()).toEqual(['app.js', 'index.html']);
		expect(bytesEqual(out['index.html'], files['index.html'])).toBe(true);
		expect(bytesEqual(out['app.js'], files['app.js'])).toBe(true);
	});

	it('produces identical bytes regardless of file insertion order', () => {
		// Same content address must come out no matter how the map was built.
		const a = packBundle({
			entry: 'index.html',
			files: { 'index.html': utf8('a'), 'z.js': utf8('z'), 'm.css': utf8('m') },
		});
		const b = packBundle({
			entry: 'index.html',
			files: { 'm.css': utf8('m'), 'index.html': utf8('a'), 'z.js': utf8('z') },
		});

		expect(bytesEqual(a, b)).toBe(true);
	});

	it('omits the entry key entirely when no entry is given', () => {
		const payload = packBundle({ files: { 'note.md': utf8('# hi') } });
		const parsed = JSON.parse(fromUtf8(payload));

		expect('entry' in parsed).toBe(false);
		expect(unpackBundle(payload).entry).toBeUndefined();
	});

	it('tags the payload with a format version', () => {
		const parsed = JSON.parse(fromUtf8(packBundle({ files: {} })));

		expect(parsed.v).toBe(1);
	});

	it('unpackBundleText decodes file bytes back to UTF-8 text', () => {
		const payload = packBundle({
			entry: 'index.html',
			files: { 'index.html': utf8('<h1>héllo wörld</h1>') },
		});
		const { entry, files } = unpackBundleText(payload);

		expect(entry).toBe('index.html');
		expect(files['index.html']).toBe('<h1>héllo wörld</h1>');
	});

	it('round-trips durable file kinds without changing legacy bundles', () => {
		const legacy = packBundle({ files: { 'x.custom': utf8('ASCII bytes') } });
		expect('fileKinds' in JSON.parse(fromUtf8(legacy))).toBe(false);
		const payload = packBundle({
			files: { 'x.custom': utf8('ASCII bytes') },
			fileKinds: { 'x.custom': 'binary' },
		});
		expect(unpackBundle(payload).fileKinds['x.custom']).toBe('binary');
	});

	it('admits the whole shape before decoding file buffers', () => {
		const tooMany = utf8(JSON.stringify({ v: 1, files: { a: '', b: '', c: '' } }));
		expect(() => unpackBundle(tooMany, { maxFiles: 2 })).toThrow('more than 2 files');
		const tooLarge = utf8(JSON.stringify({ v: 1, files: { a: 'AAAA', b: 'AAAA' } }));
		expect(() => unpackBundle(tooLarge, { maxDecodedBytes: 5 })).toThrow('exceed 5 decoded bytes');
		const orphanKind = utf8(JSON.stringify({ v: 1, files: { a: '' }, fileKinds: { b: 'binary' } }));
		expect(() => unpackBundle(orphanKind)).toThrow('file kind has no file');
	});

	it('accepts only canonical base64 padding and unused bits', () => {
		expect(base64ByteLength('')).toBe(0);
		expect(base64ByteLength('AA==')).toBe(1);
		expect(base64ByteLength('AAA=')).toBe(2);
		expect(base64ByteLength('AAAA')).toBe(3);
		for (const encoded of ['A', 'A===', 'AA=A', 'AB==', 'AAB=', 'AAAA\n']) {
			expect(() => base64ByteLength(encoded)).toThrow('invalid base64');
		}
	});

	it('preserves prototype-looking paths as own keys', () => {
		const files: Record<string, Uint8Array> = Object.create(null);
		files.__proto__ = utf8('safe');
		const unpacked = unpackBundle(packBundle({ files }));
		expect(Object.hasOwn(unpacked.files, '__proto__')).toBe(true);
		expect(fromUtf8(unpacked.files.__proto__)).toBe('safe');
	});

	it('validates and decodes a Charon-sized file without regexp stack growth', () => {
		// Nine MiB decodes from exactly twelve MiB of canonical base64. Building
		// the encoded form directly keeps this regression pinned to the reader
		// that previously overflowed V8's regexp stack on bundle.js.
		const decodedBytes = 9 * 1024 * 1024;
		const encoded = 'A'.repeat((decodedBytes / 3) * 4);
		const payload = utf8(JSON.stringify({ v: 1, entry: 'bundle.js', files: { 'bundle.js': encoded } }));
		const unpacked = unpackBundle(payload, {
			maxPackedBytes: 16 * 1024 * 1024,
			maxDecodedBytes: 10 * 1024 * 1024,
			maxFileBytes: 10 * 1024 * 1024,
		});
		expect(unpacked.files['bundle.js'].byteLength).toBe(decodedBytes);
		expect(unpacked.files['bundle.js'][0]).toBe(0);
		expect(unpacked.files['bundle.js'][decodedBytes - 1]).toBe(0);
	});
});
