// @ts-check

// why: MV3 messages can ask a long-starting host to stop before it has exposed
// its handle. A generation barrier makes stop wait for that attempt and closes
// any late candidate before reporting success, so callers may safely rotate the
// identity or other custody material that the host captured at startup.

export class HostStartCancelledError extends Error {
  constructor() {
    super('host start was cancelled by stop');
    this.name = 'HostStartCancelledError';
  }
}

export class HostStopFailedError extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super('host could not be stopped', { cause });
    this.name = 'HostStopFailedError';
  }
}

export class HostSuspendedError extends Error {
  constructor() {
    super('host start is suspended');
    this.name = 'HostSuspendedError';
  }
}

/**
 * Serialize start/stop across an async host startup.
 *
 * @param {{
 *   getActive: () => any,
 *   create: () => Promise<any>,
 *   activate: (candidate: any) => void | Promise<void>,
 *   close: (candidate: any) => void | Promise<void>,
 * }} dependencies
 */
export const makeStartStopBarrier = ({ getActive, create, activate, close }) => {
  let generation = 0;
  /** @type {string | null} */
  let suspensionOwner = null;
  let stopping = false;
  /** @type {Promise<any> | null} */
  let pending = null;

  /** @param {any} candidate */
  const closeForStop = async (candidate) => {
    try {
      await close(candidate);
    } catch (cause) {
      throw new HostStopFailedError(cause);
    }
  };

  const start = () => {
    if (suspensionOwner !== null || stopping) return Promise.reject(new HostSuspendedError());
    const active = getActive();
    if (active) return Promise.resolve(active);
    if (!pending) {
      const startGeneration = generation;
      const attempt = (async () => {
        const candidate = await create();
        if (!candidate) return candidate;
        if (startGeneration !== generation) {
          await closeForStop(candidate);
          throw new HostStartCancelledError();
        }
        try {
          await activate(candidate);
        } catch (cause) {
          await closeForStop(candidate);
          throw cause;
        }
        if (startGeneration !== generation) {
          await closeForStop(candidate);
          throw new HostStartCancelledError();
        }
        return candidate;
      })();
      pending = attempt;
      // why: start callers still receive the rejection; this observer only
      // releases the shared attempt without creating an unhandled finally()
      // promise when no caller is waiting (for example, a background autostart).
      void attempt.finally(() => {
        if (pending === attempt) pending = null;
      }).catch(() => {});
    }
    return pending;
  };

  /** @param {{ suspensionOwner?: string }} [options] */
  const stop = async ({ suspensionOwner: requestedOwner } = {}) => {
    // Flip this before observing pending/active state. No new start may enter
    // the stop→custody-write gap while an identity rotation owns the lease.
    if (requestedOwner !== undefined) {
      if (!requestedOwner || (suspensionOwner !== null && suspensionOwner !== requestedOwner)) {
        throw new HostSuspendedError();
      }
      suspensionOwner = requestedOwner;
    }
    stopping = true;
    generation += 1;
    try {
      const inFlight = pending;
      if (inFlight) {
        try {
          await inFlight;
        } catch (cause) {
          // A normal start failure or deliberate cancellation leaves no live
          // candidate. A failed close is different: the caller must not rotate
          // custody state while the old host may still be alive.
          if (cause instanceof HostStopFailedError) throw cause;
        }
      }
      const active = getActive();
      if (active) await closeForStop(active);
    } finally {
      stopping = false;
    }
  };

  /** @param {string} owner */
  const resume = (owner) => {
    // An acknowledgement can be lost after a successful release. Retrying the
    // same release is safe when no owner remains; it can never clear another
    // owner's live lease.
    if (suspensionOwner === null) return true;
    if (suspensionOwner !== owner) return false;
    suspensionOwner = null;
    return true;
  };

  // why: an offscreen document can outlive the MV3 service worker that owned
  // a lease. Only the new worker's boot barrier calls this; normal starts and
  // unrelated operations must never be able to release a live owner's lease.
  const resetSuspension = () => { suspensionOwner = null; };

  // Read-only custody reconciliation after a lost Port reply. No caller may
  // infer this state from whether start/stop happens to succeed: a different
  // lease owner must remain distinguishable from an already-released lease.
  const snapshot = () => Object.freeze({
    suspensionOwner, stopping, pending: pending !== null, active: !!getActive(),
  });

  return { start, stop, resume, resetSuspension, snapshot };
};
