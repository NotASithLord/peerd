import { describe, expect, test } from 'bun:test';
import {
  COMPOSER_INPUT_TEXT_BYTES,
  COMPOSER_REFERENCE_LIMIT,
  COMPOSER_REFERENCE_PATH_BYTES,
  composerUtf8Bytes,
  composerUtf8Fits,
  composerReferenceRequests,
  truncateComposerUtf8,
} from '../../extension/shared/composer-reference-policy.js';
import { parseComposer } from '../../extension/shared/composer-parser.js';
import { parseComposer as parseRuntimeComposer } from '../../extension/peerd-runtime/composer/parse.js';

describe('composer reference policy', () => {
  test('caps mixed references before any host preparation', () => {
    const source = Array.from({ length: COMPOSER_REFERENCE_LIMIT + 20 }, (_, index) =>
      index % 2 === 0 ? `@tab:${index + 1}` : `@file:file-${index}.md`).join(' ');
    const requests = composerReferenceRequests(source, []);
    expect(requests).toHaveLength(COMPOSER_REFERENCE_LIMIT);
    expect(requests[0]).toEqual({
      operation: 'turn.compose.capture-tab', payload: { tabId: 1 },
    });
    expect(requests.at(-1)).toEqual({
      operation: 'turn.compose.read-file', payload: { path: 'file-63.md' },
    });
  });

  test('runtime and host consume the same checked-in grammar', () => {
    const corpus = [
      'plain', '/review arg\nbody @file:a.md', ' @tab @tab:7',
      '@tab:abc @tab:0 @tab:-1 @tab:1.5', '@file:path.md, end',
      '/x-y_2\n@file:a @tab:9', 'prefix/@tab:4 no-token',
    ];
    for (const source of corpus) {
      expect(parseRuntimeComposer(source)).toEqual(parseComposer(source));
    }
  });

  test('measures ASCII and four-byte Unicode at exact UTF-8 boundaries', () => {
    const ascii = 'a'.repeat(COMPOSER_INPUT_TEXT_BYTES);
    const unicode = '😀'.repeat(COMPOSER_INPUT_TEXT_BYTES / 4);
    expect(composerUtf8Bytes(ascii)).toBe(COMPOSER_INPUT_TEXT_BYTES);
    expect(composerUtf8Bytes(unicode)).toBe(COMPOSER_INPUT_TEXT_BYTES);
    expect(composerUtf8Fits(ascii, COMPOSER_INPUT_TEXT_BYTES)).toBe(true);
    expect(composerUtf8Fits(`${ascii}a`, COMPOSER_INPUT_TEXT_BYTES)).toBe(false);
    expect(composerUtf8Fits(unicode, COMPOSER_INPUT_TEXT_BYTES)).toBe(true);
    expect(composerUtf8Fits(`${unicode}😀`, COMPOSER_INPUT_TEXT_BYTES)).toBe(false);
    const clipped = truncateComposerUtf8(`${unicode}😀`, COMPOSER_INPUT_TEXT_BYTES);
    expect(clipped).toBe(unicode);
    expect(clipped.endsWith('\ud83d')).toBe(false);
  });

  test('does not project a file path whose characters hide an oversized byte payload', () => {
    const validPath = '😀'.repeat(COMPOSER_REFERENCE_PATH_BYTES / 4);
    const oversizedPath = `${validPath}😀`;
    expect(composerReferenceRequests(`@file:${validPath}`, [])).toHaveLength(1);
    expect(composerReferenceRequests(`@file:${oversizedPath}`, [])).toHaveLength(0);
  });
});
