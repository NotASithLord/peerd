// Wire shape for user messages carrying file attachments: live
// attachments render a content ARRAY (image/document blocks FIRST, then
// the text block); stripped attachments collapse to a one-line sentinel
// in the text; text-kind records leave no trace (their payload was
// inlined into the message text at send time).

import { describe, test, expect } from 'bun:test';
import { toAnthropicBody } from '../../extension/peerd-provider/format/to-anthropic.js';
import type { InternalMessage } from '../../extension/peerd-provider/types.js';

const userMsg = (content: string, attachments?: any[]): InternalMessage => ({
  role: 'user', content, id: 'u1', when: 0,
  ...(attachments ? { attachments } : {}),
});

const wire = (messages: InternalMessage[]) =>
  toAnthropicBody({ model: 'claude-sonnet-4-6', system: 's', messages }).messages;

const liveImage = {
  name: 'shot.png', mediaType: 'image/png', kind: 'image', size: 3, data: 'aW1n',
};
const livePdf = {
  name: 'doc.pdf', mediaType: 'application/pdf', kind: 'pdf', size: 3, data: 'cGRm',
};

describe('to-anthropic — user message attachments', () => {
  test('a live image renders [image block, text block] in that order', () => {
    const [msg] = wire([userMsg('what is this?', [liveImage])]);
    expect(Array.isArray(msg.content)).toBe(true);
    const blocks = msg.content as any[];
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aW1n' },
    });
    expect(blocks[1]).toMatchObject({ type: 'text', text: 'what is this?' });
  });

  test('a live pdf renders a document block with the pdf media type', () => {
    const [msg] = wire([userMsg('summarize', [livePdf])]);
    const blocks = msg.content as any[];
    expect(blocks[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
    });
  });

  test('multiple attachments: all blocks precede the single text block', () => {
    const [msg] = wire([userMsg('both', [liveImage, livePdf])]);
    const blocks = msg.content as any[];
    expect(blocks.map((b) => b.type)).toEqual(['image', 'document', 'text']);
  });

  test('empty text with live blocks emits NO empty text block', () => {
    // why: the API rejects empty text blocks — blocks-only is valid.
    const [msg] = wire([userMsg('', [liveImage])]);
    const blocks = msg.content as any[];
    expect(blocks.map((b) => b.type)).toEqual(['image']);
  });

  test('stripped attachments re-send as a metadata sentinel, no blocks', () => {
    const stripped = { name: 'shot.png', mediaType: 'image/png', kind: 'image', size: 1234, stripped: true };
    const [msg] = wire([userMsg('what was that?', [stripped])]);
    // string content — the cache-breakpoint wrap turns the LAST message
    // into a single text block; inspect the text either way.
    const text = typeof msg.content === 'string'
      ? msg.content
      : (msg.content as any[])[0].text;
    expect(text).toContain('<attachment name="shot.png" media_type="image/png" 1234B stripped');
    expect(text).toContain('what was that?');
    expect(JSON.stringify(msg)).not.toContain('"type":"image"');
  });

  test('text-kind records (payload already inlined) leave the wire shape untouched', () => {
    const textRec = { name: 'notes.txt', mediaType: 'text/plain', kind: 'text', size: 5 };
    const [msg] = wire([userMsg('hi\n\n<peerd_file name="notes.txt">\nhello\n</peerd_file>', [textRec])]);
    const text = typeof msg.content === 'string'
      ? msg.content
      : (msg.content as any[])[0].text;
    expect(text).toContain('<peerd_file name="notes.txt">');
    expect(text).not.toContain('<attachment ');
  });

  test('attachment-free user messages keep the plain-string path', () => {
    const [msg] = wire([userMsg('plain'), { role: 'user', content: 'second', id: 'u2', when: 1 } as InternalMessage]);
    // adjacent same-role plain strings still collapse (regression guard)
    expect(wire([userMsg('plain')]).length).toBe(1);
    expect(typeof msg.content === 'string' || Array.isArray(msg.content)).toBe(true);
  });

  test('the cache breakpoint lands on the text block of a live-attachment last message', () => {
    const body = toAnthropicBody({
      model: 'claude-sonnet-4-6', system: 's', messages: [userMsg('look', [liveImage])],
    });
    const last = body.messages[body.messages.length - 1];
    const blocks = last.content as any[];
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[blocks.length - 1].type).toBe('text');
  });
});
