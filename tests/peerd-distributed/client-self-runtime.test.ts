import { describe, expect, test } from 'bun:test';
import { createDwebClient } from '../../extension/peerd-distributed/client.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';

describe('live dweb client self-device boundary', () => {
  test('exposes every operation the offscreen self-device host calls', () => {
    const client = createDwebClient() as any;
    for (const operation of [
      'createSelfDeviceCoordinator',
      'createSelfDeviceMesh',
      'createSyncSource',
      'createSyncReceiver',
      'loadCoordinatorInputs',
    ]) {
      expect(typeof client[operation], operation).toBe('function');
    }
  });

  test('starts the base host while its bootstrap rendezvous is offline', async () => {
    const client = createDwebClient() as any;
    const identity = await generateIdentity();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const host = await Promise.race([
        client.joinBaseNetwork({
          identity,
          // Port 1 is intentionally unavailable on the CI runner. A strict
          // rendezvous join would wait for the signaling timeout here.
          url: 'ws://127.0.0.1:1/rendezvous',
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('base host waited on bootstrap')), 1_000);
        }),
      ]) as any;
      expect(host.base.did).toBe(identity.did);
      expect(host.room.rendezvous()).toBe('connecting');
      host.close();
    } finally {
      clearTimeout(timer);
    }
  });
});
