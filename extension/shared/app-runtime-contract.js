// @ts-check
// Runtime requirements describe prerequisites, never permissions or grants.
// Kept outside the distributed module so local imports and peer Apps use one
// contract. Unknown requirements survive normalization and fail compatibility.

/** @typedef {{schema:number,target:string,requires:string[]}} AppRuntime */
const TOKEN = /^[a-z][a-z0-9-]{0,63}$/;

export class AppRuntimeError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'app-runtime-invalid') {
    super(message);
    this.name = 'AppRuntimeError';
    this.code = code;
    this.performed = false;
    this.outcomeKnown = true;
    this.outcomeKind = 'pre-effect-failure';
    this.retryable = false;
  }
}

/** @param {unknown} value @returns {AppRuntime | undefined} */
export const normalizeAppRuntime = (value) => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppRuntimeError('App runtime declaration must be an object.');
  const runtime = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(runtime).some((key) => !['schema', 'target', 'requires'].includes(key))
      || !Number.isSafeInteger(runtime.schema) || /** @type {number} */ (runtime.schema) < 1
      || typeof runtime.target !== 'string' || !TOKEN.test(runtime.target)
      || !Array.isArray(runtime.requires) || runtime.requires.length > 16
      || runtime.requires.some((feature) => typeof feature !== 'string' || !TOKEN.test(feature))) {
    throw new AppRuntimeError('App runtime declaration is malformed.');
  }
  return { schema: /** @type {number} */ (runtime.schema), target: runtime.target,
    requires: [...new Set(/** @type {string[]} */ (runtime.requires))].sort() };
};
