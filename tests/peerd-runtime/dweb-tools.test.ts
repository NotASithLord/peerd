import { describe, test, expect } from 'bun:test';
import { dwebShareTool } from '../../extension/peerd-runtime/tools/defs/dweb-share.js';
import { dwebDiscoverTool } from '../../extension/peerd-runtime/tools/defs/dweb-discover.js';
import { dwebInstallTool } from '../../extension/peerd-runtime/tools/defs/dweb-install.js';
import { createDwebToolAuthority } from '../../extension/background/dweb-tool-authority.js';

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
      discover: async () => { calls.discover += 1; return { ok: true, apps: [{ name: 'Pong', dwapp_id: 'h1', slug: 'pong', seq: 7, uri: 'peerd://did/h1', publisher: 'did:key:zB' }] }; },
      install: async (a: any) => { calls.install.push(a); return { ok: true, app: { id: 'app9', name: a.name ?? 'Pong' } }; },
    },
    ...over,
  };
  return { ctx, calls };
};

const operationFor = (name: string) => ({
  dweb_share: 'turn.dweb.publish-confirmed-app',
  dweb_discover: 'turn.dweb.discover-apps',
  dweb_install: 'turn.dweb.install-confirmed-app',
}[name]);

const execute = (tool: any, args: any, ctx: any) => tool.execute(args, {
  session: ctx.session,
  dwebAuthority: createDwebToolAuthority({
    binding: { operation: operationFor(tool.name), args }, ctx,
  }),
} as any);

describe('dweb tools — share', () => {
  test('errors when the dweb is unavailable (store / off)', async () => {
    const r = await execute(dwebShareTool, { appId: 'a1' }, { dweb: null });
    expect(r).toMatchObject({ ok: false, error: 'dweb_unavailable', outcomeKind: 'pre-effect-failure' });
  });

  test('requires an appId', async () => {
    const { ctx } = mkCtx();
    expect(await execute(dwebShareTool, {}, ctx)).toMatchObject({
      ok: false, error: 'appId_required', outcomeKind: 'pre-effect-failure',
    });
  });

  test('confirmActions ON: the exact dweb authority owns exactly one confirmation', async () => {
    const { ctx, calls } = mkCtx();
    const r = await execute(dwebShareTool, { appId: 'a1' }, ctx);
    expect(calls.confirm.length).toBe(1);
    expect(calls.share).toEqual(['a1']);
    expect(r.ok).toBe(true);
    expect(JSON.parse((r as any).content)).toMatchObject({ shared: true, uri: 'peerd://did:key:zA/abc' });
  });

  test('confirmActions OFF: force-confirms; a decline blocks the publish', async () => {
    const { ctx, calls } = mkCtx({ permission: { mode: 'act', confirmActions: false }, confirmAnswer: 'no' });
    const r = await execute(dwebShareTool, { appId: 'a1' }, ctx);
    expect(calls.confirm.length).toBe(1);
    expect(calls.share.length).toBe(0);              // never published
    expect(r).toMatchObject({ ok: false, error: 'declined', outcomeKind: 'pre-effect-failure' });
  });

  test('confirmActions OFF + approve: publishes', async () => {
    const { ctx, calls } = mkCtx({ permission: { mode: 'act', confirmActions: false }, confirmAnswer: 'yes_once' });
    const r = await execute(dwebShareTool, { appId: 'a1' }, ctx);
    expect(calls.confirm.length).toBe(1);
    expect(calls.share).toEqual(['a1']);
    expect(r.ok).toBe(true);
  });

  test('surfaces committed cleanup warnings with a recovery instruction', async () => {
    const { ctx } = mkCtx({
      dweb: {
        share: async () => ({
          ok: true, uri: 'peerd://did/new', hash: 'new', cleanupPending: true,
          warning: 'previous-version-cleanup-pending',
        }),
      },
    });
    const result = await execute(dwebShareTool, { appId: 'a1' }, ctx);
    expect(result.ok).toBe(true);
    expect(JSON.parse((result as any).content)).toMatchObject({
      shared: true,
      hash: 'new',
      cleanupPending: true,
      warning: 'previous-version-cleanup-pending',
    });
    expect(JSON.parse((result as any).content).recovery).toContain('next share or delete');
  });
});

describe('dweb tools — discover', () => {
  test('maps the heard apps (read-only, no confirm)', async () => {
    const { ctx, calls } = mkCtx();
    const r = await execute(dwebDiscoverTool, {}, ctx);
    expect(calls.discover).toBe(1);
    expect(calls.confirm.length).toBe(0);
    const out = JSON.parse((r as any).content);
    expect(out.count).toBe(1);
    expect(out.apps[0]).toMatchObject({
      name: 'Pong', dwapp_id: 'h1', slug: 'pong', seq: 7,
      uri: 'peerd://did/h1', publisher: 'did:key:zB',
    });
  });
});

describe('dweb tools — install', () => {
  test('reports an unavailable dweb as a definitive pre-effect failure', async () => {
    expect(await execute(dwebInstallTool, { uri: 'peerd://did/hash' }, { dweb: null }))
      .toMatchObject({
        ok: false, error: 'dweb_unavailable', outcomeKind: 'pre-effect-failure',
      });
  });

  test('requires a peerd:// uri', async () => {
    const { ctx } = mkCtx();
    expect(await execute(dwebInstallTool, { uri: 'https://evil.example' }, ctx)).toMatchObject({
      ok: false, error: 'peerd_uri_required', outcomeKind: 'pre-effect-failure',
    });
  });

  test('confirmActions OFF: a decline blocks the install', async () => {
    const { ctx, calls } = mkCtx({ permission: { mode: 'act', confirmActions: false }, confirmAnswer: 'no' });
    const r = await execute(dwebInstallTool, { uri: 'peerd://did/h1' }, ctx);
    expect(calls.install.length).toBe(0);
    expect(r).toMatchObject({ ok: false, error: 'declined', outcomeKind: 'pre-effect-failure' });
  });

  test('installs and returns the new app id', async () => {
    const { ctx, calls } = mkCtx();
    const r = await execute(dwebInstallTool, { uri: 'peerd://did/h1', name: 'Pong' }, ctx);
    expect(calls.install[0]).toEqual({ uri: 'peerd://did/h1', name: 'Pong' });
    expect(JSON.parse((r as any).content)).toMatchObject({ installed: true, appId: 'app9', name: 'Pong' });
  });

  test('preserves a definitive pre-effect refusal from the service bridge', async () => {
    const { ctx } = mkCtx({
      dweb: {
        install: async () => ({
          ok: false, error: 'dweb-disabled', outcomeKind: 'pre-effect-failure',
        }),
      },
    });
    expect(await execute(dwebInstallTool, { uri: 'peerd://did/h1' }, ctx)).toMatchObject({
      ok: false, error: 'dweb-disabled', outcomeKind: 'pre-effect-failure',
    });
  });

  test('surfaces a committed install audit warning to the model', async () => {
    const { ctx } = mkCtx({
      dweb: {
        install: async () => ({
          ok: true, app: { id: 'app9', name: 'Pong' }, warning: 'audit-write-failed',
        }),
      },
    });
    const result = await execute(dwebInstallTool, { uri: 'peerd://did/h1' }, ctx);
    expect(JSON.parse((result as any).content)).toMatchObject({
      installed: true, appId: 'app9', warning: 'audit-write-failed',
    });
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
