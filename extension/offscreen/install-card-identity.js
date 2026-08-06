// @ts-check
// Bind an install to the discovery card the local host actually heard.

/**
 * @param {any[]} rows
 * @param {unknown} uri
 * @returns {{ dwappId: string, slug: string, seq: number, publisher: string | null } | null}
 */
export const identityForDiscoveredUri = (rows, uri) => {
  if (typeof uri !== 'string') return null;
  const matches = (Array.isArray(rows) ? rows : []).filter((row) => (
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
