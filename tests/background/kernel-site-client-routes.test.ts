import { beforeAll, describe, expect, test } from 'bun:test';
import { useFakeIndexedDB } from '../setup.ts';
import {
  createKernelSiteClientRoutes,
  makeKernelVoiceAuditRoute,
} from '../../extension/background/kernel-utility-routes.js';
import { createSiteClientStore } from '../../extension/peerd-runtime/site-clients/store.js';

beforeAll(async () => { await useFakeIndexedDB(); });
let sequence = 0;
const dossier = {
  origin: 'api.example.com', summary: 'Example API',
  endpoints: [{ method: 'GET', path: '/v1/items' }],
  auth: 'bearer' as const, deriver: 'capture-cdp' as const,
};

describe('native Site Client routes', () => {
  test('lists only the exact legacy metadata projection and preserves the body', async () => {
    const dbName = `kernel-site-client-${++sequence}`;
    const rich = createSiteClientStore({ idbFactory: indexedDB, dbName, now: () => 123 });
    await rich.put({ dossier, body: 'return { secretBody: true }' });
    const routes = createKernelSiteClientRoutes({
      isAllowed: (sender) => sender === 'options', idbFactory: indexedDB, dbName,
    });
    await expect(routes['site-client/list']({}, 'options')).resolves.toEqual({
      ok: true,
      clients: [{
        origin: 'https://api.example.com', summary: 'Example API', endpoints: 1,
        auth: 'bearer', deriver: 'capture-cdp', sizeBytes: 27,
        derivedAt: 123, lastVerifiedAt: 0, recentFailures: 0,
      }],
    });
    expect((await rich.get('https://api.example.com'))?.body)
      .toBe('return { secretBody: true }');
    expect(JSON.stringify(await routes['site-client/list']({}, 'options')))
      .not.toContain('secretBody');
  });

  test('refuses forged senders and malformed deletes before opening storage', async () => {
    let opens = 0;
    const routes = createKernelSiteClientRoutes({
      isAllowed: (sender) => sender === 'options',
      idbFactory: { open: () => { opens += 1; throw new Error('must not open'); } } as any,
    });
    expect(await routes['site-client/list']({}, 'home'))
      .toEqual({ ok: false, error: 'site-client-unauthorized' });
    expect(await routes['site-client/delete']({ origin: 'https://api.example.com' }, 'app'))
      .toEqual({ ok: false, error: 'site-client-unauthorized' });
    expect(await routes['site-client/delete']({}, 'options'))
      .toEqual({ ok: false, error: 'origin-required' });
    expect(opens).toBe(0);
  });

  test('atomically removes metadata and body and survives a fresh kernel factory', async () => {
    const dbName = `kernel-site-client-${++sequence}`;
    const rich = createSiteClientStore({ idbFactory: indexedDB, dbName });
    await rich.put({ dossier, body: 'persisted module' });
    const first = createKernelSiteClientRoutes({ isAllowed: () => true, idbFactory: indexedDB, dbName });
    expect(await first['site-client/delete']({ origin: 'https://api.example.com' }, {})).toEqual({ ok: true });
    expect(await rich.get('https://api.example.com')).toBeNull();
    expect(await first['site-client/delete']({ origin: 'https://api.example.com' }, {})).toEqual({ ok: true });
    const successor = createKernelSiteClientRoutes({ isAllowed: () => true, idbFactory: indexedDB, dbName });
    expect(await successor['site-client/list']({}, {})).toEqual({ ok: true, clients: [] });
  });
});

test('native voice audit is type-locked, bounded, and human-document pinned', async () => {
  const entries: any[] = [];
  const route = makeKernelVoiceAuditRoute({
    auditLog: { append: async (entry) => { entries.push(entry); } },
    isAllowed: (sender) => sender === 'sidepanel' || sender === 'options',
  });
  expect(await route({ url: 'x'.repeat(400) }, 'engine'))
    .toEqual({ ok: false, error: 'voice-audit-unauthorized' });
  expect(await route({ url: 'x'.repeat(400), type: 'forged' } as any, 'options'))
    .toEqual({ ok: true });
  await Promise.resolve();
  expect(entries).toEqual([{
    type: 'voice_model_fetch', details: { url: 'x'.repeat(300) },
  }]);
});
