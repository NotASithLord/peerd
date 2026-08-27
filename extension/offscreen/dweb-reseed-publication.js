// @ts-check
// Exact compensation around one generation-bound dweb reseed publication.

export class DwebReseedRetiredError extends Error {
  constructor() {
    super('dweb-generation-retired');
    this.name = 'DwebReseedRetiredError';
    this.code = 'dweb-generation-retired';
  }
}

/** @param {()=>boolean} current */
const requireCurrent = (current) => {
  if (!current()) throw new DwebReseedRetiredError();
};

/** @param {unknown} cause @param {()=>Promise<unknown>|unknown} cleanup @param {string} message */
const failAfterCleanup = async (cause, cleanup, message) => {
  try { await cleanup(); }
  catch (cleanupCause) {
    throw Object.assign(new AggregateError([cause, cleanupCause], message), {
      code: 'dweb-reseed-compensation-failed', outcomeKnown: false,
    });
  }
  throw cause;
};

/**
 * Bytes and metadata are separate commit points. A generation change after
 * either await compensates exactly that stage; the synchronous commit then
 * transfers temporary ownership only while the attempt is still current.
 *
 * @template P,A
 * @param {{
 *   current:()=>boolean,
 *   publish:()=>Promise<P>,
 *   announce:(published:P)=>Promise<A>,
 *   rollbackBytes:(published:P)=>Promise<unknown>|unknown,
 *   compensate:(published:P,announced:A|null)=>Promise<unknown>|unknown,
 *   commit:(published:P,announced:A)=>unknown,
 * }} steps
 */
export const runDwebReseedPublication = async ({
  current, publish, announce, rollbackBytes, compensate, commit,
}) => {
  if ([current, publish, announce, rollbackBytes, compensate, commit].some(
    (value) => typeof value !== 'function',
  )) throw new TypeError('dweb-reseed-publication-config-invalid');
  requireCurrent(current);
  const published = await publish();
  if (!current()) {
    return failAfterCleanup(
      new DwebReseedRetiredError(),
      () => rollbackBytes(published),
      'dweb reseed retired and byte rollback failed',
    );
  }
  let announced;
  try { announced = await announce(published); }
  catch (cause) {
    return failAfterCleanup(
      cause,
      () => compensate(published, null),
      'dweb reseed announcement and compensation failed',
    );
  }
  if (!current()) {
    return failAfterCleanup(
      new DwebReseedRetiredError(),
      () => compensate(published, announced),
      'dweb reseed retired and publication compensation failed',
    );
  }
  let committed;
  try { committed = commit(published, announced); }
  catch (cause) {
    return failAfterCleanup(
      cause,
      () => compensate(published, announced),
      'dweb reseed commit and compensation failed',
    );
  }
  if (committed && typeof /** @type {any} */ (committed).then === 'function') {
    return failAfterCleanup(
      new TypeError('dweb-reseed-commit-must-be-synchronous'),
      () => compensate(published, announced),
      'dweb reseed commit and compensation failed',
    );
  }
  return { published, announced };
};
