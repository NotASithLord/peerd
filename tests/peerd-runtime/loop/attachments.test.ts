// File-attachment pure core: classification, cap enforcement (typed
// errors, fail closed), text inlining, and the send-once-then-strip
// metadata transform.

import { describe, test, expect } from 'bun:test';
import {
  classifyAttachment,
  validateAttachment,
  validateAttachments,
  prepareUserAttachments,
  prepareUserAttachmentsWithDocs,
  stripAttachment,
  stripAttachments,
  attachmentBytes,
  formatBytes,
  ATTACHMENT_CAPS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  UnsupportedAttachmentError,
  AttachmentTooLargeError,
  TooManyAttachmentsError,
  AttachmentConversionError,
} from '../../../extension/peerd-runtime/loop/attachments.js';

const b64 = (s: string) => btoa(s);

describe('classifyAttachment', () => {
  test('the four Anthropic image media types classify as image', () => {
    for (const mt of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      expect(classifyAttachment({ name: 'f', mediaType: mt, size: 1 })).toBe('image');
    }
  });

  test('application/pdf classifies as pdf', () => {
    expect(classifyAttachment({ name: 'f.pdf', mediaType: 'application/pdf', size: 1 })).toBe('pdf');
  });

  test('any text/* classifies as text', () => {
    expect(classifyAttachment({ name: 'a.txt', mediaType: 'text/plain', size: 1 })).toBe('text');
    expect(classifyAttachment({ name: 'a.csv', mediaType: 'text/csv', size: 1 })).toBe('text');
  });

  test('everything else is unsupported (svg, zip, missing type)', () => {
    expect(classifyAttachment({ name: 'a.svg', mediaType: 'image/svg+xml', size: 1 })).toBe('unsupported');
    expect(classifyAttachment({ name: 'a.zip', mediaType: 'application/zip', size: 1 })).toBe('unsupported');
    expect(classifyAttachment({ name: 'a', mediaType: '', size: 1 })).toBe('unsupported');
  });

  test('media types are case-insensitive and parameter-tolerant', () => {
    expect(classifyAttachment({ name: 'f', mediaType: 'IMAGE/PNG', size: 1 })).toBe('image');
    expect(classifyAttachment({ name: 'f', mediaType: 'text/plain; charset=utf-8', size: 1 })).toBe('text');
  });
});

describe('validateAttachment — caps with typed errors', () => {
  test('a valid image normalizes to the internal shape', () => {
    const att = validateAttachment({ name: 'shot.png', mediaType: 'image/png', size: 0, data: b64('png-bytes') });
    expect(att.kind).toBe('image');
    expect(att.mediaType).toBe('image/png');
    expect(att.size).toBe('png-bytes'.length);   // measured from base64, not the claimed 0
    expect(att.data).toBe(b64('png-bytes'));
  });

  test('unsupported type throws UnsupportedAttachmentError', () => {
    expect(() => validateAttachment({ name: 'a.zip', mediaType: 'application/zip', size: 1 }))
      .toThrow(UnsupportedAttachmentError);
  });

  test('over-cap image throws AttachmentTooLargeError (5MB cap)', () => {
    expect(() => validateAttachment({ name: 'big.png', mediaType: 'image/png', size: ATTACHMENT_CAPS.image + 1 }))
      .toThrow(AttachmentTooLargeError);
    // exactly at cap is fine
    expect(validateAttachment({ name: 'ok.png', mediaType: 'image/png', size: ATTACHMENT_CAPS.image }).size)
      .toBe(ATTACHMENT_CAPS.image);
  });

  test('pdf gets the larger 10MB cap; text the 64KB cap', () => {
    expect(validateAttachment({ name: 'a.pdf', mediaType: 'application/pdf', size: ATTACHMENT_CAPS.image + 1 }).kind)
      .toBe('pdf');
    expect(() => validateAttachment({ name: 'a.pdf', mediaType: 'application/pdf', size: ATTACHMENT_CAPS.pdf + 1 }))
      .toThrow(AttachmentTooLargeError);
    expect(() => validateAttachment({ name: 'a.txt', mediaType: 'text/plain', size: ATTACHMENT_CAPS.text + 1 }))
      .toThrow(AttachmentTooLargeError);
  });

  test('the cap is enforced against the base64 payload, not the claimed size', () => {
    // why: the claimed size can lie; the bytes can't. A 6MB payload with
    // a claimed size of 1 byte must still be refused.
    const sixMb = 'A'.repeat(Math.ceil((6 * 1024 * 1024) / 3) * 4);
    expect(() => validateAttachment({ name: 'liar.png', mediaType: 'image/png', size: 1, data: sixMb }))
      .toThrow(AttachmentTooLargeError);
  });
});

