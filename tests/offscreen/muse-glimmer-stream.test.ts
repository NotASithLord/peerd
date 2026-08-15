import { describe, test, expect } from 'bun:test';
import {
  MUSE_CONTENT_MARKER,
  museVisibleText,
  makeMuseChannelSplitter,
} from '../../extension/offscreen/muse-glimmer-stream.js';

// Simulate the engine's cumulative-text yields from a raw stream by slicing it
// at every boundary the tokenizer could pick - the splitter must produce the
// same final visible text no matter where the chunk edges fall.
const drainAll = (raw: string, chunkLengths: number[]) => {
  const splitter = makeMuseChannelSplitter();
  let cursor = 0;
  let out = '';
  for (const len of chunkLengths) {
    cursor = Math.min(raw.length, cursor + len);
    out += splitter.push(raw.slice(0, cursor));
  }
  out += splitter.push(raw);
  return { out, splitter };
};

describe('museVisibleText', () => {
  test('reasoning-first stream hides everything until the content marker', () => {
    expect(museVisibleText(' to=self')).toBe('');
    expect(museVisibleText(' to=selfLet me think about')).toBe('');
    expect(museVisibleText(` to=selfthinking...${MUSE_CONTENT_MARKER}`)).toBe('');
    expect(museVisibleText(` to=selfthinking...${MUSE_CONTENT_MARKER}Hello!`)).toBe('Hello!');
  });
  test('direct-answer stream is visible immediately after the opener', () => {
    expect(museVisibleText(' to=userHi there')).toBe('Hi there');
    expect(museVisibleText('to=userHi')).toBe('Hi'); // opener without the leading space
  });
  test('a partial content marker at the tail stays hidden', () => {
    expect(museVisibleText(' to=selfhmm assistant to=')).toBe('');
    expect(museVisibleText(' to=selfhmm assistant to=userYes')).toBe('Yes');
  });
  test('a prefix of an opener is held back until it can be classified', () => {
    expect(museVisibleText(' ')).toBe('');
    expect(museVisibleText(' to')).toBe('');
    expect(museVisibleText(' to=')).toBe('');
    expect(museVisibleText(' to=u')).toBe('');
  });
  test('an unframed stream passes through whole', () => {
    expect(museVisibleText('Plain prose with no channels.')).toBe('Plain prose with no channels.');
    // ' toaster' diverges from every opener at char 3 → visible in full.
    expect(museVisibleText(' toaster ready')).toBe(' toaster ready');
  });
  test('reasoning may mention to=user without opening the channel early', () => {
    // Only the full marker (with the assistant remnant) flips the channel.
    expect(museVisibleText(' to=selfthe user said to=user once')).toBe('');
  });
});

describe('makeMuseChannelSplitter', () => {
  const RAW = ` to=selfFirst I consider the request.${MUSE_CONTENT_MARKER}The answer is 42.`;

  test('emits only content deltas, whatever the chunking', () => {
    for (const chunks of [[1, 1, 1, 200], [3, 5, 7, 11, 200], [RAW.length], [10, 10, 10, 10, 200]]) {
      const { out } = drainAll(RAW, chunks);
      expect(out).toBe('The answer is 42.');
    }
  });
  test('adversarial chunking: every split point of the marker region', () => {
    const markerStart = RAW.indexOf(MUSE_CONTENT_MARKER);
    for (let cut = markerStart - 2; cut <= markerStart + MUSE_CONTENT_MARKER.length + 2; cut += 1) {
      const { out } = drainAll(RAW, [cut, RAW.length]);
      expect(out).toBe('The answer is 42.');
    }
  });
  test('push returns incremental deltas that concatenate to the visible text', () => {
    const splitter = makeMuseChannelSplitter();
    const d1 = splitter.push(' to=userHel');
    const d2 = splitter.push(' to=userHello, wo');
    const d3 = splitter.push(' to=userHello, world');
    expect(d1 + d2 + d3).toBe('Hello, world');
    expect(splitter.visible).toBe('Hello, world');
  });
  test('reconcile flushes an under-revealed tail from the authoritative parse', () => {
    const splitter = makeMuseChannelSplitter();
    // Generation aborted mid-marker: the stream revealed nothing...
    splitter.push(' to=selfthinking assistant to=');
    expect(splitter.visible).toBe('');
    // ...but the engine's raw-text parse recovered the content.
    expect(splitter.reconcile('Recovered answer')).toBe('Recovered answer');
    expect(splitter.visible).toBe('Recovered answer');
  });
  test('reconcile refuses to double or contradict what already streamed', () => {
    const splitter = makeMuseChannelSplitter();
    splitter.push(' to=userStreamed text');
    expect(splitter.reconcile('Different text entirely')).toBe('');
    expect(splitter.reconcile('Streamed text plus a tail')).toBe(' plus a tail');
    expect(splitter.reconcile(null)).toBe('');
    expect(splitter.visible).toBe('Streamed text plus a tail');
  });
  test('reconcile never leaks the reasoning channel from the engine\'s raw fallback', () => {
    // The engine's post-parse falls back to the RAW special-stripped text when
    // its channel parse fails (token budget exhausted mid-reasoning) - that
    // fallback arrives channel-framed and must not reach the chat verbatim.
    const truncatedMidReasoning = makeMuseChannelSplitter();
    truncatedMidReasoning.push(' to=selfstep one of the hidden plan');
    expect(truncatedMidReasoning.reconcile(' to=selfstep one of the hidden plan, step two')).toBe('');
    expect(truncatedMidReasoning.visible).toBe('');
    // A fallback that DID cross into the visible channel yields only the
    // visible part, never the reasoning prefix or the marker text.
    const truncatedMidContent = makeMuseChannelSplitter();
    truncatedMidContent.push(' to=selfhidden');
    const flushed = truncatedMidContent.reconcile(` to=selfhidden${MUSE_CONTENT_MARKER}The visible half`);
    expect(flushed).toBe('The visible half');
    expect(truncatedMidContent.visible).toBe('The visible half');
  });
});
