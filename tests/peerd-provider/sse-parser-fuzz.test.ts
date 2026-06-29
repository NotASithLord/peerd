// Property fuzz for the SSE stream parser — every provider response flows
// through it, and the classic bug is a record split across network chunk
// boundaries (a `data:` line, or the blank line that ends a record, arriving in
// two reads). The gold property: the SAME bytes, split at ANY boundaries, must
// yield the SAME events. Plus round-trip + never-throws-on-garbage.
//
// PRNG is seeded so any failure reproduces from the fixed seed.

import { describe, test, expect } from 'bun:test';
import { parseSSE } from '../../extension/peerd-provider/format/sse-parser.js';

const rng = (seed: number) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const enc = new TextEncoder();

const streamOf = (chunks: Uint8Array[]): ReadableStream<Uint8Array> => {
  let i = 0;
  return new ReadableStream({ pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); } });
};
const drain = async (s: ReadableStream<Uint8Array>) => {
  const out: any[] = [];
  for await (const e of parseSSE(s)) out.push(e);
  return out;
};
const splitBytes = (r: () => number, bytes: Uint8Array, n: number): Uint8Array[] => {
  if (bytes.length <= 1 || n <= 0) return [bytes];
  const cuts = [...new Set(Array.from({ length: n }, () => 1 + Math.floor(r() * (bytes.length - 1))))].sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let prev = 0;
  for (const c of cuts) { chunks.push(bytes.slice(prev, c)); prev = c; }
  chunks.push(bytes.slice(prev));
  return chunks.filter((c) => c.length > 0);
};

// A random SSE event. Data chars are drawn from a colon/space-free alphabet so
// the (spec-mandated) single-leading-space strip never alters the round-trip.
const DATA_ALPHA = 'abcXYZ0._{}"-';
const randEvent = (r: () => number) => {
  const name = r() < 0.3 ? 'message' : `evt${Math.floor(r() * 1000)}`; // 'message' = the default name
  const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
    const len = Math.floor(r() * 12);
    let s = '';
    for (let i = 0; i < len; i++) s += DATA_ALPHA[Math.floor(r() * DATA_ALPHA.length)];
    return s;
  });
  return { name, lines };
};
type Ev = { name: string, lines: string[] };
const serialize = (evs: Ev[]) => evs.map((e) =>
  (e.name === 'message' ? '' : `event: ${e.name}\n`) + e.lines.map((l) => `data: ${l}\n`).join('') + '\n').join('');
const expected = (evs: Ev[]) => evs.map((e) => ({ event: e.name, data: e.lines.join('\n') }));

describe('SSE parser — property fuzz', () => {
  test('chunk-boundary invariance: the same bytes split at ANY boundaries yield the same events', async () => {
    const r = rng(0xC0FFEE);
    for (let i = 0; i < 400; i++) {
      const evs = Array.from({ length: 1 + Math.floor(r() * 5) }, () => randEvent(r));
      const bytes = enc.encode(serialize(evs));
      const whole = await drain(streamOf([bytes]));
      const split = await drain(streamOf(splitBytes(r, bytes, 1 + Math.floor(r() * 7))));
      if (JSON.stringify(whole) !== JSON.stringify(split)) {
        throw new Error(`boundary mismatch on ${JSON.stringify(serialize(evs))}\n whole=${JSON.stringify(whole)}\n split=${JSON.stringify(split)}`);
      }
    }
  });

  test('round-trips well-formed events', async () => {
    const r = rng(0xD00D);
    for (let i = 0; i < 400; i++) {
      const evs = Array.from({ length: 1 + Math.floor(r() * 5) }, () => randEvent(r));
      const got = await drain(streamOf([enc.encode(serialize(evs))]));
      expect(got).toEqual(expected(evs));
    }
  });

  test('CRLF line endings parse identically to LF', async () => {
    const r = rng(0x0D0A);
    for (let i = 0; i < 300; i++) {
      const evs = Array.from({ length: 1 + Math.floor(r() * 4) }, () => randEvent(r));
      const lf = serialize(evs);
      const crlf = lf.replace(/\n/g, '\r\n');
      expect(await drain(streamOf([enc.encode(crlf)]))).toEqual(await drain(streamOf([enc.encode(lf)])));
    }
  });

  test('never throws on arbitrary bytes (random chunks)', async () => {
    const r = rng(0xFACE);
    for (let i = 0; i < 400; i++) {
      const bytes = new Uint8Array(Array.from({ length: Math.floor(r() * 220) }, () => Math.floor(r() * 256)));
      const chunks = splitBytes(r, bytes, Math.floor(r() * 4));
      await expect(drain(streamOf(chunks))).resolves.toBeDefined();
    }
  });
});

describe('SSE parser — overflow caps (a malformed/oversized stream is bounded)', () => {
  const drainWith = async (stream: ReadableStream<Uint8Array>, opts: any) => {
    const out: any[] = [];
    for await (const e of parseSSE(stream, opts)) out.push(e);
    return out;
  };

  test('a line that never terminates throws past maxLine (not unbounded growth)', async () => {
    const chunk = enc.encode('x'.repeat(200)); // no newline, ever
    await expect(drainWith(streamOf([chunk]), { maxLine: 50 })).rejects.toThrow(/line buffer exceeded/);
  });

  test('a record that never completes throws past maxRecord', async () => {
    const chunk = enc.encode(`data: ${'y'.repeat(200)}\n`); // a data line with no blank-line terminator
    await expect(drainWith(streamOf([chunk]), { maxRecord: 50 })).rejects.toThrow(/record exceeded/);
  });

  test('a well-formed stream is unaffected by the caps', async () => {
    const ok = await drainWith(streamOf([enc.encode('data: hello\n\n')]), { maxLine: 1e6, maxRecord: 1e6 });
    expect(ok).toEqual([{ event: 'message', data: 'hello' }]);
  });
});
