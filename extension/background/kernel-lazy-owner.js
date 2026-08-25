// @ts-check
import { withDeadline } from '../shared/cold-util.js';

const DEFAULT_LOAD_TIMEOUT_MS = 15_000;

const startupError = (/** @type {unknown} */ cause) => Object.assign(
  new Error(/** @type {{message?:string}} */ (cause)?.message ?? 'kernel route owner unavailable',
    { cause: cause instanceof Error ? cause : undefined }),
  {
    code: /** @type {{code?:string}} */ (cause)?.code ?? 'kernel-route-owner-load-failed',
    outcomeKnown: true, phase: 'startup', retryable: true,
  },
);

/** @template T @param {Record<string,any>} deps @param {(deps:Record<string,any>)=>T|Promise<T>} build */
export const makeKernelLazyOwner = (deps, build) => {
  /** @type {Promise<T>|null} */ let pending = null;
  return () => {
    if (!pending) {
      const current = Promise.resolve().then(async () => {
        const loaded = typeof deps.load === 'function' ? await deps.load() : null;
        return build(loaded ? { ...deps, ...loaded } : deps);
      }).catch((cause) => { throw startupError(cause); });
      pending = current;
      void current.catch(() => { if (pending === current) pending = null; });
    }
    return withDeadline(() => /** @type {Promise<T>} */ (pending),
      deps.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS, () => Object.assign(
        new Error('kernel route owner did not become ready'),
        {
          code: 'kernel-route-owner-timeout', outcomeKnown: true,
          phase: 'startup', retryable: true,
        },
      ));
  };
};
