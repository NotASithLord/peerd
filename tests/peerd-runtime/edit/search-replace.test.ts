// SEARCH/REPLACE parser + applier — the pure core of feature 02.

import { describe, test, expect } from 'bun:test';
import {
  parseEditBlocks,
  applyEdit,
} from '../../../extension/peerd-runtime/edit/search-replace.js';
import {
  EditParseError,
  SearchNotFoundError,
  SearchAmbiguousError,
} from '../../../extension/peerd-runtime/edit/errors.js';

const block = (search: string, replace: string) =>
  `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

describe('parseEditBlocks', () => {
  test('parses a single block', () => {
    const blocks = parseEditBlocks(block('foo', 'bar'));
    expect(blocks).toEqual([{ search: 'foo', replace: 'bar' }]);
  });

  test('parses multiple back-to-back blocks and ignores prose between them', () => {
    const raw = `some chatter\n${block('a', 'A')}\nmore prose\n${block('b', 'B')}`;
    const blocks = parseEditBlocks(raw);
    expect(blocks).toEqual([
      { search: 'a', replace: 'A' },
      { search: 'b', replace: 'B' },
    ]);
  });

  test('multi-line bodies survive intact', () => {
    const blocks = parseEditBlocks(block('line1\nline2', 'newA\nnewB'));
    expect(blocks[0]).toEqual({ search: 'line1\nline2', replace: 'newA\nnewB' });
  });

  test('throws on an unterminated block', () => {
    expect(() => parseEditBlocks('<<<<<<< SEARCH\nfoo\n=======\nbar'))
      .toThrow(EditParseError);
  });

  test('throws on a stray divider with no open block', () => {
    expect(() => parseEditBlocks('=======\nbar')).toThrow(EditParseError);
  });

  test('throws when no blocks present', () => {
    expect(() => parseEditBlocks('just prose, no fences')).toThrow(EditParseError);
  });
});

describe('applyEdit — clean apply', () => {
  test('replaces a unique anchor', () => {
    const src = 'const x = 1;\nconst y = 2;\n';
    const { content, blocks } = applyEdit(src, block('const y = 2;', 'const y = 42;'));
    expect(content).toBe('const x = 1;\nconst y = 42;\n');
    expect(blocks).toBe(1);
  });

  test('applies multiple blocks in order; a later block sees the earlier edit', () => {
    const src = 'a\nb\n';
    const raw = `${block('a', 'X')}\n${block('X', 'Y')}`;
    const { content } = applyEdit(src, raw);
    expect(content).toBe('Y\nb\n');
  });

  test('empty SEARCH replaces the whole file (create path)', () => {
    const { content } = applyEdit('', block('', '<!doctype html>\n<p>hi</p>'));
    expect(content).toBe('<!doctype html>\n<p>hi</p>');
  });

  test('preserves CRLF line endings on a CRLF source', () => {
    const src = 'one\r\ntwo\r\n';
    const { content } = applyEdit(src, block('two', 'TWO'));
    expect(content).toBe('one\r\nTWO\r\n');
  });
});

describe('applyEdit — failures', () => {
  test('no-match: SEARCH text absent throws SearchNotFoundError', () => {
    const src = 'const x = 1;\n';
    let err: unknown;
    try { applyEdit(src, block('const z = 9;', 'whatever')); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(SearchNotFoundError);
    expect((err as SearchNotFoundError).code).toBe('search_not_found');
    expect((err as SearchNotFoundError).blockIndex).toBe(0);
  });

  test('multi-match: ambiguous SEARCH throws SearchAmbiguousError with count', () => {
    const src = 'x\nx\nx\n';
    let err: unknown;
    try { applyEdit(src, block('x', 'y')); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(SearchAmbiguousError);
    expect((err as SearchAmbiguousError).code).toBe('search_ambiguous');
    expect((err as SearchAmbiguousError).count).toBe(3);
  });

  test('empty SEARCH combined with anchored blocks is rejected', () => {
    const raw = `${block('', 'whole')}\n${block('a', 'b')}`;
    expect(() => applyEdit('a', raw)).toThrow(EditParseError);
  });
});
