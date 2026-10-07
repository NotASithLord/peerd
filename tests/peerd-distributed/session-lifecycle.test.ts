import { expect, test } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { buildEnvelope, signEnvelope } from '../../extension/peerd-distributed/transport/envelope.js';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

test('HELLO resolves both peers even when remote verification wins before local signing', async () => {
  const [a, b] = await Promise.all([generateIdentity(), generateIdentity()]);
  const [ca, cb] = memoryPair();
  const signing = gate();
  const started = gate();
  const delayed = { did: a.did, sign: async (bytes: Uint8Array) => {
    started.release(); await signing.promise; return a.sign(bytes);
  } };
  const pa = createSession({ channel: ca, identity: delayed });
  const pb = createSession({ channel: cb, identity: b });
  await started.promise;
  ca.deliver({ t: 'early-content' });
  signing.release();
  expect(await pa).toEqual({ remoteDid: b.did });
  expect(await pb).toEqual({ remoteDid: a.did });
  const received: any[] = [];
  ca.setHandler((msg) => received.push(msg));
  expect(received).toEqual([{ t: 'early-content' }]);
  ca.close();
});

test('closing during HELLO rejects promptly, including an already closed pipe', async () => {
  const identity = await generateIdentity();
  const [a, b] = memoryPair();
  const pending = createSession({ channel: a, identity });
  const failed = pending.catch((error) => error.message);
  b.close();
  expect(await failed).toContain('closed during HELLO');
  await expect(createSession({ channel: a, identity })).rejects.toThrow('closed during HELLO');
});

test('silent HELLO times out and closes its transport', async () => {
  const identity = await generateIdentity();
  const [a] = memoryPair();
  await expect(createSession({ channel: a, identity, timeoutMs: 10 })).rejects.toThrow('HELLO timed out');
  expect(a.isClosed()).toBe(true);
});

test('abort while local signing stalls settles immediately and fences the late send', async () => {
  const identity = await generateIdentity();
  const [a, b] = memoryPair();
  const signing = gate();
  const signed = gate();
  const ac = new AbortController();
  let sent = 0;
  b.setHandler(() => { sent++; });
  const delayed = { did: identity.did, sign: async (bytes: Uint8Array) => {
    await signing.promise; const result = await identity.sign(bytes); signed.release(); return result;
  } };
  const pending = createSession({ channel: a, identity: delayed, signal: ac.signal });
  const failed = pending.catch((error) => error.message);
  ac.abort(); expect(await failed).toContain('HELLO cancelled');
  signing.release(); await signed.promise;
  await Promise.resolve();
  expect(sent).toBe(0);
  expect(a.isClosed()).toBe(true);
});

test('unauthenticated early frames cannot grow the handoff stash without bound', async () => {
  const identity = await generateIdentity();
  const [a] = memoryPair();
  const pending = createSession({ channel: a, identity });
  const failed = pending.catch((error) => error.message);
  for (let i = 0; i < 17; i++) a.deliver({ i });
  expect(await failed).toContain('backlog exceeded');
  expect(a.isClosed()).toBe(true);
});

test('duplicate HELLO bursts start only one verification candidate', async () => {
  const identity = await generateIdentity();
  const [a] = memoryPair();
  const pending = createSession({ channel: a, identity });
  const failed = pending.catch((error) => error.message);
  let reads = 0;
  const hello = { __t: 'HELLO', get env() {
    reads++; return { v: 1, ch: 0, typ: 0, from: identity.did, sig: 'invalid', body: { proto: 2, caps: [] }, id: crypto.randomUUID(), ts: 0 };
  } };
  for (let i = 0; i < 100; i++) a.deliver(hello);
  expect(reads).toBe(1);
  expect(await failed).toContain('signature invalid');
});

test('a valid signature on the wrong control frame cannot authenticate HELLO', async () => {
  const identity = await generateIdentity();
  const [a] = memoryPair();
  const env = await signEnvelope(buildEnvelope({ ch: 3, typ: 0, from: identity.did,
    body: { proto: 2, caps: [] }, id: crypto.randomUUID(), ts: 0 }), identity);
  const pending = createSession({ channel: a, identity });
  const failed = pending.catch((error) => error.message);
  a.deliver({ __t: 'HELLO', env });
  expect(await failed).toContain('invalid peer HELLO envelope');
});

test('terminal HELLO diagnostics are fixed-size, secret-free and preserve cancellation', async () => {
  const identity = await generateIdentity();
  const [a] = memoryPair();
  const ac = new AbortController();
  const pending = createSession({ channel: a, identity, signal: ac.signal });
  const failed = pending.catch(error => error);
  a.deliver({ secret: 'DO-NOT-RETAIN', body: 'private application payload' });
  ac.abort();
  const error = await failed;
  expect(error.message).toBe('peer HELLO cancelled');
  expect(a.isClosed()).toBe(true);
  expect(Object.keys(error.helloProgress).sort()).toEqual([
    'helloReceived', 'helloSent', 'proofReceived', 'proofSent',
    'stashedBytes', 'stashedFrames', 'verifyingHello', 'verifyingProof',
  ]);
  expect(error.helloProgress.stashedFrames).toBe(1);
  expect(Object.isFrozen(error.helloProgress)).toBe(true);
  const encoded = JSON.stringify(error.helloProgress);
  expect(encoded.length).toBeLessThan(256);
  expect(encoded).not.toContain('DO-NOT-RETAIN');
  expect(encoded).not.toContain(identity.did);
});

test('a frozen signing failure keeps its original rejection even when diagnostics cannot attach', async () => {
  const identity = await generateIdentity();
  const [a] = memoryPair();
  const error = Object.freeze(new Error('signer unavailable'));
  const result = createSession({ channel: a, identity: { did: identity.did,
    sign: async () => { throw error; } } });
  expect(await result.catch(cause => cause)).toBe(error);
  expect(a.isClosed()).toBe(true);
});
