import { describe, expect, test } from 'bun:test';
import { makeSemanticRouteKernel } from '../../extension/background/semantic-route-kernel.js';
import { dispatchSemanticRoute } from '../../extension/offscreen/semantic-route-host.js';
import { makeActorOverviewRoutes } from '../../extension/background/routes/actor-overview.js';

const HOME = { id: 'extension', url: 'extension://home/home.html' };
const OTHER = { id: 'extension', url: 'extension://sidepanel/sidepanel.html' };

const withoutClock = (value: any) => {
  const copy = structuredClone(value);
  delete copy.observedAt;
  for (const root of copy.roots ?? []) delete root.observedAt;
  return copy;
};

const harness = (overrides: Record<string, any> = {}) => {
  const toolboxStore = overrides.toolboxStore ?? {
    getBody: async (name: string) => name === 'known' ? 'export default 1' : null,
    recordRuns: async () => {},
  };
  const deps = {
    isHomeSender: (sender: any) => sender === HOME,
    vault: { isLocked: () => false },
    sessions: {
      getMetadata: async () => ({ kind: 'chat', title: 'Main', provider: 'p', model: 'm' }),
      getLatestNonSyntheticUserMessage: async () => ({ content: 'Build the thing' }),
    },
    actorLiveProjection: {
      rootSessionIds: () => ['root'], activeActorCount: () => 1,
      snapshot: () => ({ actors: { t1: {
        sessionId: 'actor', rootSessionId: 'root', parentSessionId: 'root',
        kind: 'actor', name: 'Worker', running: true, grantedTools: ['read'],
      } }, spawned: { byToolUse: {}, sessions: {} }, asyncTasks: {} }),
    },
    turnSlots: { busySessionIds: () => ['root'], isBusy: () => true },
    toolboxStore,
    auditLog: overrides.auditLog ?? { list: async () => [] },
    contacts: overrides.contacts ?? {
      list: async () => [], upsert: async (did: string, patch: any) => ({ did, ...patch }),
      remove: async () => false,
    },
    appRegistry: overrides.appRegistry ?? { list: async () => [] },
    ...overrides,
  };
  let kernel: ReturnType<typeof makeSemanticRouteKernel>;
  kernel = makeSemanticRouteKernel({
    ...deps,
    callSemantic: overrides.callSemantic ?? (async (payload: any) => {
      const authority = kernel.authorize(payload);
      const result: any = await dispatchSemanticRoute(payload, {
        signal: new AbortController().signal,
        authority,
        kernelCall: (operation: string, value: unknown) => kernel.handleKernelCall(
          operation, value, { capability: 'semantic.dispatch', authority },
        ),
      });
      return result?.ok === true && Object.hasOwn(result, 'semanticResult')
        ? result.semanticResult : result;
    }),
  });
  return { kernel, deps };
};

describe('migrated semantic route parity', () => {
  test('actor overview and count are differential-equivalent to the legacy route body', async () => {
    const { kernel, deps } = harness();
    const legacy = makeActorOverviewRoutes({
      vault: deps.vault, sessions: deps.sessions, turnSlots: deps.turnSlots,
      actorLiveProjection: deps.actorLiveProjection,
      isActualHomeSender: deps.isHomeSender,
    });
    const [legacyOverview, migratedOverview] = await Promise.all([
      legacy['actors/overview']({}, HOME), kernel.routes['actors/overview']({ type: 'actors/overview' }, HOME),
    ]);
    expect(withoutClock(migratedOverview)).toEqual(withoutClock(legacyOverview));
    const [legacyCount, migratedCount] = await Promise.all([
      legacy['actors/count']({}, HOME), kernel.routes['actors/count']({ type: 'actors/count' }, HOME),
    ]);
    expect(withoutClock(migratedCount)).toEqual(withoutClock(legacyCount));
  });

  test('sender and locked-vault refusals happen before controller startup', async () => {
    let starts = 0;
    const { kernel } = harness({
      callSemantic: async () => { starts += 1; return { ok: true }; },
    });
    await expect(kernel.routes['actors/overview']({ type: 'actors/overview' }, OTHER))
      .resolves.toEqual({ ok: false, error: 'actor-overview-unauthorized' });
    expect(starts).toBe(0);
  });

  test('kernel projection strips actor transcripts before crossing into the keyless host', async () => {
    let payload: any;
    const { kernel } = harness({
      actorLiveProjection: {
        rootSessionIds: () => ['root'], activeActorCount: () => 1,
        snapshot: () => ({
          actors: { t1: { sessionId: 'actor', rootSessionId: 'root', running: true,
            messages: [{ content: 'private transcript' }], toolInput: 'private input' } },
          spawned: { byToolUse: {}, sessions: {} }, asyncTasks: {},
        }),
      },
      callSemantic: async (value: any) => { payload = value; return { ok: true }; },
    });
    await kernel.routes['actors/overview']({ type: 'actors/overview' }, HOME);
    expect(JSON.stringify(payload)).not.toContain('private transcript');
    expect(JSON.stringify(payload)).not.toContain('private input');
  });

});
