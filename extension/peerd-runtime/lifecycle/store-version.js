// @ts-check
// Versioned durable stores — the migration/downgrade guard (contract §11).
//
// Each durable surface carries its OWN schema version. This module is the
// pure decision + the pure migration driver:
//   - classify a found version against what this build supports;
//   - refuse-newer fails READ-ONLY (never reinterpret as empty or corrupt);
//   - migration is forward-only, restart-safe (checkpointed per step),
//     idempotent on rerun, version-stamped only after success;
//   - a step that silently drops fields it did not declare fails the run;
//   - failure preserves the original data byte-for-byte and surfaces a
//     deterministic diagnostic identifier — never an empty replacement.
//
// Pure: steps are injected functions; no IO, no clock.

/**
 * @typedef {'current' | 'migratable' | 'newer' | 'unsupported' | 'malformed'}
 *   VersionClass
 */

/**
 * Classify a store's found schema version.
 *
 * @param {Object} input
 * @param {unknown} input.found        version stamped on the stored data
 * @param {number} input.supported     the version this build reads/writes
 * @param {number} [input.oldestMigratable]  floor we still migrate from
 *                                     (defaults to every version <= supported)
 * @returns {VersionClass}
 */
export const classifyStoreVersion = ({ found, supported, oldestMigratable }) => {
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 0) {
    return 'malformed';
  }
  if (found === supported) return 'current';
  if (found > supported) return 'newer';
  const floor = typeof oldestMigratable === 'number' ? oldestMigratable : 0;
  return found >= floor ? 'migratable' : 'unsupported';
};

/**
 * Turn a classification into an access mode. The downgrade contract
 * (§11.5) lands here: a newer schema is REFUSED for mutation but never
 * reinterpreted — 'read-only' with an unsupported-newer-profile reason,
 * data untouched. Unsupported-old and malformed stores fail closed the
 * same way (original retained, diagnostic id exposed).
 *
 * @param {Object} input
 * @param {string} input.store   store name (diagnostics only)
 * @param {unknown} input.found
 * @param {number} input.supported
 * @param {number} [input.oldestMigratable]
 * @returns {{ mode: 'read-write' | 'migrate' | 'read-only',
 *   versionClass: VersionClass, reason: string, diagnosticId?: string }}
 */
export const guardStore = ({ store, found, supported, oldestMigratable }) => {
  const versionClass = classifyStoreVersion({ found, supported, oldestMigratable });
  switch (versionClass) {
    case 'current':
      return { mode: 'read-write', versionClass, reason: 'schema current' };
    case 'migratable':
      return { mode: 'migrate', versionClass, reason: `schema v${String(found)} migrates to v${supported}` };
    case 'newer':
      return {
        mode: 'read-only',
        versionClass,
        reason: `profile schema v${String(found)} is newer than this peerd supports (v${supported}); `
          + 'refusing to mutate — upgrade peerd or restore a compatible backup',
        diagnosticId: `store-${store}-newer-v${String(found)}`,
      };
    case 'unsupported':
      return {
        mode: 'read-only',
        versionClass,
        reason: `schema v${String(found)} predates the oldest supported migration source`,
        diagnosticId: `store-${store}-unsupported-v${String(found)}`,
      };
    case 'malformed':
    default:
      return {
        mode: 'read-only',
        versionClass,
        reason: 'schema version missing or malformed; original data retained for diagnosis',
        diagnosticId: `store-${store}-malformed-version`,
      };
  }
};

/**
 * @typedef {Object} MigrationStep
 * @property {number} from
 * @property {number} to             must be > from (forward-only)
 * @property {(data: Record<string, unknown>) => Record<string, unknown>} migrate
 * @property {string[]} [drops]      top-level keys this step is ALLOWED to
 *                                   remove; any other disappearance fails
 */

/**
 * @typedef {{ ok: true, data: Record<string, unknown>, version: number,
 *   completedSteps: number[] }
 * | { ok: false, diagnosticId: string, failedStep: { from: number, to: number } | null,
 *   data: unknown, version: unknown, resumeFrom: number, reason: string }}
 *   MigrationResult
 */

/**
 * Run a store's migration chain. Restart-safe: `checkpointVersion` is the
 * last version a previous (possibly interrupted) run durably reached —
 * steps at or below it are skipped, which is also what makes a full rerun
 * idempotent. On ANY failure the ORIGINAL input data is returned
 * untouched with a deterministic diagnostic id; the caller must not stamp
 * a version or replace the store.
 *
 * @param {Object} input
 * @param {string} input.store            store name (diagnostics)
 * @param {unknown} input.data            the stored payload
 * @param {unknown} input.fromVersion     version stamped on the payload
 * @param {number} input.toVersion        target (this build's supported)
 * @param {MigrationStep[]} input.steps
 * @param {number} [input.checkpointVersion]  durable resume cursor
 * @returns {MigrationResult}
 */
