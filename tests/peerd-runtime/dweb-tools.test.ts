import { describe, test, expect } from 'bun:test';
import { dwebShareTool } from '../../extension/peerd-runtime/tools/defs/dweb-share.js';
import { dwebDiscoverTool } from '../../extension/peerd-runtime/tools/defs/dweb-discover.js';
import { dwebInstallTool } from '../../extension/peerd-runtime/tools/defs/dweb-install.js';

// A mock ctx with a spyable dweb service + confirm. confirmActions default ON
// (so the dispatcher's gate owns the confirm and the tool does NOT double it).
const mkCtx = (over: any = {}) => {
  const calls: any = { share: [], discover: 0, install: [], confirm: [] };
  const ctx: any = {
    permission: { mode: 'act', confirmActions: true },
    session: { sessionId: 's1' },
    confirm: async (p: any) => { calls.confirm.push(p); return over.confirmAnswer ?? 'yes_once'; },
    dweb: {
      share: async (id: string) => { calls.share.push(id); return { ok: true, uri: 'peerd://did:key:zA/abc', hash: 'abc' }; },
      discover: async () => { calls.discover += 1; return { ok: true, apps: [{ name: 'Pong', dwapp_id: 'h1', uri: 'peerd://did/h1', publisher: 'did:key:zB' }] }; },
      install: async (a: any) => { calls.install.push(a); return { ok: true, app: { id: 'app9', name: a.name ?? 'Pong' } }; },
    },
    ...over,
  };
  return { ctx, calls };
};

describe('dweb tools — share', () => {
  test('errors when the dweb is unavailable (store / off)', async () => {
    const r = await dwebShareTool.execute({ appId: 'a1' }, { dweb: null } as any);
    expect(r).toMatchObject({ ok: false, error: 'dweb_unavailable' });
  });

  test('requires an appId', async () => {
    const { ctx } = mkCtx();
    expect(await dwebShareTool.execute({}, ctx)).toMatchObject({ ok: false, error: 'appId_required' });
  });

  test('confirmActions ON: shares without a tool-level confirm (the gate owns it)', async () => {
    const { ctx, calls } = mkCtx();
    const r = await dwebShareTool.execute({ appId: 'a1' }, ctx);
    expect(calls.confirm.length).toBe(0);            // no double-confirm
    expect(calls.share).toEqual(['a1']);
    expect(r.ok).toBe(true);
    expect(JSON.parse((r as any).content)).toMatchObject({ shared: true, uri: 'peerd://did:key:zA/abc' });
  });

  test('confirmActions OFF: force-confirms; a decline blocks the publish', async () => {
    const { ctx, calls } = mkCtx({ permission: { mode: 'act', confirmActions: false }, confirmAnswer: 'no' });
    const r = await dwebShareTool.execute({ appId: 'a1' }, ctx);
    expect(calls.confirm.length).toBe(1);
    expect(calls.share.length).toBe(0);              // never published
    expect(r).toMatchObject({ ok: false, error: 'declined' });
  });

  test('confirmActions OFF + approve: publishes', async () => {
    const { ctx, calls } = mkCtx({ permission: { mode: 'act', confirmActions: false }, confirmAnswer: 'yes_once' });
    const r = await dwebShareTool.execute({ appId: 'a1' }, ctx);
    expect(calls.confirm.length).toBe(1);
    expect(calls.share).toEqual(['a1']);
    expect(r.ok).toBe(true);
  });
});

describe('dweb tools — discover', () => {
  test('maps the heard apps (read-only, no confirm)', async () => {
    const { ctx, calls } = mkCtx();
    const r = await dwebDiscoverTool.execute({}, ctx);
    expect(calls.discover).toBe(1);
    expect(calls.confirm.length).toBe(0);
    const out = JSON.parse((r as any).content);
    expect(out.count).toBe(1);
    expect(out.apps[0]).toMatchObject({ name: 'Pong', uri: 'peerd://did/h1', publisher: 'did:key:zB' });
  });
});

describe('dweb tools — install', () => {
  test('requires a peerd:// uri', async () => {
    const { ctx } = mkCtx();
    expect(await dwebInstallTool.execute({ uri: 'https://evil.example' }, ctx)).toMatchObject({ ok: false, error: 'peerd_uri_required' });
  });

  test('confirmActions OFF: a decline blocks the install', async () => {
    const { ctx, calls } = mkCtx({ permission: { mode: 'act', confirmActions: false }, confirmAnswer: 'no' });
    const r = await dwebInstallTool.execute({ uri: 'peerd://did/h1' }, ctx);
    expect(calls.install.length).toBe(0);
    expect(r).toMatchObject({ ok: false, error: 'declined' });
  });

  test('installs and returns the new app id', async () => {
    const { ctx, calls } = mkCtx();
    const r = await dwebInstallTool.execute({ uri: 'peerd://did/h1', name: 'Pong' }, ctx);
    expect(calls.install[0]).toMatchObject({ uri: 'peerd://did/h1', name: 'Pong' });
    expect(JSON.parse((r as any).content)).toMatchObject({ installed: true, appId: 'app9', name: 'Pong' });
  });
});

// The tools carry the dweb flag the exposure filter reads.
describe('dweb tools — exposure metadata', () => {
  test('all three are flagged dweb + classified outward/read correctly', () => {
    expect(dwebShareTool.dweb).toBe(true);
    expect(dwebDiscoverTool.dweb).toBe(true);
    expect(dwebInstallTool.dweb).toBe(true);
    expect(dwebShareTool.sideEffect).toBe('mutate_external');   // EXTERNAL → Plan-blocked, Act-confirmed
    expect(dwebInstallTool.sideEffect).toBe('mutate_external');
    expect(dwebDiscoverTool.sideEffect).toBe('read');           // free
  });
});
