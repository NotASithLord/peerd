import { describe, expect, test } from 'bun:test';
import {
  createIntrospectionToolAuthority,
} from '../../extension/background/introspection-tool-authority.js';

describe('exact introspection authority', () => {
  test('filters sensitive browser targets before returning an actor roster', async () => {
    const authority = createIntrospectionToolAuthority({
      call: { name: 'actor_list', args: {} },
      ctx: {
        session: { sessionId: 's1' },
        tabs: { query: async () => [
          { id: 1, url: 'https://example.test/x', title: 'Docs', active: true },
          { id: 2, url: 'http://127.0.0.1/admin', title: 'Admin' },
          { id: 3, url: 'https://bank.test/account', title: 'Bank' },
        ] },
        denylist: ['bank.test'],
      },
    });
    const roster: any = await authority.readActorRoster();
    expect(roster.tabs.map((tab: any) => tab.id)).toEqual([1]);
    expect(roster.restrictedTabsHidden).toBe(2);
    expect(JSON.stringify(roster)).not.toContain('127.0.0.1');
    expect(JSON.stringify(roster)).not.toContain('bank.test');
  });

  test('pins a storage inspection to the admitted facet and prefix', async () => {
    const authority = createIntrospectionToolAuthority({
      call: { name: 'inspect', args: { kind: 'storage', prefix: 'session:' } },
      ctx: { kv: { list: async (prefix: string) => ({ prefix }) } },
    });
    await expect(authority.readStorageSnapshot('session:')).resolves
      .toEqual({ prefix: 'session:' });
    expect(() => authority.readStorageSnapshot('vault:'))
      .toThrow('introspection authority mismatch');
    expect(() => authority.readAuditEntries()).toThrow('introspection authority mismatch');
  });

  test('pins an installed-skill read to the admitted normalized name', async () => {
    let reads = 0;
    const authority = createIntrospectionToolAuthority({
      call: { name: 'load_skill', args: { name: ' writer ' } },
      ctx: { skills: { loadBody: async (name: string) => {
        reads += 1;
        return { meta: { name }, body: 'body' };
      } } },
    });
    await expect(authority.readInstalledSkill('writer')).resolves
      .toEqual({ meta: { name: 'writer' }, body: 'body' });
    expect(() => authority.readInstalledSkill('other'))
      .toThrow('introspection authority mismatch');
    expect(reads).toBe(1);
  });
});
