import { describe, expect, test } from 'bun:test';
import {
  appCountLabel, bytesLabel, createEffects, installSteps, isFailure, kbLabel, letterOf, libraryPeerApps, libraryStatus,
  matchQuery, networkState, pageState, peerCountLabel, pillFilter, rootView, savedContactNames, shortKey, tileAction,
  toneOf, TONES, wasmLabel,
} from '../../extension/home/discover-model.js';
import type { DwebApp } from '../../extension/home/discover-model.js';

// The shipped avatar palette, in order, that the token list replaces.
const SHIPPED_HEX = ['#00B7EB', '#EF4444', '#F59E0B', '#22C55E', '#D946EF'];
const shippedColorOf = (key: string) => {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SHIPPED_HEX[h % SHIPPED_HEX.length];
};
const TOKEN_FOR_HEX: Record<string, string> = {
  '#00B7EB': '--cyan', '#EF4444': '--red', '#F59E0B': '--amber', '#22C55E': '--green', '#D946EF': '--magenta',
};

const ready = (status: string) => ({ ok: true, featureLeases: { leases: { dweb: { status } } } });

describe('discover labels', () => {
  test('KB uses 1000-byte units, floors a non-empty bundle at 1 KB and rejects invalid sizes', () => {
    expect(kbLabel(48213)).toBe('48 KB');
    expect(kbLabel(1)).toBe('1 KB');
    expect(kbLabel(999)).toBe('1 KB');
    expect(kbLabel(131_499)).toBe('131 KB');
    expect(kbLabel(0)).toBe('0 KB');
    for (const invalid of [undefined, null, -1, 1.5, Number.NaN, '48213']) expect(kbLabel(invalid)).toBe(null);
  });

  test('exact bytes use the locale number format with a singular for one byte', () => {
    expect(bytesLabel(48213)).toBe(`${new Intl.NumberFormat().format(48213)} bytes`);
    expect(bytesLabel(1)).toBe('1 byte');
    expect(bytesLabel(undefined)).toBe(null);
  });

  test('letters take the first character of the trimmed name, upper case, with a fallback', () => {
    expect(letterOf('Expense splitter')).toBe('E');
    expect(letterOf('  reading list')).toBe('R');
    expect(letterOf('')).toBe('?');
    expect(letterOf(undefined)).toBe('?');
    expect(letterOf('😀 party')).toBe('😀');
  });

  test('tones keep the shipped hash and palette order, now as tokens', () => {
    expect(TONES).toEqual(['--cyan', '--red', '--amber', '--green', '--magenta']);
    for (const key of ['', 'fixture-0', 'fixture-1', 'commons', 'did:key:z6MkxLJVYqKJSdKUXPeMkE9sHd269nZz4t2sBNrDk8Wq3TzA']) {
      expect(toneOf(key)).toBe(TOKEN_FOR_HEX[shippedColorOf(key)]);
    }
  });

  test('the short key is the last 8 characters of the full did', () => {
    expect(shortKey('did:key:z6MkxLJVYqKJSdKUXPeMkE9sHd269nZz4t2sBNrDk8Wq3TzA')).toBe('k8Wq3TzA');
    expect(shortKey(undefined)).toBe('????????');
  });

  test('counts and WebAssembly hints read as drawn', () => {
    expect(peerCountLabel(1)).toBe('Connected to 1 peer');
    expect(peerCountLabel(3)).toBe('Connected to 3 peers');
    expect(appCountLabel(1)).toBe('1 app shared');
    expect(appCountLabel(6)).toBe('6 apps shared');
    expect(wasmLabel(true)).toBe('Includes WebAssembly');
    expect(wasmLabel(false)).toBe('No detected WebAssembly files');
    expect(wasmLabel(null)).toBe('WebAssembly not specified');
  });
});

