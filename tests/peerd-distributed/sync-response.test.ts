import { expect, test } from 'bun:test';
import { sendSyncResponse, syncResponsePages } from '../../extension/peerd-distributed/gossip/sync-response.js';
import { createBufferedChannel } from '../../extension/peerd-distributed/transport/channel.js';
import { createOutgoingGovernor, createOutgoingWriter } from '../../extension/peerd-distributed/transport/outgoing.js';
import { buildEnvelope, signEnvelope, verifyEnvelope } from '../../extension/peerd-distributed/transport/envelope.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';

// Page-builder checks only; end-to-end processing ACK pacing is covered by
// sync-response.integration.test.ts with two real topic-sync instances.
const sendPages = async (options: Parameters<typeof sendSyncResponse>[0]) => {
  for await (const frame of syncResponsePages(options)) {
    if (await options.send(frame) === false) throw new Error('sync response send failed');
  }
};

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test('whole signed responses respect a negotiated small frame cap and preserve all selected entries in order', async () => {
  const identity = await generateIdentity();
  let sequence = 0;
  const sign = (typ: number, body: any) => signEnvelope(buildEnvelope({
    ch: 4, typ, from: identity.did, body, ts: 1, id: `frame:${sequence++}`,
  }), identity);
  const envs = await Promise.all(Array.from({ length: 20 }, (_, i) => sign(0, { topic: 'feed', data: `${i}:${'π'.repeat(200)}` })));
  const sent: any[] = [];
  const dc = Object.assign(new EventTarget(), {
    readyState: 'open', bufferedAmount: 0, bufferedAmountLowThreshold: 0,
    send(encoded: string) { expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(1800); sent.push(JSON.parse(encoded)); },
  });
  const writer = createOutgoingWriter({ dc: dc as any, governor: createOutgoingGovernor(), maxMessageSize: () => 1800 });
  const channel = createBufferedChannel({ send: writer.send, maxFrameBytes: writer.maxFrameBytes, close: writer.close });
  await sendPages({ topic: 'feed', envs, current: () => !channel.isClosed(), maxFrameBytes: channel.maxFrameBytes,
    sign: (body) => sign(3, body), send: channel.send });
  expect(sent.length).toBeGreaterThan(1);
  expect(sent.flatMap((frame) => frame.body.envs)).toEqual(envs);
  for (const frame of sent) expect(await verifyEnvelope(frame)).toBe(true);
  channel.close();
  expect(channel.maxFrameBytes()).toBe(0);
});

test('effective cap follows negotiated changes and shares the exact writer enforcement', async () => {
  let negotiated = 90;
  const dc = Object.assign(new EventTarget(), { readyState: 'open', bufferedAmount: 0, send() {} });
  const writer = createOutgoingWriter({ dc: dc as any, governor: createOutgoingGovernor(), maxMessageSize: () => negotiated });
  expect(writer.maxFrameBytes()).toBe(90);
  negotiated = 40;
  expect(writer.maxFrameBytes()).toBe(40);
  await expect(writer.send('x'.repeat(39))).rejects.toThrow('frame too large');
  negotiated = 0; // SCTP zero means no negotiated maximum; local policy still applies.
  expect(writer.maxFrameBytes()).toBe(1_000_000);
  writer.close();
});

test('response continuation waits for send completion and stops when that carrier retires', async () => {
  const blocked = gate();
  const entered = gate();
  let current = true;
  let signs = 0;
  const sent: any[] = [];
  const pending = sendPages({ topic: 'feed', envs: Array.from({ length: 4 }, (_, i) => ({ i, data: 'x'.repeat(60) })),
    current: () => current, maxFrameBytes: () => 130,
    sign: async (body) => { signs++; return { body }; },
    send: async (frame) => { sent.push(frame); entered.resolve(); await blocked.promise; return true; } });
  await entered.promise;
  const before = signs;
  await Promise.resolve();
  expect(sent).toHaveLength(1);
  expect(signs).toBe(before);
  current = false;
  blocked.resolve();
  await pending;
  expect(sent).toHaveLength(1);
});

test('retirement during signing prevents sends and a failed send never starts the next page', async () => {
  let current = true;
  let sends = 0;
  const options = { topic: 'feed', envs: [{ data: 'x'.repeat(60) }, { data: 'y'.repeat(60) }],
    current: () => current, maxFrameBytes: () => 130,
    sign: async (body: any) => { current = false; return { body }; },
    send: async () => { sends++; return true; } };
  await sendPages(options);
  expect(sends).toBe(0);
  current = true;
  await expect(sendPages({ ...options, sign: async (body) => ({ body }),
    send: async () => { sends++; return false; } })).rejects.toThrow('send failed');
  expect(sends).toBe(1);
});

test('header overhead has a finite split fallback; an unrepresentable entry fails without sending it', async () => {
  let signs = 0;
  let sends = 0;
  await expect(sendPages({ topic: 'feed', envs: [{ data: 1 }, { data: 2 }], current: () => true,
    maxFrameBytes: () => 80, sign: async (body) => { signs++; return { body, header: 'x'.repeat(100) }; },
    send: async () => { sends++; } })).rejects.toThrow('entry exceeds frame limit');
  expect(signs).toBe(2);
  expect(sends).toBe(0);
  await expect(sendPages({ topic: 'feed', envs: new Array(257).fill(null), current: () => true,
    maxFrameBytes: () => 80, sign: async () => { signs++; }, send: async () => {} })).rejects.toThrow('entry limit');
  expect(signs).toBe(2);
});


test('legacy response remains one frame and refuses oversized history without paging', async () => {
  let signs = 0;
  const sent: any[] = [];
  const options = { topic: 'feed', current: () => true, maxFrameBytes: () => 130,
    sign: async (body: any) => { signs++; return { body }; }, send: async (env: any) => { sent.push(env); } };
  await sendSyncResponse({ ...options, envs: [{ data: 'x'.repeat(40) }] });
  expect(sent).toHaveLength(1);
  await expect(sendSyncResponse({ ...options, envs: [{ data: 'x'.repeat(80) }, { data: 'y'.repeat(80) }] }))
    .rejects.toThrow('requires window capability');
  expect(signs).toBe(1);
  expect(sent).toHaveLength(1);
});
