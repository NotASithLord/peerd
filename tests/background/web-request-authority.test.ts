import { describe, expect, test } from 'bun:test';
import { makeWebRequestAuthorityBinder, withRequestLocalWebFetch } from '../../extension/background/web-request-authority.js';
import { makeWebFetch, withSessionScopedCredentials, withWebRequestAuthority } from '../../extension/peerd-egress/fetch/web-fetch.js';
import { needsWebWriteConfirm } from '../../extension/peerd-engine/vm-net/http-bridge.js';
import { captureSessionAuthority } from '../../extension/shared/session-authority-epoch.js';
import { createSessionStore } from '../../extension/peerd-runtime/sessions/store.js';
import { restrictCtxCapabilities } from '../../extension/peerd-runtime/actor/spawn.js';

const bindWebRequestAuthority = makeWebRequestAuthorityBinder({ withWebRequestAuthority, needsWebWriteConfirm });

const setup = () => {
  let mode = 'act';
  let landing = 'https://app.example';
  const calls: any[] = [];
  let pace = async () => {};
  let permission = async () => {};
  let tab = async () => {};
  let judge = async () => {};
  const idb = { get: async () => ({ sessionId: 'chat', messagesV2: true, msgIndex: [], permissionMode: mode }),
    getAll: async () => [], put: async (_store: string, record: any) => { mode = record.permissionMode; } };
  const sessions = createSessionStore({ idb });
  const raw = makeWebFetch({ getDenylist: () => [], matchDenylist: () => false,
    pace: { canonicalOrigin: (origin) => origin, isWriteMethod: () => true,
      reserve: async () => { await pace(); return { outcome: 'waited', waitedMs: 1 }; }, observe: async () => {} },
    fetchFn: (async (_url, init) => { calls.push(init); return new Response('sent'); }) as typeof fetch });
  const guarded = withRequestLocalWebFetch(() => {
    let lastLanding: string | undefined;
    const checked = bindWebRequestAuthority({ webFetch: raw,
      captureRequestAuthority: () => captureSessionAuthority(idb),
      readPermission: async () => { const snapshot = mode; await permission(); return { mode: snapshot }; },
      reauthorize: async () => { await tab(); lastLanding = landing; await judge(); return true; },
    });
    return withSessionScopedCredentials(checked, () => lastLanding);
  });
  // The legacy production seam keeps the authority inside this fetch closure;
  // actor projection must not need or expose a generic policy callback.
  const ctx = restrictCtxCapabilities({ webFetch: guarded, permission: { mode: 'act' } }, new Set(['fetch_url']));
  const send = ctx.webFetch as typeof guarded;
  return { send, calls, sessions,
    setPace: (fn: () => Promise<void>) => { pace = fn; },
    setPermission: (fn: () => Promise<void>) => { permission = fn; },
    setTab: (fn: () => Promise<void>) => { tab = fn; },
    setJudge: (fn: () => Promise<void>) => { judge = fn; },
    move: () => { landing = 'https://other.example'; },
    moveHome: () => { landing = 'https://app.example'; },
  };
};

describe('legacy production request authority binding', () => {
  test('overlapping requests cannot replace each other’s last proven cookie origin', async () => {
    const f = setup();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let proofs = 0;
    f.setPace(async () => { if (proofs === 1) f.move(); });
    f.setJudge(async () => {
      if (++proofs === 2) { entered.resolve(); await resume.promise; }
    });
    const first = f.send('https://app.example/write', { method: 'POST' });
    await entered.promise;
    f.moveHome();
    await f.send('https://app.example/other', { method: 'POST' });
    resume.resolve();
    await first;
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].credentials).toBe('include');
    expect(f.calls[1].credentials).toBe('omit');
  });

  test('unchanged confirmed write survives actor capability projection and retains cookies', async () => {
    const f = setup();
    await f.send('https://app.example/write', { method: 'POST' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].credentials).toBe('include');
  });

  test('Plan changes during pacing refuse the final write', async () => {
    const f = setup();
    f.setPace(async () => { await f.sessions.update('chat', { permissionMode: 'plan' }); });
    await expect(f.send('https://app.example/write', { method: 'POST' })).rejects.toMatchObject({ performed: false });
    expect(f.calls).toHaveLength(0);
  });

  test('Plan changes during the final landing read invalidate the earlier permission proof', async () => {
    const f = setup();
    let reads = 0;
    f.setTab(async () => { if (++reads === 2) await f.sessions.update('chat', { permissionMode: 'plan' }); });
    await expect(f.send('https://app.example/write', { method: 'POST' })).rejects.toMatchObject({ performed: false });
    expect(f.calls).toHaveLength(0);
  });

  test('tab changes during final permission read are reflected in final cookie selection', async () => {
    const f = setup();
    let reads = 0;
    f.setPermission(async () => { if (++reads === 2) f.move(); });
    await f.send('https://app.example/write', { method: 'POST' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].credentials).toBe('omit');
  });

  test('a Request signal remains authoritative after asynchronous proof', async () => {
    const f = setup();
    const controller = new AbortController();
    f.setPace(async () => { controller.abort(); });
    await expect(f.send(new Request('https://app.example/write', { method: 'POST', signal: controller.signal })))
      .rejects.toMatchObject({ performed: false, outcomeKnown: true });
    expect(f.calls).toHaveLength(0);
  });
});
