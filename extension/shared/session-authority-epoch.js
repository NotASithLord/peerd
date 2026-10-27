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

// why: the new-chat pointer and its permission cache form one mutation. A
// permission click during durable creation must land after binding, never be
// overwritten by the permission snapshot that creation captured earlier.
/** @type {WeakMap<object,Promise<unknown>>} */
const mutationTails = new WeakMap();
/** @template T @param {object} storage @param {()=>Promise<T>} mutate @returns {Promise<T>} */
export const withSessionAuthorityMutation = (storage, mutate) => {
  // Revoke synchronously, including while this mutation waits for its turn.
  const finish = beginSessionAuthorityChange(storage);
  const previous = mutationTails.get(storage) ?? Promise.resolve();
  const result = previous.then(mutate);
  const settled = result.then(() => {}, () => {}).finally(() => {
    finish();
    if (mutationTails.get(storage) === settled) mutationTails.delete(storage);
  });
  mutationTails.set(storage, settled);
  return result.finally(() => settled);
};
