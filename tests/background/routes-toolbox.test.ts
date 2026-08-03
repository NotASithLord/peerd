// design js-superpower/06 — the toolbox routes: 'toolbox/read' (the resolver
// relay — body-tier only, never a dossier, never into a prompt) and
// 'toolbox/record' (post-run rot bookkeeping). Import-free module; the store
// is injected, so a stub proves the reply shapes + pass-through.

import { describe, test, expect } from 'bun:test';
import { makeToolboxRoutes } from '../../extension/background/routes/toolbox.js';

const makeStubStore = () => {
  const bodies = new Map<string, string>([['tables', 'export const x = 1;']]);
  const recorded: Array<{ names: string[], ok: boolean }> = [];
  return {
    recorded,
    store: {
      getBody: async (name: string) => bodies.get(name) ?? null,
      recordRuns: async (names: string[], { ok }: { ok: boolean }) => { recorded.push({ names, ok }); },
    },
  };
};

describe('toolbox/read', () => {
  test('serves a stored body', async () => {
    const { store } = makeStubStore();
    const routes = makeToolboxRoutes({ toolboxStore: store });
    expect(await routes['toolbox/read']({ name: 'tables' })).toEqual({ ok: true, body: 'export const x = 1;' });
  });

  test('unknown module → ok:false with an actionable error (no throw)', async () => {
    const { store } = makeStubStore();
    const routes = makeToolboxRoutes({ toolboxStore: store });
    const r = await routes['toolbox/read']({ name: 'ghost' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ghost');
    expect(r.error).toContain('toolbox_list');
  });

  test('a store failure surfaces as ok:false, never a rejection', async () => {
    const routes = makeToolboxRoutes({ toolboxStore: { getBody: async () => { throw new Error('idb dead'); } } });
    const r = await routes['toolbox/read']({ name: 'tables' });
    expect(r).toEqual({ ok: false, error: 'idb dead' });
  });
});

describe('toolbox/record', () => {
  test('passes names + ok through to recordRuns, coercing shapes defensively', async () => {
    const { store, recorded } = makeStubStore();
    const routes = makeToolboxRoutes({ toolboxStore: store });
    expect(await routes['toolbox/record']({ names: ['a', 'b'], ok: true })).toEqual({ ok: true });
    // non-array names / non-boolean ok coerce rather than crash the host's fire-and-forget
    expect(await routes['toolbox/record']({ names: 'junk', ok: 'yes' })).toEqual({ ok: true });
    expect(recorded).toEqual([
      { names: ['a', 'b'], ok: true },
      { names: [], ok: false },
    ]);
  });
});
