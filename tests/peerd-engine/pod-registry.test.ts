import { describe, expect, test } from 'bun:test';
import { createPodRegistry, POD_OPFS_ROOT, POD_TAB_PATH } from '../../extension/peerd-engine/pod-registry.js';
import { createStorageStub } from '../setup.ts';

describe('createPodRegistry', () => {
  test('pins the tab page and durable OPFS namespace', () => {
    expect(POD_TAB_PATH).toBe('/engine-tabs/pod-tab/index.html');
    expect(POD_OPFS_ROOT).toBe('peerd-pods');
  });

  test('creates persistent Pods by default and explicit ephemeral Pods', async () => {
    const registry = createPodRegistry({ storage: createStorageStub() });
    const durable = await registry.create({ name: 'durable' });
    const ephemeral = await registry.create({ name: 'scratch', persistent: false });
    expect(durable.id).toMatch(/^pod-/);
    expect(durable.persistent).toBe(true);
    expect(ephemeral.persistent).toBe(false);
  });

  test('session default and actor binding survive a fresh registry load', async () => {
    const storage = createStorageStub();
    const first = createPodRegistry({ storage });
    const record = await first.create({ name: 'workspace', ownerSessionId: 'chat-1' });
    await first.setDefaultForSession('chat-1', record.id);
    await first.setActorSession(record.id, 'actor-1');

    const reopened = createPodRegistry({ storage });
    expect(await reopened.getDefaultForSession('chat-1')).toBe(record.id);
    expect(await reopened.getActorSession(record.id)).toBe('actor-1');
    expect((await reopened.snapshot({ sessionId: 'chat-1' })).pods).toHaveLength(1);
  });

  test('delete clears stale session pointers', async () => {
    const registry = createPodRegistry({ storage: createStorageStub() });
    const record = await registry.create({});
    await registry.setDefaultForSession('chat-1', record.id);
    await registry.delete(record.id);
    expect(await registry.getDefaultForSession('chat-1')).toBeNull();
  });
});
