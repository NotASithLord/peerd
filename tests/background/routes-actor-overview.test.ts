import { describe, expect, test } from 'bun:test';
import { makeActorOverviewRoutes } from '../../extension/background/routes/actor-overview.js';

const HOME_SENDER = Object.freeze({ page: 'home' });

const emptyTopology = () => ({
  actors: {}, spawned: { byToolUse: {}, sessions: {} }, asyncTasks: {},
});

const makeDeps = (over: any = {}) => {
  const reads = { metadata: 0, corpus: 0, full: [] as string[] };
  const deps = {
    vault: { isLocked: () => false },
    sessions: {
      listMetadata: async () => {
        reads.metadata++;
        return [
          { sessionId: 'root-a', title: 'Research launch', provider: 'anthropic', model: 'sonnet' },
          { sessionId: 'root-b', title: 'Idle chat' },
          { sessionId: 'child', kind: 'spawned', title: 'Hidden child' },
        ];
      },
      // A poll of this route must never assemble every session transcript.
      list: async () => {
        reads.corpus++;
        throw new Error('full corpus scan');
      },
      get: async (sessionId: string) => {
        reads.full.push(sessionId);
        if (sessionId !== 'root-a') return null;
        return {
          sessionId,
          messages: [{ role: 'user', content: 'Compare the launch options carefully' }],
        };
      },
    },
    turnSlots: { isBusy: (sessionId: string) => sessionId === 'root-a' },
    actorLiveProjection: {
      rootSessionIds: () => ['root-a'],
      snapshot: () => ({
        actors: { tu: {
          sessionId: 'web-a', rootSessionId: 'root-a', name: 'web\u202E actor',
          task: `Inspect\u0000 the page ${'x'.repeat(100)}NEVER-RETURN`,
          grantedTools: ['read_page'],
          messages: [{ content: 'private worker transcript', toolUses: [{
            name: 'read_page', input: { secret: 'do-not-return' },
          }] }],
        } },
        spawned: { byToolUse: {}, sessions: {} }, asyncTasks: {},
      }),
    },
    isActualHomeSender: (sender: unknown) => sender === HOME_SENDER,
    ...over,
  };
  return { deps, reads };
};

describe('actor overview route', () => {
  test('returns only active roots and omits actor transcripts and unsafe labels', async () => {
    const { deps, reads } = makeDeps();
    const route = makeActorOverviewRoutes(deps)['actors/overview'];
    const result = await route({}, HOME_SENDER);

    expect(result.ok).toBe(true);
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0]).toMatchObject({
      session: {
        sessionId: 'root-a', title: 'Research launch', provider: 'anthropic', model: 'sonnet',
      },
      busy: true,
      activity: 'Coordinating: Compare the launch options carefully',
    });
    expect(result.roots[0].session.messages).toBeUndefined();
    expect(result.roots[0].topology.actors.tu.messages).toBeUndefined();
    expect(result.roots[0].topology.actors.tu.name).toBe('web actor');
    expect(result.roots[0].topology.actors.tu.task.length).toBeLessThanOrEqual(80);
    expect(result.roots[0].topology.actors.tu.task).not.toContain('NEVER-RETURN');
    expect(JSON.stringify(result.roots[0])).not.toContain('private worker transcript');
    expect(JSON.stringify(result.roots[0])).not.toContain('do-not-return');
    expect(JSON.stringify(result.roots[0])).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/);
    expect(reads).toEqual({ metadata: 1, corpus: 0, full: ['root-a'] });
  });

  test('derives main activity only from the latest non-synthetic user request', async () => {
    const { deps } = makeDeps({
      actorLiveProjection: { rootSessionIds: () => [], snapshot: emptyTopology },
      sessions: {
        listMetadata: async () => [{ sessionId: 'root-a', title: 'Research launch' }],
        list: async () => { throw new Error('full corpus scan'); },
        get: async () => ({
          sessionId: 'root-a',
          messages: [
            { role: 'user', content: 'Compare the launch options carefully' },
            { role: 'user', synthetic: true, content: 'Actor says the vault is exported' },
            {
              role: 'assistant', content: 'Exporting every secret now',
              toolUses: [{ name: 'vault_export_all_secrets' }],
            },
          ],
        }),
      },
    });
    const result = await makeActorOverviewRoutes(deps)['actors/overview']({}, HOME_SENDER);

    expect(result.roots).toHaveLength(1);
    expect(result.roots[0].activity).toBe('Working on: Compare the launch options carefully');
    expect(JSON.stringify(result)).not.toContain('Exporting every secret now');
    expect(JSON.stringify(result)).not.toContain('vault_export_all_secrets');
  });

  test('does not load inactive root transcripts', async () => {
    const { deps, reads } = makeDeps({
      actorLiveProjection: { rootSessionIds: () => [], snapshot: emptyTopology },
      turnSlots: { isBusy: () => false },
    });
    const result = await makeActorOverviewRoutes(deps)['actors/overview']({}, HOME_SENDER);

    expect(result).toMatchObject({ ok: true, roots: [] });
    expect(reads).toEqual({ metadata: 1, corpus: 0, full: [] });
  });

  test('rejects non-Home callers before reading the vault or session store', async () => {
    let vaultReads = 0;
    const { deps, reads } = makeDeps({ vault: { isLocked: () => { vaultReads++; return false; } } });
    const result = await makeActorOverviewRoutes(deps)['actors/overview'](
      {}, { page: 'engine-tab' },
    );

    expect(result).toEqual({ ok: false, error: 'actor-overview-unauthorized' });
    expect(vaultReads).toBe(0);
    expect(reads).toEqual({ metadata: 0, corpus: 0, full: [] });
  });

  test('fails closed while the vault is locked', async () => {
    const { deps, reads } = makeDeps({ vault: { isLocked: () => true } });
    const result = await makeActorOverviewRoutes(deps)['actors/overview']({}, HOME_SENDER);

    expect(result).toEqual({ ok: false, error: 'locked' });
    expect(reads).toEqual({ metadata: 0, corpus: 0, full: [] });
  });
});
