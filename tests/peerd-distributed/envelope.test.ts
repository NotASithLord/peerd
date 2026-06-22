import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import {
  buildEnvelope,
  signEnvelope,
  verifyEnvelope,
} from '../../extension/peerd-distributed/transport/envelope.js';

describe('signed envelopes', () => {
  test('sign then verify succeeds with the signer did', async () => {
    const id = await generateIdentity();
    const env = await signEnvelope(
      buildEnvelope({ ch: 0, typ: 0, from: id.did, body: { proto: 1 }, id: 'x', ts: 1 }),
      id,
    );
    expect(env.from).toBe(id.did);
    expect(await verifyEnvelope(env)).toBe(true);
  });

  test('detects a tampered body', async () => {
    const id = await generateIdentity();
    const env = await signEnvelope(
      buildEnvelope({ ch: 0, typ: 0, from: id.did, body: { proto: 1 }, id: 'x', ts: 1 }),
      id,
    );
    env.body.proto = 2;
    expect(await verifyEnvelope(env)).toBe(false);
  });

  test('rejects a signature that belongs to a different identity', async () => {
    const a = await generateIdentity();
    const b = await generateIdentity();
    const env = await signEnvelope(
      buildEnvelope({ ch: 0, typ: 0, from: a.did, body: {}, id: 'x', ts: 1 }),
      a,
    );
    env.from = b.did; // claim to be B while signed by A
    expect(await verifyEnvelope(env)).toBe(false);
  });
});
