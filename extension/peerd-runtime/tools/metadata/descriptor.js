// @ts-check

import { retryClassForTool } from '../../lifecycle/tool-retry-class.js';
import { resolveToolOrigins } from './origins.js';

/**
 * @typedef {Pick<import('/shared/tool-types.js').Tool,
 *   'name'|'primitive'|'sideEffect'|'origins'>
 *   & Partial<Pick<import('/shared/tool-types.js').Tool,
 *   'description'|'schema'|'dispatch'|'retryClass'|'dweb'>>} ToolDescriptor
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
    ...(source.dispatch === undefined ? {} : { dispatch: source.dispatch }),
    schema: source.schema,
    sideEffect: source.sideEffect,
    ...(source.retryClass === undefined ? {} : { retryClass: source.retryClass }),
    ...(source.dweb === undefined ? {} : { dweb: source.dweb }),
    origins,
  }));
};

/**
 * Structured-clone-safe authority projection. Model prose/schema are restored
 * only after this exact policy subset reaches a sealed agent heap.
 * @param {{name:string,primitive?:any,sideEffect?:any,dispatch?:any,retryClass?:any,dweb?:any}} descriptor
 */
export const projectToolAuthority = (descriptor) => Object.freeze({
  name: descriptor.name,
  primitive: descriptor.primitive,
  sideEffect: descriptor.sideEffect,
  ...(descriptor.dispatch === undefined ? {} : { dispatch: descriptor.dispatch }),
  ...(descriptor.retryClass === undefined ? {} : { retryClass: descriptor.retryClass }),
  ...(descriptor.dweb === undefined ? {} : { dweb: descriptor.dweb }),
});

/** @param {ToolDescriptor} descriptor @param {any} args @param {any} ctx */
export const resolveDescriptorOrigins = (descriptor, args, ctx) =>
  descriptor.origins(args, ctx) ?? [];

/** @param {ToolDescriptor | null | undefined} descriptor */
export const retryClassForDescriptor = (descriptor) => retryClassForTool(descriptor);
