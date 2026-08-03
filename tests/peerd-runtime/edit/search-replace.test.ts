// SEARCH/REPLACE parser + applier — the pure core of feature 02.

import { describe, test, expect } from 'bun:test';
import {
  parseEditBlocks,
  applyEdit,
  isWholeFileCreate,
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

describe('isWholeFileCreate', () => {
  test('true for a single empty-SEARCH block', () => {
    expect(isWholeFileCreate(parseEditBlocks(block('', 'new file')))).toBe(true);
  });
  test('false for an anchored block', () => {
    expect(isWholeFileCreate(parseEditBlocks(block('foo', 'bar')))).toBe(false);
  });
  test('false for multiple blocks even if one is empty', () => {
    // multi-block empty SEARCH is itself illegal, but the create predicate is
    // "single empty block" — a >1-block payload is never a whole-file create.
    expect(isWholeFileCreate(parseEditBlocks(`${block('a', 'A')}\n${block('b', 'B')}`))).toBe(false);
  });
});

describe('applyEdit — 3b already-applied (idempotent, reported no-op)', () => {
  test('re-applying a landed edit → no error, file unchanged, index reported', () => {
    // The REPLACE text is already present and the SEARCH is gone (a retry).
    const src = 'const timeoutMs = 5000;\n';
    const { content, alreadyApplied } = applyEdit(
      src, block('const timeoutMs = 3000;', 'const timeoutMs = 5000;'));
    expect(content).toBe(src);            // untouched
    expect(alreadyApplied).toEqual([0]);  // block 0 skipped as already-applied
  });

  test('false-positive guard: a trivially short REPLACE still errors as not-found', () => {
    // REPLACE ';' is present all over; we must NOT claim already-applied.
    const src = 'a;\nb;\nc;\n';
    let err: unknown;
    try { applyEdit(src, block('zzz', ';')); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(SearchNotFoundError);
    expect((err as SearchNotFoundError).whitespace).toBe(false);
  });

  test('false-positive guard: a short MULTI-LINE REPLACE ("  }\\n}") is not distinctive', () => {
    // A deletion whose SEARCH missed (typo) but whose short boilerplate REPLACE
    // ("  }\n}") happens to exist elsewhere must NOT read as already-applied — a
    // lone newline can't confer distinctiveness, or we'd silently skip the edit.
    const src = 'first();\n  }\n}\nsecond();\n';
    let err: unknown;
    try { applyEdit(src, block('  cleanUp();\n  }\n}', '  }\n}')); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(SearchNotFoundError); // NOT a silent no-op
  });

  test('false-positive guard: a deletion/trim (REPLACE ⊂ SEARCH) is never "applied"', () => {
    // The retained context line ("  doThing(1);") still exists in the file, but
    // REPLACE being a substring of SEARCH means its presence can't prove the
    // deletion landed — must error, not report a false alreadyApplied.
    const src = 'keep();\n  doThing(1);\nmore();\n';
    let err: unknown;
    try { applyEdit(src, block('  doThing(1);\n  removeThisLine();', '  doThing(1);')); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(SearchNotFoundError);
  });

  test('mixed: one block applies, another is already-applied', () => {
    const src = 'const a = 1;\nconst b = 2;\n';
    const raw = `${block('const a = 1;', 'const a = 10;')}\n${block('const b = 20;', 'const b = 2;')}`;
    const { content, alreadyApplied } = applyEdit(src, raw);
    expect(content).toBe('const a = 10;\nconst b = 2;\n');
    expect(alreadyApplied).toEqual([1]);
  });
});

describe('applyEdit — 3c ambiguous match reports locations', () => {
  test('3 matches → SearchAmbiguousError with per-location line + preview', () => {
    const src = 'x = 1;\ny = 2;\nx = 1;\nz = 3;\nx = 1;\n';
    let err: unknown;
    try { applyEdit(src, block('x = 1;', 'x = 9;')); }
    catch (e) { err = e; }
    const amb = err as SearchAmbiguousError;
    expect(amb).toBeInstanceOf(SearchAmbiguousError);
    expect(amb.count).toBe(3);
    expect(amb.locations.map((l) => l.line)).toEqual([1, 3, 5]);
    expect(amb.locations[0].preview).toContain('x = 1;');
    // the compact rendering names the lines in the message text
    expect(amb.message).toContain('L1, L3, L5');
  });

  test('locations render is capped (many matches → at most 5 shown)', () => {
    const src = Array.from({ length: 8 }, () => 'dup;').join('\n');
    let err: unknown;
    try { applyEdit(src, block('dup;', 'DUP;')); }
    catch (e) { err = e; }
    const amb = err as SearchAmbiguousError;
    expect(amb.count).toBe(8);
    expect(amb.locations.length).toBe(5);
  });
});

describe('applyEdit — 3d whitespace/indentation diagnosis', () => {
  test('indentation-only mismatch (tab vs spaces) → whitespace message naming the line', () => {
    const src = 'function f() {\n    return 1;\n}\n'; // 4-space indent
    let err: unknown;
    try { applyEdit(src, block('\treturn 1;', '\treturn 2;')); } // tab-indented
    catch (e) { err = e; }
    const nf = err as SearchNotFoundError;
    expect(nf).toBeInstanceOf(SearchNotFoundError);
    expect(nf.whitespace).toBe(true);
    expect(nf.line).toBe(2);
    expect(nf.message).toContain('whitespace-only difference matched at L2');
  });

  test('genuinely absent SEARCH → plain not-found, no false whitespace claim', () => {
    const src = 'const x = 1;\n';
    let err: unknown;
    try { applyEdit(src, block('totally different line', 'whatever')); }
    catch (e) { err = e; }
    const nf = err as SearchNotFoundError;
    expect(nf).toBeInstanceOf(SearchNotFoundError);
    expect(nf.whitespace).toBe(false);
    expect(nf.message).toContain('The file may have changed');
  });

  test('a trimmed match that only lands MID-LINE is not a whitespace difference', () => {
    // Trimmed SEARCH ("return x;\n}") occurs inside "if (y) return x;" — the real
    // difference is the "if (y) " content prefix, not whitespace. Must NOT claim
    // a whitespace-only difference; require a line-aligned trimmed match.
    const src = 'if (y) return x;\n}\n';
    let err: unknown;
    try { applyEdit(src, block('  return x;\n  }', '  return z;\n  }')); }
    catch (e) { err = e; }
    const nf = err as SearchNotFoundError;
    expect(nf).toBeInstanceOf(SearchNotFoundError);
    expect(nf.whitespace).toBe(false);
    expect(nf.message).toContain('The file may have changed');
  });
});

describe('applyEdit — 3c ambiguous render marks the unshown remainder', () => {
  test('more matches than the render cap → a "(+N more)" suffix', () => {
    const src = Array.from({ length: 8 }, () => 'dup;').join('\n');
    let err: unknown;
    try { applyEdit(src, block('dup;', 'DUP;')); }
    catch (e) { err = e; }
    const amb = err as SearchAmbiguousError;
    expect(amb.count).toBe(8);
    expect(amb.locations.length).toBe(5);
    expect(amb.message).toContain('(+3 more)');
  });

  test('all matches shown → no "(+N more)" suffix', () => {
    const src = 'x;\ny;\nx;\n';
    let err: unknown;
    try { applyEdit(src, block('x;', 'X;')); }
    catch (e) { err = e; }
    const amb = err as SearchAmbiguousError;
    expect(amb.count).toBe(2);
    expect(amb.message).not.toContain('more)');
  });
});
