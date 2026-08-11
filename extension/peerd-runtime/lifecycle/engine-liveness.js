// @ts-check
// Engine liveness ledger — which engine instances were HOSTED when the
// lights went out (§9's missing durable fact).
//
// The engine registries are durable CATALOGS (which instances exist); the
// tab trackers know which are LIVE — but only in SW memory, which is
// exactly what an eviction destroys. Without a durable copy, a fresh boot
// cannot tell "dormant instance" (normal, most of the catalog) from
// "instance whose running process was just lost" (the §9/§14
// resource-lost case that must be reaped, audited, and reported).
//
// This ledger is that copy: the tab trackers write it on adopt/drop, and
// boot sweeps it against the tabs that actually survived — entries with no
// surviving tab are the orphans (process state lost, files persist).
// Session-tier data about session-tier resources: a stale ledger is
// self-healing (the sweep rewrites it to the survivor set every boot).
//
// Same injected-storage + mutation-queue shape as the operation log.

export const ENGINE_LIVENESS_KEY = 'peerd.lifecycle.engineLiveness';

/**
 * @typedef {Object} LivenessEntry
 * @property {string} kind    'vm' | 'notebook' | 'pod' | 'app'
 * @property {string} id      instance id
 * @property {number} tabId
 * @property {number} at      adopt time, epoch ms
 */

/**
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>,
 *   set: (key: string, value: any) => Promise<void> }} deps.storage
 * @param {() => number} [deps.now]
 */
export const makeEngineLiveness = ({ storage, now = Date.now }) => {
  /** @type {Promise<unknown>} */
  let queueTail = Promise.resolve();
  /** @template T @param {() => Promise<T>} job @returns {Promise<T>} */
  const enqueue = (job) => {
    const run = queueTail.then(job, job);
    queueTail = run.then(() => undefined, () => undefined);
    return run;
  };

  /** @returns {Promise<Record<string, LivenessEntry>>} */
  const load = async () => {
    const raw = await storage.get(ENGINE_LIVENESS_KEY).catch(() => null);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  };

  /** @param {string} kind @param {string} id */
  const keyOf = (kind, id) => `${kind}:${id}`;

  /**
   * Record that an instance is hosted in a live tab. Idempotent;
   * best-effort (a failed write costs a missed reap notice, never a
   * broken adopt — the tracker's own bookkeeping is the live truth).
   * @param {string} kind @param {string} id @param {number} tabId
   */
  const adopt = (kind, id, tabId) => enqueue(async () => {
    const map = await load();
    map[keyOf(kind, id)] = { kind, id, tabId, at: now() };
    await storage.set(ENGINE_LIVENESS_KEY, map).catch(() => {});
  }).catch(() => {});

  /** Clean drop (tab closed while the SW watched). @param {string} kind @param {string} id */
  const drop = (kind, id) => enqueue(async () => {
    const map = await load();
    delete map[keyOf(kind, id)];
    await storage.set(ENGINE_LIVENESS_KEY, map).catch(() => {});
  }).catch(() => {});

  /**
   * The boot sweep: entries whose instance is NOT in the survivor set lost
   * their process to the interruption. The ledger is rewritten to exactly
   * the survivors, so a stale/corrupt ledger heals in one boot.
   *
   * @param {{ surviving: Iterable<string> }} input  keys as `${kind}:${id}`
   * @returns {Promise<LivenessEntry[]>} the lost instances
   */
  const sweep = ({ surviving }) => enqueue(async () => {
    const map = await load();
    const survivorKeys = new Set(surviving);
    /** @type {LivenessEntry[]} */
    const lost = [];
    /** @type {Record<string, LivenessEntry>} */
    const next = {};
    for (const [key, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
      if (survivorKeys.has(key)) next[key] = entry;
      else lost.push(entry);
    }
    await storage.set(ENGINE_LIVENESS_KEY, next).catch(() => {});
    return lost;
  });

  return { adopt, drop, sweep };
};
