// @ts-check
// peerd-distributed/transport/channel.js — a buffered message channel.
//
// why: a single handler slot plus a backlog buffer. Messages that arrive
// before a handler is installed (or between handler swaps, e.g. handing
// off from the HELLO handshake to the content responder) are queued and
// flushed when the next handler is set. This removes an entire class of
// race conditions from the transfer flow without timing assumptions.
//
// The channel is transport-agnostic: `send` is injected. peer.js supplies
// a send backed by an RTCDataChannel; memoryPair() supplies an in-process
// send for tests. Messages are already-parsed JS objects either way.
//
// PHASE 1 adds close semantics: a mesh holding many links needs to know
// when a pipe dies. `signalClose()` is the TRANSPORT's notification (data
// channel closed, pc failed); `close()` is the LOCAL hang-up (also closes
// the underlying transport via the injected `close`). Both settle the
// channel exactly once and fire onClose subscribers.

import { localSessionBindings } from './channel-binding.js';

/** Locally classified wire faults, never remote-supplied close reasons. @param {unknown} reason */
export const isRawProtocolClose = (reason) => ['raw-frame-type', 'raw-frame-size', 'raw-frame-json'].includes(/** @type {string} */ (reason));

/**
 * @param {{ send: (msg: any, options?: import('./outgoing.js').SendOptions) => void | Promise<void>, close?: () => void, getSessionBinding?: () => Readonly<import('./channel-binding.js').SessionBinding> }} io
 */
export const createBufferedChannel = ({ send, close, getSessionBinding } = /** @type {{ send: (msg: any) => void }} */ ({})) => {
  /** @type {((msg: any) => void) | null} */
  let handler = null;
  let closed = false;
  let transportReleased = false;
  /** @type {string | undefined} */
  let closeReason;
  /** @type {any[]} */
  const backlog = [];
  /** @type {Set<(reason?: string) => void>} */
  const closeCbs = new Set();

  /** @param {any} msg */
  const invoke = (msg) => {
    try { Promise.resolve(handler?.(msg)).catch(() => chan.close()); }
    catch { chan.close(); }
  };

  const chan = {
    getSessionBinding: () => closed ? null : getSessionBinding?.() ?? null,
    /** @param {any} msg @param {import('./outgoing.js').SendOptions} [options] */
    send: async (msg, options) => {
      if (closed) throw new Error('peer channel closed');
      if (options?.signal?.aborted) throw new Error('peer send cancelled');
      await send(msg, options);
    },
    // Called by the transport when a message arrives.
    /** @param {any} msg */
    deliver(msg) {
      if (closed) return;
      if (handler) invoke(msg);
      else if (backlog.length < 16) backlog.push(msg);
      // why: a stalled handshake/consumer cannot retain an unbounded stream.
      else chan.close();
    },
    // Install (or clear, with null) the handler. Flushes the backlog.
    /** @param {((msg: any) => void) | null} fn */
    setHandler(fn) {
      if (closed) return;
      handler = fn;
      if (fn) while (backlog.length && handler) invoke(backlog.shift());
    },
    isClosed: () => closed,
    // Fires once, immediately if already closed. Returns unsubscribe.
    /** @param {(reason?: string) => void} cb */
    onClose(cb) {
      if (closed) {
        try { cb(closeReason); } catch { /* observer failure cannot retain transport ownership */ }
        return () => {};
      }
      closeCbs.add(cb);
      return () => closeCbs.delete(cb);
    },
    // Transport-side: the pipe is gone (remote close, failure, or local
    // close() below). Idempotent.
    signalClose() {
      if (closed) return;
      closed = true;
      backlog.length = 0;
      handler = null;
      const observers = [...closeCbs];
      closeCbs.clear();
      for (const cb of observers) {
        try { cb(closeReason); } catch { /* notify every owner despite a failed observer */ }
      }
    },
    // Local hang-up: tear down the underlying transport too.
    /** @param {string} [reason] */
    close(reason) {
      // Latch before native close can synchronously notify us. The first close
      // owns blame; a later caller cannot upgrade an ordinary retirement.
      if (!closed && !transportReleased && isRawProtocolClose(reason)) closeReason = reason;
      // A transport notification can precede its owner's cleanup. Release the
      // underlying resource once even when signalClose already notified users.
      if (!transportReleased) {
        transportReleased = true;
        try { close?.(); } catch { /* transport already gone */ }
      }
      chan.signalClose();
    },
  };
  return chan;
};

// Two channels wired to each other in-process. The full transfer + session
// logic runs over this with real crypto — a complete end-to-end test of
// everything except the actual WebRTC bytes (which peer.js owns). Closing
// either end signals the other, like a real pipe.
export const memoryPair = () => {
  const [bindingA, bindingB] = localSessionBindings();
  // Mutually wired: each channel's `send`/`close` reaches the other. `a`
  // names `b` before `b` exists, which is fine — neither closure fires during
  // construction, only once a message is actually delivered/closed.
  const a = createBufferedChannel({ send: (m) => b.deliver(m), close: () => b.signalClose(), getSessionBinding: () => bindingA });
  const b = createBufferedChannel({ send: (m) => a.deliver(m), close: () => a.signalClose(), getSessionBinding: () => bindingB });
  return [a, b];
};
