import { describe, expect, test } from 'bun:test';
import { makeSemanticRouteKernel } from '../../extension/background/semantic-route-kernel.js';
import { dispatchSemanticRoute } from '../../extension/offscreen/semantic-route-host.js';
import { makeActorOverviewRoutes } from '../../extension/background/routes/actor-overview.js';
import { makeContactsRoutes } from '../../extension/background/routes/contacts.js';
import { makeToolboxRoutes } from '../../extension/background/routes/toolbox.js';
import { createControllerKernelQuota } from '../../extension/shared/controller-kernel-quota.js';
import { mergeContacts } from '../../extension/peerd-runtime/contacts/aggregate.js';

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

  test('toolbox read/record preserve success, unknown, coercion, and storage failures', async () => {
    const records: any[] = [];
    const store = {
      getBody: async (name: string) => {
        if (name === 'fail') throw new Error('idb dead');
        return name === 'known' ? 'export default 1' : null;
      },
      recordRuns: async (names: any[], result: any) => { records.push({ names, result }); },
    };
    const { kernel } = harness({ toolboxStore: store });
    const legacy = makeToolboxRoutes({ toolboxStore: store });
    for (const message of [
      { type: 'toolbox/read', name: 'known' },
      { type: 'toolbox/read', name: 'missing' },
      { type: 'toolbox/read', name: 'fail' },
    ]) {
      expect(await kernel.routes['toolbox/read'](message)).toEqual(await legacy['toolbox/read'](message));
    }
    expect(await kernel.routes['toolbox/record']({
      type: 'toolbox/record', names: 'bad', ok: 1,
    })).toEqual(await legacy['toolbox/record']({ names: 'bad', ok: 1 }));
    expect(records.at(-2)).toEqual(records.at(-1));
  });

  test('contacts list/set/forget are differential-equivalent and keep storage in the kernel', async () => {
    const makeStores = () => {
      const rows = new Map<string, any>([['did:key:zSaved', {
        did: 'did:key:zSaved', name: 'Alice', favorite: true, tags: ['friend'],
      }]]);
      return {
        auditLog: { list: async () => [{
          when: 10, type: 'dweb_app_installed', details: { publisher: 'did:key:zPeer' },
        }] },
        appRegistry: { list: async () => [{
          id: 'app-1', name: 'Notes', dweb: { publisher: 'did:key:zPeer', version_id: 'v1' },
        }] },
        contacts: {
          list: async () => [...rows.values()],
          upsert: async (did: string, patch: any) => {
            const value = { ...(rows.get(did) ?? { did }), ...patch };
            rows.set(did, value);
            return value;
          },
          remove: async (did: string) => rows.delete(did),
        },
      };
    };
    const migratedStores = makeStores();
    const legacyStores = makeStores();
    const { kernel } = harness(migratedStores);
    const migratedRoutes = kernel.routes as unknown as Record<string, (message: any) => any>;
    const legacy = makeContactsRoutes({
      vault: { isLocked: () => false }, ...legacyStores, mergeContacts,
    });
    for (const message of [
      { type: 'contacts/list' },
      { type: 'contacts/set', did: 'did:key:zSaved', notes: 'trusted', favorite: false },
      { type: 'contacts/forget', did: 'did:key:zSaved' },
      { type: 'contacts/forget', did: 'did:key:zMissing' },
    ]) {
      expect(await migratedRoutes[message.type](message)).toEqual(
        await legacy[message.type](message),
      );
    }
  });

  test('contacts refuse while locked before controller startup', async () => {
    let starts = 0;
    const { kernel } = harness({
      vault: { isLocked: () => true },
      callSemantic: async () => { starts += 1; return { ok: true }; },
    });
    const routes = kernel.routes as unknown as Record<string, (message: any) => any>;
    for (const route of ['contacts/list', 'contacts/set', 'contacts/forget']) {
      expect(await routes[route]({ type: route }))
        .toEqual({ ok: false, error: 'vault-locked' });
    }
    expect(starts).toBe(0);
  });

  test('contacts list gets exactly three independent read grants and no mutation grant', () => {
    const quota = createControllerKernelQuota('semantic.dispatch', {
      protocol: 1, route: 'contacts/list', message: { type: 'contacts/list' },
    });
    for (const operation of [
      'semantic.contacts.list-saved',
      'semantic.contacts.list-apps',
      'semantic.contacts.list-audit',
    ]) expect(quota.admit(operation, {})).toMatchObject({ ok: true });
    expect(quota.admit('semantic.contacts.list-saved', {}))
      .toMatchObject({ ok: false, code: 'kernel-operation-denied' });
    expect(quota.admit('semantic.contacts.upsert', {}))
      .toMatchObject({ ok: false, code: 'kernel-operation-denied' });
  });

  test('authority is one-shot and kernel operations are route-bound', async () => {
    const { kernel } = harness();
    let captured: any;
    const isolated = makeSemanticRouteKernel({
      isHomeSender: () => true,
      vault: { isLocked: () => false },
      sessions: { getMetadata: async () => null, getLatestNonSyntheticUserMessage: async () => null },
      actorLiveProjection: { rootSessionIds: () => [], snapshot: () => ({}), activeActorCount: () => 0 },
      turnSlots: { busySessionIds: () => [], isBusy: () => false },
      toolboxStore: { getBody: async () => 'body', recordRuns: async () => {} },
      auditLog: { list: async () => [] },
      contacts: { list: async () => [], upsert: async () => null, remove: async () => false },
      appRegistry: { list: async () => [] },
      callSemantic: async (payload) => { captured = payload; return { ok: true }; },
    });
    await isolated.routes['toolbox/read']({ type: 'toolbox/read', name: 'known' });
    const authority = isolated.authorize(captured);
    expect(authority).toMatchObject({ target: 'semantic:toolbox/read:first-party', replayClass: 'A' });
    expect(isolated.authorize(captured)).toBeNull();
    await expect(kernel.handleKernelCall('semantic.toolbox.record-runs', {}, {
      authority: { target: 'semantic:toolbox/read:first-party' },
    })).resolves.toMatchObject({ ok: false, code: 'semantic-kernel-operation-denied' });
  });
});
