import { describe, test, expect } from 'bun:test';
import {
  createEngineInstanceResolver, shortSessionSuffix,
} from '../../extension/background/engine-process.js';
import { createKeyedQueue } from '../../extension/peerd-engine/command-queue.js';

// The precedence every tab-hosted engine kind uses to pick its target:
// explicit id → the session's current instance → lazy create (or refuse).

const makeRegistry = (seed: Record<string, object> = {}, defaults: Record<string, string> = {}) => {
  const records = new Map(Object.entries(seed));
  const sessionDefaults = new Map(Object.entries(defaults));
  const created: any[] = [];
  let next = 0;
  return {
    created,
    records,
    sessionDefaults,
    get: async (id: string) => records.get(id) ?? null,
    getDefaultForSession: async (sessionId: string) => {
      // A real registry read yields; this keeps concurrent callers interleaved.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return sessionDefaults.get(sessionId) ?? null;
    },
    setDefaultForSession: async (sessionId: string, id: string) => { sessionDefaults.set(sessionId, id); },
    create: async (opts: any) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const id = `x-${next++}`;
      records.set(id, { id, ...opts });
      created.push(opts);
      return { id };
    },
  };
};

const config = (registry: any, overrides: Record<string, unknown> = {}) => ({
  registry,
  queue: createKeyedQueue(),
  notFound: (id: string) => new Error(`not found: ${id}`),
  missingTarget: () => new Error('missing target'),
  createOptions: (sessionId: string) => ({ name: `k-${shortSessionSuffix(sessionId)}`, ownerSessionId: sessionId }),
  ...overrides,
});

describe('engine instance resolver', () => {
  test('an explicit id must exist and wins over the session default', async () => {
    const registry = makeRegistry({ a: {}, b: {} }, { s1: 'b' });
    const resolver = createEngineInstanceResolver(config(registry));
    expect(await resolver.resolve({ sessionId: 's1', id: 'a' })).toBe('a');
    await expect(resolver.resolve({ sessionId: 's1', id: 'nope' })).rejects.toThrow('not found: nope');
    expect(registry.created).toEqual([]);
  });

  test('the session default is used before creating anything', async () => {
    const registry = makeRegistry({ b: {} }, { s1: 'b' });
    const resolver = createEngineInstanceResolver(config(registry));
    expect(await resolver.resolve({ sessionId: 's1' })).toBe('b');
    expect(registry.created).toEqual([]);
  });

  test('a lazy create is owned by the session and becomes its default', async () => {
    const registry = makeRegistry();
    const resolver = createEngineInstanceResolver(config(registry));
    const id = await resolver.resolve({ sessionId: 'session-abcdef123456' });
    expect(registry.created).toEqual([{ name: 'k-123456', ownerSessionId: 'session-abcdef123456' }]);
    expect(registry.sessionDefaults.get('session-abcdef123456')).toBe(id);
  });

  test('neither an id nor a session is refused without touching the registry', async () => {
    const registry = makeRegistry();
    const resolver = createEngineInstanceResolver(config(registry));
    await expect(resolver.resolve({})).rejects.toThrow('missing target');
    await expect(resolver.resolveExisting({})).rejects.toThrow('missing target');
    expect(registry.created).toEqual([]);
  });

  test('a kind that never creates lazily refuses with its missing-default error', async () => {
    const registry = makeRegistry();
    const resolver = createEngineInstanceResolver(config(registry, {
      createOptions: null,
      missingDefault: () => Object.assign(new Error('no current'), { code: 'default_missing' }),
    }));
    await expect(resolver.resolve({ sessionId: 's1' })).rejects.toMatchObject({ code: 'default_missing' });
    expect(registry.created).toEqual([]);
  });

  test('resolveExisting never creates and reports the missing default', async () => {
    const registry = makeRegistry();
    const resolver = createEngineInstanceResolver(config(registry, {
      missingDefault: () => new Error('no current instance'),
    }));
    await expect(resolver.resolveExisting({ sessionId: 's1' })).rejects.toThrow('no current instance');
    expect(registry.created).toEqual([]);
  });

  test('concurrent implicit first calls share one lazily created instance', async () => {
    const registry = makeRegistry();
    const resolver = createEngineInstanceResolver(config(registry));
    const ids = await Promise.all([
      resolver.resolveQueued({ sessionId: 's1' }),
      resolver.resolveQueued({ sessionId: 's1' }),
      resolver.resolveQueued({ sessionId: 's1' }),
    ]);
    expect(new Set(ids).size).toBe(1);
    expect(registry.created.length).toBe(1);
  });

  test('without the lane the same race really does create twice', async () => {
    // Proves the test above exercises the race it claims to prevent.
    const registry = makeRegistry();
    const resolver = createEngineInstanceResolver(config(registry));
    await Promise.all([resolver.resolve({ sessionId: 's1' }), resolver.resolve({ sessionId: 's1' })]);
    expect(registry.created.length).toBe(2);
  });

  test('an explicit id skips the lane so it never waits behind a lazy create', async () => {
    const registry = makeRegistry({ a: {} });
    let enqueued = 0;
    const resolver = createEngineInstanceResolver(config(registry, {
      queue: { enqueue: (_key: string, task: () => Promise<unknown>) => { enqueued += 1; return task(); } },
    }));
    expect(await resolver.resolveQueued({ sessionId: 's1', id: 'a' })).toBe('a');
    expect(enqueued).toBe(0);
    await resolver.resolveQueued({ sessionId: 's1' });
    expect(enqueued).toBe(1);
  });

  test('resolveQueued without a client queue is a programming error, not a silent race', async () => {
    const resolver = createEngineInstanceResolver(config(makeRegistry(), { queue: undefined }));
    await expect(resolver.resolveQueued({ sessionId: 's1' })).rejects.toThrow(TypeError);
  });

  test('the session suffix is the last six characters', () => {
    expect(shortSessionSuffix('abc')).toBe('abc');
    expect(shortSessionSuffix('session-123456')).toBe('123456');
  });
});
