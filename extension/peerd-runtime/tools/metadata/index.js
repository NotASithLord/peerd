// @ts-check

// Authority-side tool composition. Model-facing prose and schemas live in
// /peerd-runtime/semantic.js so registering executable handlers in the SW does
// not import the full catalog.

import { getToolPolicy } from './policy.js';
import { resolveToolOrigins } from '../../tool-origin-policy.js';

export { resolveToolOrigins };

/** @param {string} name @param {{execute?:(args:any,ctx:any)=>Promise<any>}} implementation */
export const composeTool = (name, implementation) => {
  const policy = getToolPolicy(name);
  if (!policy || typeof implementation?.execute !== 'function') {
    throw new TypeError(`tool composition invalid: ${name}`);
  }
  const { originRule, ...descriptor } = policy;
  return {
    ...descriptor,
    origins: (/** @type {any} */ args, /** @type {any} */ ctx) =>
      resolveToolOrigins(originRule, args, ctx),
    execute: implementation.execute,
  };
};