describe('network and root state', () => {
  test('the lease decides first; info maps running and linked peers', () => {
    expect(networkState(ready('starting'), null)).toEqual({ kind: 'looking', linked: 0 });
    expect(networkState(ready('idle'), null)).toEqual({ kind: 'offline', linked: 0 });
    expect(networkState(ready('active'), { ok: true, running: false })).toEqual({ kind: 'offline', linked: 0 });
    expect(networkState(ready('active'), { ok: true, running: true, linkedCount: 0 })).toEqual({ kind: 'looking', linked: 0 });
    expect(networkState(ready('active'), { ok: true, running: true, linkedCount: 3 })).toEqual({ kind: 'connected', linked: 3 });
  });

  test('unreadable status returns null so the caller keeps the last known state', () => {
    expect(networkState({ ok: false }, null)).toBe(null);
    expect(networkState(null, null)).toBe(null);
    expect(networkState(ready('active'), { ok: false })).toBe(null);
    expect(networkState(ready('active'), null)).toBe(null);
    expect(networkState(ready('active'), { ok: true, running: true, linkedCount: -1 })).toBe(null);
    expect(networkState(ready('active'), { ok: true, running: true, linkedCount: 1.5 })).toBe(null);
  });

  test('root view follows the peer network, never claiming an empty network before a good read', () => {
    const connected = { kind: 'connected' as const, linked: 2 };
    const base = { enabled: true, net: connected, heardCount: 0, loading: false, failed: false, included: false };
    expect(rootView({ ...base, enabled: false })).toBe('start');
    expect(rootView({ ...base, net: { kind: 'offline', linked: 0 }, heardCount: 4 })).toBe('offline');
    expect(rootView({ ...base, heardCount: 4 })).toBe('grid');
    expect(rootView({ ...base, net: { kind: 'looking', linked: 0 }, heardCount: 4 })).toBe('grid');
    expect(rootView(base)).toBe('empty');
    expect(rootView({ ...base, loading: true })).toBe('looking');
    expect(rootView({ ...base, failed: true })).toBe('looking');
    expect(rootView({ ...base, net: null })).toBe('looking');
    expect(rootView({ ...base, net: { kind: 'looking', linked: 0 } })).toBe('looking');
  });

  test('the Included pill needs no peer: it lists apps with no heard app, but never with the network off', () => {
    const included = { enabled: true, net: null, heardCount: 0, loading: true, failed: false, included: true };
    expect(rootView(included)).toBe('grid');
    expect(rootView({ ...included, net: { kind: 'connected', linked: 2 }, loading: false })).toBe('grid');
    expect(rootView({ ...included, failed: true })).toBe('grid');
    expect(rootView({ ...included, net: { kind: 'offline', linked: 0 } })).toBe('offline');
    expect(rootView({ ...included, enabled: false })).toBe('start');
  });

  test('the Library line: checking, never read, or refresh failed; silent after a good read', () => {
    expect(libraryStatus({ ready: false, failed: false })).toBe('Checking your Library…');
    expect(libraryStatus({ ready: false, failed: true })).toBe('Could not read your Library. Install stays off until peerd can read it.');
    expect(libraryStatus({ ready: true, failed: true }))
      .toBe('Could not refresh your Library. Surprise me stays off until peerd can read it.');
    expect(libraryStatus({ ready: true, failed: false })).toBe(null);
  });
});

describe('tile and page states', () => {
  const card = { incompatible: false, busy: undefined, uncertain: false, installed: false, updatable: false, mine: false };

  test('tile action ladder: can’t run, in flight, failed or unknown, update, open, review', () => {
    expect(tileAction({ ...card, incompatible: true, installed: true, updatable: true }))
      .toEqual({ kind: 'status', text: 'Can’t run in this browser' });
    expect(tileAction({ ...card, busy: 'installing' })).toEqual({ kind: 'status', text: 'Installing…' });
    expect(tileAction({ ...card, busy: 'updating', installed: true })).toEqual({ kind: 'status', text: 'Updating…' });
    expect(tileAction({ ...card, busy: 'peerd could not install this app. Try again.' })).toEqual({ kind: 'review' });
    expect(tileAction({ ...card, uncertain: true, installed: true, updatable: true })).toEqual({ kind: 'review' });
    expect(tileAction({ ...card, installed: true, updatable: true })).toEqual({ kind: 'update' });
    expect(tileAction({ ...card, installed: true, updatable: true, mine: true })).toEqual({ kind: 'open' });
    expect(tileAction({ ...card, installed: true })).toEqual({ kind: 'open' });
    expect(tileAction({ ...card, busy: 'installed', installed: true })).toEqual({ kind: 'open' });
    expect(tileAction(card)).toEqual({ kind: 'review' });
  });

  test('page state puts an unknown outcome ahead of a stale conflict or failure', () => {
    const page = { incompatible: false, conflict: false, busy: undefined, uncertain: false, installed: false };
    expect(pageState({ ...page, incompatible: true })).toBe('cant-run');
    expect(pageState({ ...page, busy: 'updating' })).toBe('installing');
    expect(pageState({ ...page, uncertain: true, conflict: true, busy: 'text' })).toBe('unknown');
    expect(pageState({ ...page, conflict: true, installed: true })).toBe('conflict');
    expect(pageState({ ...page, busy: 'peerd could not update this app. Try again.', installed: true })).toBe('failed');
    expect(pageState({ ...page, installed: true })).toBe('installed');
    expect(pageState({ ...page, busy: 'installed' })).toBe('installed');
    expect(pageState(page)).toBe('review');
  });

  test('failure text is any busy value that is not a state word', () => {
    expect(isFailure(undefined)).toBe(false);
    for (const word of ['installing', 'updating', 'installed']) expect(isFailure(word)).toBe(false);
    expect(isFailure('peerd could not install this app. Try again.')).toBe(true);
  });

  test('install steps for every state; "You are here" only on a current Review step', () => {
    const table = (state: Parameters<typeof installSteps>[0]) => installSteps(state).map(step => [step.state, step.sub]);
    const install = 'peerd checks every file, then adds it to your Library';
    const open = 'Opens in its own tab';
    expect(installSteps('review').map(step => step.title)).toEqual(['Review', 'Install and share', 'Open']);
    expect(table('review')).toEqual([['current', 'You are here'], ['pending', install], ['pending', open]]);
    expect(table('installing')).toEqual([['done', null], ['working', install], ['pending', open]]);
    expect(table('installed')).toEqual([['done', null], ['done', install], ['current', open]]);
    expect(table('failed')).toEqual([['done', null], ['failed', install], ['pending', open]]);
    expect(table('unknown')).toEqual([['done', null], ['unknown', install], ['pending', open]]);
  });

  test('effects start empty and are independent per call', () => {
    const one = createEffects();
    const two = createEffects();
    one.busy.a = 'installing';
    one.conflicts.set('a', { token: 1, versionId: 'a-v2' });
    expect(two.busy).toEqual({});
    expect(two.conflicts.size).toBe(0);
    expect(two.unconfirmed.size).toBe(0);
  });
});

