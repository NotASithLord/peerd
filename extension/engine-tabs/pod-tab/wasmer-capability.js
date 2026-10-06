// @ts-check
// why: expose browser availability before a user starts a job. Wasmer needs
// both shared memory and the isolation that permits using it.
/** @param {{crossOriginIsolated?:boolean,SharedArrayBuffer?:unknown}} [environment] */
export const supportsWasmer = (environment = globalThis) =>
  environment.crossOriginIsolated === true && typeof environment.SharedArrayBuffer === 'function';
