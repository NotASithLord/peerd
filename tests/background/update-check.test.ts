import { describe, test, expect } from 'bun:test';
import {
  compareVersions, latestGeckoUpdate, makeUpdateCheck,
  UPDATE_CHECK_SESSION_KEY, MIN_CHECK_INTERVAL_MS,
} from '../../extension/background/update-check.js';

// Pins the preview self-update contract: the pure version/feed logic, the
// Chrome requestUpdateCheck → onUpdateAvailable → reload-when-quiet flow
// (with the onQuiet re-arm), the Firefox feed → persisted-notice flow, the
// Firefox listener-presence semantics (register only on self-hosted
// manifests; disabled restores the no-listener default), and the structural
// no-op on manifests without a self-hosted update_url (dev, store).

describe('compareVersions', () => {
  test('orders numeric triples', () => {
    expect(compareVersions('0.6.0', '0.7.0')).toBeLessThan(0);
    expect(compareVersions('0.7.0', '0.6.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0);
  });
  test('missing parts count as zero', () => {
    expect(compareVersions('0.6', '0.6.0')).toBe(0);
    expect(compareVersions('0.6.1', '0.6')).toBeGreaterThan(0);
  });
  test('garbage parts count as zero, never NaN-poison the compare', () => {
    expect(compareVersions('x.y', '0.0')).toBe(0);
    expect(compareVersions('0.abc.1', '0.0.1')).toBe(0);
  });
});

describe('latestGeckoUpdate', () => {
  const GECKO_ID = 'peerd-preview@peerd.ai';
  const feed = (updates: unknown[]) => ({ addons: { [GECKO_ID]: { updates } } });

  test('picks the highest version', () => {
    const result = latestGeckoUpdate(feed([
      { version: '0.6.0', update_link: 'https://github.com/a.xpi' },
      { version: '0.7.1', update_link: 'https://github.com/c.xpi' },
      { version: '0.7.0', update_link: 'https://github.com/b.xpi' },
    ]), GECKO_ID);
    expect(result).toEqual({ version: '0.7.1', updateLink: 'https://github.com/c.xpi' });
  });
  test('skips non-https links and malformed entries', () => {
    const result = latestGeckoUpdate(feed([
      { version: '0.9.0', update_link: 'http://github.com/evil.xpi' },
      { version: '0.9.1', update_link: 'not a url' },
      { version: 42, update_link: 'https://github.com/x.xpi' },
      null,
      { version: '0.8.0', update_link: 'https://github.com/ok.xpi' },
    ]), GECKO_ID);
    expect(result).toEqual({ version: '0.8.0', updateLink: 'https://github.com/ok.xpi' });
  });
  test('rejects hosts outside the allow-list - a compromised feed cannot aim the Install button elsewhere', () => {
    const result = latestGeckoUpdate(feed([
      { version: '0.9.0', update_link: 'https://evil.example/fake-peerd.xpi' },
      { version: '0.8.0', update_link: 'https://peerd.ai/dl/ok.xpi' },
    ]), GECKO_ID);
    expect(result).toEqual({ version: '0.8.0', updateLink: 'https://peerd.ai/dl/ok.xpi' });
  });
  test('rejects junk version strings before they reach the compare or the notice copy', () => {
    expect(latestGeckoUpdate(feed([
      { version: '0.7.0-beta<script>', update_link: 'https://github.com/a.xpi' },
      { version: '9'.repeat(64), update_link: 'https://github.com/b.xpi' },
    ]), GECKO_ID)).toBeNull();
  });
  test('null on a missing addon id or malformed feed', () => {
    expect(latestGeckoUpdate(feed([]), GECKO_ID)).toBeNull();
    expect(latestGeckoUpdate({ addons: {} }, GECKO_ID)).toBeNull();
    expect(latestGeckoUpdate(null, GECKO_ID)).toBeNull();
    expect(latestGeckoUpdate('garbage', GECKO_ID)).toBeNull();
  });
});

type Manifest = {
  version: string,
  update_url?: string,
  browser_specific_settings?: { gecko?: { id?: string, update_url?: string } },
};

const CHROME_MANIFEST: Manifest = {
  version: '0.6.0',
  update_url: 'https://peerd.ai/updates/chrome-preview.xml',
};
const FIREFOX_MANIFEST: Manifest = {
  version: '0.6.0',
  browser_specific_settings: {
    gecko: { id: 'peerd-preview@peerd.ai', update_url: 'https://peerd.ai/updates/firefox-preview.json' },
  },
};
// Store-Firefox shape: gecko id present, but NO self-hosted update_url.
const STORE_FIREFOX_MANIFEST: Manifest = {
  version: '0.6.0',
  browser_specific_settings: { gecko: { id: 'peerd@peerd.ai' } },
};
const FEED = {
  addons: {
    'peerd-preview@peerd.ai': {
      updates: [{ version: '0.7.0', update_link: 'https://github.com/NotASithLord/peerd/releases/download/v0.7.0/peerd-preview-firefox.xpi' }],
    },
  },
};

const makeHarness = (over: {
  manifest?: Manifest,
  enabled?: boolean,
  busy?: boolean,
  surfaces?: boolean,
  delivered?: boolean,
  feedJson?: unknown,
  fetchFails?: boolean,
  session?: Map<string, unknown>,
} = {}) => {
  const flags = {
    enabled: over.enabled !== false,
    busy: over.busy === true,
    surfaces: over.surfaces === true,
    delivered: over.delivered !== false,
  };
  const calls = {
    requestUpdateCheck: 0,
    reload: 0,
    listenerRegistered: false,
    fetches: [] as string[],
    notices: [] as Array<{ text: string, action?: { kind: string, label: string, url: string } }>,
  };
  let onUpdateAvailableListener: ((details: { version: string }) => void) | null = null;
  const session = over.session ?? new Map<string, unknown>();
  let clock = 1_000_000;
  // Firefox has no requestUpdateCheck at all - a gecko manifest models that
  // by omitting the API from the fake runtime entirely.
  const hasRequestUpdateCheck = over.manifest?.browser_specific_settings === undefined;
  const updateCheck = makeUpdateCheck({
    runtime: {
      getManifest: () => over.manifest ?? CHROME_MANIFEST,
      ...(hasRequestUpdateCheck ? {
        requestUpdateCheck: () => {
          calls.requestUpdateCheck += 1;
          return Promise.resolve(['no_update']);
        },
      } : {}),
      onUpdateAvailable: {
        addListener: (fn) => { calls.listenerRegistered = true; onUpdateAvailableListener = fn; },
      },
      reload: () => { calls.reload += 1; },
    },
    fetchFn: (url) => {
      calls.fetches.push(url);
      if (over.fetchFails) return Promise.reject(new Error('offline'));
      return Promise.resolve(new Response(JSON.stringify(over.feedJson ?? FEED), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    },
    ready: Promise.resolve(),
    isEnabled: () => flags.enabled,
    busy: () => flags.busy,
    surfacesOpen: () => flags.surfaces,
    notify: (text, action) => {
      calls.notices.push({ text, ...(action ? { action } : {}) });
      return flags.delivered;
    },
    sessionKv: {
      get: (key) => Promise.resolve(session.get(key)),
      set: (key, value) => { session.set(key, value); return Promise.resolve(); },
    },
    now: () => clock,
  });
  updateCheck.start();
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
  const fireUpdateAvailable = async (version: string) => {
    onUpdateAvailableListener?.({ version });
    await settle();
    await settle();
  };
  const advance = (ms: number) => { clock += ms; };
  return { updateCheck, calls, flags, session, fireUpdateAvailable, advance, settle };
};

describe('makeUpdateCheck - Chrome flow', () => {
  test('checkNow asks the browser for the update', async () => {
    const h = makeHarness();
    await h.updateCheck.checkNow('boot');
    expect(h.calls.requestUpdateCheck).toBe(1);
    expect(h.calls.fetches).toEqual([]);
  });
  test('concurrent boot and ui-connect checks coalesce into one', async () => {
    const h = makeHarness();
    await Promise.all([h.updateCheck.checkNow('boot'), h.updateCheck.checkNow('ui-connect')]);
    expect(h.calls.requestUpdateCheck).toBe(1);
  });
  test('re-checks inside the throttle window are skipped; a later one runs', async () => {
    const h = makeHarness();
    await h.updateCheck.checkNow('boot');
    await h.updateCheck.checkNow('ui-connect');
    expect(h.calls.requestUpdateCheck).toBe(1);
    h.advance(MIN_CHECK_INTERVAL_MS + 1);
    await h.updateCheck.checkNow('ui-connect');
    expect(h.calls.requestUpdateCheck).toBe(2);
  });
  test('downloaded update applies immediately when quiet', async () => {
    const h = makeHarness();
    await h.fireUpdateAvailable('0.7.0');
    expect(h.calls.reload).toBe(1);
    expect(h.calls.notices).toEqual([]);
  });
  test('a busy turn defers the reload and says so once', async () => {
    const h = makeHarness({ busy: true, surfaces: true });
    await h.fireUpdateAvailable('0.7.0');
    await h.updateCheck.onQuiet();
    await h.settle();
    expect(h.calls.reload).toBe(0);
    expect(h.calls.notices).toHaveLength(1);
    expect(h.calls.notices[0]?.text).toContain('0.7.0');
  });
  test('an undelivered downloaded-note is not latched - it can post again later', async () => {
    const h = makeHarness({ busy: true, delivered: false });
    await h.fireUpdateAvailable('0.7.0');
    expect(h.calls.notices).toHaveLength(1);
    h.flags.delivered = true;
    h.updateCheck.onQuiet();
    await h.settle();
    expect(h.calls.notices).toHaveLength(2);
  });
  test('onQuiet applies the parked update once everything is quiet', async () => {
    const h = makeHarness({ surfaces: true });
    await h.fireUpdateAvailable('0.7.0');
    expect(h.calls.reload).toBe(0);
    h.flags.surfaces = false;
    h.updateCheck.onQuiet();
    await h.settle();
    expect(h.calls.reload).toBe(1);
  });
  test('an open surface alone defers the reload', async () => {
    const h = makeHarness({ surfaces: true });
    await h.fireUpdateAvailable('0.7.0');
    expect(h.calls.reload).toBe(0);
  });
  test('disabled setting: no check, and Chrome keeps its default (no reload)', async () => {
    const h = makeHarness({ enabled: false });
    await h.updateCheck.checkNow('boot');
    await h.fireUpdateAvailable('0.7.0');
    expect(h.calls.requestUpdateCheck).toBe(0);
    expect(h.calls.reload).toBe(0);
  });
});

describe('makeUpdateCheck - Firefox flow', () => {
  test('reads the gecko feed and posts an install notice with the XPI link', async () => {
    const h = makeHarness({ manifest: FIREFOX_MANIFEST, surfaces: true });
    await h.updateCheck.checkNow('boot');
    expect(h.calls.fetches).toEqual(['https://peerd.ai/updates/firefox-preview.json']);
    expect(h.calls.requestUpdateCheck).toBe(0);
    expect(h.calls.notices).toHaveLength(1);
    expect(h.calls.notices[0]?.action).toEqual({
      kind: 'open-url',
      label: 'Install update',
      url: 'https://github.com/NotASithLord/peerd/releases/download/v0.7.0/peerd-preview-firefox.xpi',
    });
  });
  test('a delivered notice is not re-posted this browser session', async () => {
    const h = makeHarness({ manifest: FIREFOX_MANIFEST, surfaces: true });
    await h.updateCheck.checkNow('boot');
    h.updateCheck.onUiConnect();
    await h.settle();
    expect(h.calls.notices).toHaveLength(1);
  });
  test('an UNdelivered notice replays when a surface connects', async () => {
    const h = makeHarness({ manifest: FIREFOX_MANIFEST, delivered: false });
    await h.updateCheck.checkNow('boot');
    expect(h.calls.notices).toHaveLength(1); // tried, nobody listening
    h.flags.delivered = true;
    h.updateCheck.onUiConnect();
    await h.settle();
    expect(h.calls.notices).toHaveLength(2); // replayed to the fresh surface
  });
  test('the pending notice survives an event-page respawn (persisted, not module state)', async () => {
    const session = new Map<string, unknown>();
    const first = makeHarness({ manifest: FIREFOX_MANIFEST, delivered: false, session });
    await first.updateCheck.checkNow('boot');
    expect(first.calls.notices).toHaveLength(1);
    // The event page suspends; a later panel open boots a FRESH module over
    // the same storage.session - the throttle blocks a re-fetch, but the
    // persisted notice must still reach the new surface.
    const second = makeHarness({ manifest: FIREFOX_MANIFEST, session });
    second.updateCheck.onUiConnect();
    await second.settle();
    await second.settle();
    expect(second.calls.fetches).toEqual([]); // throttled - no second fetch
    expect(second.calls.notices).toHaveLength(1);
    expect(second.calls.notices[0]?.action?.url).toContain('peerd-preview-firefox.xpi');
  });
  test('a failed fetch does not burn the throttle window', async () => {
    const h = makeHarness({ manifest: FIREFOX_MANIFEST, surfaces: true, fetchFails: true });
    await h.updateCheck.checkNow('boot');
    expect(h.calls.fetches).toHaveLength(1);
    await h.updateCheck.checkNow('ui-connect'); // online again moments later
    expect(h.calls.fetches).toHaveLength(2);
  });
  test('an equal-or-older feed version is silent', async () => {
    const h = makeHarness({
      manifest: FIREFOX_MANIFEST,
      surfaces: true,
      feedJson: {
        addons: {
          'peerd-preview@peerd.ai': {
            updates: [{ version: '0.6.0', update_link: 'https://github.com/same.xpi' }],
          },
        },
      },
    });
    await h.updateCheck.checkNow('boot');
    expect(h.calls.notices).toEqual([]);
  });
  test('disabled toggle restores the no-listener Firefox default: apply immediately', async () => {
    // On Firefox a registered onUpdateAvailable listener DEFERS every add-on
    // update until reload()/browser restart. Disabled must therefore reload
    // right away - exactly what Firefox would do with no listener.
    const h = makeHarness({ manifest: FIREFOX_MANIFEST, enabled: false, busy: true, surfaces: true });
    await h.fireUpdateAvailable('0.7.0');
    expect(h.calls.reload).toBe(1);
    expect(h.calls.notices).toEqual([]);
  });
});

describe('makeUpdateCheck - no self-hosted update_url (dev, store)', () => {
  test('structural no-op: no listener, nothing called, nothing stored', async () => {
    const h = makeHarness({ manifest: { version: '0.6.0' } });
    await h.updateCheck.checkNow('boot');
    expect(h.calls.requestUpdateCheck).toBe(0);
    expect(h.calls.fetches).toEqual([]);
    expect(h.session.has(UPDATE_CHECK_SESSION_KEY)).toBe(false);
  });
  test('dev-Chrome (API present, no update_url) registers no listener', () => {
    const h = makeHarness({ manifest: { version: '0.6.0' } });
    expect(h.calls.listenerRegistered).toBe(false);
  });
  test('store-Firefox (gecko id, no update_url) registers no listener - AMO auto-updates stay untouched', () => {
    // Load-bearing: a listener's mere presence would defer every AMO update
    // until the user fully restarts Firefox.
    const h = makeHarness({ manifest: STORE_FIREFOX_MANIFEST });
    expect(h.calls.listenerRegistered).toBe(false);
  });
});
