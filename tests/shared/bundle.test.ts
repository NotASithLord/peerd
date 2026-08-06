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
import { utf8, fromUtf8, bytesEqual } from '../../extension/shared/bundle/bytes.js';

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

	it('preserves prototype-shaped root filenames without dictionary collisions', () => {
		const files: Record<string, Uint8Array> = Object.create(null);
		files['__proto__'] = utf8('proto');
		(files as any).constructor = utf8('ctor');
		(files as any).toString = utf8('string');
		const out = unpackBundle(packBundle({ files }));

		expect(Object.keys(out.files).sort()).toEqual(['__proto__', 'constructor', 'toString']);
		expect(fromUtf8(out.files['__proto__'])).toBe('proto');
		expect(fromUtf8((out.files as any).constructor)).toBe('ctor');
		expect(fromUtf8((out.files as any).toString)).toBe('string');
	});
});
