// @ts-check
// Browser-neutral private protocol for moving semantic route execution out of
// the authority kernel. This module grants no route by itself: a route must be
// present, reviewed, migrated, and registered by package code before dispatch.

import {
  parseControllerAuthority,
  SEMANTIC_DISPATCH_PROTOCOL,
  structuredClonePayloadFits,
} from './structured-clone-size.js';

export const SEMANTIC_DISPATCH_CAPABILITY = 'semantic.dispatch';
export { SEMANTIC_DISPATCH_PROTOCOL };
export const SEMANTIC_DISPATCH_MAX_REQUEST_BYTES = 256 * 1024;
export const SEMANTIC_DISPATCH_MAX_RESULT_BYTES = 256 * 1024;

export const SEMANTIC_ROUTE_PLACEMENTS = Object.freeze([
  'kernel', 'semantic-host', 'split',
]);
export const SEMANTIC_ROUTE_STATES = Object.freeze(['migrated', 'unmigrated']);

const ROUTE_PATTERN = /^[a-z][a-z0-9-]*(?:[/.][A-Za-z0-9][A-Za-z0-9-]*){0,7}$/;
const isPlainRecord = (/** @type {unknown} */ value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const exactKeys = (/** @type {Record<string, unknown>} */ value, /** @type {string[]} */ keys) => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
};

/** @param {unknown} value */
export const isSemanticRouteName = (value) => typeof value === 'string'
  && value.length <= 128 && ROUTE_PATTERN.test(value);

/**
 * @typedef {{
 *   route: string,
 *   channels: readonly string[],
 *   source: string,
 *   placement: 'kernel'|'semantic-host'|'split',
 *   state: 'migrated'|'unmigrated',
 * }} SemanticRouteClassification
 */

/**
 * Validate and freeze the reviewed route table. Duplicate or malformed rows
 * are a build error, not a last-write-wins policy decision.
 * @param {unknown} value
 * @returns {ReadonlyMap<string, Readonly<SemanticRouteClassification>>}
 */
export const compileSemanticRouteClassification = (value) => {
  if (!Array.isArray(value)) throw new TypeError('semantic-route-table-invalid');
  /** @type {Map<string, Readonly<SemanticRouteClassification>>} */
  const table = new Map();
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) throw new TypeError('semantic-route-row-invalid');
    const row = /** @type {Record<string, unknown>} */ (candidate);
    if (!exactKeys(row, ['channels', 'placement', 'route', 'source', 'state'])) {
      throw new TypeError('semantic-route-row-shape-invalid');
    }
    if (!isSemanticRouteName(row.route) || table.has(/** @type {string} */ (row.route))) {
      throw new TypeError('semantic-route-name-invalid-or-duplicate');
    }
    if (!Array.isArray(row.channels) || row.channels.length === 0
        || row.channels.length > 3 || row.channels.some((channel) =>
          !['store', 'preview', 'dev'].includes(channel))
        || new Set(row.channels).size !== row.channels.length
        || typeof row.source !== 'string' || row.source.length === 0 || row.source.length > 256
        || !SEMANTIC_ROUTE_PLACEMENTS.includes(/** @type {any} */ (row.placement))
        || !SEMANTIC_ROUTE_STATES.includes(/** @type {any} */ (row.state))) {
      throw new TypeError('semantic-route-row-value-invalid');
    }
    const frozen = Object.freeze({
      route: /** @type {string} */ (row.route),
      channels: Object.freeze([...row.channels]),
      source: /** @type {string} */ (row.source),
      placement: /** @type {'kernel'|'semantic-host'|'split'} */ (row.placement),
      state: /** @type {'migrated'|'unmigrated'} */ (row.state),
    });
    table.set(frozen.route, frozen);
  }
  return table;
};

/**
 * Exact wire parser. The browser sender is intentionally absent: sender facts
 * are interpreted by the kernel and reduced to the bound controller authority.
 * @param {unknown} value
 */
export const parseSemanticDispatchRequest = (value) => {
  if (!isPlainRecord(value)) return null;
  const input = /** @type {Record<string, unknown>} */ (value);
  if (!exactKeys(input, ['message', 'protocol', 'route'])
      || input.protocol !== SEMANTIC_DISPATCH_PROTOCOL
      || !isSemanticRouteName(input.route)
      || !isPlainRecord(input.message)
      || !Object.hasOwn(/** @type {Record<string, unknown>} */ (input.message), 'type')
      || /** @type {Record<string, unknown>} */ (input.message).type !== input.route
      || !structuredClonePayloadFits(input, SEMANTIC_DISPATCH_MAX_REQUEST_BYTES)) return null;
  return Object.freeze({
    protocol: SEMANTIC_DISPATCH_PROTOCOL,
    route: /** @type {string} */ (input.route),
    message: /** @type {Record<string, unknown>} */ (input.message),
  });
};

/** @param {unknown} value */
export const parseSemanticDispatchAuthority = (value) => parseControllerAuthority(value);

/**
 * A manifest cutover is admissible only when both the generated inventory and
 * reviewed table have exact cardinality and every route is migrated. This is
 * intentionally independent of the candidate's own CI policy.
 * @param {ReadonlyMap<string, SemanticRouteClassification>} table
 * @param {readonly {route:string}[]} inventory
 */
export const semanticDispatchCutoverReport = (table, inventory) => {
  const expected = new Set(inventory.map(({ route }) => route));
  const missing = [...expected].filter((route) => !table.has(route)).sort();
  const extra = [...table.keys()].filter((route) => !expected.has(route)).sort();
  const unmigrated = [...table.values()].filter((row) => row.state !== 'migrated')
    .map((row) => row.route).sort();
  return Object.freeze({
    ready: missing.length === 0 && extra.length === 0 && unmigrated.length === 0,
    expected: expected.size,
    classified: table.size,
    missing: Object.freeze(missing),
    extra: Object.freeze(extra),
    unmigrated: Object.freeze(unmigrated),
  });
};

/** @param {unknown} result */
export const semanticDispatchResultFits = (result) => isPlainRecord(result)
  && structuredClonePayloadFits(result, SEMANTIC_DISPATCH_MAX_RESULT_BYTES);
