// @ts-check
// why: routing occupancy must leave bounded room for temporary content links.
// Pending handshakes consume the same slots as authenticated connections.
// This core grants no wire authority; the transport owner still authenticates
// purpose, enforces traffic scope and closes IO before releasing a reservation.
/** @param {{ total: number, transfer: number }} limits */
export const createLinkReservations = ({ total, transfer }) => {
  if (!Number.isSafeInteger(total) || total < 1 || !Number.isSafeInteger(transfer)
    || transfer < 0 || transfer >= total) throw new Error('invalid link reservation limits');
  const routingLimit = total - transfer;
  let routing = 0, content = 0, stopped = false;
  return {
    /** @param {'routing' | 'content'} purpose */
    acquire(purpose) {
      if (purpose !== 'routing' && purpose !== 'content') throw new Error('invalid link purpose');
      if (stopped || routing + content >= total
        || (purpose === 'routing' ? routing >= routingLimit : content >= transfer)) return null;
      if (purpose === 'routing') routing++; else content++;
      let released = false;
      // why: only the owner holding this closure can release its slot. A late
      // completion or repeated cancellation cannot release another attempt.
      return Object.freeze({ purpose, release() {
        if (released) return false;
        released = true;
        if (purpose === 'routing') routing--; else content--;
        return true;
      } });
    },
    // Closing admission does not pretend outstanding transports were closed.
    stop() { stopped = true; },
    snapshot: () => Object.freeze({ total, routingLimit, transferLimit: transfer,
      routing, content, occupied: routing + content, stopped }),
  };
};
