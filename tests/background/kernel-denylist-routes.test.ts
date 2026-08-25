// Kernel denylist editor migration: the mutation routes must preserve the
// legacy Logs-view editor's observable behavior while the network backstop
// obligation stays live in the kernel.

import { describe, expect, test } from 'bun:test';
import {
  createKernelDenylistPolicy,
  makeKernelDenylistRoutes,
} from '../../extension/background/kernel-denylist-policy.js';
import { makeDenylistRoutes } from '../../extension/background/routes/denylist.js';
import { makeDenylistStore } from '../../extension/background/denylist-store.js';
import {
  flattenCategorisedDenylist,
  normalizeDenylistPattern,
} from '../../extension/peerd-egress/kernel-storage.js';

const seed = {
  categories: { sensitive: ['bank.example', '*.health.example'] },
};

const makeKv = (initial: any = null) => {
  const values = new Map<string, any>([['denylist.user.v1', initial]]);
  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: any) => { values.set(key, value); },
    _values: values,
  };
};

const makeKernelLane = ({
  kv = makeKv(), networkCustody = { sync: async () => {} },
}: { kv?: any, networkCustody?: any } = {}) => {
  const audit: any[] = [];
  const policy = createKernelDenylistPolicy({ kv, readSeed: async () => seed });
  const routes = makeKernelDenylistRoutes({
    policy,
    networkCustody,
    auditLog: { append: async (entry: any) => { audit.push(entry); } },
  });
  return { routes, audit, kv, networkCustody };
};

const makeLegacyLane = ({ kv = makeKv() } = {}) => {
  const audit: any[] = [];
  const syncs: number[] = [];
  const store = makeDenylistStore({
    kv, key: 'denylist.user.v1', normalizePattern: normalizeDenylistPattern,
  });
  const ready = store.load(flattenCategorisedDenylist(seed));
  const routes = makeDenylistRoutes({
    denylistStore: store,
    auditLog: { append: async (entry: any) => { audit.push(entry); } },
    denylistNetGuard: { sync: () => { syncs.push(1); } },
    getSeedCategories: () => seed.categories,
  });
  return { routes, audit, kv, ready, syncs };
};

describe('kernel denylist mutation routes', () => {
  test('add and remove replies match the legacy editor exactly', async () => {
    const kernel = makeKernelLane();
    const legacy = makeLegacyLane();
    await legacy.ready;
    for (const [route, message] of [
      ['denylist/add', { pattern: ' Private.Example ' }],
      ['denylist/add', { pattern: 'private.example' }],
      ['denylist/remove', { pattern: 'private.example' }],
      ['denylist/remove', { pattern: 'bank.example' }],
      ['denylist/add', { pattern: 'bank.example' }],
      ['denylist/remove', { pattern: 'never-added.example' }],
      ['denylist/add', { pattern: '' }],
    ] as const) {
      const kernelReply = await kernel.routes[route](message);
      const legacyReply = await legacy.routes[route](message);
      expect(JSON.parse(JSON.stringify(kernelReply))).toEqual(
        JSON.parse(JSON.stringify(legacyReply)),
      );
    }
    expect(kernel.audit).toEqual(legacy.audit);
    expect(kernel.kv._values.get('denylist.user.v1'))
      .toEqual(legacy.kv._values.get('denylist.user.v1'));
  });

  test('a successful edit resyncs the network backstop; a refused one does not', async () => {
    const updates: any[] = [];
    const { routes } = makeKernelLane({
      networkCustody: { sync: async () => { updates.push({}); } },
    });
    await routes['denylist/add']({ pattern: 'private.example' });
    expect(updates).toHaveLength(1);
    await routes['denylist/remove']({ pattern: 'missing.example' });
    expect(updates).toHaveLength(1);
    await routes['denylist/remove']({ pattern: 'private.example' });
    expect(updates).toHaveLength(2);
  });

  test('an edit before hydration cannot race the overlay load', async () => {
    const kv = makeKv({ added: ['pre-existing.example'], disabled: [] });
    const { routes } = makeKernelLane({ kv });
    const reply = await routes['denylist/add']({ pattern: 'private.example' });
    expect(reply.added).toEqual(['pre-existing.example', 'private.example']);
  });
});
