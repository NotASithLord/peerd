// End-to-end conversion tests: real archives in, Markdown out.
//
// These are written against the OUTPUT, not the intermediate model, because
// the output is the contract — it is what a model reads and answers from. A
// test that asserts on block shapes passes happily while the serializer emits
// `**Hel****lo**`.

import { describe, test, expect } from 'bun:test';
import { convertToDocument } from '../../../extension/peerd-runtime/doc/convert.js';
import { toMarkdown } from '../../../extension/peerd-runtime/doc/markdown.js';
import { formatDocBody } from '../../../extension/peerd-runtime/doc/format.js';
import { makeDocx, makeXlsx, makePptx, makeOdt, makeOds, makeEpub, makeZip } from './fixtures.ts';

const md = async (bytes: Uint8Array, hints = {}) => toMarkdown(await convertToDocument(bytes, hints));

describe('.docx', () => {
  test('headings, merged bold runs, links, lists and tables all survive', async () => {
    const out = await md(await makeDocx());
    expect(out).toContain('# Findings');
    // The two adjacent bold runs must merge — `**Revenue ****rose**` renders wrong.
    expect(out).toContain('**Revenue rose**');
    expect(out).toContain('[the spec](https://example.com/spec)');
    expect(out).toContain('Not bold.');
    expect(out).not.toContain('**Not bold.**');
    expect(out).toContain('1. First step');
    expect(out).toContain('- A bullet');
    // numId="0" is "explicitly not a list" — it must not gain a bullet.
    expect(out).toMatch(/^Plain again$/m);
    // A pipe inside a cell must be escaped or it splits the column.
    expect(out).toContain('| EMEA \\| North | 12 |');
    expect(out).toContain('| --- | --- |');
  });

  test('core properties become the title and metadata', async () => {
    const doc = await convertToDocument(await makeDocx());
    expect(doc.title).toBe('Quarterly Report');
    expect(doc.meta.author).toBe('A. Writer');
  });
});

describe('.xlsx', () => {
  test('pooled strings resolve and a sparse row keeps its columns', async () => {
    const out = await md(await makeXlsx());
    expect(out).toContain('## Sales');
    expect(out).toContain('| Region | Q1 | Q2 |');
    // B2 is absent in the source; 91 belongs in the THIRD column, not the second.
    expect(out).toContain('| EMEA |  | 91 |');
    // Concatenated styled runs in one shared string.
    expect(out).toContain('EMEA');
    // A formula cell reports its cached VALUE, and a boolean renders as TRUE.
    expect(out).toContain('| APAC | 3 | TRUE |');
  });

  test('a hidden sheet is not read, and says so', async () => {
    const doc = await convertToDocument(await makeXlsx());
    expect(toMarkdown(doc)).not.toContain('SECRET');
    expect(doc.notes.join(' ')).toContain('hidden');
  });
});

describe('.pptx', () => {
  test('slides follow the sldIdLst order, not the relationship order', async () => {
    const out = await md(await makePptx());
    const first = out.indexOf('First Deck Slide');
    const second = out.indexOf('Second Deck Slide');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
  });

  test('titles head their slide and speaker notes are kept', async () => {
    const out = await md(await makePptx());
    expect(out).toContain('## Slide 1: First Deck Slide');
    expect(out).toContain('### Speaker notes');
    expect(out).toContain('Remember to mention margin.');
    // The notes placeholder's bare slide number is an artifact, not content.
    expect(out).not.toMatch(/^1$/m);
  });
});

describe('OpenDocument', () => {
  test('.odt keeps headings, links, lists and tables', async () => {
    const doc = await convertToDocument(await makeOdt());
    const out = toMarkdown(doc);
    expect(doc.title).toBe('Field Notes');
    expect(out).toContain('# Observations');
    expect(out).toContain('[a link](https://example.org/x)');
    expect(out).toContain('- Alpha');
    expect(out).toContain('| Key | Value |');
  });

  test('.ods grid padding is trimmed, not expanded', async () => {
    const out = await md(await makeOds());
    expect(out).toContain('## Data');
    expect(out).toContain('| Name | Count |');
    expect(out).toContain('| widgets | 7 |');
    // 16381 repeated empty columns and a million repeated empty rows must not
    // reach the output — the whole sheet is four cells.
    expect(out.length).toBeLessThan(400);
    expect(out).not.toContain('|  |  |  |  |');
  });
});

describe('.epub', () => {
  test('chapters come out in SPINE order with structure intact', async () => {
    const doc = await convertToDocument(await makeEpub());
    const out = toMarkdown(doc);
    expect(doc.title).toBe('A Short Book');
    expect(doc.meta.author).toBe('E. Author');
    // ch1 is listed SECOND in the manifest but FIRST in the spine.
    expect(out.indexOf('Chapter One')).toBeLessThan(out.indexOf('Chapter Two'));
    expect(out).toContain('It was a **dark** and stormy night.');
    expect(out).toContain('- one');
    expect(out).toContain('> A quoted line.');
    // The stylesheet is in the manifest but not the spine.
    expect(out).not.toContain('margin: 0');
  });
});

describe('the refusals are specific', () => {
  test('a legacy OLE2 binary names the format and the way out', async () => {
    const ole2 = new Uint8Array(600);
    ole2.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const err = await convertToDocument(ole2, { name: 'old.doc' }).catch((e) => e);
    expect(err.name).toBe('LegacyDocFormatError');
    expect(err.message).toContain('Word 97-2003');
    expect(err.message).toContain('libreoffice');
  });

  test('an unknown binary is refused rather than rendered as mojibake', async () => {
    const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x42]);
    const err = await convertToDocument(junk).catch((e) => e);
    expect(err.name).toBe('UnsupportedDocFormatError');
  });

  test('an encrypted archive says so instead of failing as corrupt', async () => {
    const zip = await makeZip([{ name: 'word/document.xml', content: '<w/>' }]);
    // Flip the central directory's general-purpose bit 0 (encrypted). It sits
    // at offset 8 of the central header, which follows the local data.
    const marker = zip.lastIndexOf(0x02);
    const at = zip.findIndex((_, i) => i < zip.length - 4
      && zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02);
    expect(at).toBeGreaterThan(-1);
    expect(marker).toBeGreaterThan(-1);
    zip[at + 8] |= 0x01;
    const err = await convertToDocument(zip, { name: 'locked.docx' }).catch((e) => e);
    expect(err.name).toBe('ZipError');
    expect(err.message).toContain('encrypted');
  });
});

describe('formatDocBody', () => {
  test('truncation is announced with the real numbers', async () => {
    const doc = await convertToDocument(await makeDocx());
    const body = formatDocBody({ doc, maxChars: 80, source: 'https://example.com/r.docx' });
    expect(body).toContain('[source: https://example.com/r.docx]');
    expect(body).toContain('truncated: showing');
    expect(body).toContain('format: docx');
  });

  test('an empty conversion says so rather than returning nothing', async () => {
    const doc = await convertToDocument(new TextEncoder().encode('a,b\n'), { name: 'x.csv' });
    doc.blocks = [];
    expect(formatDocBody({ doc })).toContain('converted to no text');
  });
});
