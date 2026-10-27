import { describe, expect, test } from 'bun:test';
import {
  appCountLabel, BLOCKED, bytesLabel, createEffects, FAILED, failureHint, installSteps, isFailure, kbLabel, keptCards, letterOf,
  libraryPeerApps, libraryStatus, makerMenu, matchQuery, networkState, noSuggestionNote, pageState, peerCountLabel, pillFilter, rootView,
  savedContactNames, savedNameForm, saysIt, shareLinkError, shortKey, tileAction, toneOf, TONES, UNKNOWN, unknownLines, updateOffer,
  verifiedDeclared, wasmLabel, yourApps,
} from '../../extension/home/discover-model.js';
import type { DwebApp } from '../../extension/home/discover-model.js';
import { encodeDidKey } from '../../extension/shared/address/did.js';
import { formatDwappUri } from '../../extension/shared/address/dwapp-uri.js';
import { immutableAppRoot } from '../../extension/shared/address/immutable-app-root.js';

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
    expect(peerCountLabel(1)).toBe('Connected to 1 person');
    expect(peerCountLabel(3)).toBe('Connected to 3 people');
    expect(appCountLabel(1)).toBe('1 app shared');
    expect(appCountLabel(6)).toBe('6 apps shared');
    expect(wasmLabel(true)).toBe('Includes WebAssembly');
    expect(wasmLabel(false)).toBe('No detected WebAssembly files');
    expect(wasmLabel(null)).toBe('WebAssembly not specified');
  });

  test('a rejected share link says what to paste, never the parser text', () => {
    const address = formatDwappUri({ did: encodeDidKey(new Uint8Array(32).fill(1)), hash: 'a'.repeat(64) });
    const errorOf = (input: string) => {
      try { immutableAppRoot(input); return null; } catch (cause) { return shareLinkError((cause as Error).message); }
    };
    expect(errorOf(`${address}/index.html`)).toBe('This link points to one file inside an app. Paste the link to the whole app.');
    // Not a link, a leading space, no hash, no maker key, empty.
    for (const input of ['hello', ` ${address}`, address.slice(0, address.lastIndexOf('/')), `dwapp://content/${'a'.repeat(64)}`, '']) {
      expect(errorOf(input)).toBe('This is not a share link. Paste the whole link you were sent.');
    }
    expect(shareLinkError(undefined)).toBe('This is not a share link. Paste the whole link you were sent.');
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
    // The offline root offers neither Install nor Surprise me, so its lines name what it shows.
    // An error says what failed, then what to do: the poll reads the Library again.
    expect(libraryStatus({ ready: false, failed: true, offline: true })).toBe('peerd could not read your Library. Try again in a moment.');
    expect(libraryStatus({ ready: true, failed: true, offline: true })).toBe('Could not refresh your Library. This list may be out of date.');
    expect(libraryStatus({ ready: false, failed: false, offline: true })).toBe('Checking your Library…');
    expect(libraryStatus({ ready: true, failed: false, offline: true })).toBe(null);
  });

  test('Surprise me names the filters only while one is on, and the Library only when every app is in it', () => {
    const filters = 'No new suggestions match these filters. Change your search or filters.';
    expect(noSuggestionNote({ filtered: true, allInLibrary: true })).toBe(filters);
    expect(noSuggestionNote({ filtered: true, allInLibrary: false })).toBe(filters);
    expect(noSuggestionNote({ filtered: false, allInLibrary: true })).toBe('No new suggestions. Every app here is already in your Library.');
    expect(noSuggestionNote({ filtered: false, allInLibrary: false })).toBe('No new suggestions.');
  });
});

