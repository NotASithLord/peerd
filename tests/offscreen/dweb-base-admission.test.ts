import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createAppRoomAuthority, AppRoomAuthorityChangedError } from '../../extension/offscreen/app-room-authority.js';
import { publishFailureError } from '../../extension/shared/publish-transaction.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { buildManifest } from '../../extension/peerd-distributed/content/manifest.js';
import { packBundle } from '../../extension/peerd-distributed/content/bundle.js';
import { formatPeerdUri } from '../../extension/peerd-distributed/content/uri.js';
import { prepareAppBundle } from '../../extension/peerd-distributed/apps/loader.js';
import { fromBase64, toBase64 } from '../../extension/shared/bundle/bytes.js';

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
  const callback = section('install: async', '\n              },', update)
    .replace(/^install: /, '') + '\n}';
  const calls: any[] = [];
  let reply: any = { ok: true, app: { id: 'a' }, cleanupHashes: ['old', 'old', 3] };
  const message = {
    appId: 'a', strategy: 'replace', conflictToken: 7, publicationGeneration: 11,
    previousHash: 'forged-old', pendingHashes: ['forged-pending'],
  };
  const boundary = new Function('msg', 'swEffectCall', 'jsonSafeFiles', 'publishFailureError', 'manifest', 'payload', 'toBase64',
    'let cleanupHashes = []; return { install: ' + callback + ', cleanup: () => cleanupHashes };',
  )(message, async (type: string, args: any) => { calls.push({ type, ...args }); return reply; },
    (files: any) => files, publishFailureError, manifest, payload, toBase64);
  await boundary.install(app);
  expect(calls[0]).toMatchObject({
    type: 'dweb/app-update', appId: 'a', strategy: 'replace',
    conflictToken: 7, publicationGeneration: 11,
  });
  expect(calls[0].dweb).toEqual(app.dweb);
  expect(calls[0].seedBundle.manifest).toEqual(manifest);
  expect(fromBase64(calls[0].seedBundle.payload)).toEqual(payload);
  expect(boundary.cleanup()).toEqual(['old']);
  reply = {
    ok: false, error: 'conflict', conflictToken: 8, requiresAction: true,
    performed: true, outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
  };
  await expect(boundary.install(app)).rejects.toMatchObject({
    message: 'conflict', conflictToken: 8, requiresAction: true,
    performed: true, outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
  });
});
