import { expect, test } from 'bun:test';
import { CHUNK_PART_BYTES, createChannelClient, createContentResponder } from '../../extension/peerd-distributed/content/transfer.js';
import { CHUNK_SIZE } from '../../extension/peerd-distributed/content/chunk.js';
import { fromBase64, toBase64 } from '../../extension/shared/bundle/bytes.js';

test('a full signed chunk crosses a 64 KiB wire limit without changing its bytes', async () => {
  const bytes = new Uint8Array(CHUNK_SIZE);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  let handler: any;
  const frames: any[] = [];
  const respond = createContentResponder({ store: { getManifest: () => null, getChunk: () => bytes } });
  const client = createChannelClient({
    setHandler: value => { handler = value; },
    send: request => respond(request, response => {
      expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThanOrEqual(65_536);
      frames.push(response);
      handler?.(response);
    }),
  }, 1000);
  try {
    const result = await client.chunk('hash');
    expect(fromBase64(result.bytes!)).toEqual(bytes);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.map(frame => frame.offset)).toEqual(Array.from({ length: Math.ceil(CHUNK_SIZE / CHUNK_PART_BYTES) }, (_, i) => i * CHUNK_PART_BYTES));
    expect(new Set(frames.map(frame => frame.requestId)).size).toBe(1);
  } finally { client.close(); }
});

test('old clients still get whole chunks and new clients accept old responders', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const frames: any[] = [];
  await createContentResponder({ store: { getManifest: () => null, getChunk: () => bytes } })({ t: 'CHUNK_REQ', hash: 'hash' }, message => { frames.push(message); });
  expect(frames).toEqual([{ t: 'CHUNK', hash: 'hash', bytes: toBase64(bytes) }]);
  let handler: any;
  const client = createChannelClient({ setHandler: value => { handler = value; }, send: () => handler(frames[0]) }, 1000);
  try { expect(await client.chunk('hash')).toEqual(frames[0]); }
  finally { client.close(); }
});

test('interleaved same-hash downloads remain correlated to their own requests', async () => {
  const handlers = new Set<any>();
  const requests: any[] = [];
  const clients = Array.from({ length: 2 }, () => {
    let handler: any;
    return createChannelClient({
      setHandler: value => { handlers.delete(handler); handler = value; if (value) handlers.add(value); },
      send: request => { requests.push(request); },
    }, 1000);
  });
  const pending = clients.map(client => client.chunk('hash'));
  const publish = (message: any) => { for (const handler of handlers) handler(message); };
  try {
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
    for (const offset of [0, CHUNK_PART_BYTES]) for (const [index, request] of requests.entries()) {
      publish({ t: 'CHUNK', hash: 'hash', requestId: request.requestId, offset, size: CHUNK_PART_BYTES + 1,
        bytes: toBase64(new Uint8Array(offset ? 1 : CHUNK_PART_BYTES).fill(index + 1)) });
    }
    const results = await Promise.all(pending);
    results.forEach((result, index) => expect(fromBase64(result.bytes!)).toEqual(new Uint8Array(CHUNK_PART_BYTES + 1).fill(index + 1)));
  } finally { clients.forEach(client => client.close()); }
});

test('part size, order and total are bounded before retaining remote bytes', async () => {
  for (const defect of ['oversize', 'order', 'changed-total', 'short-part', 'oversize-part']) {
    let handler: any;
    let request: any;
    const client = createChannelClient({ setHandler: value => { handler = value; }, send: value => { request = value; } }, 1000);
    const result = client.chunk('hash').catch(error => error);
    const first = { t: 'CHUNK', hash: 'hash', requestId: request.requestId, offset: 0,
      size: CHUNK_PART_BYTES + 1, bytes: toBase64(new Uint8Array(CHUNK_PART_BYTES)) };
    try {
      if (defect === 'oversize') handler({ ...first, size: CHUNK_SIZE + 1 });
      if (defect === 'order') handler({ ...first, offset: CHUNK_PART_BYTES });
      if (defect === 'short-part') handler({ ...first, bytes: toBase64(new Uint8Array(1)) });
      if (defect === 'oversize-part') handler({ ...first, bytes: toBase64(new Uint8Array(CHUNK_PART_BYTES + 1)) });
      if (defect === 'changed-total') {
        handler(first);
        handler({ ...first, offset: CHUNK_PART_BYTES, size: CHUNK_PART_BYTES + 2, bytes: toBase64(new Uint8Array(2)) });
      }
      expect(await result).toBeInstanceOf(Error);
    } finally { client.close(); }
  }
});

test('a stalled partial chunk times out and link closure cancels partial state', async () => {
  for (const stop of ['timeout', 'close']) {
    let handler: any;
    const client = createChannelClient({ setHandler: value => { handler = value; }, send: request => {
      handler({ t: 'CHUNK', hash: request.hash, requestId: request.requestId, offset: 0,
        size: CHUNK_SIZE, bytes: toBase64(new Uint8Array(CHUNK_PART_BYTES)) });
    } }, 10);
    const result = client.chunk('hash').catch(error => error);
    if (stop === 'close') client.close();
    expect((await result).message).toContain(stop === 'close' ? 'closed' : 'timeout');
    client.close();
  }
});

