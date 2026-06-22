import { describe, test, expect } from 'bun:test';
import { createCommandStore, isValidCommandName } from '../../../extension/peerd-runtime/composer/command-store.js';
import { localStoreSource, skillRegistrySource, mergeSources } from '../../../extension/peerd-runtime/composer/command-sources.js';
import { applyComposer } from '../../../extension/peerd-runtime/composer/apply.js';

// In-memory KV matching the project's KV shape (get/set/delete/list).
const makeKV = () => {
  const m = new Map<string, any>();
  return {
    get: async (k: string) => m.get(k),
    set: async (k: string, v: any) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    list: async (prefix?: string) => {
      const out: Record<string, any> = {};
      for (const [k, v] of m) if (!prefix || k.startsWith(prefix)) out[k] = v;
      return out;
    },
    clear: async () => { m.clear(); },
  };
};

describe('isValidCommandName', () => {
  test('accepts kebab/word names, rejects junk', () => {
    expect(isValidCommandName('review')).toBe(true);
    expect(isValidCommandName('run-tests')).toBe(true);
    expect(isValidCommandName('/review')).toBe(false);
    expect(isValidCommandName('has space')).toBe(false);
    expect(isValidCommandName('')).toBe(false);
  });
});

describe('createCommandStore', () => {
  test('put then get round-trips the body', async () => {
    const store = createCommandStore({ kv: makeKV(), now: () => 123 });
    await store.put({ name: 'review', body: 'Review the code.', description: 'code review' });
    const got = await store.get('review');
    expect(got).toMatchObject({ name: 'review', body: 'Review the code.', updatedAt: 123 });
  });
  test('list returns name-sorted records', async () => {
    const store = createCommandStore({ kv: makeKV() });
    await store.put({ name: 'zeta', body: 'z' });
    await store.put({ name: 'alpha', body: 'a' });
    const names = (await store.list()).map((r) => r.name);
    expect(names).toEqual(['alpha', 'zeta']);
  });
  test('remove is idempotent', async () => {
    const store = createCommandStore({ kv: makeKV() });
    await store.put({ name: 'x', body: 'x' });
    await store.remove('x');
    await store.remove('x');
    expect(await store.get('x')).toBeNull();
  });
  test('rejects an invalid name on put', async () => {
    const store = createCommandStore({ kv: makeKV() });
    await expect(store.put({ name: 'bad name', body: 'b' })).rejects.toThrow();
  });
});

describe('command-sources — feature-07 adapter + merge', () => {
  test('localStoreSource maps store records to the source contract', async () => {
    const store = createCommandStore({ kv: makeKV() });
    await store.put({ name: 'a', body: 'A', description: 'da' });
    const src = localStoreSource(store);
    expect(await src.list()).toEqual([{ name: 'a', body: 'A', description: 'da' }]);
  });

  test('skillRegistrySource pulls from a 07-shaped registry', async () => {
    const registry = { listCommands: async () => [{ name: 'skillcmd', body: 'do skill' }] };
    const src = skillRegistrySource(registry);
    const out = await src.list();
    expect(out[0]).toMatchObject({ name: 'skillcmd', body: 'do skill', description: 'from a skill' });
  });

  test('skillRegistrySource degrades to [] when 07 is not wired', async () => {
    expect(await skillRegistrySource(null).list()).toEqual([]);
  });

  test('mergeSources: earlier source wins on name collision (user shadows skill)', async () => {
    const local = { list: async () => [{ name: 'dup', body: 'LOCAL' }] };
    const skill = { list: async () => [{ name: 'dup', body: 'SKILL' }, { name: 'only', body: 'S' }] };
    const merged = mergeSources([local, skill]);
    const out = await merged.list();
    expect(out.find((c) => c.name === 'dup')!.body).toBe('LOCAL');
    expect(out.map((c) => c.name)).toEqual(['dup', 'only']); // sorted, deduped
  });

  test('mergeSources tolerates a throwing source', async () => {
    const bad = { list: async () => { throw new Error('07 not ready'); } };
    const good = { list: async () => [{ name: 'g', body: 'G' }] };
    expect((await mergeSources([bad, good]).list()).map((c) => c.name)).toEqual(['g']);
  });
});

describe('applyComposer — end-to-end command + ref expansion', () => {
  // A ctx whose resolvers no-op the IO (we only assert command expansion +
  // that refs are spliced; resolver internals are covered separately).
  const ctx = {
    activeTab: { id: 1, url: 'https://example.com', origin: 'https://example.com' },
    denylist: [],
    tabs: {
      get: async (id: number) => ({ id, url: 'https://example.com/p', title: 'T' }),
      query: async () => [{ id: 1, url: 'https://example.com/p', title: 'T' }],
    },
    scripting: { executeScript: async () => [{ result: { title: 'D', url: 'https://example.com/p', text: 'tabtext' } }] },
    appClient: { readFile: async ({ path }: any) => `FILE(${path})` },
    session: { sessionId: 's1' },
  };

  const sourcesWith = (cmds: any[]) => ({ list: async () => cmds });

  test('a /command prepends its body and appends the user argument', async () => {
    const sources = sourcesWith([{ name: 'review', body: 'You are a code reviewer.', description: '' }]);
    const out = await applyComposer({ text: '/review the auth flow', commandSources: sources, ctx });
    expect(out.command).toBe('review');
    expect(out.commandFound).toBe(true);
    expect(out.text).toContain('You are a code reviewer.');
    expect(out.text).toContain('the auth flow');
  });

  test('an unknown /command passes through as literal text (message not dropped)', async () => {
    const out = await applyComposer({ text: '/nope hello', commandSources: sourcesWith([]), ctx });
    expect(out.commandFound).toBe(false);
    expect(out.text).toContain('/nope hello');
  });

  test('command body + @tab reference both expand', async () => {
    const sources = sourcesWith([{ name: 'sum', body: 'Summarize:', description: '' }]);
    const out = await applyComposer({ text: '/sum @tab', commandSources: sources, ctx });
    expect(out.text).toContain('Summarize:');
    expect(out.text).toContain('<untrusted_web_content');
    expect(out.text).toContain('tabtext');
    expect(out.refs[0].ok).toBe(true);
  });

  test('a plain message with no command/refs is unchanged', async () => {
    const out = await applyComposer({ text: 'just a question', commandSources: sourcesWith([]), ctx });
    expect(out.text).toBe('just a question');
    expect(out.command).toBeNull();
    expect(out.refs).toEqual([]);
  });
});
