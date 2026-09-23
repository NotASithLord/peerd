import { describe, expect, test } from 'bun:test';
import { makeWebRequestAuthorityBinder } from '../../extension/background/web-request-authority.js';
import { makeWebFetch, withSessionScopedCredentials, withWebRequestAuthority } from '../../extension/peerd-egress/fetch/web-fetch.js';
import { needsWebWriteConfirm } from '../../extension/peerd-engine/vm-net/http-bridge.js';
import { captureSessionAuthority } from '../../extension/shared/session-authority-epoch.js';
import { createSessionStore } from '../../extension/peerd-runtime/sessions/store.js';
import { restrictCtxCapabilities } from '../../extension/peerd-runtime/actor/spawn.js';

const bindWebRequestAuthority = makeWebRequestAuthorityBinder({ withWebRequestAuthority, needsWebWriteConfirm });

const setup = () => {
  let mode = 'act';
  let landing = 'https://app.example';
  let lastLanding: string | undefined;
  const calls: any[] = [];
  let pace = async () => {};
  let permission = async () => {};
  let tab = async () => {};
  const idb = { get: async () => ({ sessionId: 'chat', messagesV2: true, msgIndex: [], permissionMode: mode }),
    getAll: async () => [], put: async (_store: string, record: any) => { mode = record.permissionMode; } };
  const sessions = createSessionStore({ idb });
  const raw = makeWebFetch({ getDenylist: () => [], matchDenylist: () => false,
    pace: { canonicalOrigin: (origin) => origin, isWriteMethod: () => true,
      reserve: async () => { await pace(); return { outcome: 'waited', waitedMs: 1 }; }, observe: async () => {} },
    fetchFn: (async (_url, init) => { calls.push(init); return new Response('sent'); }) as typeof fetch });
  const guarded = bindWebRequestAuthority({ webFetch: raw,
    captureRequestAuthority: () => captureSessionAuthority(idb),
    readPermission: async () => { const snapshot = mode; await permission(); return { mode: snapshot }; },
    reauthorize: async () => { await tab(); lastLanding = landing; return true; },
  });
  // The legacy production seam keeps the authority inside this fetch closure;
  // actor projection must not need or expose a generic policy callback.
  const ctx = restrictCtxCapabilities({ webFetch: guarded, permission: { mode: 'act' } }, new Set(['fetch_url']));
  const send = withSessionScopedCredentials(ctx.webFetch as typeof guarded, () => lastLanding);
  return { send, calls, sessions,
    setPace: (fn: () => Promise<void>) => { pace = fn; },
    setPermission: (fn: () => Promise<void>) => { permission = fn; },
    setTab: (fn: () => Promise<void>) => { tab = fn; },
    move: () => { landing = 'https://other.example'; },
  };
};

describe('legacy production request authority binding', () => {
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
