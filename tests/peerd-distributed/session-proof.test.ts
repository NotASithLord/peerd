import { expect, test } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { buildEnvelope, signEnvelope } from '../../extension/peerd-distributed/transport/envelope.js';

const identities = () => Promise.all([generateIdentity(), generateIdentity()]);

test('crossing HELLO and proof authenticate both endpoints with fresh transcripts', async () => {
  const [alice, bob] = await identities();
  const [a, b] = memoryPair();
  try {
    const [first, second] = await Promise.all([
      createSession({ channel: a, identity: alice }), createSession({ channel: b, identity: bob }),
    ]);
    expect(first.remoteDid).toBe(bob.did);
    expect(second.remoteDid).toBe(alice.did);
  } finally { a.close(); b.close(); }
});

test('recorded HELLO and proof cannot authenticate on a fresh channel', async () => {
  const [alice, bob] = await identities();
  const [a, b] = memoryPair();
  const recorded: any[] = [];
  const send = b.send;
  b.send = (message: any) => { recorded.push(structuredClone(message)); return send(message); };
  await Promise.all([createSession({ channel: a, identity: alice }), createSession({ channel: b, identity: bob })]);
  a.close();
  expect(recorded.map((message) => message.__t)).toEqual(['HELLO', 'HELLO_PROOF']);
  const [fresh, replay] = memoryPair();
  try {
    const session = createSession({ channel: fresh, identity: alice }).catch((error: Error) => error);
    for (const message of recorded) replay.send(message);
    expect(await session).toMatchObject({ message: 'peer HELLO proof does not match this channel' });
  } finally { fresh.close(); replay.close(); }
});

