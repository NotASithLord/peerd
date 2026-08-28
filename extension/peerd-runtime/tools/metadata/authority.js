// @ts-check

// Controller-only compact projection of the single rich tool catalog. The
// service worker consumes only projections sent across the sealed controller
// channel and never imports this growing semantic inventory.
import { TOOL_METADATA_ORDER, TOOL_METADATA_RECORDS } from './catalog.js';

const AUTHORITY_FIELDS = Object.freeze([
  'name', 'primitive', 'sideEffect', 'originRule', 'dispatch', 'retryClass', 'dweb',
]);

/** @param {Record<string, any>} metadata */
const projectAuthorityMetadata = (metadata) => Object.freeze(Object.fromEntries(
  AUTHORITY_FIELDS.flatMap((field) => metadata[field] === undefined
    ? [] : [[field, metadata[field]]]),
));

export const TOOL_AUTHORITY_ORDER = TOOL_METADATA_ORDER;

export const TOOL_AUTHORITY_RECORDS = Object.freeze(Object.fromEntries(
  TOOL_AUTHORITY_ORDER.map((name) => {
    const metadata = /** @type {Record<string, Record<string, any>>} */ (
      TOOL_METADATA_RECORDS
    )[name];
    if (!metadata) throw new Error(`tool metadata missing: ${name}`);
    return [name, projectAuthorityMetadata(metadata)];
  }),
));

/** @param {string} name */
export const getToolAuthority = (name) => /** @type {Record<string, any>} */ (
  TOOL_AUTHORITY_RECORDS
)[name];

export const listToolAuthorities = () => TOOL_AUTHORITY_ORDER.map((name) => {
  const authority = getToolAuthority(name);
  if (!authority) throw new Error(`tool authority metadata missing: ${name}`);
  return authority;
});
