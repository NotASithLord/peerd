import { describe, expect, test } from 'bun:test';
import { createKernelSemanticAuthority } from '../../extension/background/kernel-semantic-authority.js';
import { createKernelSemanticControl } from '../../extension/background/kernel-semantic-control.js';
import { makeActorOverviewRoutes } from '../../extension/background/routes/actor-overview.js';
import { makeContactsRoutes } from '../../extension/background/routes/contacts.js';
import { dispatchSemanticRoute } from '../../extension/offscreen/semantic-route-host.js';
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
  const vault = overrides.vault ?? { isLocked: () => false };
  const sessions = overrides.sessions ?? {
    getMetadata: async () => ({ kind: 'chat', title: 'Main', provider: 'p', model: 'm' }),
    getLatestNonSyntheticUserMessage: async () => ({ content: 'Build the thing' }),
  };
  const actorLiveProjection = overrides.actorLiveProjection ?? {
    rootSessionIds: () => ['root'], activeActorCount: () => 1,
    snapshot: () => ({ actors: { t1: {
      sessionId: 'actor', rootSessionId: 'root', parentSessionId: 'root',
      kind: 'actor', name: 'Worker', running: true, visibleTools: ['read'],
    } }, spawned: { byToolUse: {}, sessions: {} }, asyncTasks: {} }),
  };
  const turnSlots = overrides.turnSlots ?? {
    busySessionIds: () => ['root'], isBusy: () => true,
  };
  const auditLog = overrides.auditLog ?? { list: async () => [], append: async () => {} };
  const contacts = overrides.contacts ?? {
    list: async () => [], upsert: async (did: string, patch: any) => ({ did, ...patch }),
    remove: async () => false,
  };
  const appRegistry = overrides.appRegistry ?? { list: async () => [] };
  const actorRoutes = makeActorOverviewRoutes({
    vault, sessions, turnSlots, actorLiveProjection,
    isActualHomeSender: (sender: any) => sender === HOME,
  });
  const contactRoutes = makeContactsRoutes({
    vault, auditLog, contacts, appRegistry, mergeContacts,
  });
  const authority = createKernelSemanticAuthority({
    idb: {}, kv: {}, auditLog, vault, ready: Promise.resolve(), contacts,
    memory: { routes: {} },
  });
  let control: ReturnType<typeof createKernelSemanticControl>;
  const callSemantic = overrides.callSemantic ?? (async (payload: any) => {
    const grant = control.authorize(payload);
    const signal = new AbortController().signal;
    const result: any = await dispatchSemanticRoute(payload, {
      signal,
      authority: grant,
      kernelCall: (operation: string, value: unknown) => control.handleKernelCall(
        operation, value, { capability: 'semantic.dispatch', authority: grant, signal },
      ),
    });
    return result?.ok === true && Object.hasOwn(result, 'semanticResult')
      ? result.semanticResult : result;
  });
  control = createKernelSemanticControl({
    callSemantic,
    isHomeSender: (sender: any) => sender === HOME,
    vault,
    authority,
    localRoutes: { 'contacts/list': contactRoutes['contacts/list'] },
    actorCount: () => actorRoutes['actors/count']({}, HOME),
    actorOverview: () => actorRoutes['actors/overview']({}, HOME),
    awaitReady: async () => {},
  });
  return {
    control,
    deps: { vault, sessions, turnSlots, actorLiveProjection, contacts, auditLog, appRegistry },
    actorRoutes,
  };
};

describe('semantic control and host parity', () => {
  test('actor overview and count preserve the kernel projection', async () => {
    const { control, actorRoutes } = harness();
    const [expectedOverview, actualOverview] = await Promise.all([
      actorRoutes['actors/overview']({}, HOME),
      control.routes['actors/overview']({ type: 'actors/overview' }, HOME),
    ]);
    expect(withoutClock(actualOverview)).toEqual(withoutClock(expectedOverview));
    const [expectedCount, actualCount] = await Promise.all([
      actorRoutes['actors/count']({}, HOME),
      control.routes['actors/count']({ type: 'actors/count' }, HOME),
    ]);
    expect(withoutClock(actualCount)).toEqual(withoutClock(expectedCount));
  });

  test('sender refusal happens before controller startup', async () => {
    let starts = 0;
    const { control } = harness({
      callSemantic: async () => { starts += 1; return { ok: true }; },
    });
    await expect(control.routes['actors/overview']({ type: 'actors/overview' }, OTHER))
      .resolves.toEqual({ ok: false, error: 'actor-overview-unauthorized' });
    expect(starts).toBe(0);
  });

  test('kernel projection strips actor transcripts before the keyless host', async () => {
    let payload: any;
    const { control } = harness({
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
    await control.routes['actors/overview']({ type: 'actors/overview' }, HOME);
    expect(JSON.stringify(payload)).not.toContain('private transcript');
    expect(JSON.stringify(payload)).not.toContain('private input');
  });

  test('contact writes run sealed while reads and storage effects remain kernel-bound', async () => {
    const calls: string[] = [];
    const { control } = harness({
      contacts: {
        list: async () => { calls.push('list'); return []; },
        upsert: async (did: string, patch: any) => {
          calls.push('upsert'); return { did, ...patch };
        },
        remove: async () => { calls.push('remove'); return false; },
      },
    });
    await expect(control.routes['contacts/list']({ type: 'contacts/list' })).resolves.toEqual({
      ok: true, contacts: [],
    });
    await expect(control.routes['contacts/set']({
      type: 'contacts/set', did: 'did:key:z6MkContact', name: 'Peer',
    })).resolves.toEqual({
      ok: true, contact: { did: 'did:key:z6MkContact', name: 'Peer' },
    });
    await expect(control.routes['contacts/forget']({
      type: 'contacts/forget', did: 'did:key:z6MkContact',
    })).resolves.toEqual({ ok: false, error: 'contact-not-found' });
    expect(calls).toEqual(['list', 'upsert', 'remove']);
  });
});
