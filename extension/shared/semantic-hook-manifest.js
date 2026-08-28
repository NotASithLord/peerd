// @ts-check

import { structuredClonePayloadBytes } from './structured-clone-size.js';

export const USER_HOOK_RECORDS_MAX_COUNT = 256;
export const USER_HOOK_RECORDS_MAX_BYTES = 8 * 1024 * 1024;
export const SEMANTIC_HOOK_MANIFEST_MAX_BYTES = 256 * 1024;

export class HookRecordsLimitError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'HookRecordsLimitError';
    this.code = 'hook-records-limit';
  }
}

/** @param {unknown} records */
export const assertUserHookRecordsBounded = (records) => {
  if (!Array.isArray(records)) throw new HookRecordsLimitError('hooks must be an array');
  if (records.length > USER_HOOK_RECORDS_MAX_COUNT) {
    throw new HookRecordsLimitError(
      `hook limit exceeded: at most ${USER_HOOK_RECORDS_MAX_COUNT} hooks may be stored`,
    );
  }
  const bytes = structuredClonePayloadBytes(records, { maxDepth: 8, maxNodes: 10_000 });
  if (!Number.isFinite(bytes) || bytes > USER_HOOK_RECORDS_MAX_BYTES) {
    throw new HookRecordsLimitError(
      `hook data limit exceeded: stored hooks must fit within ${USER_HOOK_RECORDS_MAX_BYTES} bytes`,
    );
  }
  return bytes;
};

const invalidRecord = (/** @type {number} */ index) => Object.freeze({
  id: `invalid-user-hook-${index}`, event: 'pre-tool-use', enabled: true, kind: 'invalid',
});

/**
 * Project durable hook configuration into the semantic turn. Prose and retired
 * executable bodies stay in storage/UI only; the controller receives exactly
 * the bounded fields needed to compile an enabled rule or fail closed.
 * @param {unknown} records
 */
export const projectSemanticHookManifest = (records) => {
  assertUserHookRecordsBounded(records);
  /** @type {any[]} */
  const projected = [];
  for (const [index, value] of /** @type {any[]} */ (records).entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      projected.push(invalidRecord(index));
      continue;
    }
    const record = /** @type {Record<string,any>} */ (value);
    if (record.enabled === false) continue;
    const rule = record.rule && typeof record.rule === 'object' && !Array.isArray(record.rule)
      ? Object.freeze({
        ...(typeof record.rule.matchArg === 'string'
          ? { matchArg: record.rule.matchArg } : {}),
        ...(typeof record.rule.contains === 'string'
          ? { contains: record.rule.contains } : {}),
        ...(typeof record.rule.pattern === 'string'
          ? { pattern: record.rule.pattern } : {}),
        ...(record.rule.onMatch === 'allow' || record.rule.onMatch === 'block'
          ? { onMatch: record.rule.onMatch } : {}),
        ...(typeof record.rule.reason === 'string'
          ? { reason: record.rule.reason } : {}),
      })
      : undefined;
    projected.push(Object.freeze({
      id: typeof record.id === 'string' ? record.id : `invalid-user-hook-${index}`,
      event: record.event === 'post-tool-use' ? 'post-tool-use' : 'pre-tool-use',
      enabled: true,
      ...(typeof record.order === 'number' ? { order: record.order } : {}),
      ...(typeof record.match === 'string' ? { match: record.match } : {}),
      kind: typeof record.kind === 'string' ? record.kind : 'invalid',
      ...(rule ? { rule } : {}),
    }));
  }
  const bytes = structuredClonePayloadBytes(projected, { maxDepth: 8, maxNodes: 10_000 });
  if (!Number.isFinite(bytes) || bytes > SEMANTIC_HOOK_MANIFEST_MAX_BYTES) {
    throw new HookRecordsLimitError(
      `enabled hook policy limit exceeded: semantic hooks must fit within ${SEMANTIC_HOOK_MANIFEST_MAX_BYTES} bytes`,
    );
  }
  return Object.freeze(projected);
};
