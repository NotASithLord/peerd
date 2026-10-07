import { describe, expect, test } from 'bun:test';
import {
  parseDwappUri, formatDwappUri, canonicalizeDwappUri, toWebDwappUri, fromWebDwappUri,
  DwappUriError, MAX_DWAPP_PATH_BYTES, MAX_DWAPP_URI_LENGTH,
} from '../../extension/peerd-distributed/content/dwapp-uri.js';
import { encodeDidKey } from '../../extension/peerd-distributed/identity/did.js';
import { parsePeerdUri, formatPeerdUri } from '../../extension/peerd-distributed/content/uri.js';

const hash = 'ab'.repeat(32);
const did = encodeDidKey(Uint8Array.from({ length: 32 }, (_, i) => i));
const key = did.slice('did:key:'.length);
const root = `dwapp://content/${hash}`;

describe('immutable dwapp share addresses', () => {
  test('full manifest hash, optional publisher and decoded file path roundtrip', () => {
    for (const signer of [undefined, did]) {
      for (const path of [undefined, 'index.html', 'assets/hello world/日本語.wasm', '100%/%2F', "a/!'()*:@.txt"]) {
        const parts = { did: signer, hash, path };
        const uri = formatDwappUri(parts);
        expect(parseDwappUri(uri)).toEqual(parts);
        expect(canonicalizeDwappUri(uri)).toBe(uri);
        expect(fromWebDwappUri(toWebDwappUri(uri))).toBe(uri);
        expect(new URL(uri).href).toBe(uri);
        expect(new URL(toWebDwappUri(uri)).href).toBe(toWebDwappUri(uri));
      }
    }
    expect(formatDwappUri({ hash, path: 'hello world.wasm' })).toBe(`${root}/hello%20world.wasm`);
  });

  test('percent aliases canonicalize once without losing file identity', () => {
    expect(canonicalizeDwappUri(`${root}/%69ndex/%e6%97%a5.txt`)).toBe(`${root}/index/%E6%97%A5.txt`);
    expect(toWebDwappUri(`${root}/%61`)).toBe(`web+dwapp://content/${hash}/a`);
    expect(parseDwappUri(`${root}/%252F`).path).toBe('%2F');
    expect(canonicalizeDwappUri(`${root}/%252F`)).toBe(`${root}/%252F`);
    expect(formatDwappUri({ hash, path: '100%.wasm' })).toBe(`${root}/100%25.wasm`);
  });

  test.each([
    '', 'https://example.com/a', `DWAPP://content/${hash}`, `dwapp://content/${hash.toUpperCase()}`,
    `dwapp://content:80/${hash}`, `dwapp://user@content/${hash}`, `dwapp://CONTENT/${hash}`,
    `dwapp://name/${hash}`, `dwapp://content./${hash}`, `dwapp://%63ontent/${hash}`,
    `dwapp://content/${hash.slice(1)}`, `dwapp://content/${hash}a`, `dwapp://content/user@${hash}`, `dwapp://content/${hash}:80`,
    `${root}?a=b`, `${root}#x`, `${root}/a?b`, `${root}/a#b`, `${root}/`, `${root}//a`,
    `${root}/a/`, `${root}/./a`, `${root}/a/../b`, `${root}/%2e%2e/b`, `${root}/%2f`,
    `${root}/%5C`, `${root}/%3f`, `${root}/%23`, `${root}/%00`,
    `${root}/%0a`, `${root}/%7F`, `${root}/%C2%85`, `${root}/%E2%80%AE`,
    `${root}/e%CC%81`, `${root}/%ED%A0%80`, `${root}/%FF`, `${root}/%C0%AF`,
    `${root}/%`, `${root}/%2`, `${root}/a b`, `${root}/日本語`, ` ${root}`, `${root}\n`,
    `dwapp://content/did:key:fake/${hash}`, `dwapp://content/did:web:example.com/${hash}`,
    `dwapp://content/${key}#key/${hash}`, `dwapp://content/${key}/`, `dwapp://content/${key}`,
    `dwapp://content/${key.toUpperCase()}/${hash}`, `dwapp://content/${key}extra/${hash}`,
  ])('rejects ambiguous or invalid URI %s', input => {
    expect(() => parseDwappUri(input)).toThrow(DwappUriError);
  });

  test.each(['', '/a', 'a/', 'a//b', '.', '..', 'a/../b', 'a\\b', 'a?b', 'a#b', '\u0000', '\ud800', 'e\u0301'])('formatter rejects unsafe decoded path %s', path => {
    expect(() => formatDwappUri({ hash, path })).toThrow(DwappUriError);
  });

  test('bounds apply symmetrically to encoded input and decoded resource names', () => {
    const path = Array(4).fill('a'.repeat(255)).join('/');
    expect(parseDwappUri(formatDwappUri({ hash, path })).path).toBe(path);
    for (const excessive of ['a'.repeat(256), Array(65).fill('a').join('/'), Array(5).fill('a'.repeat(255)).join('/'), '日'.repeat(86)]) {
      expect(() => formatDwappUri({ hash, path: excessive })).toThrow(DwappUriError);
      expect(() => parseDwappUri(`${root}/${excessive.split('/').map(encodeURIComponent).join('/')}`)).toThrow(DwappUriError);
    }
    expect(path.length).toBeLessThanOrEqual(MAX_DWAPP_PATH_BYTES);
    expect(() => parseDwappUri(`${root}/${'a'.repeat(MAX_DWAPP_URI_LENGTH)}`)).toThrow(DwappUriError);
    expect(() => fromWebDwappUri(`web+dwapp://content/${'a'.repeat(MAX_DWAPP_URI_LENGTH)}`)).toThrow(DwappUriError);
  });

  test('publisher validation is canonical Ed25519 only', () => {
    for (const invalid of ['', 'did:key:z', `${did}/x`, `${did}?x`, did.replace('z6', 'z7')]) {
      expect(() => formatDwappUri({ hash, did: invalid })).toThrow(DwappUriError);
    }
  });

  test('handoff only unwraps the exact scheme, with no URL parameter or nested URL interpretation', () => {
    for (const invalid of [root, `web+dwapp:${hash}`, `web+dwapp://content/https://example.com/${hash}`, `web+dwapp://content/${hash}?uri=x`]) {
      expect(() => fromWebDwappUri(invalid)).toThrow(DwappUriError);
    }
    expect(() => parseDwappUri(toWebDwappUri(root))).toThrow(DwappUriError);
  });

  test('format canonicalization is idempotent across the permitted printable ASCII alphabet', () => {
    for (let code = 32; code < 127; code++) {
      const char = String.fromCharCode(code);
      if ('/\\?#'.includes(char)) continue;
      const path = `file${char}.wasm`;
      const uri = formatDwappUri({ did, hash, path });
      expect(parseDwappUri(uri).path).toBe(path);
      expect(canonicalizeDwappUri(uri)).toBe(uri);
      expect(new URL(uri).href).toBe(uri);
      expect(fromWebDwappUri(new URL(toWebDwappUri(uri)).href)).toBe(uri);
    }
  });

  test('legacy peerd codec remains verbatim and is not silently migrated to stricter semantics', () => {
    const parts = { did: 'did:legacy:placeholder', hash, path: '../a?b#c' };
    const legacy = formatPeerdUri(parts);
    expect(parsePeerdUri(legacy)).toEqual(parts);
    expect(() => parseDwappUri(legacy)).toThrow(DwappUriError);
    expect(() => parsePeerdUri(root)).toThrow();
  });
});
