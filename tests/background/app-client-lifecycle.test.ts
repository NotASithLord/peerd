import { describe, expect, test } from 'bun:test';
import {
  AppDefaultMissingError,
  createAppClient,
} from '../../extension/background/app-client.js';
import { makeWriteGuard, StoreReadOnlyError } from '../../extension/peerd-runtime/lifecycle/write-guard.js';

const blockedAppGuard = (reason: string) => {
  const guard = makeWriteGuard();
  guard.block([{ store: 'app-manifests', reason }]);
  return () => guard.assertWritable('app-manifests');
};

const testRepositories = (overrides: Record<string, unknown> = {}) => ({
  coordinate: async (_ref: unknown, operation: () => Promise<unknown>) => operation(),
  ...overrides,
});

describe('App OPFS lifecycle posture', () => {
  test('construction fails closed without repository coordination', () => {
    expect(() => createAppClient({ registry: {} as any, tracker: {} as any } as any))
      .toThrow('repositories.coordinate is required');
  });

  for (const operation of ['update', 'write', 'delete'] as const) {
    test(`Stop while ${operation} waits for the App lane prevents its first durable edge`, async () => {
      let enterLane!: () => void;
      let releaseLane!: () => void;
      const laneEntered = new Promise<void>((resolve) => { enterLane = resolve; });
      const laneGate = new Promise<void>((resolve) => { releaseLane = resolve; });
      const controller = new AbortController();
      let catalogWrites = 0;
      let byteWrites = 0;
      let byteDeletes = 0;
      let reloads = 0;
      const record = {
        id: 'app-1', name: 'work', tags: [], entryFile: 'index.html',
        fileKinds: { 'index.html': 'text', 'old.txt': 'text' },
      };
      const client = createAppClient({
        registry: {
          get: async () => record,
          update: async () => { catalogWrites += 1; return record; },
        } as any,
        tracker: {
          reloadTab: async () => { reloads += 1; return true; },
        } as any,
        repositories: {
          coordinate: async (_ref: unknown, action: () => Promise<unknown>) => {
            enterLane();
            await laneGate;
            return action();
          },
        } as any,
        opfsForApp: () => ({
          list: async () => [
            { path: '/index.html', size: 3 }, { path: '/old.txt', size: 3 },
          ],
          readBytes: async () => new TextEncoder().encode('old'),
          write: async () => { byteWrites += 1; },
          delete: async () => { byteDeletes += 1; },
        }) as any,
      });
      const pending = operation === 'update'
        ? client.update({ appId: 'app-1', html: 'new', signal: controller.signal })
        : operation === 'write'
          ? client.writeFile({
            appId: 'app-1', path: 'index.html', content: 'new', signal: controller.signal,
          })
          : client.deleteFile({
            appId: 'app-1', path: 'old.txt', signal: controller.signal,
          });

      await laneEntered;
      controller.abort('stopped');
      releaseLane();
      await expect(pending).rejects.toMatchObject({
        outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
      });
      expect({ catalogWrites, byteWrites, byteDeletes, reloads }).toEqual({
        catalogWrites: 0, byteWrites: 0, byteDeletes: 0, reloads: 0,
      });
    });
  }

  test('missing session default has a stable typed pre-read refusal', async () => {
    const client = createAppClient({
      registry: {
        getDefaultForSession: async () => null,
      } as any,
      tracker: {} as any,
      repositories: testRepositories() as any,
    });

    const failure = await client.readFile({ sessionId: 'session-a', path: 'notes.md' })
      .then(() => null, (cause) => cause);
    expect(failure).toBeInstanceOf(AppDefaultMissingError);
    expect(failure).toMatchObject({
      name: 'AppDefaultMissingError', code: 'app_default_missing',
    });
  });

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
        repositories: testRepositories() as any,
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
      repositories: testRepositories({
        destroyApp: async () => { throw new Error('gitdir cleanup failed'); },
      }) as any,
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

  test('snapshotFilesBase64 does not reject compressible v2 payloads using the legacy v1 container size', async () => {
    const source = await Bun.file('./extension/background/app-client.js').text();
    const start = source.indexOf('const snapshotFilesBase64 = async');
    const end = source.indexOf('const deleteFile = async', start);
    const body = source.slice(start, end);
    expect(body).not.toContain('packBundle');
    expect(body).not.toContain('MAX_NETWORK_BUNDLE_BYTES');
    expect(body).not.toContain('packedBytes');
    expect(body).toContain('return { ...snapshot, files }');
  });

  test('versioned replacement settles commit custody before success and rolls back on refusal', async () => {
    const events: string[] = [];
    const oldRecord = {
      id: 'app-1', name: 'Old', tags: [], entryFile: 'index.html',
      fileKinds: { 'index.html': 'text' }, dweb: { hash: 'old' },
    };
    let registryWrites = 0;
    const client = createAppClient({
      registry: {
        get: async () => oldRecord,
        update: async (_id: string, patch: any) => {
          registryWrites += 1;
          events.push(registryWrites === 1 ? 'metadata:new' : 'metadata:rollback');
          return { ...oldRecord, ...patch };
        },
      } as any,
      tracker: { reloadTab: async () => true } as any,
      repositories: testRepositories({
        replaceWorkingTree: async (_ref: any, args: any) => {
          events.push(args.message === 'rollback failed App release update'
            ? 'files:rollback' : 'files:new');
          return { oid: 'a'.repeat(40), created: true };
        },
      }) as any,
      opfsForApp: () => ({
        list: async () => [{ path: '/index.html', size: 3 }],
        readBytes: async () => new TextEncoder().encode('old'),
      }) as any,
      onManifestMutation: async () => { events.push('manifest'); },
    });
    await expect(client.replaceVersionedFilesUnlocked({
      appId: 'app-1', files: { 'index.html': 'new' }, entryFile: 'index.html',
      metadataForOid: () => ({
        dweb: { uri: 'dweb://app-1', publisher: 'did:key:test', hash: 'new' },
      }),
      afterCommit: async () => { events.push('after-commit'); throw new Error('commit refused'); },
    })).rejects.toThrow('commit refused');
    expect(events).toEqual([
      'files:new', 'metadata:new', 'manifest', 'after-commit',
      'files:rollback', 'metadata:rollback',
    ]);
  });

  test('failed version replacement records the rollback HEAD so a retry starts clean', async () => {
    const originalOid = 'a'.repeat(40);
    const failedOid = 'b'.repeat(40);
    const rollbackOid = 'c'.repeat(40);
    const retryOid = 'd'.repeat(40);
    let record: any = {
      id: 'app-1', name: 'Old', tags: [], entryFile: 'index.html',
      fileKinds: { 'index.html': 'text' },
      dweb: { git_oid: originalOid, source_git_oid: originalOid, version_id: 'v1' },
    };
    const seenBaselines: string[] = [];
    const repositoryOids = [failedOid, rollbackOid, retryOid];
    const client = createAppClient({
      registry: {
        get: async () => record,
        update: async (_id: string, patch: any) => {
          record = Object.hasOwn(patch, 'dwebExact')
            ? { ...record, ...patch, dweb: patch.dwebExact }
            : { ...record, ...patch };
          return record;
        },
      } as any,
      tracker: { reloadTab: async () => true } as any,
      repositories: testRepositories({
        replaceWorkingTree: async () => ({ oid: repositoryOids.shift(), created: true }),
      }) as any,
      opfsForApp: () => ({
        list: async () => [{ path: '/index.html', size: 3 }],
        readBytes: async () => new TextEncoder().encode('old'),
      }) as any,
    });
    const replacement = {
      appId: 'app-1', files: { 'index.html': 'new' }, entryFile: 'index.html',
      metadataForOid: (oid: string | null, oldRecord: any) => {
        seenBaselines.push(oldRecord.dweb.git_oid);
        return { dweb: { ...oldRecord.dweb, git_oid: oid, version_id: 'v2' } };
      },
    };

    await expect(client.replaceVersionedFilesUnlocked({
      ...replacement,
      afterCommit: async () => { throw new Error('commit refused'); },
    })).rejects.toThrow('commit refused');
    expect(record.dweb).toMatchObject({
      git_oid: rollbackOid, source_git_oid: originalOid, version_id: 'v1',
    });

    await expect(client.replaceVersionedFilesUnlocked({
      ...replacement,
      afterCommit: async () => {},
    })).resolves.toMatchObject({ oid: retryOid });
    expect(seenBaselines).toEqual([originalOid, rollbackOid]);
    expect(record.dweb.git_oid).toBe(retryOid);
  });

  test('versioned replacement requires its commit callback before opening storage', async () => {
    let storageTouched = false;
    const client = createAppClient({
      registry: { get: async () => { storageTouched = true; return null; } } as any,
      tracker: {} as any,
      repositories: testRepositories({
        replaceWorkingTree: async () => { storageTouched = true; return { oid: null }; },
      }) as any,
      beforeOpfsMutation: async () => { storageTouched = true; },
    });
    const failure = await client.replaceVersionedFilesUnlocked({
      appId: 'app-1', files: {}, entryFile: 'index.html',
    } as any).then(() => null, (cause) => cause);
    expect(failure).toBeInstanceOf(TypeError);
    expect(failure.message).toBe('afterCommit is required');
    expect(storageTouched).toBe(false);
  });
});
