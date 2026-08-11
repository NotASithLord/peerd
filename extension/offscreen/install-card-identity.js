// @ts-check
// Bind an install to the discovery card the local host actually heard.

/**
 * A discovery head carries the same manifest hash twice: as `version_id` and
 * inside its `peerd://` content address. Keep the check local to this boundary
 * module so the Store package still has no static distributed-module edge.
 * @param {any} row
 */
const hasConsistentVersionAddress = (row) => {
  const uri = row?.head?.content_addr;
  const versionId = row?.head?.version_id;
  if (typeof uri !== 'string' || !uri.startsWith('peerd://')
      || typeof versionId !== 'string' || !/^[a-f0-9]{64}$/.test(versionId)) return false;
  let rest = uri.slice('peerd://'.length);
  if (rest.startsWith('did:')) {
    const slash = rest.indexOf('/');
    if (slash < 0) return false;
    rest = rest.slice(slash + 1);
  }
  const [addressedHash] = rest.split('/');
  return addressedHash === versionId;
};

/**
 * Convert one verified discovery row into the Library/update view. A signed
 * but internally inconsistent card is omitted rather than becoming a
 * perpetual false update prompt.
 * @param {any} row
 * @returns {any | null}
 */
export const discoveredAppFromRow = (row) => hasConsistentVersionAddress(row) ? ({
  dwapp_id: row.dwapp_id,
  slug: row.slug ?? null,
  name: row.name,
  uri: row.head.content_addr,
  version_id: row.head.version_id,
  seq: row.seq ?? 0,
  publisher: row.publisher ?? null,
  previous_version_id: row.head.previous_version_id ?? null,
  git_commit_oid: row.head.git_commit_oid ?? null,
  changelog: row.head.changelog ?? '',
}) : null;

/**
 * @param {any[]} rows
 * @param {unknown} uri
 * @returns {{ dwappId: string, slug: string, seq: number, publisher: string | null } | null}
 */
export const identityForDiscoveredUri = (rows, uri) => {
  if (typeof uri !== 'string') return null;
  const matches = (Array.isArray(rows) ? rows : []).filter((row) => (
    hasConsistentVersionAddress(row)
    &&
    row?.head?.content_addr === uri
    && typeof row.dwapp_id === 'string'
    && typeof row.slug === 'string'
    && Number.isInteger(row.seq)
  )).map((row) => ({
    dwappId: row.dwapp_id,
    slug: row.slug,
    seq: row.seq,
    publisher: typeof row.publisher === 'string' ? row.publisher : null,
  }));
  if (!matches.length) return null;
  const first = matches[0];
  return matches.every((candidate) => (
    candidate.dwappId === first.dwappId
    && candidate.slug === first.slug
    && candidate.seq === first.seq
    && candidate.publisher === first.publisher
  )) ? first : null;
};

/**
 * Compare a heard card with the durable App stream and fetched manifest.
 * Omitted expectations are not checked, which lets first install bind only the
 * manifest while update binds all three identities.
 *
 * @param {{ dwappId: string, publisher: string | null } | null} identity
 * @param {{ expectedDwappId?: unknown, expectedPublisher?: unknown,
 *   manifestPublisher?: unknown }} [expected]
 * @returns {string | null}
 */
export const discoveredIdentityError = (identity, expected = {}) => {
  if (!identity) return 'discovery-card-not-found';
  if (typeof expected.expectedDwappId === 'string'
      && identity.dwappId !== expected.expectedDwappId) {
    return 'discovery-stream-mismatch';
  }
  if (typeof expected.expectedPublisher === 'string'
      && identity.publisher !== expected.expectedPublisher) {
    return 'discovery-stream-publisher-mismatch';
  }
  if (Object.hasOwn(expected, 'manifestPublisher') && identity.publisher
      && expected.manifestPublisher !== identity.publisher) {
    return 'discovery-publisher-mismatch';
  }
  return null;
};