describe('validateAttachments — per-message batch', () => {
  test('more than 5 attachments throws TooManyAttachmentsError', () => {
    const list = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) =>
      ({ name: `f${i}.png`, mediaType: 'image/png', size: 10 }));
    expect(() => validateAttachments(list)).toThrow(TooManyAttachmentsError);
  });

  test('exactly 5 valid attachments pass', () => {
    const list = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, i) =>
      ({ name: `f${i}.png`, mediaType: 'image/png', size: 10 }));
    expect(validateAttachments(list).length).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
  });

  test('one bad apple fails the whole batch (fail closed)', () => {
    expect(() => validateAttachments([
      { name: 'ok.png', mediaType: 'image/png', size: 10 },
      { name: 'bad.zip', mediaType: 'application/zip', size: 10 },
    ])).toThrow(UnsupportedAttachmentError);
  });
});

describe('prepareUserAttachments — text inlining + block-kind passthrough', () => {
  test('text files inline as <peerd_file name=…> appended to the message text', () => {
    const { text, attachments } = prepareUserAttachments({
      text: 'look at this',
      attachments: [{ name: 'notes.txt', mediaType: 'text/plain', size: 5, data: b64('hello') }],
    });
    expect(text).toBe('look at this\n\n<peerd_file name="notes.txt">\nhello\n</peerd_file>');
    // the record keeps metadata only — the payload lives in the text now
    expect(attachments.length).toBe(1);
    expect(attachments[0].kind).toBe('text');
    expect(attachments[0].data).toBeUndefined();
  });

  test('filenames are attribute-escaped in the wrapper', () => {
    const { text } = prepareUserAttachments({
      text: 'x',
      attachments: [{ name: 'a"><evil>.txt', mediaType: 'text/plain', size: 1, data: b64('y') }],
    });
    expect(text).toContain('<peerd_file name="a&quot;&gt;&lt;evil&gt;.txt">');
    expect(text).not.toContain('"><evil>');
  });

  test('utf-8 text survives the base64 round trip', () => {
    const payload = 'héllo — ünïcode ✓';
    const data = btoa(String.fromCharCode(...new TextEncoder().encode(payload)));
    const { text } = prepareUserAttachments({
      text: '',
      attachments: [{ name: 'u.txt', mediaType: 'text/plain', size: 1, data }],
    });
    expect(text).toContain(payload);
  });

  test('image/pdf records keep their base64 and the text is untouched', () => {
    const { text, attachments } = prepareUserAttachments({
      text: 'see attached',
      attachments: [
        { name: 'a.png', mediaType: 'image/png', size: 3, data: b64('img') },
        { name: 'b.pdf', mediaType: 'application/pdf', size: 3, data: b64('pdf') },
      ],
    });
    expect(text).toBe('see attached');
    expect(attachments.map((a) => a.kind)).toEqual(['image', 'pdf']);
    expect(attachments.every((a) => typeof a.data === 'string')).toBe(true);
  });

  test('validation errors propagate (the send fails closed as a unit)', () => {
    expect(() => prepareUserAttachments({
      text: 'x',
      attachments: [{ name: 'a.zip', mediaType: 'application/zip', size: 1 }],
    })).toThrow(UnsupportedAttachmentError);
  });
});

describe('stripAttachment(s) — send-once-then-strip metadata shape', () => {
  test('drops data, keeps name/mediaType/kind/size, sets stripped:true', () => {
    const stripped = stripAttachment({
      name: 'a.png', mediaType: 'image/png', kind: 'image', size: 42, data: b64('img'),
    });
    expect(stripped).toEqual({
      name: 'a.png', mediaType: 'image/png', kind: 'image', size: 42, stripped: true,
    });
    expect('data' in stripped).toBe(false);
  });

  test('stripAttachments maps a list and tolerates non-arrays', () => {
    const out = stripAttachments([
      { name: 'a.png', mediaType: 'image/png', kind: 'image', size: 1, data: 'x' },
      { name: 'b.pdf', mediaType: 'application/pdf', kind: 'pdf', size: 2, data: 'y' },
    ]);
    expect(out.every((a) => a.stripped === true && !('data' in a))).toBe(true);
    expect(stripAttachments(undefined as any)).toEqual([]);
  });
});

