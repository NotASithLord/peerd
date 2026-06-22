// @ts-check
// Keyed FIFO command queue — the functional core of per-VM command
// serialization.
//
// Each key gets an independent lane; tasks within a lane run strictly
// one-at-a-time in enqueue order, while different lanes stay fully
// concurrent. The module is pure logic: it imports no IO and performs
// none — "tasks" are injected thunks (the imperative shell passes the
// actual tabs.sendMessage round-trip), which is what makes the queue
// unit-testable in Bun with plain deferred promises.
//
// why this exists: a WebVM is one persistent bash behind one capture
// buffer (vm-tab.js `activeRunCapture`). Two concurrent vm/run RPCs to
// the same tab overwrite that capture and clobber each other's output/
// exit markers. Serializing at the SW client (the single chokepoint
// every caller goes through) fixes the race without touching the tab's
// marker protocol.
//
// Interrupt semantics (the tab-close path): `interrupt(key, error)`
// rejects the caller-facing promise of the in-flight task AND every
// queued task, then DETACHES the lane. The in-flight task's underlying
// promise keeps running (we can't cancel a sendMessage round-trip) but
// its eventual settlement is dropped — and, crucially, it no longer
// blocks the lane, so a command issued after the interrupt starts
// immediately against the respawned tab instead of waiting out the
// orphan's ~90s message timeout.

/**
 * @typedef {{ task: () => Promise<unknown>, resolve: (v: unknown) => void,
 *             reject: (e: unknown) => void, settled: boolean }} Entry
 */

/** @typedef {{ active: Entry | null, waiting: Entry[] }} Lane */

/**
 * @returns {{
 *   enqueue<T>(key: string, task: () => Promise<T> | T): Promise<T>,
 *   interrupt(key: string, error: Error): number,
 *   pendingCount(key: string): number,
 * }}
 */
export const createKeyedQueue = () => {
  /** @type {Map<string, Lane>} */
  const lanes = new Map();

  /**
   * @param {string} key
   * @param {Lane} lane
   */
  const startNext = (key, lane) => {
    if (lane.active) return;
    const entry = lane.waiting.shift();
    if (!entry) {
      // why: drop empty lanes so the map doesn't grow forever as VMs
      // come and go (keys are per-VM / per-session strings).
      if (lanes.get(key) === lane) lanes.delete(key);
      return;
    }
    lane.active = entry;
    Promise.resolve()
      .then(() => entry.task())
      .then(
        (v) => { if (!entry.settled) { entry.settled = true; entry.resolve(v); } },
        (e) => { if (!entry.settled) { entry.settled = true; entry.reject(e); } },
      )
      .then(() => {
        // why the lane.active identity check: interrupt() detaches the
        // lane (sets active=null, possibly a successor lane exists under
        // the same key). An orphaned task settling later must not free
        // or advance a lane it no longer owns.
        if (lane.active === entry) {
          lane.active = null;
          startNext(key, lane);
        }
      });
  };

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T> | T} task
   * @returns {Promise<T>}
   */
  const enqueue = (key, task) => {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { active: null, waiting: [] };
      lanes.set(key, lane);
    }
    const settledLane = lane;
    return new Promise((resolve, reject) => {
      settledLane.waiting.push({
        task: async () => task(),
        resolve: /** @type {(v: unknown) => void} */ (resolve),
        reject,
        settled: false,
      });
      startNext(key, settledLane);
    });
  };

  /**
   * Reject the in-flight task's caller promise and drain every queued
   * task with `error`. Returns how many entries were rejected.
   *
   * @param {string} key
   * @param {Error} error
   * @returns {number}
   */
  const interrupt = (key, error) => {
    const lane = lanes.get(key);
    if (!lane) return 0;
    let rejected = 0;
    if (lane.active && !lane.active.settled) {
      lane.active.settled = true;
      lane.active.reject(error);
      rejected++;
    }
    lane.active = null;   // detach the orphan (see header comment)
    for (const entry of lane.waiting.splice(0)) {
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(error);
        rejected++;
      }
    }
    lanes.delete(key);
    return rejected;
  };

  /**
   * Queued-but-not-started count (in-flight task not included).
   * @param {string} key
   */
  const pendingCount = (key) => lanes.get(key)?.waiting.length ?? 0;

  return { enqueue, interrupt, pendingCount };
};
