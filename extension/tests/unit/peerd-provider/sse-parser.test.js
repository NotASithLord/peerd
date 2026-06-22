// @ts-check
// SSE parser tests.
//
// The parser is the bottom of the streaming stack — every provider's
// from-* translator builds on it. Coverage targets:
//   - single-event records (event: + data:)
//   - multi-line data: fields
//   - comment lines (`:`)
//   - record boundaries split across chunks
//   - UTF-8 multibyte char split across chunks
//   - trailing record with no final blank line

import { describe, it, expect } from '../../framework.js';
import { parseSSE } from '/peerd-provider/format/sse-parser.js';

const enc = new TextEncoder();

/** @param {ReadonlyArray<string | Uint8Array>} chunks */
const streamOf = (chunks) => new ReadableStream({
  start(controller) {
    for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
    controller.close();
  },
});

/** @param {ReadableStream<Uint8Array>} stream */
const collect = async (stream) => {
  const out = [];
  for await (const ev of parseSSE(stream)) out.push(ev);
  return out;
};

describe('sse-parser', () => {
  it('parses a single event with named event and data', async () => {
    const events = await collect(streamOf(['event: ping\ndata: hello\n\n']));
    expect(events).toEqual([{ event: 'ping', data: 'hello' }]);
  });

  it('defaults event name to "message" when omitted', async () => {
    const events = await collect(streamOf(['data: hi\n\n']));
    expect(events).toEqual([{ event: 'message', data: 'hi' }]);
  });

  it('joins multi-line data: fields with newlines', async () => {
    const events = await collect(streamOf(['data: line1\ndata: line2\n\n']));
    expect(events).toEqual([{ event: 'message', data: 'line1\nline2' }]);
  });

  it('skips comment lines', async () => {
    const events = await collect(streamOf([': keepalive\ndata: x\n\n']));
    expect(events).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('splits records across chunks correctly', async () => {
    const events = await collect(streamOf([
      'event: a\nda', 'ta: one\n\nevent: b\ndata: two\n\n',
    ]));
    expect(events).toEqual([
      { event: 'a', data: 'one' },
      { event: 'b', data: 'two' },
    ]);
  });

  it('survives a UTF-8 multibyte char split across chunks', async () => {
    // "🚀" is U+1F680, four UTF-8 bytes: F0 9F 9A 80.
    const bytes = enc.encode('data: hi 🚀\n\n');
    // Slice mid-character.
    const a = bytes.slice(0, 12);  // through F0 9F
    const b = bytes.slice(12);
    const events = await collect(streamOf([a, b]));
    expect(events).toEqual([{ event: 'message', data: 'hi 🚀' }]);
  });

  it('emits an in-flight record when stream ends without trailing blank', async () => {
    const events = await collect(streamOf(['event: x\ndata: y\n']));
    expect(events).toEqual([{ event: 'x', data: 'y' }]);
  });

  it('handles CRLF line endings', async () => {
    const events = await collect(streamOf(['event: x\r\ndata: y\r\n\r\n']));
    expect(events).toEqual([{ event: 'x', data: 'y' }]);
  });
});