test('a live bidirectional relay across distinct channels cannot forward proofs', async () => {
  const [alice, bob] = await identities();
  const [a, proxyA] = memoryPair();
  const [proxyB, b] = memoryPair();
  // Forward even fresh challenges and valid proofs unchanged. Only the locally
  // measured channel binding distinguishes this from a direct authenticated pipe.
  proxyA.setHandler((message: any) => proxyB.send(message));
  proxyB.setHandler((message: any) => proxyA.send(message));
  proxyA.onClose(() => proxyB.close());
  proxyB.onClose(() => proxyA.close());
  try {
    const results = await Promise.allSettled([
      createSession({ channel: a, identity: alice }), createSession({ channel: b, identity: bob }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(results.some((result) => result.status === 'rejected'
      && result.reason.message.includes('does not match this channel'))).toBe(true);
  } finally { a.close(); b.close(); }
});

test('legacy signed HELLO is rejected without a downgrade', async () => {
  const [alice, bob] = await identities();
  const [a, b] = memoryPair();
  try {
    const session = createSession({ channel: a, identity: alice }).catch((error: Error) => error);
    b.send({ __t: 'HELLO', env: await signEnvelope(buildEnvelope({ ch: 0, typ: 0, from: bob.did,
      body: { proto: 1, caps: [] }, id: crypto.randomUUID(), ts: Date.now() }), bob) });
    expect(await session).toMatchObject({ message: 'unsupported peer protocol: upgrade required (protocol 2)' });
    expect(a.isClosed()).toBe(true);
  } finally { a.close(); b.close(); }
});

test('missing transport binding cannot be replaced by a wire claim', async () => {
  const [alice] = await identities();
  const [a, b] = memoryPair();
  try {
    const unbound = { send: a.send, setHandler: a.setHandler, deliver: a.deliver, close: a.close, onClose: a.onClose };
    await expect(createSession({ channel: unbound, identity: alice })).rejects.toThrow('authenticated transport binding');
    expect(a.isClosed()).toBe(true);
  } finally { a.close(); b.close(); }
});

test('oversized unauthenticated handoff bytes are rejected before admission', async () => {
  const [alice] = await identities();
  const [a, b] = memoryPair();
  try {
    const session = createSession({ channel: a, identity: alice }).catch((error: Error) => error);
    b.send({ content: 'x'.repeat(1_048_577) });
    expect(await session).toMatchObject({ message: 'peer HELLO backlog exceeded' });
  } finally { a.close(); b.close(); }
});

// A peer with a real signing key can still offer a proof for a different
// connection. Construct correctly signed adversarial transcripts explicitly.
const manualPeer = async () => {
  const [alice, bob] = await identities();
  const [a, b] = memoryPair();
  let receive!: (message: any) => void;
  const firstHello = new Promise<any>((resolve) => { receive = resolve; });
  b.setHandler((message: any) => { if (message.__t === 'HELLO') receive(message.env); });
  const outcome = createSession({ channel: a, identity: alice }).catch((error: Error) => error);
  const localHello = await firstHello;
  const remoteHello = await signEnvelope(buildEnvelope({ ch: 0, typ: 0, from: bob.did,
    body: { proto: 2, caps: ['content'] }, id: crypto.randomUUID(), ts: Date.now() }), bob);
  const proof = async (mutate: (body: any) => void = () => {}) => {
    const body = { proto: 2, to: alice.did, hello: remoteHello.id, challenge: localHello.id,
      binding: { ...b.getSessionBinding()! } };
    mutate(body);
    return signEnvelope(buildEnvelope({ ch: 0, typ: 1, from: bob.did, body,
      id: crypto.randomUUID(), ts: Date.now() }), bob);
  };
  return { a, b, alice, bob, localHello, remoteHello, proof, outcome };
};

for (const field of ['to', 'hello', 'challenge', 'localFingerprint', 'remoteFingerprint', 'streamId'] as const) {
  test(`correctly signed proof with wrong ${field} cannot authenticate`, async () => {
    const peer = await manualPeer();
    try {
      peer.b.send({ __t: 'HELLO', env: peer.remoteHello });
      const env = await peer.proof((body) => {
        if (field === 'to') body.to = peer.bob.did;
        else if (field === 'hello' || field === 'challenge') body[field] = crypto.randomUUID();
        else if (field === 'streamId') body.binding.streamId = 7;
        else body.binding[field] = 'f'.repeat(64);
      });
      peer.b.send({ __t: 'HELLO_PROOF', env });
      expect(await peer.outcome).toMatchObject({ message: 'peer HELLO proof does not match this channel' });
    } finally { peer.a.close(); peer.b.close(); }
  });
}

test('a matching transcript with an invalid signature is rejected', async () => {
  const peer = await manualPeer();
  try {
    peer.b.send({ __t: 'HELLO', env: peer.remoteHello });
    const env = await peer.proof();
    env.sig = 'A'.repeat(88);
    peer.b.send({ __t: 'HELLO_PROOF', env });
    expect(await peer.outcome).toMatchObject({ message: 'peer HELLO proof signature invalid' });
  } finally { peer.a.close(); peer.b.close(); }
});

test('an early proof is retained once and verified after its HELLO', async () => {
  const peer = await manualPeer();
  try {
    const env = await peer.proof();
    let reads = 0;
    const frame = { __t: 'HELLO_PROOF', get env() { reads++; return env; } };
    for (let i = 0; i < 100; i++) peer.b.send(frame);
    expect(reads).toBe(1);
    peer.b.send({ __t: 'HELLO', env: peer.remoteHello });
    expect(await peer.outcome).toEqual({ remoteDid: peer.bob.did });
  } finally { peer.a.close(); peer.b.close(); }
});

test('verified transcript fields remain stable if sender-owned objects change', async () => {
  const peer = await manualPeer();
  try {
    const env = await peer.proof();
    peer.b.send({ __t: 'HELLO_PROOF', env });
    env.body.to = peer.bob.did;
    env.body.binding.localFingerprint = '0'.repeat(64);
    peer.b.send({ __t: 'HELLO', env: peer.remoteHello });
    peer.remoteHello.from = peer.alice.did;
    expect(await peer.outcome).toEqual({ remoteDid: peer.bob.did });
  } finally { peer.a.close(); peer.b.close(); }
});

test('a reflected local HELLO cannot become a remote challenge', async () => {
  const [identity] = await identities();
  const [a, b] = memoryPair();
  b.setHandler((message: any) => b.send(message));
  try {
    await expect(createSession({ channel: a, identity })).rejects.toThrow('reflected local challenge');
  } finally { a.close(); b.close(); }
});

test('oversized HELLO capabilities fail before signature verification', async () => {
  const peer = await manualPeer();
  try {
    peer.remoteHello.body.caps = Array.from({ length: 33 }, () => 'content');
    peer.b.send({ __t: 'HELLO', env: peer.remoteHello });
    expect(await peer.outcome).toMatchObject({ message: 'invalid peer HELLO envelope' });
  } finally { peer.a.close(); peer.b.close(); }
});

test('aborting during proof signing fences the late proof send', async () => {
  const [alice, bob] = await identities();
  const [a, b] = memoryPair();
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let signed!: () => void;
  const finished = new Promise<void>((resolve) => { signed = resolve; });
  let signs = 0;
  let proofs = 0;
  const ac = new AbortController();
  const delayed = { did: alice.did, sign: async (bytes: Uint8Array) => {
    if (++signs === 2) { start(); await blocked; const result = await alice.sign(bytes); signed(); return result; }
    return alice.sign(bytes);
  } };
  b.setHandler((message: any) => { if (message.__t === 'HELLO_PROOF') proofs++; });
  const outcome = createSession({ channel: a, identity: delayed, signal: ac.signal }).catch((error: Error) => error);
  try {
    b.send({ __t: 'HELLO', env: await signEnvelope(buildEnvelope({ ch: 0, typ: 0, from: bob.did,
      body: { proto: 2, caps: [] }, id: crypto.randomUUID(), ts: Date.now() }), bob) });
    await started;
    ac.abort();
    expect(await outcome).toMatchObject({ message: 'peer HELLO cancelled' });
    release(); await finished; await Promise.resolve(); await Promise.resolve();
    expect(proofs).toBe(0);
  } finally { release(); a.close(); b.close(); }
});

test('WebRTC-shaped bindings use the same reversed-fingerprint transcript', async () => {
  const [alice, bob] = await identities();
  const [a, b] = memoryPair();
  const bindA = a.getSessionBinding()!;
  const bindB = b.getSessionBinding()!;
  // This tests session proof semantics, not browser certificate extraction.
  a.getSessionBinding = () => ({ ...bindA, kind: 'webrtc-dtls-sha256', streamId: 12 });
  b.getSessionBinding = () => ({ ...bindB, kind: 'webrtc-dtls-sha256', streamId: 12 });
  try {
    const sessions = await Promise.all([createSession({ channel: a, identity: alice }), createSession({ channel: b, identity: bob })]);
    expect(sessions).toEqual([{ remoteDid: bob.did }, { remoteDid: alice.did }]);
  } finally { a.close(); b.close(); }
});

test('outbound proof objects cannot mutate the private transport binding', async () => {
  const peer = await manualPeer();
  let observed!: () => void;
  const sentProof = new Promise<void>((resolve) => { observed = resolve; });
  peer.b.setHandler((message: any) => {
    if (message.__t !== 'HELLO_PROOF') return;
    // A same-heap channel deliberately does not structured-clone messages.
    message.env.body.binding.localFingerprint = 'f'.repeat(64);
    observed();
  });
  try {
    peer.b.send({ __t: 'HELLO', env: peer.remoteHello });
    await sentProof;
    peer.b.send({ __t: 'HELLO_PROOF', env: await peer.proof() });
    expect(await peer.outcome).toEqual({ remoteDid: peer.bob.did });
  } finally { peer.a.close(); peer.b.close(); }
});