test('valid chunk progress renews the idle deadline without weakening stalled-part failure', async () => {
  const clock = transferClock();
  let handler: any;
  let request: any;
  const bytes = new Uint8Array(CHUNK_PART_BYTES * 2 + 1).fill(7);
  const client = createChannelClient({
    setHandler: value => { handler = value; },
    send: value => { request = value; },
  }, 20, clock.timers);
  const result = client.chunk('hash');
  try {
    // Let the send receipt arm the response deadline before advancing time.
    await Promise.resolve();
    for (const offset of [0, CHUNK_PART_BYTES, CHUNK_PART_BYTES * 2]) {
      clock.advance(12);
      const length = Math.min(CHUNK_PART_BYTES, bytes.length - offset);
      handler({ t: 'CHUNK', hash: 'hash', requestId: request.requestId, offset,
        size: bytes.length, bytes: toBase64(bytes.subarray(offset, offset + length)) });
    }
    expect(fromBase64((await result).bytes!)).toEqual(bytes);
  } finally { client.close(); expect(clock.pending()).toBe(0); }
});

test('progress on a shared ordered channel keeps a queued chunk request alive', async () => {
  const clock = transferClock();
  let handler: any;
  const requests = new Map<string, any>();
  const client = createChannelClient({
    setHandler: value => { handler = value; },
    send: value => { requests.set(value.hash, value); },
  }, 20, clock.timers);
  const first = client.chunk('first');
  const second = client.chunk('second');
  try {
    // Let the send receipt arm the response deadline before advancing time.
    await Promise.resolve();
    clock.advance(12);
    handler({ t: 'CHUNK', hash: 'first', requestId: requests.get('first').requestId, offset: 0,
      size: CHUNK_PART_BYTES + 1, bytes: toBase64(new Uint8Array(CHUNK_PART_BYTES)) });
    clock.advance(12);
    handler({ t: 'CHUNK', hash: 'first', requestId: requests.get('first').requestId, offset: CHUNK_PART_BYTES,
      size: CHUNK_PART_BYTES + 1, bytes: toBase64(new Uint8Array(1)) });
    clock.advance(12);
    handler({ t: 'CHUNK', hash: 'second', requestId: requests.get('second').requestId, offset: 0,
      size: 1, bytes: toBase64(new Uint8Array([2])) });
    expect(fromBase64((await first).bytes!).length).toBe(CHUNK_PART_BYTES + 1);
    expect(fromBase64((await second).bytes!)).toEqual(new Uint8Array([2]));
  } finally { client.close(); expect(clock.pending()).toBe(0); }
});

const transferClock = () => {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number, run: () => void }>();
  return {
    timers: {
      setTimeout: ((run: () => void, delay: number) => {
        const id = ++next;
        pending.set(id, { at: now + delay, run });
        return id;
      }) as unknown as typeof setTimeout,
      clearTimeout: ((id: number) => { pending.delete(id); }) as unknown as typeof clearTimeout,
    },
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const due = [...pending].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        pending.delete(due[0]);
        due[1].run();
      }
      now = end;
    },
    pending: () => pending.size,
  };
};

test('unrelated chunk progress cannot replace the unsent request deadline', async () => {
  const clock = transferClock();
  let handler: any;
  const requests = new Map<string, any>();
  const client = createChannelClient({
    setHandler: value => { handler = value; },
    send: request => {
      requests.set(request.hash, request);
      return request.hash === 'unsent' ? new Promise<void>(() => {}) : undefined;
    },
  }, 20_000, clock.timers);
  const queued = client.chunk('unsent').catch(error => error);
  const active = client.chunk('active').catch(error => error);
  try {
    await Promise.resolve();
    clock.advance(14_000);
    handler({ t: 'CHUNK', hash: 'active', requestId: requests.get('active').requestId,
      offset: 0, size: CHUNK_SIZE, bytes: toBase64(new Uint8Array(CHUNK_PART_BYTES)) });
    clock.advance(1_000);
    // Closing settles any erroneously retained request, so a regression fails
    // the assertion instead of hanging the test.
    client.close();
    expect((await queued).message).toBe('content send timed out');
    await active;
    expect(clock.pending()).toBe(0);
  } finally { client.close(); }
});

test('a provider serving other chunks cannot pin a permanently missing chunk', async () => {
  const clock = transferClock();
  let handler: any;
  const requests = new Map<string, any>();
  const client = createChannelClient({
    setHandler: value => { handler = value; },
    send: request => { requests.set(request.hash, request); },
  }, 100, clock.timers);
  const missing = client.chunk('missing').catch(error => error);
  try {
    await Promise.resolve();
    for (let index = 0; index < 40; index++) {
      const hash = `available-${index}`;
      const result = client.chunk(hash);
      await Promise.resolve();
      clock.advance(50);
      handler({ t: 'CHUNK', hash, requestId: requests.get(hash).requestId,
        offset: 0, size: 1, bytes: toBase64(new Uint8Array([1])) });
      await result;
    }
    client.close();
    expect((await missing).message).toBe('transfer lifetime exceeded');
    expect(clock.pending()).toBe(0);
  } finally { client.close(); }
});

test('malformed correlated parts do not renew other response deadlines', async () => {
  const clock = transferClock();
  let handler: any;
  const requests = new Map<string, any>();
  const client = createChannelClient({
    setHandler: value => { handler = value; },
    send: request => { requests.set(request.hash, request); },
  }, 100, clock.timers);
  const waiting = client.chunk('waiting').catch(error => error);
  const invalid = client.chunk('invalid').catch(error => error);
  try {
    await Promise.resolve();
    clock.advance(90);
    handler({ t: 'CHUNK', hash: 'invalid', requestId: requests.get('invalid').requestId,
      offset: 1, size: 1, bytes: toBase64(new Uint8Array([1])) });
    clock.advance(10);
    client.close();
    expect((await waiting).message).toBe('transfer timeout');
    expect((await invalid).message).toBe('invalid chunk part bounds');
    expect(clock.pending()).toBe(0);
  } finally { client.close(); }
});
