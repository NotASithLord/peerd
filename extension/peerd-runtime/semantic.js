// @ts-check
// Sealed-agent public surface. Model-facing tool prose and schemas live here so
// authority hosts can select compact policy descriptors without importing them.

import { filterByRuntimeCapabilities } from './runtime-capabilities.js';
import { TOOL_METADATA_ORDER, TOOL_METADATA_RECORDS } from './tools/metadata/catalog.js';
import { resolveToolOrigins } from './tool-origin-policy.js';

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
  'primitive', 'sideEffect', 'originRule', 'dispatch', 'retryClass', 'dweb',
]);

/**
 * Add model-facing prose/schema while proving that compact projection fields
 * still match the sealed catalog. This is a drift/consistency check inside the
 * semantic realm; fixed exact-operation ceilings and live host gates remain the
 * authority boundary. Runtime-specific prose shaping happens only afterward.
 * @param {ReadonlyArray<Record<string, any>>} descriptors
 * @param {any} [runtimeCapabilities]
 */
export const hydrateToolDescriptors = (descriptors, runtimeCapabilities) => {
  const hydrated = descriptors.map((descriptor) => {
    const metadata = getToolMetadata(descriptor?.name);
    if (!metadata) throw new TypeError(`tool semantic metadata missing: ${descriptor?.name ?? ''}`);
    for (const field of AUTHORITY_FIELDS) {
      const matches = field === 'originRule'
        ? JSON.stringify(descriptor[field]) === JSON.stringify(metadata[field])
        : descriptor[field] === metadata[field];
      if (!matches) {
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
