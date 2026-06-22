// OpenAI-formatter parity with the Anthropic path.
//   #1 to-openai.js: user image attachments must ride as image_url content
//      parts (they were silently dropped, so vision input never reached the
//      model); PDFs and stripped records leave a visible note instead of
//      silent loss.
//   #2 from-openai.js: a content_filter finish_reason must surface a visible
//      note + a clean terminal stop, not leak raw and finalize an empty bubble.

import { describe, test, expect } from 'bun:test';
import { _toOpenAiMessagesForTests as toOpenAiMessages } from '../../extension/peerd-provider/format/to-openai.js';
import { fromOpenAiStream } from '../../extension/peerd-provider/format/from-openai.js';

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> => {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
};
const drain = async (gen: AsyncGenerator<any>) => {
  const out: any[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};
const userMsg = (over: Record<string, unknown>) => ({ role: 'user', id: 'u1', when: 0, ...over });

describe('to-openai — user image attachments (#1 parity)', () => {
  test('a live image becomes an image_url content part alongside the text', () => {
    const msgs = toOpenAiMessages('', [userMsg({
      content: 'what is in this image?',
      attachments: [{ kind: 'image', mediaType: 'image/png', data: 'AAAA', size: 3 }],
    })] as any);
    const user: any = msgs.find((m: any) => m.role === 'user');
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content.some((p: any) => p.type === 'text' && p.text.includes('what is in this image?'))).toBe(true);
    const img = user.content.find((p: any) => p.type === 'image_url');
    expect(img).toBeTruthy();
    expect(img.image_url.url).toBe('data:image/png;base64,AAAA');
  });

  test('a stripped image leaves a text note, no image_url (bytes already sent on its turn)', () => {
    const msgs = toOpenAiMessages('', [userMsg({
      content: 'follow-up',
      attachments: [{ kind: 'image', mediaType: 'image/png', size: 1234, stripped: true }],
    })] as any);
    const user: any = msgs.find((m: any) => m.role === 'user');
    expect(typeof user.content).toBe('string');
    expect(user.content).toContain('sent on its original turn');
    expect(user.content).toContain('follow-up');
  });

  test('a live PDF leaves a note (OpenAI wire has no document part), not silent loss', () => {
    const msgs = toOpenAiMessages('', [userMsg({
      content: 'read this',
      attachments: [{ kind: 'pdf', mediaType: 'application/pdf', data: 'JVBER', size: 4 }],
    })] as any);
    const user: any = msgs.find((m: any) => m.role === 'user');
    expect(typeof user.content).toBe('string');
    expect(user.content).toContain('Anthropic');
    expect(user.content).toContain('read this');
  });

  test('a plain text message stays a compact string (no regression)', () => {
    const msgs = toOpenAiMessages('', [userMsg({ content: 'hi' })] as any);
    const user: any = msgs.find((m: any) => m.role === 'user');
    expect(user.content).toBe('hi');
  });
});

describe('from-openai — content_filter + unknown finish_reason (#2)', () => {
  const finalChunk = (finish: string) =>
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;

  test('content_filter surfaces a visible note and a clean end_turn (not a silent empty bubble)', async () => {
    const events = await drain(fromOpenAiStream(streamOf([finalChunk('content_filter')])));
    const note = events.find((e) => e.type === 'text-delta');
    expect(note).toBeTruthy();
    expect(note.text).toMatch(/content policy|blocked/i);
    const stop = events.find((e) => e.type === 'message-stop');
    expect(stop.stopReason).toBe('end_turn');
  });

  test('an unknown finish_reason is mapped to end_turn, never leaked raw', async () => {
    const events = await drain(fromOpenAiStream(streamOf([finalChunk('some_future_reason')])));
    const stop = events.find((e) => e.type === 'message-stop');
    expect(stop.stopReason).toBe('end_turn');
  });
});
