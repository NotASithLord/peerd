import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createPageToolAuthority } from '../../extension/background/page-tool-authority.js';
import { createResourceToolAuthority } from '../../extension/background/resource-tool-authority.js';
import { createOriginPacingStore } from '../../extension/peerd-runtime/pacing/origin-pacing-store.js';
import { makeWebFetch } from '../../extension/peerd-egress/fetch/web-fetch.js';
import { normalizeApiOrigin } from '../../extension/shared/api-origin.js';
import { makePacedOriginRoutes } from '../../extension/background/routes/paced-origins.js';
import { makeKernelRouteProvenance, makeVaultKernelMessageHandler } from '../../extension/background/vault-kernel-core.js';

const ORIGIN = 'https://www.wikipedia.org';
const fixture = (options: Record<string, any> = {}) => {
  let now = Date.now();
  let record: any = null;
  let actions = 0;
  let confirms = 0;
  let href = `${ORIGIN}/wiki/Test`;
  const store = createOriginPacingStore({
    kv: { get: async () => { await options.hydrate; return record; },
      set: async (_key, value) => { record = value; } },
    now: () => now,
    sleep: options.sleep ?? (async (duration) => { now += duration; }),
  });
  const ctx: any = {
    actorType: 'web', backing: 'tab', activeTab: { id: 7, url: href },
    permission: { mode: 'act', confirmActions: true },
    readAuthorityPermission: async () => ({ mode: 'act', confirmActions: true }),
    denylist: [], ensureBrowserNetworkGuard: async () => ({ ok: true }),
    armBrowserChildQuarantine: async () => ({ ok: true }),
    tabs: { get: async () => ({ id: 7, url: href }) },
    confirm: async () => { confirms += 1; return true; },
    pacing: {
      engaged: store.engaged,
      peek: async (origin: string, opts: any) => { await store.hydrate(); return store.peek(origin, opts); },
      reserve: store.reserve,
    },
    scripting: { executeScript: async (request: any) => {
      if (!request.target.documentIds) return [{ documentId: 'doc-1',
        result: { origin: new URL(href).origin, href, timeOrigin: 1 } }];
      if (!request.args) return [{ documentId: 'doc-1', result: { has: false, capped: false } }];
      actions += 1;
      return [{ documentId: 'doc-1', result: {
        ok: true, clicked: true, tag: 'BUTTON', text: 'Next', matchedCount: 1, nth: 0,
      } }];
    } },
  };
  const click = (signal?: AbortSignal) => createPageToolAuthority({
    binding: { operation: 'turn.page.click', args: { selector: '#next' } }, ctx, signal,
  }).clickOwnedTarget();
  return { store, ctx, click, now: () => now,
    seed: (value: any) => { record = value; },
    record: () => record,
    move: (value: string) => { href = value; },
    actions: () => actions, confirms: () => confirms };
};

