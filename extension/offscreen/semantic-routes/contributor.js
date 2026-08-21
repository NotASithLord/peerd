// @ts-check
// Preview Contributor Metrics are formatted in the sealed host. The kernel
// exposes one read-only record and retains every storage/mutation capability.

import { makeContributorStore } from '/peerd-runtime/observability/contributor-store.js';

/** @param {string} route @param {any} _message
 * @param {{kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} options */
export const dispatchContributorSemanticRoute = async (route, _message, options) => {
  if (!['contributor/status', 'contributor/enable', 'contributor/disable'].includes(route)
      || typeof options.kernelCall !== 'function') {
    return { ok: false, code: 'semantic-contributor-route-refused', outcomeKnown: true };
  }
  const kernelCall = options.kernelCall;
  if (route === 'contributor/status') {
    const result = await kernelCall('semantic.contributor.read', {});
    if (result?.ok !== true) return {
      ok: false, error: 'Contributor Metrics status is temporarily unavailable.',
      outcomeKnown: true, retryable: true,
    };
    const store = makeContributorStore({ kv: {
      get: async () => result.value ?? null,
      set: async () => { throw new Error('contributor-status-read-only'); },
      delete: async () => { throw new Error('contributor-status-read-only'); },
    } });
    return { ok: true, status: await store.status() };
  }
  const readOperation = route === 'contributor/status' ? 'semantic.contributor.read'
    : `semantic.contributor.${route.slice('contributor/'.length)}-read`;
  /** @type {any} */ let expected = null;
  /** @type {any} */ let failure = null;
  const unwrap = (/** @type {any} */ result) => {
    if (result?.ok === true) return result.value;
    failure = result ?? { outcomeKnown: false };
    throw new Error('contributor-kernel-operation-failed');
  };
  const store = makeContributorStore({
    kv: {
      get: async () => {
        expected = unwrap(await kernelCall(readOperation, {})) ?? null;
        return expected;
      },
      set: async () => {
        const action = unwrap(await kernelCall('semantic.contributor.enable', { expected }));
        if (action?.ok !== true) {
          failure = { outcomeKnown: true };
          throw new Error('contributor-state-changed');
        }
      },
      delete: async () => {
        const action = unwrap(await kernelCall('semantic.contributor.clear', {}));
        if (action?.ok !== true) throw new Error('contributor-clear-failed');
      },
    },
  });
  try {
    const status = route === 'contributor/enable'
      ? await store.enable() : await store.disableAndClear();
    return { ok: true, status };
  } catch {
    const known = failure?.outcomeKnown === true;
    return {
      ok: false,
      error: known ? 'Contributor Metrics could not be updated.'
        : 'The Contributor Metrics update outcome could not be confirmed.',
      outcomeKnown: known,
      retryable: known,
    };
  }
};
