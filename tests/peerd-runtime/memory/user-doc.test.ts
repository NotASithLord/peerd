// The user doc — onboarding seeding + the confirm gate it rides.
//
// seedUserDocBody is the pure half of "doc on the user": onboarding's
// optional basic facts in, markdown body out ('' = write nothing). The
// doc itself is just the memory system's 'user' scope, so the second
// describe verifies the load-bearing property end to end against the
// real store: USER-origin seeding commits directly (onboarding is an
// explicit act) while AGENT expansion of the SAME doc stays behind the
// confirmation gate — the lethal-trifecta seam the owner's "very very
// frugal" expansion must pass through.

import { describe, test, expect } from 'bun:test';

import { seedUserDocBody, USER_DOC_SCOPE }
  from '../../../extension/peerd-runtime/memory/user-doc.js';
import { createMemoryStore }
  from '../../../extension/peerd-runtime/memory/store.js';

/** Minimal in-memory stand-in for the egress idb adapter. */
const fakeIdb = () => {
  const stores = new Map<string, Map<string, any>>();
  const s = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    get: async (store: string, key: string) => s(store).get(key),
    put: async (store: string, value: any) => { s(store).set(value.id, value); },
    getAll: async (store: string) => [...s(store).values()],
    del: async (store: string, key: string) => { s(store).delete(key); },
  };
};

describe('seedUserDocBody', () => {
  test('returns "" when everything is empty (skip writes nothing)', () => {
    expect(seedUserDocBody()).toBe('');
    expect(seedUserDocBody({})).toBe('');
    expect(seedUserDocBody({ callMe: '  ', notes: '\n\n' })).toBe('');
  });

  test('builds a fresh doc with title, bullet, and notes', () => {
    const body = seedUserDocBody({ callMe: 'Ari', notes: 'I ship browser agents.' });
    expect(body).toBe([
      '# User memory',
      '',
      '## About the user',
      '- Prefers to be called: Ari',
      '',
      'I ship browser agents.',
      '',
    ].join('\n'));
  });

  test('callMe whitespace is collapsed to one clean line', () => {
    const body = seedUserDocBody({ callMe: '  Sam   Q ' });
    expect(body).toContain('- Prefers to be called: Sam Q');
  });

  test('appends to a prior body instead of clobbering it', () => {
    const prior = '# User memory\n\n- Already curated fact.\n';
    const body = seedUserDocBody({ callMe: 'Ariel' }, prior);
    expect(body.startsWith('# User memory\n\n- Already curated fact.')).toBe(true);
    expect(body).toContain('## About the user');
    expect(body).toContain('- Prefers to be called: Ariel');
    // Exactly one title — append, not a second fresh doc.
    expect(body.match(/^# User memory$/gm)!.length).toBe(1);
  });

  test('notes-only input still seeds', () => {
    const body = seedUserDocBody({ notes: 'Night owl. Prefers terse answers.' });
    expect(body).toContain('## About the user');
    expect(body).toContain('Night owl. Prefers terse answers.');
  });
});

describe('the user doc rides the memory confirm gate', () => {
  test('onboarding (user-origin) seed commits without a confirm channel', async () => {
    const store = createMemoryStore({ idb: fakeIdb(), now: () => 1000 });
    const body = seedUserDocBody({ callMe: 'Ariel' });
    const res = await store.writeWithConfirm({ scope: USER_DOC_SCOPE, body, origin: 'user' });
    expect(res.ok).toBe(true);
    expect((await store.readScope(USER_DOC_SCOPE))!.body).toContain('- Prefers to be called: Ariel');
  });

  test('agent expansion of the user doc fails closed without confirm, persists only on yes', async () => {
    const store = createMemoryStore({ idb: fakeIdb(), now: () => 1000 });
    await store.writeWithConfirm({
      scope: USER_DOC_SCOPE, body: seedUserDocBody({ callMe: 'Ariel' }), origin: 'user',
    });
    const expanded = `${(await store.readScope(USER_DOC_SCOPE))!.body}\n- Allergic to meetings.\n`;

    // No confirm channel → nothing persists (fail closed).
    const blocked = await store.writeWithConfirm({ scope: USER_DOC_SCOPE, body: expanded, origin: 'agent' });
    expect(blocked.ok).toBe(false);
    expect((await store.readScope(USER_DOC_SCOPE))!.body).not.toContain('Allergic');

    // Explicit no → still nothing.
    const denied = await store.writeWithConfirm({
      scope: USER_DOC_SCOPE, body: expanded, origin: 'agent', confirm: async () => 'no',
    });
    expect(denied.ok).toBe(false);
    expect((await store.readScope(USER_DOC_SCOPE))!.body).not.toContain('Allergic');

    // Explicit yes → the frugal append lands.
    const approved = await store.writeWithConfirm({
      scope: USER_DOC_SCOPE, body: expanded, origin: 'agent', confirm: async () => 'yes_once',
    });
    expect(approved.ok).toBe(true);
    expect((await store.readScope(USER_DOC_SCOPE))!.body).toContain('Allergic to meetings.');
  });
});
