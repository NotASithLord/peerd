// @ts-check

/** @typedef {'current'|'migratable'|'newer'|'unsupported'|'malformed'} VersionClass */
/** @param {{found:unknown,supported:number,oldestMigratable?:number}} input
 * @returns {VersionClass} */
export const classifyStoreVersion = ({ found, supported, oldestMigratable }) => {
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 0) {
    return 'malformed';
  }
  if (found === supported) return 'current';
  if (found > supported) return 'newer';
  const floor = typeof oldestMigratable === 'number' ? oldestMigratable : 0;
  return found >= floor ? 'migratable' : 'unsupported';
};

/** @param {{store:string,found:unknown,supported:number,oldestMigratable?:number}} input
 * @returns {{mode:'read-write'|'migrate'|'read-only',versionClass:VersionClass,
 * reason:string,diagnosticId?:string}} */
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

/** @typedef {{from:number,to:number,migrate:(data:Record<string,unknown>)=>Record<string,unknown>,
 * drops?:string[]}} MigrationStep */

/**
 * @typedef {{ ok: true, data: Record<string, unknown>, version: number,
 *   completedSteps: number[] }
 * | { ok: false, diagnosticId: string, failedStep: { from: number, to: number } | null,
 *   data: unknown, version: unknown, resumeFrom: number, reason: string }}
 *   MigrationResult
 */

/** @param {{store:string,data:unknown,fromVersion:unknown,toVersion:number,
 * steps:MigrationStep[],checkpointVersion?:number}} input @returns {MigrationResult} */
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
  if (checkpointVersion !== undefined
      && (typeof checkpointVersion !== 'number' || !Number.isInteger(checkpointVersion))) {
    return fail('malformed-checkpoint', 'checkpoint cursor is not an integer; retained for diagnosis');
  }

  const start = Math.max(fromVersion, checkpointVersion ?? fromVersion);

  const chain = (Array.isArray(steps) ? [...steps] : [])
    .filter((step) => step && step.to > start && step.from >= fromVersion)
    .sort((a, b) => a.from - b.from);
  for (const step of chain) {
    if (step.to <= step.from) {
      return fail(`backward-step-${step.from}`, 'migration steps must be forward-only');
    }
  }

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