describe('tile and page states', () => {
  const card = { incompatible: false, busy: undefined, uncertain: false, installed: false, sameVersion: false, updatable: false, mine: false };

  test('tile action ladder: cannot run, in flight, failed or unknown, update, open, look at it', () => {
    expect(tileAction({ ...card, incompatible: true })).toEqual({ kind: 'status', text: 'This browser cannot run it' });
    // The runtime flag rides the version on offer: an installed app of another version still opens.
    expect(tileAction({ ...card, incompatible: true, installed: true, updatable: true })).toEqual({ kind: 'open' });
    expect(tileAction({ ...card, incompatible: true, installed: true })).toEqual({ kind: 'open' });
    // The Library holds the very version the card flags: it can't run here either.
    expect(tileAction({ ...card, incompatible: true, installed: true, sameVersion: true }))
      .toEqual({ kind: 'status', text: 'This browser cannot run it' });
    expect(tileAction({ ...card, busy: 'installing' })).toEqual({ kind: 'status', text: 'Installing…' });
    expect(tileAction({ ...card, busy: 'updating', installed: true })).toEqual({ kind: 'status', text: 'Updating…' });
    expect(tileAction({ ...card, busy: 'peerd could not install this app. Try again.' })).toEqual({ kind: 'review' });
    // A failure is stale once the Library holds this exact version (a share link, another tab); another version keeps it.
    expect(tileAction({ ...card, busy: 'peerd could not install this app. Try again.', installed: true, sameVersion: true })).toEqual({ kind: 'open' });
    expect(tileAction({ ...card, busy: 'peerd could not update this app. Try again.', installed: true })).toEqual({ kind: 'review' });
    expect(tileAction({ ...card, uncertain: true, installed: true, updatable: true })).toEqual({ kind: 'review' });
    expect(tileAction({ ...card, installed: true, updatable: true })).toEqual({ kind: 'update' });
    expect(tileAction({ ...card, installed: true, updatable: true, mine: true })).toEqual({ kind: 'open' });
    expect(tileAction({ ...card, installed: true })).toEqual({ kind: 'open' });
    expect(tileAction({ ...card, busy: 'installed', installed: true })).toEqual({ kind: 'open' });
    expect(tileAction(card)).toEqual({ kind: 'review' });
  });

  test('page state puts an unknown outcome ahead of a stale conflict or failure', () => {
    const page = { incompatible: false, conflict: false, busy: undefined, uncertain: false, installed: false, sameVersion: false };
    expect(pageState({ ...page, incompatible: true })).toBe('cant-run');
    expect(pageState({ ...page, incompatible: true, installed: true })).toBe('installed');
    expect(pageState({ ...page, incompatible: true, busy: 'installed' })).toBe('installed');
    expect(pageState({ ...page, incompatible: true, installed: true, sameVersion: true })).toBe('cant-run');
    expect(pageState({ ...page, busy: 'updating' })).toBe('installing');
    expect(pageState({ ...page, uncertain: true, conflict: true, busy: 'text' })).toBe('unknown');
    expect(pageState({ ...page, conflict: true, installed: true })).toBe('conflict');
    expect(pageState({ ...page, busy: 'peerd could not update this app. Try again.', installed: true })).toBe('failed');
    expect(pageState({ ...page, busy: 'peerd could not install this app. Try again.', installed: true, sameVersion: true })).toBe('installed');
    expect(pageState({ ...page, installed: true })).toBe('installed');
    expect(pageState({ ...page, busy: 'installed' })).toBe('installed');
    expect(pageState(page)).toBe('review');
  });

  test('an update is on offer only for an installed app of another maker; a new version that can’t run says so', () => {
    const app = { installed: true, updatable: true, mine: false, incompatible: false };
    expect(updateOffer(app)).toBe('update');
    expect(updateOffer({ ...app, incompatible: true })).toBe('update-cant-run');
    expect(updateOffer({ ...app, installed: false })).toBe(null);
    expect(updateOffer({ ...app, updatable: false })).toBe(null);
    expect(updateOffer({ ...app, mine: true })).toBe(null);
  });

  test('failure text is any busy value that is not a state word', () => {
    expect(isFailure(undefined)).toBe(false);
    for (const word of ['installing', 'updating', 'installed']) expect(isFailure(word)).toBe(false);
    expect(isFailure('peerd could not install this app. Try again.')).toBe(true);
    expect(isFailure(FAILED)).toBe(true);
    expect(isFailure(UNKNOWN)).toBe(true);
  });

  test('a failure hint: someone may be offline, or the browser cannot run it, with the host reason kept for Technical details', () => {
    expect(failureHint(FAILED)).toEqual({ hint: 'The person who shares it may have gone offline. Try again in a moment.', runtime: null });
    expect(failureHint(UNKNOWN)).toEqual({ hint: 'The person who shares it may have gone offline. Try again in a moment.', runtime: null });
    expect(failureHint('Unsupported App runtime target: wasi.'))
      .toEqual({ hint: 'This browser cannot run it. Technical details says why.', runtime: 'Unsupported App runtime target: wasi.' });
  });

  test('a blocked maker is a failure whose hint says who chose it and how to undo it, in the words of the action', () => {
    expect(isFailure(BLOCKED)).toBe(true);
    expect(failureHint(BLOCKED)).toEqual({ hint: 'You blocked the maker of this app. To install it, unblock them in Contacts.', runtime: null });
    expect(failureHint(BLOCKED, 'update')).toEqual({ hint: 'You blocked the maker of this app. To update it, unblock them in Contacts.', runtime: null });
    expect(failureHint(FAILED, 'update').hint).toBe('The person who shares it may have gone offline. Try again in a moment.');
  });

  test('an unknown outcome stays neutral and says what to do next', () => {
    expect(unknownLines('install')).toEqual({
      status: 'peerd is not sure the install finished. It may still finish by itself.',
      hint: 'Check again before you try to install it again.',
    });
    expect(unknownLines('update')).toEqual({
      status: 'peerd is not sure the update finished. It may still finish by itself.',
      hint: 'Check again before you try to update it again.',
    });
  });

  test('install steps for every state; "You are here" only on a current first step', () => {
    const table = (state: Parameters<typeof installSteps>[0]) => installSteps(state).map(step => [step.state, step.sub]);
    const install = 'peerd checks every file, then adds the app to your Library';
    const open = 'It opens in its own tab';
    expect(installSteps('review').map(step => step.title)).toEqual(['Look at it', 'Install', 'Open']);
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
    one.running.set('a', { action: 'install', uri: 'peerd://a' });
    one.conflicts.set('a', { token: 1, versionId: 'a-v2' });
    one.commons = 'unknown';
    one.link = { address: 'dwapp://content/a', outcome: Promise.resolve({}) };
    one.committed.set('a', { appId: 'local-a', version_id: 'a-v2', seq: 2, read: 1 });
    one.reads = 3;
    one.commonsAdded = 2;
    expect(two.busy).toEqual({});
    expect(two.running.size).toBe(0);
    expect(two.conflicts.size).toBe(0);
    expect(two.unconfirmed.size).toBe(0);
    expect(two.commons).toBe(null);
    expect(two.link).toBe(null);
    expect(two.committed.size).toBe(0);
    expect(two.reads).toBe(0);
    expect(two.commonsAdded).toBe(null);
  });
});

