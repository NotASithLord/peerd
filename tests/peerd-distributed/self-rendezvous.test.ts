// Private rendezvous derivation — the issue's §5 properties, each as a
// test: only secret-holders can compute a topic, topics don't correlate
// with the did, epochs rotate, the skew window is bounded, and rotating the
// secret changes every topic while the did stands still.

import { describe, test, expect } from 'bun:test';
import {
  deriveRendezvousTopic, rendezvousWindow, epochIndexFor, mintDiscoverySecret,
  SELF_RENDEZVOUS_DOMAIN, ENROLL_RENDEZVOUS_DOMAIN,
  RENDEZVOUS_EPOCH_MS, DISCOVERY_SECRET_BYTES,
} from '../../extension/peerd-distributed/self/rendezvous.js';

describe('rendezvous derivation', () => {
  test('deterministic per (secret, epoch, domain) — two devices meet', async () => {
    const secret = mintDiscoverySecret();
    const desktop = await deriveRendezvousTopic(secret, 1234);
    const laptop = await deriveRendezvousTopic(secret, 1234);
    expect(desktop).toBe(laptop);
    expect(desktop).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a different secret yields an unrelated topic (observers learn nothing)', async () => {
    const topicA = await deriveRendezvousTopic(mintDiscoverySecret(), 1234);
    const topicB = await deriveRendezvousTopic(mintDiscoverySecret(), 1234);
    expect(topicA).not.toBe(topicB);
  });

  test('the derivation consumes ONLY the secret — no did input exists to correlate', async () => {
    // Structural property: the function signature admits no identity
    // material. Two "people" with the same secret bytes (impossible in
    // practice, illustrative here) get the same topic regardless of did —
    // the topic is a pure function of (secret, domain, epoch).
    const secret = new Uint8Array(DISCOVERY_SECRET_BYTES).fill(7);
    expect(await deriveRendezvousTopic(secret, 5))
      .toBe(await deriveRendezvousTopic(secret.slice(), 5));
  });

  test('epochs rotate the topic', async () => {
    const secret = mintDiscoverySecret();
    expect(await deriveRendezvousTopic(secret, 100))
      .not.toBe(await deriveRendezvousTopic(secret, 101));
  });

  test('domains separate: the enroll space never collides with the self space', async () => {
    const secret = mintDiscoverySecret();
    expect(await deriveRendezvousTopic(secret, 9, SELF_RENDEZVOUS_DOMAIN))
      .not.toBe(await deriveRendezvousTopic(secret, 9, ENROLL_RENDEZVOUS_DOMAIN));
  });

  test('the skew window covers ±skew epochs and is bounded', async () => {
    const secret = mintDiscoverySecret();
    const now = 100 * RENDEZVOUS_EPOCH_MS + 5;
    const window = await rendezvousWindow(secret, { now, skew: 1 });
    expect(window.map((w) => w.epochIndex)).toEqual([99, 100, 101]);
    // A dialer inside the window (clock drift of one epoch) still meets a
    // listener: its CURRENT topic appears in the listener's window.
    const driftedDialer = await deriveRendezvousTopic(secret, epochIndexFor(now - RENDEZVOUS_EPOCH_MS));
    expect(window.some((w) => w.topic === driftedDialer)).toBe(true);
    await expect(rendezvousWindow(secret, { now, skew: 3 })).rejects.toThrow(/skew window/);
    // Near time zero the window clamps instead of deriving negative epochs.
    const early = await rendezvousWindow(secret, { now: 5, skew: 1 });
    expect(early.map((w) => w.epochIndex)).toEqual([0, 1]);
  });

  test('rotating the discovery secret moves every topic (did unchanged by construction)', async () => {
    const oldSecret = mintDiscoverySecret();
    const newSecret = mintDiscoverySecret();
    for (const epoch of [1, 2, 3]) {
      expect(await deriveRendezvousTopic(oldSecret, epoch))
        .not.toBe(await deriveRendezvousTopic(newSecret, epoch));
    }
  });

  test('bounds: secret size and epoch index are validated', async () => {
    await expect(deriveRendezvousTopic(new Uint8Array(16), 1)).rejects.toThrow(/32 bytes/);
    await expect(deriveRendezvousTopic(mintDiscoverySecret(), -1)).rejects.toThrow(/non-negative/);
    await expect(deriveRendezvousTopic(mintDiscoverySecret(), 1.5)).rejects.toThrow(/non-negative integer/);
  });
});
