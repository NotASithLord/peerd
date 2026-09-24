import { describe, expect, test } from 'bun:test';
import { makeActorOverviewRoutes } from '../../extension/background/routes/actor-overview.js';

const HOME_SENDER = Object.freeze({ page: 'home' });

const emptyTopology = () => ({
  actors: {}, spawned: { byToolUse: {}, sessions: {} }, asyncTasks: {},
});

const makeDeps = (over: any = {}) => {
  const reads = { metadata: [] as string[], latest: [] as string[], corpus: 0 };
  const deps = {
    vault: { isLocked: () => false },
    sessions: {
      listMetadata: async () => {
        reads.corpus++;
        throw new Error('full metadata scan');
      },
      list: async () => {
        reads.corpus++;
        throw new Error('full corpus scan');
      },
      get: async () => {
        reads.corpus++;
        throw new Error('transcript assembly');
      },
      getMetadata: async (sessionId: string) => {
        reads.metadata.push(sessionId);
        if (sessionId !== 'root-a') return undefined;
        return {
          sessionId, title: 'Research launch', provider: 'anthropic', model: 'sonnet',
        };
      },
      getLatestNonSyntheticUserMessage: async (sessionId: string) => {
        reads.latest.push(sessionId);
        return { role: 'user', content: 'Compare the launch options carefully' };
      },
    },
    turnSlots: {
      isBusy: (sessionId: string) => sessionId === 'root-a',
      busySessionIds: () => ['root-a'],
    },
    actorLiveProjection: {
      rootSessionIds: () => ['root-a'],
      activeActorCount: () => 1,
      snapshot: () => ({
        actors: { tu: {
          sessionId: 'web-a', rootSessionId: 'root-a', name: 'web\u202E actor',
          task: `Inspect\u0000 the page ${'x'.repeat(100)}NEVER-RETURN`,
          visibleTools: ['read_page'],
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
    expect(reads).toEqual({ metadata: ['root-a'], latest: ['root-a'], corpus: 0 });
  });

  test('derives main activity only from the latest non-synthetic user request', async () => {
    const { deps } = makeDeps({
      actorLiveProjection: { rootSessionIds: () => [], snapshot: emptyTopology },
      sessions: {
        getMetadata: async () => ({ sessionId: 'root-a', title: 'Research launch' }),
        getLatestNonSyntheticUserMessage: async () => ({
          role: 'user', content: 'Compare the launch options carefully',
        }),
      },
    });
    const result = await makeActorOverviewRoutes(deps)['actors/overview']({}, HOME_SENDER);

    expect(result.roots).toHaveLength(1);
    expect(result.roots[0].activity).toBe('Working on: Compare the launch options carefully');
    expect(JSON.stringify(result)).not.toContain('Exporting every secret now');
    expect(JSON.stringify(result)).not.toContain('vault_export_all_secrets');
  });

  test('live turn activity wins before the durable user message append completes', async () => {
    let durableReads = 0;
    const { deps } = makeDeps({
      turnSlots: {
        isBusy: () => true,
        busySessionIds: () => ['root-a'],
        activityFor: () => 'Prepare the beta launch sequence',
      },
      sessions: {
        getMetadata: async () => ({ sessionId: 'root-a', title: 'Beta launch' }),
        getLatestNonSyntheticUserMessage: async () => {
          durableReads++;
          return { role: 'user', content: 'stale prior request' };
        },
      },
    });
    const result = await makeActorOverviewRoutes(deps)['actors/overview']({}, HOME_SENDER);

    expect(result.roots[0].activity).toBe('Coordinating: Prepare the beta launch sequence');
    expect(durableReads).toBe(0);
  });

  test('does not load inactive root transcripts', async () => {
    const { deps, reads } = makeDeps({
      actorLiveProjection: { rootSessionIds: () => [], snapshot: emptyTopology },
      turnSlots: { isBusy: () => false, busySessionIds: () => [] },
    });
    const result = await makeActorOverviewRoutes(deps)['actors/overview']({}, HOME_SENDER);

    expect(result).toMatchObject({ ok: true, roots: [] });
    expect(reads).toEqual({ metadata: [], latest: [], corpus: 0 });
  });

  test('returns a content-free actor count without reading any session record', async () => {
    const { deps, reads } = makeDeps({
      actorLiveProjection: {
        rootSessionIds: () => { throw new Error('root labels are unnecessary'); },
        snapshot: () => { throw new Error('topology serialization is unnecessary'); },
        activeActorCount: () => 7,
      },
    });
    const result = await makeActorOverviewRoutes(deps)['actors/count']({}, HOME_SENDER);

    expect(result).toMatchObject({ ok: true, activeActors: 7 });
    expect(reads).toEqual({ metadata: [], latest: [], corpus: 0 });
  });

  test('coalesces concurrent overview polls from multiple Home surfaces', async () => {
    let metadataReads = 0;
    let releaseMetadata = () => {};
    const metadataGate = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    const { deps } = makeDeps({
      sessions: {
        getMetadata: async () => {
          metadataReads++;
          await metadataGate;
          return { sessionId: 'root-a', title: 'Research launch' };
        },
        getLatestNonSyntheticUserMessage: async () => ({ role: 'user', content: 'Compare' }),
      },
    });
    const route = makeActorOverviewRoutes(deps)['actors/overview'];
    const first = route({}, HOME_SENDER);
    const second = route({}, HOME_SENDER);
    await Promise.resolve();
    expect(metadataReads).toBe(1);
    releaseMetadata();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
  });

  test('rejects non-Home callers before reading the vault or session store', async () => {
    let vaultReads = 0;
    const { deps, reads } = makeDeps({ vault: { isLocked: () => { vaultReads++; return false; } } });
    const result = await makeActorOverviewRoutes(deps)['actors/overview'](
      {}, { page: 'engine-tab' },
    );

    expect(result).toEqual({ ok: false, error: 'actor-overview-unauthorized' });
    expect(vaultReads).toBe(0);
    expect(reads).toEqual({ metadata: [], latest: [], corpus: 0 });
  });

  test('fails closed while the vault is locked', async () => {
    const { deps, reads } = makeDeps({ vault: { isLocked: () => true } });
    const result = await makeActorOverviewRoutes(deps)['actors/overview']({}, HOME_SENDER);

    expect(result).toEqual({ ok: false, error: 'locked' });
    expect(reads).toEqual({ metadata: [], latest: [], corpus: 0 });
  });
});
