// @ts-check

import { TOOL_METADATA_ORDER, TOOL_METADATA_RECORDS } from './catalog.js';
import { resolveToolOrigins } from './origins.js';

/** @template T @param {T} value @returns {T} */
const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
};

deepFreeze(TOOL_METADATA_RECORDS);

export { TOOL_METADATA_ORDER, resolveToolOrigins };

/** @param {string} name */
export const getToolMetadata = (name) => /** @type {Record<string, any>} */ (
  TOOL_METADATA_RECORDS
)[name];

export const listToolMetadata = () => TOOL_METADATA_ORDER.map((name) => {
  const metadata = getToolMetadata(name);
  if (!metadata) throw new Error(`tool metadata missing: ${name}`);
  return metadata;
});

/** @param {string} name @param {{execute?:(args:any,ctx:any)=>Promise<any>}} implementation */
export const composeTool = (name, implementation) => {
  const metadata = getToolMetadata(name);
  if (!metadata || typeof implementation?.execute !== 'function') {
    throw new TypeError(`tool composition invalid: ${name}`);
  }
  const { originRule, ...descriptor } = metadata;
  return {
    ...descriptor,
    origins: (/** @type {any} */ args, /** @type {any} */ ctx) =>
      resolveToolOrigins(originRule, args, ctx),
    execute: implementation.execute,
  };
};
