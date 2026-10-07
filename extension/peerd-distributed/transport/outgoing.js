// @ts-check
// why: awaiting a producer is useful only if its transport also waits for drain.
// Budgets cover encoded JS queues plus browser-reported native buffered bytes.
export class SendError extends Error {
  /** @param {string} reason */
  constructor(reason) { super(`peer send ${reason}`); this.name = 'SendError'; this.reason = reason; }
}

export const OUTGOING_LIMITS = Object.freeze({
  frameBytes: 1_000_000, linkBytes: 2_000_000, realmBytes: 8_000_000,
  linkFrames: 64, realmFrames: 256, nativeBytes: 1_000_000,
  controlBytes: 16_384, reservedBytes: 65_536, reservedFrames: 4,
  timeoutMs: 15_000,
});

/** @param {Partial<Record<keyof typeof OUTGOING_LIMITS, number>>} [overrides] */
export const createOutgoingGovernor = (overrides = {}) => {
  const limits = { ...OUTGOING_LIMITS, ...overrides };
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value >= 0)
    || limits.nativeBytes < 1 || limits.frameBytes < 1 || limits.timeoutMs < 1
    || limits.linkBytes <= limits.reservedBytes || limits.realmBytes <= limits.reservedBytes
    || limits.linkFrames <= limits.reservedFrames || limits.realmFrames <= limits.reservedFrames) throw new SendError('invalid limits');
  /** @typedef {{ dc: RTCDataChannel, queuedBytes: number, queuedFrames: number, flush: () => boolean }} Writer */
  /** @type {Set<Writer>} */
  const writers = new Set();
  let pumping = false;
  const totals = () => {
    let bytes = 0; let frames = 0;
    for (const writer of writers) {
      bytes += writer.queuedBytes + (writer.dc.bufferedAmount || 0);
      frames += writer.queuedFrames;
    }
    return { bytes, frames };
  };
  const pump = () => {
    if (pumping) return;
    pumping = true;
    try {
      let progress;
      do {
        progress = false;
        // One frame per link per round prevents one ready writer draining all
        // admitted work before another link gets its turn.
        for (const writer of writers) if (writer.flush()) progress = true;
      } while (progress);
    } finally { pumping = false; }
  };
  return {
    limits, pump, stats: totals,
    /** @param {Writer} writer */
    register(writer) { writers.add(writer); return () => { writers.delete(writer); pump(); }; },
    /** @param {Writer} writer @param {number} bytes @param {boolean} control */
    available(writer, bytes, control) {
      const total = totals();
      const reserveBytes = control ? 0 : limits.reservedBytes;
      const reserveFrames = control ? 0 : limits.reservedFrames;
      return writer.queuedFrames < limits.linkFrames - reserveFrames
        && total.frames < limits.realmFrames - reserveFrames
        && writer.queuedBytes + (writer.dc.bufferedAmount || 0) + bytes <= limits.linkBytes - reserveBytes
        && total.bytes + bytes <= limits.realmBytes - reserveBytes;
    },
  };
};

export const outgoingGovernor = createOutgoingGovernor();
/** @typedef {{ signal?: AbortSignal, priority?: 'control'|'bulk' }} SendOptions */