describe('filters and contacts', () => {
  const ana = 'did:key:z6MkAna00000000000000000000000000000000000000000';
  const bob = 'did:key:z6MkBob00000000000000000000000000000000000000000';
  const apps: DwebApp[] = [
    { dwapp_id: 'a', publisher: ana, name: 'Expense splitter' },
    { dwapp_id: 'b', publisher: bob, name: 'Trip planner' },
    { dwapp_id: 'c', publisher: bob, name: 'Chess clock' },
  ];
  const facts = {
    updatable: (app: DwebApp) => app.dwapp_id === 'b',
    pending: (app: DwebApp) => app.dwapp_id === 'c',
    contacts: new Map([[ana, 'Ana']]),
  };

  test('pills: All keeps every app, Updates and From contacts keep pending apps, Included is not a heard filter', () => {
    expect(pillFilter(apps, 'all', facts)).toEqual(apps);
    expect(pillFilter(apps, 'updates', facts).map(app => app.dwapp_id)).toEqual(['b', 'c']);
    expect(pillFilter(apps, 'contacts', facts).map(app => app.dwapp_id)).toEqual(['a', 'c']);
    expect(pillFilter(apps, 'included', facts)).toEqual([]);
  });

  test('From contacts keys on the full did, never a matching short key', () => {
    const lookalike = `did:key:z6MkEvil${ana.slice(-8)}`;
    const rows = pillFilter([{ dwapp_id: 'x', publisher: lookalike }], 'contacts', { ...facts, pending: () => false });
    expect(rows).toEqual([]);
  });

  test('saved contact names: saved rows with a non-empty name only, keyed by the full did', () => {
    const names = savedContactNames([
      { did: ana, name: ' Ana ', saved: true },
      { did: bob, name: 'Presence Bob', saved: false },
      { did: 'did:key:zEmpty', name: '   ', saved: true },
      { did: 'did:key:zNull', name: null, saved: true },
      { name: 'No did', saved: true },
      null,
    ]);
    expect([...names]).toEqual([[ana, 'Ana']]);
    expect(savedContactNames(undefined).size).toBe(0);
  });

  test('offline grid: Library peer apps, filled from cards heard earlier', () => {
    const records = [
      { id: 'local-a', name: 'Expense splitter', dweb: { uri: 'peerd://a/1', dwapp_id: 'a', publisher: ana, version_id: '1' } },
      { id: 'local-link', name: 'Linked app', dweb: { uri: 'peerd://l/2', publisher: bob } },
      { id: 'local-only', name: 'Made here' },
      { name: 'No id', dweb: { uri: 'peerd://x/3' } },
    ];
    const heard = new Map([['a', { dwapp_id: 'a', description: 'Split costs.', size: 48213, name: 'Card name' }]]);
    expect(libraryPeerApps(records, heard)).toEqual([
      { dwapp_id: 'a', uri: 'peerd://a/1', name: 'Expense splitter', publisher: ana, version_id: '1', description: 'Split costs.', size: 48213 },
      { dwapp_id: 'peerd://l/2', uri: 'peerd://l/2', name: 'Linked app', publisher: bob, version_id: undefined, description: undefined, size: undefined },
    ]);
  });

  test('included search matches name and description without case', () => {
    const items = [{ name: 'CSV Lab', description: 'Explore CSV tables' }, { name: 'Commons', description: 'Peer chat' }];
    expect(matchQuery(items, 'chat')).toEqual([items[1]]);
    expect(matchQuery(items, '  csv ')).toEqual([items[0]]);
    expect(matchQuery(items, '')).toEqual(items);
  });
});
