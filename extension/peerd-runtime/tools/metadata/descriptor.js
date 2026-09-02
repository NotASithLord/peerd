// @ts-check

import { resolveToolOrigins } from '../../tool-origin-policy.js';

/**
 * @typedef {Pick<import('/shared/tool-types.js').Tool,
 *   'name'|'primitive'|'sideEffect'|'origins'>
 *   & Partial<Pick<import('/shared/tool-types.js').Tool,
 *   'description'|'schema'|'retryClass'|'dweb'>>
 *   & {originRule?:Record<string,any>}} ToolDescriptor
 */

/** @param {Record<string, any>} source @returns {ToolDescriptor} */
export const toToolDescriptor = (source) => {
  if (!source || typeof source.name !== 'string' || source.name.length === 0) {
    throw new TypeError('tool descriptor name is required');
  }
  if (typeof source.primitive !== 'string') {
    throw new TypeError(`tool descriptor '${source.name}' is missing the primitive field`);
  }
  const origins = typeof source.origins === 'function'
    ? source.origins
    : (/** @type {any} */ args, /** @type {any} */ ctx) =>
      resolveToolOrigins(source.originRule, args, ctx);
  return Object.freeze(/** @type {ToolDescriptor} */ ({
    name: source.name,
    description: source.description,
    primitive: source.primitive,
    schema: source.schema,
    sideEffect: source.sideEffect,
    ...(source.originRule === undefined ? {} : { originRule: source.originRule }),
    ...(source.retryClass === undefined ? {} : { retryClass: source.retryClass }),
    ...(source.dweb === undefined ? {} : { dweb: source.dweb }),
    origins,
  }));
};

/**
 * Structured-clone-safe authority projection. Model prose/schema are restored
 * only after this exact policy subset reaches a sealed agent heap.
 * @param {{name:string,primitive?:any,sideEffect?:any,originRule?:any,retryClass?:any,dweb?:any}} descriptor
 */
export const projectToolAuthority = (descriptor) => Object.freeze({
  name: descriptor.name,
  primitive: descriptor.primitive,
  sideEffect: descriptor.sideEffect,
  ...(descriptor.originRule === undefined ? {} : { originRule: descriptor.originRule }),
  ...(descriptor.retryClass === undefined ? {} : { retryClass: descriptor.retryClass }),
  ...(descriptor.dweb === undefined ? {} : { dweb: descriptor.dweb }),
});
