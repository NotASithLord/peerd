import { describe, expect, test } from 'bun:test';
import {
  createKernelFirefoxUpdateCustody,
  FIREFOX_UPDATE_CUSTODY_KEY,
  selectFirefoxPreviewUpdate,
} from '../../extension/background/kernel-firefox-update-custody.js';

const manifest = {
  version: '0.9.0',
  browser_specific_settings: { gecko: {
    id: 'peerd-preview@example.invalid',
    update_url: 'https://peerd.ai/updates/firefox-preview.json',
  } },
};
const candidate = {
  version: '0.10.0',
  update_link: 'https://github.com/NotASithLord/peerd/releases/download/v0.10.0/peerd-preview-firefox.xpi',
};

describe('Firefox preview update custody', () => {
  test('accepts only the exact repository XPI path with a matching version', () => {
    expect(selectFirefoxPreviewUpdate({ addons: {
      [manifest.browser_specific_settings.gecko.id]: { updates: [
        { ...candidate, update_link: 'https://github.com/other/repo/releases/download/v0.10.0/peerd-preview-firefox.xpi' },
        { ...candidate, update_link: 'https://github.com/NotASithLord/peerd/releases/download/v9.0.0/peerd-preview-firefox.xpi' },
        { ...candidate, update_link: 'https://github.com:444/NotASithLord/peerd/releases/download/v0.10.0/peerd-preview-firefox.xpi' },
        candidate,
      ] },
    } }, manifest.browser_specific_settings.gecko.id)).toEqual({
      version: candidate.version, url: candidate.update_link,
    });
  });

  test('rejects a manifest feed on a non-default HTTPS port', async () => {
    let fetches = 0;
    const custody = createKernelFirefoxUpdateCustody({
      runtime: { getManifest: () => ({
        ...manifest,
        browser_specific_settings: { gecko: {
          ...manifest.browser_specific_settings.gecko,
          update_url: 'https://peerd.ai:444/updates/firefox-preview.json',
        } },
      }) },
      session: { get: async () => null, set: async () => {} },
      fetchFn: async () => { fetches += 1; return { ok: false }; },
      ready: async () => {}, isEnabled: () => true, notify: () => false,
    });
    expect(await custody.checkNow()).toBe(false);
    expect(fetches).toBe(0);
  });

  test('Store Firefox stays inert when its manifest has no self-hosted feed', async () => {
    let fetches = 0;
    const custody = createKernelFirefoxUpdateCustody({
      runtime: { getManifest: () => ({
        version: manifest.version,
        browser_specific_settings: { gecko: { id: 'peerd@example.invalid' } },
      }) },
      session: { get: async () => null, set: async () => {} },
      fetchFn: async () => { fetches += 1; return { ok: false }; },
      ready: async () => {}, isEnabled: () => true, notify: () => false,
    });
    expect(await custody.start()).toBe(false);
    expect(fetches).toBe(0);
  });

  test('persists a validated update and marks only a delivered notice', async () => {
    const values = new Map<string, any>();
    const notices: any[] = [];
    let connected = false;
    let fetches = 0;
    const custody = createKernelFirefoxUpdateCustody({
      runtime: { getManifest: () => manifest },
      session: {
        get: async (key: string) => structuredClone(values.get(key)),
        set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
      },
      fetchFn: async (_url: string, init: any) => {
        fetches += 1;
        expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
        return { ok: true, json: async () => ({ addons: {
          [manifest.browser_specific_settings.gecko.id]: { updates: [candidate] },
        } }) };
      },
      ready: async () => {},
      isEnabled: () => true,
      notify: (text: string, action: any) => {
        if (!connected) return false;
        notices.push({ text, action });
        return true;
      },
      now: () => 10_000,
    });
    await custody.start();
    expect(fetches).toBe(1);
    expect(values.get(FIREFOX_UPDATE_CUSTODY_KEY).pending.version).toBe('0.10.0');
    expect(values.get(FIREFOX_UPDATE_CUSTODY_KEY).notifiedVersion).toBeNull();
    connected = true;
    await custody.onUiConnect();
    expect(fetches).toBe(1);
    expect(notices).toHaveLength(1);
    expect(notices[0].action).toEqual({
      kind: 'open-url', label: 'Install update', url: candidate.update_link,
    });
    expect(values.get(FIREFOX_UPDATE_CUSTODY_KEY).notifiedVersion).toBe('0.10.0');
  });

  test('a failed feed read does not start the throttle', async () => {
    const values = new Map<string, any>();
    let fail = true;
    let fetches = 0;
    const custody = createKernelFirefoxUpdateCustody({
      runtime: { getManifest: () => manifest },
      session: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: any) => { values.set(key, value); },
      },
      fetchFn: async () => {
        fetches += 1;
        if (fail) throw new Error('offline');
        return { ok: true, json: async () => ({ addons: {} }) };
      },
      ready: async () => {}, isEnabled: () => true, notify: () => false,
      now: () => 20_000,
    });
    await custody.checkNow();
    fail = false;
    await custody.checkNow();
    expect(fetches).toBe(2);
  });

  test('a hung feed is aborted and cannot pin later checks', async () => {
    const values = new Map<string, any>();
    let fetches = 0;
    let aborted = false;
    const custody = createKernelFirefoxUpdateCustody({
      runtime: { getManifest: () => manifest },
      session: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: any) => { values.set(key, value); },
      },
      fetchFn: async (_url: string, init: any) => {
        fetches += 1;
        if (fetches > 1) return { ok: true, json: async () => ({ addons: {} }) };
        init.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return new Promise(() => {});
      },
      ready: async () => {}, isEnabled: () => true, notify: () => false,
      feedTimeoutMs: 5,
    });
    await expect(custody.checkNow()).resolves.toBe(false);
    expect(aborted).toBe(true);
    await expect(custody.onUiConnect()).resolves.toBe(true);
    expect(fetches).toBe(2);
  });

  test('a hung response body cannot pin later checks', async () => {
    let fetches = 0;
    const custody = createKernelFirefoxUpdateCustody({
      runtime: { getManifest: () => manifest },
      session: { get: async () => null, set: async () => {} },
      fetchFn: async () => {
        fetches += 1;
        return fetches === 1
          ? { ok: true, json: async () => new Promise(() => {}) }
          : { ok: true, json: async () => ({ addons: {} }) };
      },
      ready: async () => {}, isEnabled: () => true, notify: () => false,
      feedTimeoutMs: 5,
    });
    await expect(custody.checkNow()).resolves.toBe(false);
    await expect(custody.checkNow()).resolves.toBe(true);
    expect(fetches).toBe(2);
  });

  test('revalidates persisted notices and serializes concurrent UI delivery', async () => {
    const values = new Map<string, any>([[FIREFOX_UPDATE_CUSTODY_KEY, {
      schema: 1, lastCheckAt: 10_000,
      pending: { version: '0.10.0', url: candidate.update_link },
      notifiedVersion: null,
    }]]);
    let notices = 0;
    const custody = createKernelFirefoxUpdateCustody({
      runtime: { getManifest: () => manifest },
      session: {
        get: async (key: string) => structuredClone(values.get(key)),
        set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
      },
      fetchFn: async () => { throw new Error('throttled'); },
      ready: async () => {}, isEnabled: () => true,
      notify: () => { notices += 1; return true; },
      now: () => 10_001,
    });
    await Promise.all([custody.onUiConnect(), custody.onUiConnect()]);
    expect(notices).toBe(1);

    values.set(FIREFOX_UPDATE_CUSTODY_KEY, {
      schema: 1, lastCheckAt: 10_000,
      pending: { version: '0.11.0', url: 'https://evil.example/update.xpi' },
      notifiedVersion: null,
    });
    await custody.onUiConnect();
    expect(notices).toBe(1);
    expect(values.get(FIREFOX_UPDATE_CUSTODY_KEY).pending).toBeNull();
  });

  test('a completed feed check clears a withdrawn pending offer before notification', async () => {
    const values = new Map<string, any>([[FIREFOX_UPDATE_CUSTODY_KEY, {
      schema: 1, lastCheckAt: null,
      pending: { version: candidate.version, url: candidate.update_link },
      notifiedVersion: null,
    }]]);
    let notices = 0;
    const custody = createKernelFirefoxUpdateCustody({
      runtime: { getManifest: () => manifest },
      session: {
        get: async (key: string) => structuredClone(values.get(key)),
        set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
      },
      fetchFn: async () => ({ ok: true, json: async () => ({ addons: {} }) }),
      ready: async () => {}, isEnabled: () => true,
      notify: () => { notices += 1; return true; },
      now: () => 30_000,
    });
    await custody.checkNow();
    expect(notices).toBe(0);
    expect(values.get(FIREFOX_UPDATE_CUSTODY_KEY)).toMatchObject({
      lastCheckAt: 30_000, pending: null, notifiedVersion: null,
    });
  });

  test('a due UI reconnect refreshes a withdrawn offer before it can notify', async () => {
    const values = new Map<string, any>([[FIREFOX_UPDATE_CUSTODY_KEY, {
      schema: 1, lastCheckAt: 10_000,
      pending: { version: candidate.version, url: candidate.update_link },
      notifiedVersion: null,
    }]]);
    let notices = 0;
    const custody = createKernelFirefoxUpdateCustody({
      runtime: { getManifest: () => manifest },
      session: {
        get: async (key: string) => structuredClone(values.get(key)),
        set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
      },
      fetchFn: async () => ({ ok: true, json: async () => ({ addons: {} }) }),
      ready: async () => {}, isEnabled: () => true,
      notify: () => { notices += 1; return true; },
      now: () => 10_000 + 6 * 60 * 60 * 1000,
    });
    await custody.onUiConnect();
    expect(notices).toBe(0);
    expect(values.get(FIREFOX_UPDATE_CUSTODY_KEY)).toMatchObject({
      pending: null, notifiedVersion: null,
    });
  });

  test('an equal feed candidate clears a stale newer pending offer', async () => {
    const values = new Map<string, any>([[FIREFOX_UPDATE_CUSTODY_KEY, {
      schema: 1, lastCheckAt: null,
      pending: { version: candidate.version, url: candidate.update_link },
      notifiedVersion: candidate.version,
    }]]);
    const equal = {
      version: manifest.version,
      update_link: 'https://github.com/NotASithLord/peerd/releases/download/v0.9.0/peerd-preview-firefox.xpi',
    };
    const custody = createKernelFirefoxUpdateCustody({
      runtime: { getManifest: () => manifest },
      session: {
        get: async (key: string) => structuredClone(values.get(key)),
        set: async (key: string, value: any) => { values.set(key, structuredClone(value)); },
      },
      fetchFn: async () => ({ ok: true, json: async () => ({ addons: {
        [manifest.browser_specific_settings.gecko.id]: { updates: [equal] },
      } }) }),
      ready: async () => {}, isEnabled: () => true, notify: () => true,
      now: () => 40_000,
    });
    await custody.checkNow();
    expect(values.get(FIREFOX_UPDATE_CUSTODY_KEY)).toMatchObject({
      pending: null, notifiedVersion: null,
    });
  });
});