export const runMigration = ({ store, data, fromVersion, toVersion, steps, checkpointVersion }) => {
  /** @param {string} suffix @param {string} reason
   *  @param {{ from: number, to: number } | null} [failedStep]
   *  @returns {MigrationResult} */
  const fail = (suffix, reason, failedStep = null) => ({
    ok: false,
    diagnosticId: `migrate-${store}-${suffix}`,
    failedStep,
    data,               // the original, untouched
    version: fromVersion,
    resumeFrom: Number.isInteger(checkpointVersion)
      ? Math.max(/** @type {number} */ (checkpointVersion),
        typeof fromVersion === 'number' ? fromVersion : 0)
      : (typeof fromVersion === 'number' ? fromVersion : 0),
    reason,
  });

  if (typeof fromVersion !== 'number' || !Number.isInteger(fromVersion)) {
    return fail('malformed-version', 'stored version is not an integer');
  }
  if (fromVersion > toVersion) {
    return fail(`downgrade-v${fromVersion}`, 'downgrade migration refused; store is newer than target');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return fail('malformed-data', 'stored payload is not a record; retained for diagnosis');
  }
  // A malformed checkpoint fails closed rather than being coerced: treating
  // it as absent would RE-RUN steps against already-migrated data, and NaN
  // arithmetic would corrupt the resume cursor.
  if (checkpointVersion !== undefined
      && (typeof checkpointVersion !== 'number' || !Number.isInteger(checkpointVersion))) {
    return fail('malformed-checkpoint', 'checkpoint cursor is not an integer; retained for diagnosis');
  }

  const start = Math.max(fromVersion, checkpointVersion ?? fromVersion);

  // Order and validate the chain before touching data: forward-only,
  // contiguous from `start` to `toVersion`.
  const chain = (Array.isArray(steps) ? [...steps] : [])
    .filter((step) => step && step.to > start && step.from >= fromVersion)
    .sort((a, b) => a.from - b.from);
  for (const step of chain) {
    if (step.to <= step.from) {
      return fail(`backward-step-${step.from}`, 'migration steps must be forward-only');
    }
  }

  // Deep-cloned at entry: steps receive an isolated copy, so a step that
  // mutates a NESTED object cannot reach back into the caller's original —
  // "failure preserves the original data" has to hold at every depth, not
  // just the top level.
  let current = /** @type {Record<string, unknown>} */ (structuredClone(data));
  let version = start;
  /** @type {number[]} */ const completedSteps = [];

  for (const step of chain) {
    if (step.from !== version) {
      return fail(`gap-at-v${version}`, `no migration step from v${version}`);
    }
    const before = current;
    let after;
    try {
      after = step.migrate({ ...before });
    } catch (error) {
      return fail(`step-v${step.from}-threw`,
        `migration step v${step.from}->v${step.to} threw: ${error instanceof Error ? error.message : String(error)}`,
        { from: step.from, to: step.to });
    }
    if (after === null || typeof after !== 'object' || Array.isArray(after)) {
      return fail(`step-v${step.from}-shape`,
        `migration step v${step.from}->v${step.to} did not return a record`,
        { from: step.from, to: step.to });
    }
    // Unknown-field guard: a step may only remove keys it declared. A key
    // set to `undefined` counts as dropped too — undefined does not survive
    // structured-clone/JSON persistence, so `{ ...d, field: undefined }`
    // would be a silent discard the moment it hits storage. This is what
    // makes "silently discard unknown fields" structurally impossible
    // rather than a review convention.
    const allowedDrops = new Set(step.drops ?? []);
    for (const key of Object.keys(before)) {
      const removed = !Object.hasOwn(after, key)
        || (after[key] === undefined && before[key] !== undefined);
      if (removed && !allowedDrops.has(key)) {
        return fail(`step-v${step.from}-dropped-${key}`,
          `migration step v${step.from}->v${step.to} dropped undeclared field "${key}"`,
          { from: step.from, to: step.to });
      }
    }
    current = /** @type {Record<string, unknown>} */ (after);
    version = step.to;
    completedSteps.push(step.to);
  }

  if (version !== toVersion) {
    return fail(`incomplete-at-v${version}`, `migration chain ends at v${version}, target v${toVersion}`);
  }

  return { ok: true, data: current, version, completedSteps };
};
