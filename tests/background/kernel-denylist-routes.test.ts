// Kernel denylist editor routes keep persistence and the network backstop
// obligation live in the authority kernel.

import { describe, expect, test } from 'bun:test';
import {
  createKernelDenylistPolicy,
  makeKernelDenylistRoutes,
} from '../../extension/background/kernel-denylist-policy.js';

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

describe('kernel denylist mutation routes', () => {
  test('audit records both added rules and each removal names only its own rule', async () => {
    const { routes, audit } = makeKernelLane();
    await routes['denylist/add']({ pattern: 'private.example' });
    expect(audit.at(-1).details.patterns).toEqual(['private.example', '*.private.example']);
    const result = await routes['denylist/remove']({ pattern: 'private.example' });
    expect(result.added).toEqual(['*.private.example']);
    expect(audit.at(-1).details.patterns).toEqual(['private.example']);
    await routes['denylist/remove']({ pattern: '*.private.example' });
    expect(audit.at(-1).details.patterns).toEqual(['*.private.example']);
  });

  test('concurrent edits record only their own effective rules', async () => {
    const pending: Array<() => void> = [];
    const kv = makeKv();
    const persist = kv.set;
    kv.set = async (key: string, value: any) => {
      await new Promise<void>((resolve) => pending.push(resolve));
      await persist(key, value);
    };
    const { routes, audit } = makeKernelLane({ kv });
    const first = routes['denylist/add']({ pattern: 'first.example' });
    const second = routes['denylist/add']({ pattern: 'second.example' });
    await Bun.sleep(0);
    expect(pending).toHaveLength(1);
    pending.shift()!();
    await first;
    await Bun.sleep(0);
    expect(pending).toHaveLength(1);
    pending.shift()!();
    await second;
    expect(audit.map((entry) => entry.details.patterns)).toEqual([
      ['first.example', '*.first.example'], ['second.example', '*.second.example'],
    ]);
    expect(kv._values.get('denylist.user.v1').added)
      .toEqual(['first.example', '*.first.example', 'second.example', '*.second.example']);
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
    expect(reply.added).toEqual(['pre-existing.example', 'private.example', '*.private.example']);
  });
});
