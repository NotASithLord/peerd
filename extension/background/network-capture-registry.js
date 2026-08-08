// @ts-check
// Per-tab ownership for CDP Network captures.
//
// The debugger pool has several independent lifecycle exits: explicit detach,
// user detach, tab removal, ordinary stop, and a replacement start. Keeping the
// map operations behind this tiny registry makes those exits use the same
// identity check. In particular, a slow stop for an old capture must not delete
// a newer capture that started on the same tab while it was settling.

import { isCloudMetadataHost, isPrivateOrLocalHost } from '../shared/private-network.js';

/**
 * @param {unknown} url
 * @param {unknown} resourceType
 * @returns {'record'|'ignore'|'discard'}
 */
export const networkCaptureRequestPolicy = (url, resourceType) => {
  try {
    const host = new URL(typeof url === 'string' ? url : '').hostname;
    if (!isCloudMetadataHost(host) && !isPrivateOrLocalHost(host)) return 'record';
    return resourceType === 'Document' ? 'discard' : 'ignore';
  } catch {
    return 'ignore';
  }
};

export const createNetworkCaptureRegistry = () => {
  /** @type {Map<number, Map<string, any>>} */
  const captures = new Map();

  /** @param {number} tabId */
  const begin = (tabId) => {
    /** @type {Map<string, any>} */
    const capture = new Map();
    captures.set(tabId, capture);
    return capture;
  };

  /** @param {number} tabId */
  const get = (tabId) => captures.get(tabId);

  /**
   * Record one request without letting a long-lived capture grow without bound.
   * Existing keys may still be replaced after the cap is reached.
   * @param {number} tabId @param {string} key @param {any} value @param {number} limit
   */
  const record = (tabId, key, value, limit) => {
    const capture = captures.get(tabId);
    if (!capture || (!capture.has(key) && capture.size >= limit)) return false;
    capture.set(key, value);
    return true;
  };

  /** @param {number} tabId @param {Map<string, any> | undefined} expected */
  const finish = (tabId, expected) => {
    // why: a replacement start or policy cancellation revokes the old capture.
    // Its settling stop still holds the old Map, but must not recover and digest
    // those bytes after ownership has moved or been discarded.
    if (!expected || captures.get(tabId) !== expected) return [];
    captures.delete(tabId);
    return [...expected.values()];
  };

  /** @param {number} tabId */
  const discard = (tabId) => captures.delete(tabId);

  /** @param {number} tabId */
  const has = (tabId) => captures.has(tabId);

  /** @param {number} tabId @param {Map<string, any>} capture */
  const isCurrent = (tabId, capture) => captures.get(tabId) === capture;

  return { begin, get, record, finish, discard, has, isCurrent };
};
