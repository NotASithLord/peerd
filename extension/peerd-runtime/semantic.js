// @ts-check
// Sealed-agent public surface. Model-facing tool prose and schemas live here so
// authority hosts can select compact policy descriptors without importing them.

import { filterByRuntimeCapabilities } from './runtime-capabilities.js';
import { TOOL_METADATA_ORDER, TOOL_METADATA_RECORDS } from './tools/metadata/catalog.js';
import { resolveToolOrigins } from './tool-origin-policy.js';

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

const AUTHORITY_FIELDS = Object.freeze([
  'primitive', 'sideEffect', 'dispatch', 'retryClass', 'dweb',
]);

/**
 * Add model-facing prose/schema to an SW-selected descriptor list without
 * allowing the sealed heap to widen policy or introduce a tool name.
 * Runtime-specific prose shaping happens only after semantic hydration.
 * @param {ReadonlyArray<Record<string, any>>} descriptors
 * @param {any} [runtimeCapabilities]
 */
export const hydrateToolDescriptors = (descriptors, runtimeCapabilities) => {
  const hydrated = descriptors.map((descriptor) => {
    const metadata = getToolMetadata(descriptor?.name);
    if (!metadata) throw new TypeError(`tool semantic metadata missing: ${descriptor?.name ?? ''}`);
    for (const field of AUTHORITY_FIELDS) {
      if (descriptor[field] !== metadata[field]) {
        throw new TypeError(`tool authority mismatch: ${descriptor.name}:${field}`);
      }
    }
    return Object.freeze(/** @type {{name:string,description:string,schema:object,
     * primitive:any,sideEffect:any,dispatch?:any,retryClass?:any,dweb?:any}} */ ({
      ...descriptor,
      description: metadata.description,
      schema: metadata.schema,
    }));
  });
  return filterByRuntimeCapabilities(hydrated, runtimeCapabilities);
};
