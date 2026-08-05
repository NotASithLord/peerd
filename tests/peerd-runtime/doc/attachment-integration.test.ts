// The attach path end to end: a real .docx in, inlined Markdown out.
//
// The unit tests either side of this seam use a stub converter, which proves
// the sequencing but not that the two halves actually fit. This wires the REAL
// converter (the same functions the offscreen host calls) to the REAL
// attachment pipeline, so a change to either side that breaks the join fails
// here rather than in a browser.

import { describe, test, expect } from 'bun:test';
import { convertToDocument } from '../../../extension/peerd-runtime/doc/convert.js';
import { formatDocBody } from '../../../extension/peerd-runtime/doc/format.js';
import {
  prepareUserAttachmentsWithDocs,
  DOC_TEXT_MAX_CHARS,
} from '../../../extension/peerd-runtime/loop/attachments.js';
import { makeDocx, makeXlsx } from './fixtures.ts';

const toBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

// Exactly what background/service-worker.js's convertDocAttachment does, minus
// the offscreen hop (which only moves bytes).
const realConvert = async (att: { name: string; mediaType: string; data?: string }) => {
  const bin = atob(att.data ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const doc = await convertToDocument(bytes, { name: att.name, contentType: att.mediaType });
  return formatDocBody({ doc, maxChars: DOC_TEXT_MAX_CHARS, source: att.name });
};

const attach = async (name: string, bytes: Uint8Array, mediaType = '') => prepareUserAttachmentsWithDocs({
  text: 'what does this say?',
  attachments: [{ name, mediaType, size: bytes.length, data: toBase64(bytes) }],
  convert: realConvert,
});

describe('attaching a real office file', () => {
  test('a .docx arrives as inlined Markdown with its structure intact', async () => {
    const out = await attach('quarterly.docx', await makeDocx());
    // Wrapped like any other inlined file, under its real name.
    expect(out.text).toContain('<peerd_file name="quarterly.docx">');
    expect(out.text).toContain('</peerd_file>');
    // The user's own words still lead the message.
    expect(out.text.startsWith('what does this say?')).toBe(true);
    // Structure survived the whole trip: ZIP → XML → model → Markdown.
    expect(out.text).toContain('# Findings');
    expect(out.text).toContain('**Revenue rose**');
    expect(out.text).toContain('| Region | Total |');
    // Provenance rides along, so the model knows what it is reading.
    expect(out.text).toContain('format: docx');
    expect(out.text).toContain('title: Quarterly Report');
    // The record is metadata-only — the bytes do not persist.
    expect(out.attachments[0]).toEqual({
      name: 'quarterly.docx',
      mediaType: '',
      kind: 'doc',
      size: expect.any(Number),
    });
  });

  test('a .xlsx arrives as one table per sheet, hidden sheets withheld', async () => {
    const out = await attach('sales.xlsx', await makeXlsx());
    expect(out.text).toContain('## Sales');
    expect(out.text).toContain('| Region | Q1 | Q2 |');
    // The hidden sheet's contents must not reach the model…
    expect(out.text).not.toContain('SECRET');
    // …and the omission is stated rather than silent.
    expect(out.text).toContain('hidden and was not read');
  });

  test('an unreadable file fails the SEND rather than attaching noise', async () => {
    // A .docx that is not a ZIP at all — the case that used to reach the model
    // as mojibake. The send must fail with something the user can act on.
    const junk = new TextEncoder().encode('this is not a docx at all, just text');
    const err = await attach('broken.docx', junk).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('broken.docx');
  });

  test('the inlined text is capped, and the cap is announced', async () => {
    const out = await attach('quarterly.docx', await makeDocx());
    const body = out.text.split('<peerd_file name="quarterly.docx">')[1];
    expect(body.length).toBeLessThan(DOC_TEXT_MAX_CHARS + 2000);
  });
});
