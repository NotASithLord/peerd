// @ts-check

// App-room membership is a soft lease on the exact trusted App-tab document.
// The offscreen dweb host outlives both the service worker and the tab, so a
// best-effort `leave` message cannot be its liveness authority. Chrome's
// browser-owned runtime context inventory is: it survives worker recycling and
// removes the document atomically when the tab navigates or closes.

/**
 * @typedef {{
 *   roomId: string,
 *   clientId: string,
 *   appId: string,
 *   documentId: string,
 *   tabId: number,
 *   admissionToken?: string,
 *   expiresAt?: number | null,
 * }} AppRoomClaim
 */

/** @param {unknown} value */
const boundedString = (value) => typeof value === 'string'
  && value.length >= 1 && value.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(value);

/**
 * @param {unknown} context
 * @param {AppRoomClaim} claim
 * @param {string} appTabUrl
 */
export const contextOwnsAppRoom = (context, claim, appTabUrl) => {
  if (!context || typeof context !== 'object') return false;
  const row = /** @type {Record<string, unknown>} */ (context);
  if (row.contextType !== 'TAB'
      || row.documentId !== claim.documentId
      || row.tabId !== claim.tabId
      || typeof row.documentUrl !== 'string') return false;
  const hashAt = row.documentUrl.indexOf('#');
  if (hashAt === -1 || row.documentUrl.slice(0, hashAt) !== appTabUrl) return false;
  const claimedApp = row.documentUrl.slice(hashAt + 1).split(/[?&]/, 1)[0];
  return claimedApp === claim.appId;
};

/**
 * @param {{
 *   appTabUrl: string,
 *   getContexts: null | ((filter: {contextTypes:string[],documentIds:string[]})=>Promise<any[]>),
 *   onExpired: (claim: AppRoomClaim)=>void|Promise<void>,
 *   intervalMs?: number,
 *   provisionalMs?: number,
 *   now?: ()=>number,
 *   setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval,
 * }} deps
 */
export const createAppRoomLiveness = ({
  appTabUrl,
  getContexts,
  onExpired,
  intervalMs = 5_000,
  provisionalMs = 15_000,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) => {
  if (typeof appTabUrl !== 'string' || !appTabUrl) throw new Error('app-room-url-required');
  if (typeof onExpired !== 'function') throw new Error('app-room-expiry-handler-required');
  if (!Number.isFinite(provisionalMs) || provisionalMs < 1_000 || provisionalMs > 120_000
      || typeof now !== 'function') throw new Error('app-room-admission-timeout-invalid');
  /** @type {Map<string, AppRoomClaim>} */
  const claims = new Map();
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let sweepTail = Promise.resolve();

  const keyFor = (/** @type {string} */ roomId, /** @type {string} */ clientId) => `${roomId}\0${clientId}`;
  const stopTimer = () => {
    if (timer == null) return;
    clearIntervalFn(timer);
    timer = null;
  };

  const sweep = () => {
    const operation = sweepTail.catch(() => {}).then(async () => {
      if (claims.size === 0) return;
      const snapshot = [...claims.entries()];
      let contexts = null;
      if (typeof getContexts === 'function') {
        try {
          const rows = await getContexts({
            contextTypes: ['TAB'],
            documentIds: [...new Set(snapshot.map(([, claim]) => claim.documentId))],
          });
          contexts = Array.isArray(rows) ? rows : [];
        } catch {
          // Context enumeration is the authority for committed membership. A
          // transient read failure must never evict a live user. Provisional
          // admission expiry is independent and remains safe to apply.
        }
      }
      for (const [key, claim] of snapshot) {
        const provisionalExpired = Number.isFinite(claim.expiresAt)
          && Number(claim.expiresAt) <= now();
        if (!provisionalExpired && (contexts === null
          || contexts.some((row) => contextOwnsAppRoom(row, claim, appTabUrl)))) continue;
        // A same-key rejoin may have replaced the document while getContexts
        // was in flight. Expire only the exact claim that was inspected.
        if (claims.get(key) !== claim) continue;
        claims.delete(key);
        await onExpired(claim);
      }
      if (claims.size === 0) stopTimer();
    });
    sweepTail = operation.then(() => undefined, () => undefined);
    return operation;
  };

  const ensureTimer = () => {
    if (timer != null || claims.size === 0) return;
    timer = setIntervalFn(() => { void sweep(); }, intervalMs);
  };

  return Object.freeze({
    /** @param {AppRoomClaim} claim */
    track(claim) {
      if (!boundedString(claim?.roomId) || !boundedString(claim?.clientId)
          || !boundedString(claim?.appId) || !boundedString(claim?.documentId)
          || !Number.isInteger(claim?.tabId) || claim.tabId < 0) {
        return false;
      }
      const admissionToken = claim.admissionToken;
      if (admissionToken !== undefined && !boundedString(admissionToken)) return false;
      const key = keyFor(claim.roomId, claim.clientId);
      const current = claims.get(key);
      if (current?.admissionToken && current.admissionToken !== admissionToken) return false;
      const { expiresAt: _untrustedExpiry, ...canonicalClaim } = claim;
      claims.set(key, Object.freeze({
        ...canonicalClaim,
        ...(admissionToken ? {
          admissionToken,
          expiresAt: current?.expiresAt === null ? null : now() + provisionalMs,
        } : {}),
      }));
      ensureTimer();
      return true;
    },
    /** @param {string} roomId @param {string} clientId @param {string|null} [admissionToken] */
    untrack(roomId, clientId, admissionToken = null) {
      const key = keyFor(roomId, clientId);
      const current = claims.get(key);
      if (!current || (admissionToken && current.admissionToken !== admissionToken)) return false;
      const removed = claims.delete(key);
      if (claims.size === 0) stopTimer();
      return removed;
    },
    /** @param {string} roomId @param {string} clientId @param {string} admissionToken */
    finalize(roomId, clientId, admissionToken) {
      const key = keyFor(roomId, clientId);
      const current = claims.get(key);
      if (!current || current.admissionToken !== admissionToken) return false;
      claims.set(key, Object.freeze({ ...current, expiresAt: null }));
      return true;
    },
    /** @param {string} roomId @param {string} clientId @param {string} admissionToken @param {string} appId */
    owns(roomId, clientId, admissionToken, appId) {
      const current = claims.get(keyFor(roomId, clientId));
      return current?.admissionToken === admissionToken && current.appId === appId;
    },
    sweep,
    clear() {
      claims.clear();
      stopTimer();
    },
    snapshot: () => [...claims.values()].map((claim) => ({ ...claim })),
  });
};