describe('the app says it', () => {
  const version = 'a'.repeat(64);
  const flags = { hash: version, dweb: true, instructions: false, observeAct: true };
  const NOT_KNOWN = 'Not known yet. peerd reads this from the app itself when it checks it.';

  test('only facts a host bound to the version on the page count, in their exact shape', () => {
    expect(verifiedDeclared(flags, version)).toEqual({ dweb: true, instructions: false, observeAct: true });
    // No hash field rides along: the facts are three booleans.
    expect(Object.keys(verifiedDeclared({ ...flags, extra: 'text' }, version) ?? {})).toEqual(['dweb', 'instructions', 'observeAct']);
    const unknown: [unknown, unknown][] = [
      [flags, 'b'.repeat(64)], [flags, undefined], [flags, ''], [{ ...flags, hash: undefined }, undefined],
      [{ hash: version, dweb: true, instructions: false }, version], [{ ...flags, observeAct: 'yes' }, version],
      [null, version], ['flags', version], [[true, true, true], version],
    ];
    for (const [value, page] of unknown) expect(verifiedDeclared(value, page)).toBe(null);
  });

  test('unchecked: how peerd finds out, never a claim, in the words of the page action', () => {
    for (const declared of [null, { dweb: true, instructions: true, observeAct: true }]) {
      expect(saysIt({ declared, checked: null })).toEqual({
        kind: 'unknown', chips: [], note: null,
        line: `${NOT_KNOWN} Paste its link or install it, and peerd checks every file first.`,
      });
    }
    expect(saysIt({ declared: null, checked: null, action: 'update' })?.line)
      .toBe(`${NOT_KNOWN} Paste its link or update it, and peerd checks every file first.`);
  });

  test('checked: a chip per fact, the agent one strong; none says so; nothing recorded is no section', () => {
    expect(saysIt({ declared: { dweb: true, instructions: true, observeAct: true }, checked: 'link' })).toEqual({
      kind: 'checked', line: null,
      chips: [
        { text: 'Uses the peer network', strong: false },
        { text: 'Comes with instructions for peerd', strong: false },
        { text: 'Lets peerd see and use it', strong: true },
      ],
      note: 'From the app’s own files, checked when peerd looked at it.',
    });
    expect(saysIt({ declared: { dweb: false, instructions: true, observeAct: false }, checked: 'installed', changed: false })).toMatchObject({
      chips: [{ text: 'Comes with instructions for peerd', strong: false }],
      note: 'From the app’s own files, checked when peerd installed it.',
    });
    // Nothing to show still says when peerd read it: an edit on this device can change the files later.
    expect(saysIt({ declared: { dweb: false, instructions: false, observeAct: false }, checked: 'installed', changed: false })).toEqual({
      kind: 'nothing', chips: [], note: 'From the app’s own files, checked when peerd installed it.',
      line: 'It does not use the peer network and has no instructions for peerd.',
    });
    expect(saysIt({ declared: { dweb: false, instructions: false, observeAct: false }, checked: 'link' })?.note)
      .toBe('From the app’s own files, checked when peerd looked at it.');
    for (const checked of ['link', 'installed'] as const) expect(saysIt({ declared: null, checked })).toBe(null);
  });

  test('the Library copy shows its facts only while the service worker says it is unchanged', () => {
    const declared = { dweb: true, instructions: true, observeAct: true };
    // Changed on this device, or not known yet: the facts peerd checked no longer stand for it.
    for (const changed of [true, null, undefined]) expect(saysIt({ declared, checked: 'installed', changed })).toBe(null);
    expect(saysIt({ declared, checked: 'installed', changed: false })?.chips).toHaveLength(3);
    // A share link's facts are its own files: no copy here to change.
    for (const changed of [true, null]) expect(saysIt({ declared, checked: 'link', changed })?.chips).toHaveLength(3);
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

  test('pills: All keeps every app, Updates and From people you know keep pending apps, Comes with peerd is not a heard filter', () => {
    expect(pillFilter(apps, 'all', facts)).toEqual(apps);
    expect(pillFilter(apps, 'updates', facts).map(app => app.dwapp_id)).toEqual(['b', 'c']);
    expect(pillFilter(apps, 'contacts', facts).map(app => app.dwapp_id)).toEqual(['a', 'c']);
    expect(pillFilter(apps, 'included', facts)).toEqual([]);
  });

  test('From people you know keys on the full did, never a matching short key', () => {
    const lookalike = `did:key:z6MkEvil${ana.slice(-8)}`;
    const rows = pillFilter([{ dwapp_id: 'x', publisher: lookalike }], 'contacts', { ...facts, pending: () => false });
    expect(rows).toEqual([]);
  });

  test('maker menu: Rename a saved maker, name an unsaved one, and Block only someone else known not to be you', () => {
    expect(makerMenu({ did: ana, myDid: bob, saved: true, blocked: false })).toEqual({ rename: 'Rename', block: true });
    expect(makerMenu({ did: ana, myDid: bob, saved: false, blocked: false })).toEqual({ rename: 'Add a name', block: true });
    // Your own page, and a page while peerd has not read your key.
    expect(makerMenu({ did: ana, myDid: ana, saved: false, blocked: false })).toEqual({ rename: 'Add a name', block: false });
    for (const myDid of [null, '']) expect(makerMenu({ did: ana, myDid, saved: true, blocked: false }).block).toBe(false);
    // Already blocked: Contacts undoes it, so no second block.
    expect(makerMenu({ did: ana, myDid: bob, saved: true, blocked: true })).toEqual({ rename: 'Rename', block: false });
  });

  test('a name in the form Contacts saves it: trimmed, inner spaces collapsed, at most 64 characters', () => {
    expect(savedNameForm('  Bob \t  Smith ')).toBe('Bob Smith');
    expect(savedNameForm('Ana')).toBe('Ana');
    expect(savedNameForm(`${'a'.repeat(70)}`)).toBe('a'.repeat(64));
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
    const heard = new Map([['a', { dwapp_id: 'a', version_id: '1', description: 'Split costs.', size: 48213, name: 'Card name' }]]);
    expect(libraryPeerApps(records, heard)).toEqual([
      { dwapp_id: 'a', uri: 'peerd://a/1', name: 'Expense splitter', publisher: ana, version_id: '1', description: 'Split costs.', size: 48213 },
      { dwapp_id: 'peerd://l/2', uri: 'peerd://l/2', name: 'Linked app', publisher: bob, version_id: undefined, description: undefined, size: undefined },
    ]);
    // A newer card describes a version the Library does not hold: nothing is borrowed from it.
    const newer = new Map([['a', { dwapp_id: 'a', version_id: '2', description: 'Adds cloud sync.', size: 900000 }]]);
    expect(libraryPeerApps(records.slice(0, 1), newer)).toEqual([
      { dwapp_id: 'a', uri: 'peerd://a/1', name: 'Expense splitter', publisher: ana, version_id: '1', description: undefined, size: undefined },
    ]);
  });

  test('the heard cache keeps the latest read and only the earlier cards it is told to keep', () => {
    const old: DwebApp = { dwapp_id: 'kept', name: 'Old kept card' };
    const cache = new Map<string, DwebApp>([['kept', old], ['gone', { dwapp_id: 'gone' }], ['still', { dwapp_id: 'still', name: 'Old card' }]]);
    const latest: DwebApp[] = [{ dwapp_id: 'still', name: 'New card' }, { dwapp_id: 'new' }, { name: 'No id' }];
    const next = keptCards(cache, latest, id => id === 'kept');
    expect([...next.keys()].sort()).toEqual(['kept', 'new', 'still']);
    expect(next.get('kept')).toBe(old);
    expect(next.get('still')?.name).toBe('New card');
    expect(cache.size).toBe(3);
    // Bounded by the latest read plus the kept ids, not by every card ever heard.
    let grown: Map<string, DwebApp> = new Map();
    for (let round = 0; round < 50; round++) grown = keptCards(grown, [{ dwapp_id: `card-${round}` }], id => id === 'card-0');
    expect([...grown.keys()]).toEqual(['card-0', 'card-49']);
  });

  test('included search matches name and description without case, by any word of the query', () => {
    const items = [{ name: 'CSV Lab', description: 'Explore CSV tables' }, { name: 'Commons', description: 'Peer chat' }];
    expect(matchQuery(items, 'chat')).toEqual([items[1]]);
    expect(matchQuery(items, '  csv ')).toEqual([items[0]]);
    expect(matchQuery(items, '')).toEqual(items);
    // A task, as the search label asks for: any longer word finds the app.
    expect(matchQuery(items, 'chat with a friend')).toEqual([items[1]]);
    expect(matchQuery(items, 'make tables or chat')).toEqual(items);
    expect(matchQuery(items, 'a b')).toEqual([]);
  });

  test('Your apps: the Library apps, the most recently added first, at most `max`, with a total', () => {
    const records = [
      { id: 'old', name: 'Old app', createdAt: 100 },
      { id: 'undated', name: 'Undated app' },
      { id: 'new', name: 'New app', createdAt: 300 },
      { id: 'peer', name: 'Peer app', createdAt: 200, dweb: { uri: 'peerd://p/1', dwapp_id: 'peer-app' } },
      { id: 'commons', name: 'Commons', createdAt: 50, dweb: { seed: 'commons' } },
      { id: 'linked', name: '  ', dweb: { uri: 'peerd://l/2' } },
      { name: 'No id', createdAt: 999 },
      { id: 'bad-time', name: 'Bad time', createdAt: Number.NaN },
    ];
    const all = yourApps(records, 10);
    expect(all.total).toBe(7);
    expect(all.apps.map(app => app.id)).toEqual(['new', 'peer', 'old', 'commons', 'undated', 'linked', 'bad-time']);
    // The tone key matches the app's tile: Commons by its seed, a peer app by its dwapp_id.
    expect(all.apps.map(app => app.toneKey)).toEqual(['new', 'peer-app', 'old', 'commons', 'undated', 'peerd://l/2', 'bad-time']);
    expect(all.apps.find(app => app.id === 'linked')?.name).toBe('Unnamed app');
    const few = yourApps(records, 2);
    expect([few.apps.map(app => app.id), few.total]).toEqual([['new', 'peer'], 7]);
    expect(yourApps([], 6)).toEqual({ apps: [], total: 0 });
  });
});


test('recent retrieval misses explain how to retry suggestions', () => {
  expect(noSuggestionNote({filtered:false,allInLibrary:false,recentMisses:true})).toContain('open an app to retry');
});