describe('helpers', () => {
  test('attachmentBytes measures base64 (padding-aware) and falls back to size', () => {
    expect(attachmentBytes({ data: b64('abc') })).toBe(3);     // no padding
    expect(attachmentBytes({ data: b64('abcd') })).toBe(4);    // == padding
    expect(attachmentBytes({ data: b64('abcde') })).toBe(5);   // = padding
    expect(attachmentBytes({ size: 99 })).toBe(99);
    expect(attachmentBytes({})).toBe(0);
  });

  test('formatBytes renders B / KB / MB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

// --- office / e-book attachments (the 'doc' kind) -------------------------
//
// These have no model-native transport, so they are converted to Markdown and
// ride the text transport. The interesting cases are all about the SEAM: the
// conversion is injected, so the pure core must sequence it correctly and fail
// closed with the converter's own message.

describe('classifyAttachment — documents', () => {
  test('office media types classify as doc', () => {
    for (const mediaType of [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.oasis.opendocument.text',
      'application/epub+zip',
    ]) {
      expect(classifyAttachment({ name: 'f', mediaType })).toBe('doc');
    }
  });

  test('an EMPTY media type falls back to the extension — the common real case', () => {
    // Chrome reports File.type '' for .docx on machines whose OS has no
    // registry entry. Without the fallback the picker refuses a file peerd
    // reads perfectly.
    expect(classifyAttachment({ name: 'report.docx', mediaType: '' })).toBe('doc');
    expect(classifyAttachment({ name: 'BUDGET.XLSX', mediaType: '' })).toBe('doc');
    expect(classifyAttachment({ name: 'book.epub' })).toBe('doc');
  });

  test('legacy binaries classify as doc so the refusal can be specific', () => {
    // Nothing converts these, but reaching the converter is what produces
    // "this is a Word 97-2003 file, here is what to do" instead of a generic
    // unsupported-type error.
    expect(classifyAttachment({ name: 'old.doc', mediaType: '' })).toBe('doc');
    expect(classifyAttachment({ name: 'old.xls', mediaType: 'application/vnd.ms-excel' })).toBe('doc');
  });

  test('the extension fallback does NOT rescue arbitrary unknown files', () => {
    expect(classifyAttachment({ name: 'archive.zip', mediaType: '' })).toBe('unsupported');
    expect(classifyAttachment({ name: 'app.exe', mediaType: '' })).toBe('unsupported');
  });

  test('text/* still wins over the extension fallback', () => {
    // A .csv stays text and is inlined verbatim rather than re-rendered.
    expect(classifyAttachment({ name: 'data.csv', mediaType: 'text/csv' })).toBe('text');
  });
});

describe('prepareUserAttachmentsWithDocs', () => {
  const docx = { name: 'q3.docx', mediaType: '', size: 2048, data: b64('PK-not-really') };

  test('a converted document is inlined as text and its payload dropped', async () => {
    const convert = async () => '# Q3\n\nRevenue rose.';
    const out = await prepareUserAttachmentsWithDocs({ text: 'summarize this', attachments: [docx], convert });
    expect(out.text).toContain('<peerd_file name="q3.docx">');
    expect(out.text).toContain('Revenue rose.');
    // The chip keeps its identity — the UI should not call a .docx a text file.
    expect(out.attachments[0].kind).toBe('doc');
    // Neither the source bytes nor the converted text ride the attachment
    // record: the text lives in the message, which is what persists.
    expect(out.attachments[0]).not.toHaveProperty('data');
    expect(out.attachments[0]).not.toHaveProperty('text');
  });

  test('the converter sees the file and its declared type', async () => {
    const seen: any[] = [];
    await prepareUserAttachmentsWithDocs({
      text: '', attachments: [docx], convert: async (a: any) => { seen.push(a); return 'x'; },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe('q3.docx');
    expect(seen[0].data).toBe(docx.data);
  });

  test('validation runs BEFORE conversion — an over-cap file is never parsed', async () => {
    let converted = false;
    const huge = { name: 'big.docx', mediaType: '', size: ATTACHMENT_CAPS.doc + 1 };
    await expect(prepareUserAttachmentsWithDocs({
      text: '', attachments: [huge], convert: async () => { converted = true; return ''; },
    })).rejects.toThrow(AttachmentTooLargeError);
    expect(converted).toBe(false);
  });

  test('a conversion failure fails the send with the converter\'s own message', async () => {
    // The whole point of routing legacy binaries here: the specific advice
    // survives to the user instead of collapsing into "unsupported".
    const convert = async () => { throw new Error('Word 97-2003 (.doc) is a binary format this reader cannot open.'); };
    const err = await prepareUserAttachmentsWithDocs({
      text: '', attachments: [{ name: 'old.doc', mediaType: '', size: 10, data: b64('x') }], convert,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AttachmentConversionError);
    expect(err.message).toContain('old.doc');
    expect(err.message).toContain('Word 97-2003');
  });

  test('no converter (Firefox — no offscreen document) refuses legibly', async () => {
    const err = await prepareUserAttachmentsWithDocs({
      text: '', attachments: [docx], convert: undefined,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AttachmentConversionError);
    expect(err.message).toContain('not available in this browser build');
  });

  test('a batch with no documents never touches the converter', async () => {
    let called = false;
    const out = await prepareUserAttachmentsWithDocs({
      text: 'hi',
      attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: 5, data: b64('hello') }],
      convert: async () => { called = true; return ''; },
    });
    expect(called).toBe(false);
    expect(out.text).toContain('hello');
  });

  test('images and documents mix in one message', async () => {
    const out = await prepareUserAttachmentsWithDocs({
      text: 'compare',
      attachments: [
        { name: 'chart.png', mediaType: 'image/png', size: 100, data: b64('img') },
        docx,
      ],
      convert: async () => 'converted body',
    });
    // The image keeps its bytes for this turn; the document became text.
    expect(out.attachments[0].kind).toBe('image');
    expect(out.attachments[0].data).toBeTruthy();
    expect(out.text).toContain('converted body');
  });
});
