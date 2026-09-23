// @ts-check

// The rich turn store and cold metadata reader share one host IDB dependency.
// Revoke in-flight proofs before an authority write awaits storage, and keep
// them invalid while that write is unresolved (including failed writes).
/** @type {WeakMap<object,{version:number,pending:number}>} */
const authorities = new WeakMap();
const stateFor = (/** @type {object} */ storage) => {
  let state = authorities.get(storage);
  if (!state) {
    state = { version: 0, pending: 0 };
    authorities.set(storage, state);
  }
  return state;
};

/** @param {object} storage */
export const beginSessionAuthorityChange = (storage) => {
  const state = stateFor(storage);
  state.version += 1;
  state.pending += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    state.pending -= 1;
    state.version += 1;
  };
};

/** @param {object} storage */
export const captureSessionAuthority = (storage) => {
  const state = stateFor(storage);
  const version = state.version;
  return () => state.pending === 0 && state.version === version;
};

/** @param {unknown} patch */
export const changesSessionAuthority = (patch) => !!patch && typeof patch === 'object'
  && ['permissionMode', 'confirmActions', 'originState', 'archivedAt'].some((field) =>
    Object.hasOwn(patch, field));
