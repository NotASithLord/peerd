import { expect, test } from 'bun:test';
import { createDiscoverySettings } from '../../extension/offscreen/discovery-settings.js';
const deferred = () => { let resolve!: (value: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };

test('host starts paused and only strict authoritative booleans enable discovery', async () => {
  let result: any = { ok: true, discoveryEnabled: true };
  const applied: boolean[] = [];
  const host = createDiscoverySettings({ read: async () => result, apply: value => { applied.push(value); } });
  expect(host.enabled()).toBe(false);
  expect(await host.refresh()).toEqual({ ok: true, enabled: true });
  for (const value of [false, undefined, null, 'true', 1]) {
    result = { ok: true, discoveryEnabled: value };
    expect(await host.refresh()).toEqual({ ok: true, enabled: false });
    expect(host.enabled()).toBe(false);
  }
  expect(applied[0]).toBe(false);
  result = { ok: false, discoveryEnabled: true };
  expect(await host.refresh()).toMatchObject({ ok: false });
  expect(host.enabled()).toBe(false);
});

test('late old reads and notifications cannot restore superseded or stopped discovery', async () => {
  const reads = [deferred(), deferred(), deferred()]; let next = 0;
  const host = createDiscoverySettings({ read: () => reads[next++].promise, apply: () => {} });
  const old = host.refresh(); const current = host.refresh();
  reads[1].resolve({ ok: true, discoveryEnabled: false });
  expect(await current).toEqual({ ok: true, enabled: false });
  reads[0].resolve({ ok: true, discoveryEnabled: true });
  expect(await old).toMatchObject({ ok: false, error: 'discovery-refresh-superseded' });
  expect(host.enabled()).toBe(false);
  const stopped = host.refresh(); host.invalidate();
  reads[2].resolve({ ok: true, discoveryEnabled: true });
  expect(await stopped).toMatchObject({ ok: false });
  expect(host.enabled()).toBe(false);
});

test('read failure pauses discovery without throwing into transport policy hydration', async () => {
  const host = createDiscoverySettings({ read: async () => { throw new Error('storage unavailable'); }, apply: () => {} });
  expect(await host.refresh()).toEqual({ ok: false, error: 'discovery-settings-unavailable' });
  expect(host.enabled()).toBe(false);
});

test('actual host refresh command ignores requested values and never starts networking', async () => {
  const source = await Bun.file(new URL('../../extension/offscreen/dweb-base.js', import.meta.url)).text();
  const start = source.indexOf("case 'dweb/base-host/set-discovery':");
  const end = source.indexOf("case 'dweb/base-host/", start + 5);
  const route = source.slice(start, end);
  let starts = 0, reads = 0; let reply: any;
  const host = createDiscoverySettings({ read: async () => { reads++; return { ok: true, discoveryEnabled: false }; }, apply: () => {} });
  const execute = new Function('discoverySettings', 'start', 'sendResponse',
    `return async msg => { switch (msg.type) { ${route} } };`)(host,
    () => { starts++; throw new Error('unexpected startup'); }, (value: any) => { reply = value; });
  await execute({ type: 'dweb/base-host/set-discovery', enabled: true });
  expect(reply).toEqual({ ok: true, enabled: false });
  expect(reads).toBe(1); expect(starts).toBe(0);
});
