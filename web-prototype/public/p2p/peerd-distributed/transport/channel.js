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

export const createBufferedChannel = ({ send, close } = {}) => {
  let handler = null;
  let closed = false;
  const backlog = [];
  const closeCbs = new Set();

  const chan = {
    send: (msg) => {
      if (!closed) send(msg);
    },
    // Called by the transport when a message arrives.
    deliver(msg) {
      if (closed) return;
      if (handler) handler(msg);
      else backlog.push(msg);
    },
    // Install (or clear, with null) the handler. Flushes the backlog.
    setHandler(fn) {
      handler = fn;
      if (fn) while (backlog.length) fn(backlog.shift());
    },
    isClosed: () => closed,
    // Fires once, immediately if already closed. Returns unsubscribe.
    onClose(cb) {
      if (closed) {
        cb();
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
      for (const cb of [...closeCbs]) cb();
      closeCbs.clear();
    },
    // Local hang-up: tear down the underlying transport too.
    close() {
      if (closed) return;
      try { close?.(); } catch { /* transport already gone */ }
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
  // Mutually wired: each channel's `send`/`close` reaches the other. `a`
  // names `b` before `b` exists, which is fine — neither closure fires during
  // construction, only once a message is actually delivered/closed.
  const a = createBufferedChannel({ send: (m) => b.deliver(m), close: () => b.signalClose() });
  const b = createBufferedChannel({ send: (m) => a.deliver(m), close: () => a.signalClose() });
  return [a, b];
};
