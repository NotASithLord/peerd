import { describe, expect, test } from 'bun:test';
import { createAppClient } from '../../extension/background/app-client.js';
import { makeWriteGuard, StoreReadOnlyError } from '../../extension/peerd-runtime/lifecycle/write-guard.js';

const blockedAppGuard = (reason: string) => {
  const guard = makeWriteGuard();
  guard.block([{ store: 'app-manifests', reason }]);
  return () => guard.assertWritable('app-manifests');
};

describe('App OPFS lifecycle posture', () => {
  for (const reason of ['newer schema', 'malformed schema stamp']) {
    test(`${reason} refuses App bytes before opening OPFS`, async () => {
      let deletedMetadata = false;
      let closedTab = false;
      const client = createAppClient({
        registry: {
          get: async () => ({ id: 'app-1' }),
          delete: async () => { deletedMetadata = true; },
        } as any,
        tracker: {
          closeTab: async () => { closedTab = true; },
        } as any,
        beforeOpfsMutation: blockedAppGuard(reason),
      });

      await expect(client.opfsForApp('app-1').write('index.html', 'changed'))
        .rejects.toBeInstanceOf(StoreReadOnlyError);
      await expect(client.delete('app-1')).rejects.toBeInstanceOf(StoreReadOnlyError);

      // The guard is a preflight too. A blocked delete cannot close the live
      // App or erase its metadata after refusing the byte mutation.
      expect(closedTab).toBe(false);
      expect(deletedMetadata).toBe(false);
    });
  }
});
