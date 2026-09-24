import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { requireAppRoomSnapshot } from '../../extension/offscreen/app-room-snapshot.js';
import { createAppRoomAuthority } from '../../extension/offscreen/app-room-authority.js';

const claim = {
  roomId: 'room-a', clientId: 'client-abcdefgh', appId: 'app-a',
  documentId: 'document-abcdefgh', tabId: 41,
  admissionToken: 'admission-abcdefghijklmnop', expiresAt: null,
};
const message = () => ({
  op: 'publish-app', roomId: claim.roomId, roomClientId: claim.clientId,
  appId: claim.appId, appDocumentId: claim.documentId, appTabId: claim.tabId,
  roomAdmissionToken: claim.admissionToken, appGeneration: 2,
  roomSnapshot: { ok: true, record: { id: 'app-a', entryFile: 'index.html' },
    files: { 'index.html': { base64: 'eA==' } } },
});

describe('host-captured App room publication', () => {
  test('accepts only the exact acknowledged member and current App snapshot', () => {
    const msg = message();
    expect(requireAppRoomSnapshot(msg, [claim], () => true)).toBe(msg.roomSnapshot);
    expect(() => requireAppRoomSnapshot(msg, [claim], () => false)).toThrow('app-identity-changed');
    expect(() => requireAppRoomSnapshot(msg, [], () => true)).toThrow('app-room-admission-mismatch');
  });

  test.each(['roomId', 'roomClientId', 'appId', 'appDocumentId', 'roomAdmissionToken'])
    ('rejects a foreign %s', (key) => {
      expect(() => requireAppRoomSnapshot({ ...message(), [key]: 'foreign-identity' }, [claim], () => true))
        .toThrow('app-room-admission-mismatch');
    });

  test('rejects a different tab or an unacknowledged membership', () => {
    expect(() => requireAppRoomSnapshot({ ...message(), appTabId: 42 }, [claim], () => true))
      .toThrow('app-room-admission-mismatch');
    expect(() => requireAppRoomSnapshot(message(), [{ ...claim, expiresAt: Date.now() + 15_000 }], () => true))
      .toThrow('app-room-admission-mismatch');
  });

  test.each(['releaseSnapshot', 'release', 'expectedHash', 'created'])
    ('rejects the release-only field %s rather than bypassing its identity gate', (key) => {
      expect(() => requireAppRoomSnapshot({ ...message(), [key]: undefined }, [claim], () => true))
        .toThrow('room-snapshot-release-fields-forbidden');
    });

  test('rejects missing, malformed, or foreign-App bytes', () => {
    for (const roomSnapshot of [undefined, { ok: false },
      { ...message().roomSnapshot, record: { id: 'app-b' } },
      { ...message().roomSnapshot, files: [] }]) {
      expect(() => requireAppRoomSnapshot({ ...message(), roomSnapshot }, [claim], () => true))
        .toThrow('room-snapshot-identity-mismatch');
    }
  });

  test('durable generation and rotation refuse stale publication before dispatch', async () => {
    const authority = createAppRoomAuthority({ get: async () => ({ 'app.dweb-generation.app-a': 2 }) });
    let dispatched = false;
    await expect(authority.run('app-a', 1, (current) => {
      requireAppRoomSnapshot({ ...message(), appGeneration: 1 }, [claim], current);
      dispatched = true;
    })).rejects.toThrow('App room authority changed');
    await authority.run('app-a', 2, async (current) => {
      requireAppRoomSnapshot(message(), [claim], current);
      const rotation = authority.rotate('app-a', 3, () => {});
      // Rotation advances the floor before waiting for the admitted operation.
      await Promise.resolve();
      expect(() => requireAppRoomSnapshot(message(), [claim], current)).toThrow('app-identity-changed');
      void rotation;
    });
    expect(dispatched).toBe(false);
  });

  test('release publication retains its independent commit identity gate', () => {
    const source = readFileSync(new URL('../../extension/offscreen/dweb-base.js', import.meta.url), 'utf8');
    const release = source.slice(source.indexOf('const publishLocalApp ='), source.indexOf('const publishAppSnapshot ='));
    expect(release).toContain('const supplied = msg.releaseSnapshot;');
    expect(release).toContain('supplied.oid !== msg.release.gitCommitOid');
    expect(release).toContain("!/^[a-f0-9]{40}$/.test(supplied.oid)");
    expect(release).not.toContain('roomSnapshot');
  });
});
