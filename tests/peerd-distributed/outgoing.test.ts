import { expect, test } from 'bun:test';
import { createOutgoingGovernor, createOutgoingWriter, SendError } from '../../extension/peerd-distributed/transport/outgoing.js';

class DataChannel extends EventTarget {
  readyState = 'open'; bufferedAmount = 0; bufferedAmountLowThreshold = 0;
  sent: any[] = [];
  send(encoded: string) { this.bufferedAmount += Buffer.byteLength(encoded); this.sent.push(JSON.parse(encoded)); }
  drain(bytes = Infinity) {
    const before = this.bufferedAmount;
    this.bufferedAmount = Math.max(0, before - bytes);
    if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatchEvent(new Event('bufferedamountlow'));
  }
}
const limits = { frameBytes: 100, nativeBytes: 100, linkBytes: 600, realmBytes: 1000,
  controlBytes: 100, reservedBytes: 100, linkFrames: 20, realmFrames: 30, reservedFrames: 2 };
const make = (governor = createOutgoingGovernor(limits)) => {
  const dc = new DataChannel();
  const writer = createOutgoingWriter({ dc: dc as any, governor });
  return { dc, writer, governor };
};

test('largest permitted frame wakes only when enough native capacity exists', async () => {
  const { dc, writer } = make();
  dc.bufferedAmount = 100;
  const sent = writer.send('x'.repeat(98)); // JSON quotes make precisely one native window
  expect(dc.sent).toHaveLength(0);
  dc.drain(75);
  expect(dc.sent).toHaveLength(0);
  dc.drain();
  await sent;
  expect(dc.sent).toEqual(['x'.repeat(98)]);
  writer.close();
});

test('control overtakes queued bulk but continuous control cannot starve bulk', async () => {
  const { dc, writer } = make();
  dc.bufferedAmount = 100;
  const pending = [writer.send({ bulk: 1 }), writer.send({ bulk: 2 })];
  for (let n = 0; n < 6; n++) pending.push(writer.send({ control: n }, { priority: 'control' }));
  dc.drain(); dc.drain(); dc.drain();
  await Promise.all(pending);
  expect(dc.sent.slice(0, 5)).toEqual([{ control: 0 }, { control: 1 }, { control: 2 }, { control: 3 }, { bulk: 1 }]);
  expect(dc.sent.filter(m => m.bulk).map(m => m.bulk)).toEqual([1, 2]);
  writer.close();
});

test('realm/per-link queues reject overload explicitly and retain reserved control capacity', async () => {
  const governor = createOutgoingGovernor({ ...limits, realmBytes: 300, linkBytes: 300, reservedBytes: 40 });
  const a = make(governor); const b = make(governor);
  a.dc.bufferedAmount = 100; b.dc.bufferedAmount = 100;
  const pending = a.writer.send('a'.repeat(38)).catch(e => e); // 240 realm bytes
  const overflow = await b.writer.send('b'.repeat(38)).catch(e => e);
  expect(overflow).toBeInstanceOf(SendError);
  expect(overflow.reason).toBe('overloaded');
  const control = b.writer.send({ ping: 1 }, { priority: 'control' });
  expect(governor.stats().bytes).toBeLessThanOrEqual(300);
  a.dc.drain(); b.dc.drain();
  await Promise.all([pending, control]);
  a.writer.close(); b.writer.close();
  expect(governor.stats()).toEqual({ bytes: 0, frames: 0 });
});

test('cancellation releases bytes, stale drain cannot send it, and close rejects every queued send', async () => {
  const { dc, writer, governor } = make(); dc.bufferedAmount = 100;
  const ac = new AbortController();
  const cancelled = writer.send({ id: 'cancel' }, { signal: ac.signal }).catch(e => e);
  const closed = writer.send({ id: 'close' }).catch(e => e);
  ac.abort();
  expect((await cancelled).reason).toBe('cancelled');
  expect(governor.stats().frames).toBe(1);
  writer.close();
  expect((await closed).reason).toBe('closed');
  dc.drain();
  expect(dc.sent).toHaveLength(0);
  expect(governor.stats()).toEqual({ bytes: 0, frames: 0 });
});

test('queued encoded frame is immutable and native send exceptions reject their owner', async () => {
  const { dc, writer } = make(); dc.bufferedAmount = 100;
  const input = { value: 'original' };
  const pending = writer.send(input);
  input.value = 'mutated';
  dc.drain(); await pending;
  expect(dc.sent).toEqual([{ value: 'original' }]);
  dc.send = () => { throw new Error('native failure'); };
  await expect(writer.send({ value: 'error' })).rejects.toThrow('native failure');
  writer.close();
});


test('drain racing watermark installation cannot strand a queued frame', async () => {
  const { dc, writer } = make();
  dc.bufferedAmount = 100;
  let threshold = 0;
  Object.defineProperty(dc, 'bufferedAmountLowThreshold', {
    get: () => threshold,
    set: (value) => { threshold = value; dc.bufferedAmount = 0; },
  });
  const pending = writer.send({ race: true }).catch(error => error);
  try {
    expect(dc.sent).toEqual([{ race: true }]); // no bufferedamountlow event fired
    expect(await pending).toBeUndefined();
  } finally { writer.close(); }
});
