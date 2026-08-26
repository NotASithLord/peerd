// @ts-check

// why: page authority handlers retain only the fixed browser ceremony for one
// named operation. Model-facing metadata and registration stay in the sealed
// controller; this helper merely freezes the injected imperative shell.
/** @returns {any} */
export const definePageAuthorityHandler = (
  /** @type {{execute:(args:any,ctx:any)=>Promise<any>}} */ handler,
) => Object.freeze(handler);
