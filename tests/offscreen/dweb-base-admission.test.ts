import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createAppRoomAuthority, AppRoomAuthorityChangedError } from '../../extension/offscreen/app-room-authority.js';
import { publishFailureError } from '../../extension/shared/publish-transaction.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { packBundle } from '../../extension/peerd-distributed/content/bundle.js';
import { formatPeerdUri } from '../../extension/peerd-distributed/content/uri.js';
import { prepareAppBundle } from '../../extension/peerd-distributed/apps/loader.js';
import { fromBase64 } from '../../extension/shared/bundle/bytes.js';
import { appSeedHandoff } from '../../extension/shared/app-seed-handoff.js';
import { withDeclaration } from '../../extension/offscreen/app-declaration.js';

const source = readFileSync(new URL('../../extension/offscreen/dweb-base.js', import.meta.url), 'utf8');
// Exercise the authored boundary functions with finite injected host effects;
// importing the complete offscreen realm would require a live mesh and browser.
const section = (start: string, end: string, text = source) => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error('offscreen boundary fixture drift');
  return text.slice(from, to);
};

test('room startup cannot open a membership after consent generation rotates', async () => {
  let finishStart!: (value: any) => void;
  let entered!: () => void;
  const starting = new Promise<any>((resolve) => { finishStart = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let opened = 0;
  const ensureRoom = new Function(
    'start', 'rooms', 'appRoomAdmissionToken', 'AppRoomAuthorityChangedError',
    'roomLiveness', 'pushRoomEvent', 'log', 'closeRoom',
    section('const ensureRoom =', '/** @param {HostedRoom} entry') + '\nreturn ensureRoom;',
  )(
    () => { entered(); return starting; }, new Map(), (token: string) => token,
    AppRoomAuthorityChangedError, { track: () => true }, () => {}, () => {}, () => {},
  );
  const authority = createAppRoomAuthority({ get: async () => ({}) });
  const joining = authority.run('app-a', 1, (current) => ensureRoom('r', '', 'client-123', {
    appId: 'app-a', appDocumentId: 'document-123', appTabId: 7,
    roomAdmissionToken: 'admission-token-123',
  }, current));
  await started;
  joining.catch(() => {});
  const rotating = authority.rotate('app-a', 2, () => {});
  await Promise.resolve();
  finishStart({ base: { openRoom: () => {
    opened += 1;
    return {
      presence: { onJoin: () => () => {}, onLeave: () => () => {} },
      direct: { onMessage: () => () => {} },
    };
  } } });
  await expect(joining).rejects.toBeInstanceOf(AppRoomAuthorityChangedError);
  await rotating;
  expect(opened).toBe(0);
});

test('offscreen update carries exact conflict and publication receipts and trusts callback cleanup only', async () => {
  const identity = await generateIdentity();
  const files = { 'index.html': readFileSync(new URL('../../extension/tests/runner.html', import.meta.url)) };
  const payload = packBundle({ entry: 'index.html', files });
  const { manifest, hash } = await buildManifest({ payload, type: 'app', identity });
  const app = await prepareAppBundle({ uri: formatPeerdUri({ did: identity.did, hash }), manifest, payload });
  const update = source.slice(source.indexOf("case 'dweb/base-host/update-app':"));
  const callback = section('announce: async', '\n              },', update)
    .replace(/^announce: /, '') + '\n}';
  const calls: any[] = [];
  let reply: any = { ok: true, app: { id: 'a' }, cleanupHashes: ['old', 'old', 3] };
  const message = {
    appId: 'a', strategy: 'replace', conflictToken: 7, publicationGeneration: 11,
    previousHash: 'forged-old', pendingHashes: ['forged-pending'],
  };
  const boundary = new Function('msg', 'swEffectCall', 'publishFailureError', 'manifest', 'payload', 'appSeedHandoff', 'prepared',
    'withDeclaration', 'let cleanupHashes = []; return { announce: ' + callback + ', cleanup: () => cleanupHashes };',
  )(message, async (type: string, args: any) => { calls.push({ type, ...args }); return reply; },
    publishFailureError, manifest, payload, appSeedHandoff, app, withDeclaration);
  await boundary.announce();
  expect(calls[0]).toMatchObject({
    type: 'dweb/app-update', appId: 'a', strategy: 'replace',
    conflictToken: 7, publicationGeneration: 11,
  });
  // The update records what the new version's verified files ask of peerd: no peerd.json, the dwapp default.
  expect(calls[0].dweb).toEqual({ ...app.dweb, declared: { hash, dweb: true, instructions: false, observeAct: false } });
  expect(calls[0].files).toBeUndefined();
  expect(calls[0].seedBundle.manifest).toEqual(manifest);
  expect(fromBase64(calls[0].seedBundle.payload)).toEqual(payload);
  expect(boundary.cleanup()).toEqual(['old']);
  reply = {
    ok: false, error: 'conflict', conflictToken: 8, requiresAction: true,
    performed: true, outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
  };
  await expect(boundary.announce()).rejects.toMatchObject({
    message: 'conflict', conflictToken: 8, requiresAction: true,
    performed: true, outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
  });
});

test('a heard install and a room install record what the version\'s verified files ask of peerd', async () => {
  const identity = await generateIdentity();
  const files = { 'index.html': readFileSync(new URL('../../extension/tests/runner.html', import.meta.url)) };
  const payload = packBundle({ entry: 'index.html', files });
  const { manifest, hash } = await buildManifest({ payload, type: 'app', identity });
  const app = await prepareAppBundle({ uri: formatPeerdUri({ did: identity.did, hash }), manifest, payload });
  const heard = source.slice(source.indexOf("case 'dweb/base-host/install-app':"));
  const room = source.slice(source.indexOf("if (op === 'install-app') {"));
  for (const [install, end] of [[heard, '\n              },'], [room, '\n      },']]) {
    const callback = section('announce: async', end, install).replace(/^announce: /, '') + '\n}';
    const calls: ({ type: string } & Record<string, unknown>)[] = [];
    const announce = new Function('msg', 'swEffectCall', 'publishFailureError', 'manifest', 'payload', 'appSeedHandoff', 'prepared',
      'withDeclaration', 'appId', 'return ' + callback + ';',
    )({ publicationGeneration: 3 }, async (type: string, args: Record<string, unknown>) => {
      calls.push({ type, ...args });
      return { ok: true, app: { id: 'a' } };
    }, publishFailureError, manifest, payload, appSeedHandoff, app, withDeclaration, 'a') as () => Promise<unknown>;
    await announce();
    expect(calls[0]).toMatchObject({ type: 'dweb/app-install', appId: 'a', publicationGeneration: 3 });
    // No peerd.json: the dwapp default an install writes.
    expect(calls[0].dweb).toEqual({ ...app.dweb, declared: { hash, dweb: true, instructions: false, observeAct: false } });
  }
});

test('retired reseed compensates through the network, not its host wrapper', async () => {
  const { rollbackSharePublication } = await import('../../extension/offscreen/share-publication.js');
  const published: any[] = [];
  const removed: any[] = [];
  const released: any[] = [];
  const h = { base: {
    did: 'publisher',
    publishMeta: async (card: any) => { published.push(card); },
    unpublishMeta: async (card: any) => { removed.push(card); },
  } };
  const msg = { appId: 'app' };
  const makeCompensate = new Function(
    'handle', 'h', 'latestReseedAttempts', 'msg', 'reseedAttemptId',
    'rollbackSharePublication', 'publicationOwnerId', 'slug', 'previousCard',
    'rollbackPublishedBytes',
    'return ({' + section('compensate: async (published, announced) => {',
      '            commit: (published) => {') + '}).compensate;',
  );
  const invoke = async (previousCard: any) => {
    const compensate = makeCompensate(h, h, new Map([['app', 'attempt']]), msg,
      'attempt', rollbackSharePublication, 'attempt-owner', 'app-slug', previousCard,
      (item: any) => { released.push(item.hash); });
    await compensate({ hash: 'new-hash' }, { card: { seq: 7 } });
  };
  await invoke(null);
  expect(removed).toEqual([{ slug: 'app-slug', publisher: 'publisher' }]);
  const previous = { name: 'App', description: '', seq: 6,
    head: { version_id: 'old-hash', content_addr: 'peerd://old-hash', size: 12 } };
  await invoke(previous);
  expect(published).toHaveLength(1);
  expect(published[0].head).toEqual(previous.head);
  expect(published[0].seq).toBeGreaterThan(7);
  expect(released).toEqual(['new-hash', 'new-hash']);
});

test('worker adoption retains the existing mesh without arming a duplicate reseed', async () => {
  const notices: any[] = [];
  const activate = new Function('reseedNotifier',
    `let activeFeatureHostEpoch = null, meshGeneration = 0, custodyIntended = false;
     const DWEB_ENABLED = true;
     const connectCustodyPort = () => {}, disconnectCustodyPort = () => {};
     const start = async () => { if (!meshGeneration) meshGeneration = 1; };
     const status = () => ({running: true, meshGeneration, did: 'test-did'});
     ${section('const activateDwebFeatureLease =', 'export const startDwebFeatureLease')}
     return activateDwebFeatureLease;`)(
    { notify: async (notice: any) => { notices.push(notice); return { ok: true }; } },
  );
  await activate({ hostEpoch: 'retained-host-epoch' });
  await activate({ hostEpoch: 'retained-host-epoch' });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ hostEpoch: 'retained-host-epoch', meshGeneration: 1 });
  await activate({ hostEpoch: 'replacement-host-epoch' });
  expect(notices).toHaveLength(2);
});
