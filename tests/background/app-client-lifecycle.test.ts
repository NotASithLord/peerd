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

  test('Git cleanup failure preserves App metadata and fails deletion', async () => {
    let deletedMetadata = false;
    let closedTab = false;
    const client = createAppClient({
      registry: {
        get: async () => ({ id: 'app-1' }),
        delete: async () => { deletedMetadata = true; },
      } as any,
      tracker: {
        closeTab: async () => { closedTab = true; return true; },
      } as any,
      repositories: {
        coordinate: async (_ref: unknown, operation: () => Promise<unknown>) => operation(),
        destroyApp: async () => { throw new Error('gitdir cleanup failed'); },
      } as any,
    });

    await expect(client.delete('app-1')).rejects.toThrow('gitdir cleanup failed');
    expect(closedTab).toBe(true);
    expect(deletedMetadata).toBe(false);
  });

  test('deletion source removes Git before worktree and catalog metadata', async () => {
    const source = await Bun.file('./extension/background/app-client.js').text();
    const body = source.slice(source.indexOf('const deleteApp = async'));
    expect(body.indexOf('repositories?.destroyApp?.(appId)')).toBeGreaterThan(-1);
    expect(body.indexOf('guardedOpfsForApp(appId).nuke()'))
      .toBeGreaterThan(body.indexOf('repositories?.destroyApp?.(appId)'));
    expect(body.indexOf('registry.delete(appId)'))
      .toBeGreaterThan(body.indexOf('guardedOpfsForApp(appId).nuke()'));
  });
});
