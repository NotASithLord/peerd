import { describe, test, expect } from 'bun:test';
import { formatPeerdUri, parsePeerdUri } from '../../extension/peerd-distributed/content/uri.js';

const HASH = 'a'.repeat(64);
const DID = 'did:key:z6MkExampleExampleExampleExampleExampleExample';

describe('peerd:// URIs', () => {
  test('authored form roundtrips (did + hash)', () => {
    const uri = formatPeerdUri({ did: DID, hash: HASH });
    expect(uri).toBe(`peerd://${DID}/${HASH}`);
    expect(parsePeerdUri(uri)).toEqual({ did: DID, hash: HASH, path: undefined });
  });

  test('pure content-addressed form roundtrips (hash only)', () => {
    const uri = formatPeerdUri({ hash: HASH });
    expect(uri).toBe(`peerd://${HASH}`);
    expect(parsePeerdUri(uri)).toEqual({ did: undefined, hash: HASH, path: undefined });
  });

  test('carries an optional path', () => {
    const parsed = parsePeerdUri(`peerd://${DID}/${HASH}/assets/logo.png`);
    expect(parsed).toEqual({ did: DID, hash: HASH, path: 'assets/logo.png' });
  });

  test('rejects a malformed hash and a non-peerd scheme', () => {
    expect(() => parsePeerdUri('peerd://deadbeef')).toThrow();
    expect(() => parsePeerdUri(`https://example.com/${HASH}`)).toThrow();
    expect(() => formatPeerdUri({ hash: 'tooshort' })).toThrow();
  });
});
