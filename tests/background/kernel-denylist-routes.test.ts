// Kernel denylist editor migration: the mutation routes must preserve the
// legacy Logs-view editor's observable behavior while the network backstop
// obligation stays live in the kernel.

import { describe, expect, test } from 'bun:test';
import {
  createKernelDenylistNetworkCustody,
  createKernelDenylistPolicy,
  makeKernelDenylistRoutes,
  OWNED_DENYLIST_SESSION_RULE_IDS,
} from '../../extension/background/kernel-denylist-policy.js';
import { makeDenylistRoutes } from '../../extension/background/routes/denylist.js';
import { makeDenylistStore } from '../../extension/background/denylist-store.js';
import {
  APP_EGRESS_RULE_ID,
  DENYLIST_ALLOW_RULE_ID,
  DENYLIST_RULE_ID,
  denylistSessionRuleUpdate,
  PRIVATE_NETWORK_INITIATOR_RULE_IDS,
  PRIVATE_NETWORK_RULE_IDS,
} from '../../extension/peerd-egress/denylist/dnr-rules.js';
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

const makeKernelLane = ({ kv = makeKv(), dnr = undefined as any } = {}) => {
  const audit: any[] = [];
  const policy = createKernelDenylistPolicy({ kv, readSeed: async () => seed });
  const networkCustody = createKernelDenylistNetworkCustody({ dnr });
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
    const dnr = { updateSessionRules: async (update: any) => { updates.push(update); } };
    const { routes } = makeKernelLane({ dnr });
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

describe('kernel denylist network custody', () => {
  test('owned rule ids are exactly the ids the full rule math derives', () => {
    expect([...OWNED_DENYLIST_SESSION_RULE_IDS]).toEqual([
      DENYLIST_RULE_ID, DENYLIST_ALLOW_RULE_ID, APP_EGRESS_RULE_ID,
      ...PRIVATE_NETWORK_RULE_IDS,
      ...PRIVATE_NETWORK_INITIATOR_RULE_IDS,
    ]);
  });

  test('sync equals the legacy guard update for the kernel\'s empty driven set', async () => {
    const expected = denylistSessionRuleUpdate({
      patterns: ['bank.example'], tabIds: [], appTabIds: [],
      initiatorDomains: [], exemptDomains: [],
    });
    expect(expected.addRules).toEqual([]);
    const updates: any[] = [];
    const custody = createKernelDenylistNetworkCustody({
      dnr: { updateSessionRules: async (update: any) => { updates.push(update); } },
    });
    await custody.sync();
    expect(updates).toEqual([{ removeRuleIds: expected.removeRuleIds }]);
    expect(custody.status()).toEqual({ supported: true, lastError: null });
  });

  test('an unsupported namespace or failed update is recorded, never thrown', async () => {
    const absent = createKernelDenylistNetworkCustody({ dnr: undefined });
    await absent.sync();
    expect(absent.status()).toEqual({ supported: false, lastError: null });

    const failing = createKernelDenylistNetworkCustody({
      dnr: { updateSessionRules: async () => { throw new Error('session rules rejected'); } },
    });
    await failing.sync();
    expect(failing.status()).toEqual({ supported: true, lastError: 'session rules rejected' });
  });
});
