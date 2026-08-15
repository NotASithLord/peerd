// @ts-check
// Pure Pod job-state projection shared by the host and focused unit tests.

/**
 * @param {{ cancelled?: boolean, exitCode: number }} result
 * @returns {'completed'|'failed'|'cancelled'}
 */
export const podJobState = (result) => result.cancelled === true
  ? 'cancelled'
  : result.exitCode === 0 ? 'completed' : 'failed';

/**
 * A concise live-region update. Raw stdout/stderr deliberately stays in the
 * non-live terminal transcript so assistive technology is never flooded.
 * @param {{ id:string, state:'completed'|'failed'|'cancelled', exitCode:number|null, stdout?:string, stderr?:string }} job
 */
export const podJobStatusMessage = (job) => {
  const outcome = job.state === 'cancelled'
    ? 'cancelled'
    : job.state === 'completed' ? 'completed' : `failed with exit ${job.exitCode ?? 1}`;
  const hasOutput = Boolean(job.stdout || job.stderr);
  return `Pod job ${job.id} ${outcome}.${hasOutput ? ' Output is available in the terminal.' : ''}`;
};

/**
 * Track host-side workspace operations that a Worker has already requested.
 * Cancellation closes admission immediately, then waits for unabortable OPFS
 * work already in progress. Queued callbacks assert again at execution time,
 * so they are refused instead of mutating after the cancellation reply.
 */
export const createPodJobOperationTracker = () => {
  let closing = false;
  /** @type {Set<Promise<unknown>>} */ const pending = new Set();

  const assertAccepting = () => {
    if (closing) throw new Error('Pod job is no longer accepting workspace operations');
  };

  /** @template T @param {() => Promise<T>|T} operation @returns {Promise<T>} */
  const track = (operation) => {
    assertAccepting();
    const result = Promise.resolve().then(operation);
    pending.add(result);
    result.finally(() => pending.delete(result)).catch(() => {});
    return result;
  };

  const closeAndDrain = async () => {
    closing = true;
    while (pending.size) await Promise.allSettled([...pending]);
  };

  return Object.freeze({ assertAccepting, track, closeAndDrain, isClosing: () => closing });
};
