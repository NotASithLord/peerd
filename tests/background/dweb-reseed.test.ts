import { describe, expect, test } from 'bun:test';
import { makeReseedSharedApps } from '../../extension/background/dweb-reseed.js';

const sharedApp = {
  id: 'app-1', name: 'App', entryFile: 'index.html', shared: true,
  dweb: { local: true, slug: 'app', manifest_created: 1, hash: 'hash', seq: 2 },
};

describe('dweb restart reseed', () => {
  test('re-reads inside the App lane and does not resurrect a deleted candidate', async () => {
    const messages: any[] = [];
    const reseed = makeReseedSharedApps({
      enabled: true,
      active: () => true,
      locked: () => false,
      appRegistry: { list: async () => [sharedApp], get: async () => null },
      withDwebPublication: async (operation) => operation(() => true),
      withAppLifecycle: async (_id, operation) => operation(),
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
      log: { log: () => {}, warn: () => {}, debug: () => {} },
    });
    await reseed();
    expect(messages).toEqual([]);
  });

  test('holds the App lifecycle lane through the host publication', async () => {
    const events: string[] = [];
    const reseed = makeReseedSharedApps({
      enabled: true,
      active: () => true,
      locked: () => false,
      appRegistry: { list: async () => [sharedApp], get: async () => sharedApp },
      withDwebPublication: async (operation) => {
        events.push('enter:dweb');
        const result = await operation(() => true);
        events.push('exit:dweb');
        return result;
      },
      withAppLifecycle: async (id, operation) => {
        events.push(`enter:${id}`);
        const result = await operation();
        events.push(`exit:${id}`);
        return result;
      },
      sendMessage: async (message) => { events.push(message.type); return { ok: true }; },
      log: { log: () => {}, warn: () => {}, debug: () => {} },
    });
    await reseed();
    expect(events).toEqual([
      'enter:dweb', 'enter:app-1', 'dweb/base-host/share-app', 'exit:app-1', 'exit:dweb',
    ]);
  });

  test('reconstructs the exact signed Git release instead of publishing the mutable worktree', async () => {
    const oid = 'a'.repeat(40);
    const previousVersionId = 'b'.repeat(64);
    const releaseApp = {
      ...sharedApp,
      entryFile: 'current.html',
      fileKinds: { 'current.html': 'text' },
      dweb: {
        ...sharedApp.dweb,
        hash: 'c'.repeat(64),
        git_oid: oid,
        source_git_oid: oid,
        previous_version_id: previousVersionId,
        changelog: 'ship the immutable release',
        release_entry_file: 'index.html',
        release_file_kinds: { 'index.html': 'text', 'module.wasm': 'binary' },
      },
    };
    const messages: any[] = [];
    const reseed = makeReseedSharedApps({
      enabled: true,
      active: () => true,
      locked: () => false,
      appRegistry: { list: async () => [releaseApp], get: async () => releaseApp },
      withDwebPublication: async (operation) => operation(() => true),
      withAppLifecycle: async (_id, operation) => operation(),
      repositories: {
        snapshot: async (ref, opts) => {
          expect(ref).toEqual({ kind: 'app', id: 'app-1' });
          expect(opts).toEqual({ at: oid });
          return {
            'index.html': new TextEncoder().encode('released'),
            'module.wasm': Uint8Array.of(0, 97, 115, 109),
          };
        },
      },
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
      log: { log: () => {}, warn: () => {}, debug: () => {} },
    });

    await reseed();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      expectedHash: 'c'.repeat(64),
      release: {
        previousVersionId,
        gitCommitOid: oid,
        changelog: 'ship the immutable release',
      },
      releaseSnapshot: {
        ok: true,
        oid,
        totalBytes: 12,
        record: {
          entryFile: 'index.html',
          fileKinds: { 'index.html': 'text', 'module.wasm': 'binary' },
        },
      },
    });
    expect(atob(messages[0].releaseSnapshot.files['index.html'].base64)).toBe('released');
    expect([...Uint8Array.from(
      atob(messages[0].releaseSnapshot.files['module.wasm'].base64),
      (character) => character.charCodeAt(0),
    )]).toEqual([0, 97, 115, 109]);
  });

  test('rechecks master state and vault lock after waiting for lifecycle lanes', async () => {
    const messages: any[] = [];
    let active = true;
    let locked = false;
    const reseed = makeReseedSharedApps({
      enabled: true,
      active: () => active,
      locked: () => locked,
      appRegistry: { list: async () => [sharedApp], get: async () => sharedApp },
      withDwebPublication: async (operation) => {
        active = false;
        locked = true;
        return operation(() => false);
      },
      withAppLifecycle: async (_id, operation) => operation(),
      sendMessage: async (message) => { messages.push(message); return { ok: true }; },
      log: { log: () => {}, warn: () => {}, debug: () => {} },
    });
    await reseed();
    expect(messages).toEqual([]);
  });
});
