import { describe, expect, test } from 'bun:test';
import { createKernelProfileAuthority } from '../../extension/background/vault-kernel-core.js';
import { normalizeBody } from '../../extension/peerd-runtime/memory/memory.js';
import { seedUserDocBody } from '../../extension/peerd-runtime/memory/user-doc.js';

const makeIdb = () => {
  const data = new Map<string, Map<string, any>>([
    ['profiles', new Map()], ['agents_memory', new Map()], ['sessions', new Map()],
  ]);
  let failCommit = false;
  return {
    data,
    failNextCommit() { failCommit = true; },
    get: async (store: string, key: string) => structuredClone(data.get(store)?.get(key)),
    put: async (store: string, value: any) => { data.get(store)!.set(value.id, structuredClone(value)); },
    getAll: async (store: string) => [...data.get(store)!.values()].map((value) => structuredClone(value)),
    transact: async (names: string[], fn: Function) => {
      const draft = new Map(names.map((name) => [name, new Map(
        [...data.get(name)!.entries()].map(([key, value]) => [key, structuredClone(value)]),
      )]));
      const callbacks: Array<() => void> = [];
      const handles = Object.fromEntries(names.map((name) => [name, {
        get(key: string) {
          const request: any = { result: undefined, onsuccess: null };
          callbacks.push(() => {
            request.result = structuredClone(draft.get(name)?.get(key));
            request.onsuccess?.();
          });
          return request;
        },
        put(value: any) { draft.get(name)!.set(value.id, structuredClone(value)); },
      }]));
      const result = fn(handles, {});
      for (const callback of callbacks) callback();
      if (failCommit) { failCommit = false; throw new Error('commit-failed'); }
      for (const name of names) data.set(name, draft.get(name)!);
      return typeof result === 'function' ? result() : result;
    },
  };
};

