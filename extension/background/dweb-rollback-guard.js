// @ts-check
// Durable high-water marks for public App discovery streams.
//
// The offscreen Library is an in-memory availability cache, so it cannot also
// be the rollback authority: Chrome may tear it down at any time. This SW-owned
// store remembers the greatest publisher-signed sequence observed per stable
// dwapp id. Equal sequence + equal version may rehydrate an empty Library;
// lower sequences and same-sequence equivocation are refused.

export const DWEB_HIGH_WATER_KEY = 'dweb.metaHighWater.v1';
export const DWEB_HIGH_WATER_SCHEMA = 1;
export const DEFAULT_DWEB_HIGH_WATER_CAP = 10_000;

/** @param {unknown} value @param {number} max */
const boundedString = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

/**
 * @param {unknown} input
 * @returns {{ ok: true, value: { dwappId: string, publisher: string, seq: number, versionId: string } }
 *   | { ok: false, error: string }}
 */
const normalizeCandidate = (input) => {
  const candidate = /** @type {Record<string, unknown>} */ (input ?? {});
  if (typeof candidate.dwappId !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.dwappId)) {
    return { ok: false, error: 'dweb-version-identity-invalid' };
  }
  if (!boundedString(candidate.publisher, 512)
      || !Number.isSafeInteger(candidate.seq) || /** @type {number} */ (candidate.seq) < 0
      || !boundedString(candidate.versionId, 128)) {
    return { ok: false, error: 'dweb-version-metadata-invalid' };
  }
  return {
    ok: true,
    value: {
      dwappId: candidate.dwappId,
      publisher: /** @type {string} */ (candidate.publisher),
      seq: /** @type {number} */ (candidate.seq),
      versionId: /** @type {string} */ (candidate.versionId),
    },
  };
};

/**
 * @param {unknown} raw
 * @returns {{ schema: number, entries: Record<string, { publisher: string, seq: number, versionId: string }> } | null}
 */
const normalizeState = (raw) => {
  if (raw == null) return { schema: DWEB_HIGH_WATER_SCHEMA, entries: Object.create(null) };
  if (typeof raw !== 'object' || raw === null) return null;
  const value = /** @type {Record<string, any>} */ (raw);
  if (value.schema !== DWEB_HIGH_WATER_SCHEMA || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    return null;
  }
  /** @type {Record<string, { publisher: string, seq: number, versionId: string }>} */
  const entries = Object.create(null);
  for (const [dwappId, entry] of Object.entries(value.entries)) {
    const normalized = normalizeCandidate({ dwappId, .../** @type {Record<string, unknown>} */ (entry) });
    if (!normalized.ok) return null;
    entries[dwappId] = {
      publisher: normalized.value.publisher,
      seq: normalized.value.seq,
      versionId: normalized.value.versionId,
    };
  }
  return { schema: DWEB_HIGH_WATER_SCHEMA, entries };
};

/**
 * @param {{
 *   kv: { get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<any> },
 *   cap?: number,
 * }} opts
 */
export const createDwebRollbackGuard = ({ kv, cap = DEFAULT_DWEB_HIGH_WATER_CAP }) => {
  // chrome.storage.local has no compare-and-swap. Serialize each
  // read/decide/write transaction within this SW generation.
  let lane = Promise.resolve();

  /** @param {unknown} candidate */
  const admit = (candidate) => {
    const run = lane.then(async () => {
      const normalized = normalizeCandidate(candidate);
      if (!normalized.ok) return { ok: false, accepted: false, error: normalized.error };
      const next = normalized.value;
      const state = normalizeState(await kv.get(DWEB_HIGH_WATER_KEY));
      if (!state) return { ok: false, accepted: false, error: 'dweb-version-state-corrupt' };

      const current = state.entries[next.dwappId];
      if (current) {
        if (current.publisher !== next.publisher) {
          return { ok: false, accepted: false, error: 'dweb-version-publisher-conflict' };
        }
        if (next.seq < current.seq) {
          return { ok: true, accepted: false, error: 'dweb-version-rollback' };
        }
        if (next.seq === current.seq) {
          return next.versionId === current.versionId
            ? { ok: true, accepted: true, replay: true }
            : { ok: true, accepted: false, error: 'dweb-version-equivocation' };
        }
      } else if (Object.keys(state.entries).length >= cap) {
        // Eviction would reopen rollback for the removed app. Refuse a new
        // stream instead; updates to known streams remain available.
        return { ok: true, accepted: false, error: 'dweb-version-capacity' };
      }

      state.entries[next.dwappId] = {
        publisher: next.publisher,
        seq: next.seq,
        versionId: next.versionId,
      };
      await kv.set(DWEB_HIGH_WATER_KEY, state);
      return { ok: true, accepted: true, replay: false };
    });
    lane = run.then(() => undefined, () => undefined);
    return run;
  };

  return Object.freeze({ admit });
};
