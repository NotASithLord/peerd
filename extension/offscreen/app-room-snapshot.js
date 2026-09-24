// @ts-check

export class AppRoomSnapshotRejectedError extends Error {
  /** @param {string} reason */
  constructor(reason) { super(reason); this.name = 'AppRoomSnapshotRejectedError'; }
}

/**
 * A working-tree publication is not a signed release. Its snapshot is captured
 * by the kernel before it takes the App authority lock, avoiding a reverse
 * editor flush while that lock is held. Only the exact, acknowledged App-room
 * member may use that distinct path; release metadata is never accepted here.
 *
 * @param {any} message
 * @param {import('./app-room-liveness.js').AppRoomClaim[]} claims
 * @param {()=>boolean} current
 */
export const requireAppRoomSnapshot = (message, claims, current) => {
  if (message?.op !== 'publish-app'
      || typeof message.appId !== 'string' || !message.appId
      || !Number.isSafeInteger(message.appGeneration) || message.appGeneration < 0
      || !current()) throw new AppRoomSnapshotRejectedError('app-identity-changed');
  // why: a room snapshot must not become an alternate input to the release
  // identity gate, including through a caller-supplied release timestamp/hash.
  if (['releaseSnapshot', 'release', 'expectedHash', 'created'].some(
    (key) => Object.hasOwn(message, key),
  )) throw new AppRoomSnapshotRejectedError('room-snapshot-release-fields-forbidden');
  const owner = claims.find((claim) => claim.roomId === message.roomId
    && claim.clientId === message.roomClientId
    && claim.appId === message.appId
    && claim.documentId === message.appDocumentId
    && claim.tabId === message.appTabId
    && typeof claim.admissionToken === 'string' && claim.admissionToken.length >= 16
    && claim.admissionToken === message.roomAdmissionToken
    && claim.expiresAt === null);
  if (!owner) throw new AppRoomSnapshotRejectedError('app-room-admission-mismatch');
  const snapshot = message.roomSnapshot;
  if (snapshot?.ok !== true || snapshot.record?.id !== message.appId
      || !snapshot.files || typeof snapshot.files !== 'object' || Array.isArray(snapshot.files)) {
    throw new AppRoomSnapshotRejectedError('room-snapshot-identity-mismatch');
  }
  return snapshot;
};
