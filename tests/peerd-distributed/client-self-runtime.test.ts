import { describe, expect, test } from 'bun:test';
import { createDwebClient } from '../../extension/peerd-distributed/client.js';

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
});
