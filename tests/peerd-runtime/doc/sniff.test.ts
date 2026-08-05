// Format detection, and the two text formats that need no container.
//
// Sniffing is where a document reader is most often wrong in the field: the
// filename lies, the server sends application/octet-stream, and the link that
// ends in .pdf serves an HTML login page. So each of those is a test.

import { describe, test, expect } from 'bun:test';
import { sniffDocFormat, sniffDelimited, extensionOf } from '../../../extension/peerd-runtime/doc/sniff.js';
import { parseCsv, parseDelimited } from '../../../extension/peerd-runtime/doc/parse/csv.js';
import { parseRtf } from '../../../extension/peerd-runtime/doc/parse/rtf.js';
import { toMarkdown } from '../../../extension/peerd-runtime/doc/markdown.js';
import { makeDocx, makeXlsx, makeOdt, makeEpub } from './fixtures.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('sniffDocFormat — content beats the name', () => {
  test('OOXML flavors are read out of the ZIP members, not the extension', async () => {
    // Served as octet-stream under a WRONG extension: the bytes must still win.
    expect(sniffDocFormat(await makeDocx(), { name: 'report.txt', contentType: 'application/octet-stream' }))
      .toEqual({ format: 'docx', via: 'zip-member' });
    expect(sniffDocFormat(await makeXlsx(), { name: 'x' }).format).toBe('xlsx');
  });

  test('ODF and EPUB are read from the stored mimetype member', async () => {
    expect(sniffDocFormat(await makeOdt(), {})).toEqual({ format: 'odt', via: 'zip-member' });
    expect(sniffDocFormat(await makeEpub(), {})).toEqual({ format: 'epub', via: 'zip-member' });
  });

  test('a .pdf link that actually serves HTML is identified as HTML', () => {
    const html = bytes('<!DOCTYPE html><html><body>Sign in to continue</body></html>');
    expect(sniffDocFormat(html, { name: 'report.pdf', contentType: 'application/pdf' }).format).toBe('html');
  });

  test('magic numbers win for PDF, RTF and legacy OLE2', () => {
    expect(sniffDocFormat(bytes('%PDF-1.7\n...'), {}).format).toBe('pdf');
    expect(sniffDocFormat(bytes('{\\rtf1\\ansi'), { name: 'a.docx' }).format).toBe('rtf');
    const ole = new Uint8Array(16);
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(sniffDocFormat(ole, {}).format).toBe('ole2');
  });

  test('formats with no signature fall back to content-type, then name', () => {
    expect(sniffDocFormat(bytes('a;b;c'), { contentType: 'text/csv; charset=utf-8' }))
      .toEqual({ format: 'csv', via: 'content-type' });
    expect(sniffDocFormat(bytes('anything at all'), { name: '/files/notes.tsv?dl=1' }))
      .toEqual({ format: 'tsv', via: 'extension' });
  });

  test('binary with no known signature is unknown, never "text"', () => {
    const junk = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00]);
    expect(sniffDocFormat(junk, {}).format).toBe('unknown');
  });
});

describe('extensionOf', () => {
  test('query strings and fragments are not part of the extension', () => {
    expect(extensionOf('https://x.test/a/b/report.DOCX?token=1#p2')).toBe('docx');
    expect(extensionOf('https://x.test/download')).toBe('');
    expect(extensionOf('https://x.test/a.b/c')).toBe('');
  });
});

describe('sniffDelimited — conservative on purpose', () => {
  test('a consistent grid is delimited; prose containing commas is not', () => {
    expect(sniffDelimited('a,b,c\n1,2,3\n4,5,6')).toBe('csv');
    expect(sniffDelimited('a\tb\n1\t2')).toBe('tsv');
    expect(sniffDelimited('Hello, world.\nThis is prose with no structure at all.')).toBe(null);
    expect(sniffDelimited('single line, nothing else')).toBe(null);
  });
});

describe('CSV', () => {
  test('quoted fields carry delimiters, newlines and doubled quotes', () => {
    const rows = parseDelimited('name,note\n"Smith, J.","He said ""hi""\nthen left"\n', ',');
    expect(rows).toEqual([
      ['name', 'note'],
      ['Smith, J.', 'He said "hi"\nthen left'],
    ]);
  });

  test('a BOM does not contaminate the first column name', () => {
    const doc = parseCsv('﻿id,value\n1,x');
    expect(toMarkdown(doc)).toContain('| id | value |');
  });

  test('an embedded newline is flattened inside the cell, not across rows', () => {
    const out = toMarkdown(parseCsv('a,b\n"one\ntwo",3'));
    const rows = out.split('\n').filter((l) => l.startsWith('|'));
    expect(rows).toHaveLength(3);                    // header, rule, one body row
    expect(out).toContain('| one two | 3 |');
  });

  test('rows past the cap are counted, not silently dropped', () => {
    const many = ['a,b', ...Array.from({ length: 600 }, (_, i) => `${i},x`)].join('\n');
    const out = toMarkdown(parseCsv(many));
    expect(out).toContain('more rows not shown');
  });
});

describe('RTF', () => {
  test('group-scoped bold does not leak past its closing brace', () => {
    const out = toMarkdown(parseRtf('{\\rtf1\\ansi {\\b bold} plain\\par}'));
    expect(out).toContain('**bold**');
    expect(out).toContain('plain');
    expect(out).not.toContain('**bold plain**');
  });

  test('\\u escapes decode and their fallback character is swallowed', () => {
    const out = toMarkdown(parseRtf('{\\rtf1 caf\\u233 ? and \\u8212 - done\\par}'));
    expect(out).toContain('café');
    expect(out).toContain('—');
    expect(out).not.toContain('?');
  });

  test('ignorable destinations and font tables never reach the text', () => {
    const rtf = '{\\rtf1{\\fonttbl{\\f0 Times New Roman;}}{\\*\\generator Word;}Real text.\\par}';
    const out = toMarkdown(parseRtf(rtf));
    expect(out).toBe('Real text.');
  });

  test('outline levels become headings', () => {
    const out = toMarkdown(parseRtf('{\\rtf1\\pard\\outlinelevel0 Title Here\\par\\pard Body.\\par}'));
    expect(out).toContain('# Title Here');
    expect(out).toContain('Body.');
  });
});