describe('native onboarding/profile authority', () => {
  test('creates the default profile and reconciles only durable chat history', async () => {
    const idb = makeIdb();
    let chat = false;
    const authority = createKernelProfileAuthority({
      idb, sessions: { hasChat: async () => chat }, now: () => 10,
    });
    expect(await authority.reconcile()).toEqual({
      id: 'default', peerName: 'peerd', createdAt: 10, onboardingComplete: false,
    });
    chat = true;
    expect(await authority.reconcile()).toMatchObject({
      id: 'default', peerName: 'peerd', onboardingComplete: true, onboardedAt: 10,
    });
    expect(idb.data.get('agents_memory')!.size).toBe(0);
  });

  test('commits profile and canonical user memory together and is one-shot', async () => {
    const idb = makeIdb();
    idb.data.get('agents_memory')!.set('user', {
      id: 'user', kind: 'user', body: '# User memory\n\nExisting.\n', createdAt: 1, updatedAt: 1,
    });
    let now = 20;
    const authority = createKernelProfileAuthority({
      idb, sessions: { hasChat: async () => false }, now: () => now,
    });
    const result = await authority.complete({
      peerName: '  Nova   Peer  ', facts: { callMe: '  Ari   D  ', notes: 'Builds things.' },
    });
    expect(result).toMatchObject({ ok: true, profile: {
      id: 'default', peerName: 'Nova Peer', onboardingComplete: true, onboardedAt: 20,
    } });
    expect(idb.data.get('agents_memory')!.get('user')).toEqual({
      id: 'user', kind: 'user', workspace: '', createdAt: 1, updatedAt: 20,
      body: '# User memory\n\nExisting.\n\n## About the user\n- Prefers to be called: Ari D\n\nBuilds things.\n',
    });
    now = 30;
    const again = await authority.complete({
      peerName: 'Overwrite', facts: { notes: 'Duplicate' },
    });
    expect(again.profile.peerName).toBe('Nova Peer');
    expect(idb.data.get('agents_memory')!.get('user').updatedAt).toBe(20);
  });

  test('commit failure leaves neither half and invalid/corrupt input fails closed', async () => {
    const idb = makeIdb();
    const authority = createKernelProfileAuthority({
      idb, sessions: { hasChat: async () => false }, now: () => 40,
    });
    idb.failNextCommit();
    await expect(authority.complete({
      peerName: 'Nova', facts: { callMe: 'Ari' },
    })).rejects.toThrow('commit-failed');
    expect(idb.data.get('profiles')!.size).toBe(0);
    expect(idb.data.get('agents_memory')!.size).toBe(0);
    expect(await authority.complete({ facts: { notes: 'x'.repeat(24 * 1024 + 1) } }))
      .toEqual({ ok: false, error: 'onboarding-facts-invalid' });
    idb.data.get('profiles')!.set('default', { id: 'default', peerName: 3 });
    const fresh = createKernelProfileAuthority({
      idb, sessions: { hasChat: async () => false }, now: () => 40,
    });
    await expect(fresh.get()).rejects.toThrow('profile-record-invalid');
  });

  test('concurrent default read cannot re-arm a completed profile', async () => {
    const idb = makeIdb();
    let tick = 50;
    const authority = createKernelProfileAuthority({
      idb, sessions: { hasChat: async () => false }, now: () => tick++,
    });
    const [read, completed] = await Promise.all([
      authority.get(),
      authority.complete({ peerName: 'Nova', facts: { notes: 'Line 1   \n\n\nLine 2  ' } }),
    ]);
    expect(read.id).toBe('default');
    expect(completed.profile.onboardingComplete).toBe(true);
    expect(await authority.get()).toEqual(completed.profile);
    expect(idb.data.get('profiles')!.get('default')).toEqual(completed.profile);
    expect(idb.data.get('agents_memory')!.get('user').body)
      .toBe('# User memory\n\n## About the user\n\nLine 1\n\nLine 2\n');
  });

  test('an explicit completion upgrades a history-inferred latch exactly once', async () => {
    const idb = makeIdb();
    const authority = createKernelProfileAuthority({
      idb, sessions: { hasChat: async () => true }, now: () => 60,
    });
    expect(await authority.reconcile()).toMatchObject({
      onboardingComplete: true, onboardingInferred: true,
    });
    const explicit = await authority.complete({
      peerName: 'Nova', facts: { callMe: 'Ari' },
    });
    expect(explicit.profile).toMatchObject({
      peerName: 'Nova', onboardingComplete: true, onboardingInferred: false,
    });
    expect(idb.data.get('agents_memory')!.get('user').body)
      .toContain('Prefers to be called: Ari');
    expect((await authority.complete({ peerName: 'Again' })).profile.peerName).toBe('Nova');
  });

  test('matches canonical memory normalization at exact, multibyte, and prior-body limits', async () => {
    const prefix = seedUserDocBody({ notes: 'x' }).length - 1;
    for (const note of ['é漢'.repeat(20), `line 1  \n\n\nline 2\t`, 'x'.repeat(24_000 - prefix)]) {
      const idb = makeIdb();
      const authority = createKernelProfileAuthority({
        idb, sessions: { hasChat: async () => false }, now: () => 70,
      });
      expect((await authority.complete({ facts: { notes: note } })).ok).toBe(true);
      expect(idb.data.get('agents_memory')!.get('user').body)
        .toBe(normalizeBody(seedUserDocBody({ notes: note })));
    }

    const tooLarge = makeIdb();
    const tooLargeAuthority = createKernelProfileAuthority({
      idb: tooLarge, sessions: { hasChat: async () => false }, now: () => 71,
    });
    expect(await tooLargeAuthority.complete({
      facts: { notes: 'x'.repeat(24_001 - prefix) },
    })).toEqual({ ok: false, error: 'onboarding-facts-too-large' });
    expect(tooLarge.data.get('profiles')!.size).toBe(0);

    const prior = makeIdb();
    prior.data.get('agents_memory')!.set('user', {
      id: 'user', kind: 'user', body: 'p'.repeat(23_990), createdAt: 1, updatedAt: 1,
    });
    const priorAuthority = createKernelProfileAuthority({
      idb: prior, sessions: { hasChat: async () => false }, now: () => 72,
    });
    expect(await priorAuthority.complete({ facts: { notes: 'overflow' } }))
      .toEqual({ ok: false, error: 'onboarding-facts-too-large' });
    expect(prior.data.get('profiles')!.size).toBe(0);
  });
});