describe('kernel pacing cutover', () => {
  test('cold page authority hydrates the durable deadline before confirmation or action', async () => {
    const entered = Promise.withResolvers<void>();
    const warm = fixture();
    await warm.store.observe({ origin: ORIGIN, responseAtMs: warm.now(), status: 429, retryAfter: '600' });
    const cold = fixture({ hydrate: entered.promise });
    cold.seed(warm.record());
    const running = cold.click();
    await Promise.resolve();
    expect(cold.actions()).toBe(0);
    expect(cold.confirms()).toBe(0);
    entered.resolve();
    expect(await running).toMatchObject({ ok: false, code: 'origin_pacing_ceiling', endTurn: true });
    expect(cold.actions()).toBe(0);
    expect(cold.confirms()).toBe(0);
  });

  test('a trusted Retry-After response delays both the next network read and browser write', async () => {
    const h = fixture();
    let requests = 0;
    const webFetch = makeWebFetch({
      getDenylist: () => [], matchDenylist: () => false,
      fetchFn: (async () => { requests += 1; return new Response('limited', {
        status: 429, headers: { 'retry-after': '1' },
      }); }) as unknown as typeof fetch,
      pace: { reserve: h.store.reserve, observe: h.store.observe,
        isWriteMethod: (method) => method !== 'GET', canonicalOrigin: normalizeApiOrigin },
    });
    await webFetch(ORIGIN);
    const deadline = h.record().entries[ORIGIN].notBeforeMs;
    await webFetch(ORIGIN);
    expect(h.now()).toBeGreaterThanOrEqual(deadline);
    await h.click();
    expect(h.actions()).toBe(1);
    expect(requests).toBe(2);
  });

  test('Stop cancels a paced click before any physical action', async () => {
    const entered = Promise.withResolvers<void>();
    const h = fixture({ sleep: (_duration: number, signal: AbortSignal) => {
      entered.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () =>
        reject(new DOMException('stopped', 'AbortError')), { once: true }));
    } });
    await h.store.observe({ origin: ORIGIN, responseAtMs: h.now(), status: 429, retryAfter: '1' });
    const controller = new AbortController();
    const running = h.click(controller.signal);
    await entered.promise;
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.actions()).toBe(0);
  });

  test('a page navigation during a wait cannot spend another origin reservation', async () => {
    const h = fixture({ sleep: async () => { h.move('https://other.example.org/'); } });
    h.ctx.pacing.reserve = async () => { h.move('https://other.example.org/'); return { outcome: 'waited', waitedMs: 100 }; };
    await h.store.observe({ origin: ORIGIN, responseAtMs: h.now(), status: 429, retryAfter: '1' });
    expect(await h.click()).toMatchObject({ ok: false, code: 'origin_pacing_ceiling', endTurn: true });
    expect(h.actions()).toBe(0);
  });

  test.each(['plan', 'confirmation'])('a paced click rechecks tightened %s policy at the physical edge', async (change) => {
    const h = fixture();
    const permission = { mode: 'act', confirmActions: false };
    h.ctx.readAuthorityPermission = async () => ({ ...permission });
    await h.store.observe({ origin: ORIGIN, responseAtMs: h.now(), status: 429, retryAfter: '1' });
    h.ctx.pacing.reserve = async () => {
      if (change === 'plan') permission.mode = 'plan';
      else permission.confirmActions = true;
      return { outcome: 'waited', waitedMs: 1 };
    };
    expect(await h.click()).toMatchObject({ ok: false, outcomeKind: 'pre-effect-failure' });
    expect(h.actions()).toBe(0);
    expect(h.confirms()).toBe(0);
  });

  test('network pacing refusal retains terminal pre-effect custody', async () => {
    const h = fixture();
    await h.store.observe({ origin: ORIGIN, responseAtMs: h.now(), status: 429, retryAfter: '600' });
    const webFetch = makeWebFetch({ getDenylist: () => [], matchDenylist: () => false,
      fetchFn: (async () => { throw new Error('must not fetch'); }) as unknown as typeof fetch,
      pace: { reserve: h.store.reserve, observe: h.store.observe,
        isWriteMethod: () => false, canonicalOrigin: normalizeApiOrigin } });
    const authority = createResourceToolAuthority({
      binding: { operation: 'turn.resource.request-web-text', args: { url: ORIGIN } },
      ctx: { webFetch },
    });
    expect(await authority.requestWebText({ url: ORIGIN, method: 'GET', headers: {} }))
      .toMatchObject({ ok: false, endTurn: true, performed: false,
        outcomeKnown: true, outcomeKind: 'pre-effect-failure', code: 'origin_pacing_ceiling' });
  });

  test('only the settings surface can list or forget pacing, never a controller or actor', async () => {
    const h = fixture();
    await h.store.observe({ origin: ORIGIN, responseAtMs: h.now(), status: 429 });
    const routes = makePacedOriginRoutes({ originPacing: h.store, normalizeApiOrigin });
    const routeProvenance = makeKernelRouteProvenance({
      humanUi: () => false, homeUi: () => false, sidepanelUi: () => false,
      optionsUi: (sender: any) => sender.surface === 'options', appUi: () => false,
      voiceUi: () => false, vaultRoutes: [],
    });
    const handler = makeVaultKernelMessageHandler({ routes, trusted: () => true,
      humanUi: () => false, humanRoutes: new Set(), routeProvenance });
    const invoke = (surface: string, type: string) => new Promise((resolve) =>
      handler({ type }, { surface }, resolve));
    for (const surface of ['actor', 'controller', 'offscreen', 'app']) {
      expect(await invoke(surface, 'paced/clear')).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    }
    expect((await h.store.list()).length).toBe(1);
    expect(await invoke('options', 'paced/clear')).toMatchObject({ ok: true, forgotten: 1 });
    expect(await h.store.list()).toEqual([]);
  });

  test('production shares one kernel-owned store rather than a semantic policy relay', () => {
    const support = readFileSync('extension/background/kernel-demand-support.js', 'utf8');
    const plane = readFileSync('extension/background/kernel-demand-plane.js', 'utf8');
    const adapter = readFileSync('extension/background/kernel-turn-authority-adapter.js', 'utf8');
    expect(support.match(/createOriginPacingStore\(/g)?.length).toBe(1);
    expect(plane).toContain('originPacing: support.originPacing');
    expect(adapter).toContain('deps.originPacing.reserve(origin, options)');
    expect(adapter).not.toContain('deps.originPacing.forget');
  });
});
