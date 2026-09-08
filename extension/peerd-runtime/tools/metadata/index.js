// @ts-check

// Controller-side tool composition derives compact authority policy from the
// same rich catalog as its semantic descriptors. The service worker receives
// only bounded projections across the sealed channel.

import { getToolAuthority } from './authority.js';
import { resolveToolOrigins } from '../../tool-origin-policy.js';

export { resolveToolOrigins };

/** @param {string} name @param {{execute?:(args:any,ctx:any)=>Promise<any>}} implementation */
export const composeTool = (name, implementation) => {
  const policy = getToolAuthority(name);
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