/** @param {{ dc: RTCDataChannel, governor?: ReturnType<typeof createOutgoingGovernor>, maxMessageSize?: () => number }} opts */
export const createOutgoingWriter = ({ dc, governor = outgoingGovernor, maxMessageSize = () => Infinity }) => {
  const { limits } = governor;
  /** @typedef {{ encoded: string, bytes: number, control: boolean, resolve: () => void,
   * reject: (error: Error) => void, signal?: AbortSignal, abort: () => void,
   * timer?: ReturnType<typeof setTimeout> }} Frame */
  /** @type {Frame[]} */
  const queue = [];
  let closed = false;
  let controlBurst = 0;
  const state = { dc, queuedBytes: 0, queuedFrames: 0, flush: () => false };
  /** @param {Frame} frame @param {Error} [error] */
  const finish = (frame, error) => {
    const index = queue.indexOf(frame);
    if (index < 0) return;
    queue.splice(index, 1);
    state.queuedFrames--; state.queuedBytes -= frame.bytes;
    clearTimeout(frame.timer);
    frame.signal?.removeEventListener('abort', frame.abort);
    if (error) frame.reject(error); else frame.resolve();
  };
  state.flush = () => {
    if (closed || dc.readyState !== 'open' || !queue.length) return false;
    const bulk = queue.findIndex((frame) => !frame.control);
    const control = queue.findIndex((frame) => frame.control);
    const frame = queue[control >= 0 && (controlBurst < 4 || bulk < 0) ? control : bulk >= 0 ? bulk : 0];
    if ((dc.bufferedAmount || 0) + frame.bytes > limits.nativeBytes) {
      // A largest-allowed frame needs a completely drained channel. A fixed
      // low watermark would fire too early and never fire again at zero.
      dc.bufferedAmountLowThreshold = limits.nativeBytes - frame.bytes;
      // Drain may have crossed the new threshold before it was installed;
      // recheck after arming so that missing an edge cannot strand the queue.
      if ((dc.bufferedAmount || 0) + frame.bytes > limits.nativeBytes) return false;
    }
    try { dc.send(frame.encoded); }
    catch (error) {
      finish(frame, error instanceof Error ? error : new SendError('native failure'));
      return true;
    }
    if (frame.control) controlBurst++; else controlBurst = 0;
    finish(frame);
    return true;
  };
  const unregister = governor.register(state);
  const wake = () => governor.pump();
  dc.bufferedAmountLowThreshold = Math.floor(limits.nativeBytes / 4);
  dc.addEventListener?.('bufferedamountlow', wake);
  dc.addEventListener?.('open', wake);
  const close = () => {
    if (closed) return;
    closed = true;
    dc.removeEventListener?.('bufferedamountlow', wake);
    dc.removeEventListener?.('open', wake);
    for (const frame of [...queue]) finish(frame, new SendError('closed'));
    unregister();
  };
  return {
    close,
    /** @param {any} message @param {SendOptions} [options] @returns {Promise<void>} */
    send(message, { signal, priority = 'bulk' } = {}) {
      if (closed || dc.readyState === 'closed' || dc.readyState === 'closing') return Promise.reject(new SendError('closed'));
      if (signal?.aborted) return Promise.reject(new SendError('cancelled'));
      const control = priority === 'control';
      // Check count and remaining capacity before retaining/encoding more work.
      if (!governor.available(state, 0, control)) return Promise.reject(new SendError('overloaded'));
      let encoded;
      try { encoded = JSON.stringify(message); }
      catch { return Promise.reject(new SendError('not serializable')); }
      if (typeof encoded !== 'string' || encoded.length > limits.frameBytes) return Promise.reject(new SendError('frame too large'));
      const bytes = new TextEncoder().encode(encoded).byteLength;
      const nativeLimit = maxMessageSize();
      if (bytes > Math.min(limits.frameBytes, limits.nativeBytes, nativeLimit || Infinity)
        || (control && bytes > limits.controlBytes)) return Promise.reject(new SendError('frame too large'));
      if (!governor.available(state, bytes, control)) return Promise.reject(new SendError('overloaded'));
      return new Promise((resolve, reject) => {
        /** @type {Frame} */
        const frame = { encoded, bytes, control, resolve, reject, signal,
          abort: () => { finish(frame, new SendError('cancelled')); governor.pump(); } };
        queue.push(frame); state.queuedBytes += bytes; state.queuedFrames++;
        signal?.addEventListener('abort', frame.abort, { once: true });
        frame.timer = setTimeout(() => { finish(frame, new SendError('drain timed out')); governor.pump(); }, limits.timeoutMs);
        governor.pump();
      });
    },
  };
};
