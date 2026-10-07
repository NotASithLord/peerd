// @ts-check
// why: carrier verification finishes before sync's inner signatures begin.
// Hold separate bounded ownership through all inner work and reply sends.
const ACTIVE = 8;
const ACTIVE_PER_OWNER = 2;
const PENDING = 64;
const PENDING_PER_OWNER = 16;

export const createSyncWork = () => {
  /** @typedef {{ owner: object, live: () => boolean, work: () => Promise<void>, resolve: () => void }} Task */
  /** @type {Task[]} */
  const queue = [];
  /** @type {Map<object, { pending: number, active: number }>} */
  const owners = new Map();
  let active = 0;
  let pending = 0;
  let closed = false;
  /** @param {Task} task @param {boolean} started */
  const finish = (task, started) => {
    const state = owners.get(task.owner);
    if (!state) return;
    pending--; state.pending--;
    if (started) { active--; state.active--; }
    if (!state.pending) owners.delete(task.owner);
    task.resolve();
  };
  const drain = () => {
    for (let i = 0; i < queue.length;) {
      const task = queue[i];
      if (closed || !task.live()) {
        queue.splice(i, 1); finish(task, false); continue;
      }
      const state = /** @type {{ pending: number, active: number }} */ (owners.get(task.owner));
      if (active >= ACTIVE || state.active >= ACTIVE_PER_OWNER) { i++; continue; }
      queue.splice(i, 1);
      active++; state.active++;
      Promise.resolve().then(() => {
        if (!closed && task.live()) return task.work();
      }).catch(() => {}).finally(() => { finish(task, true); drain(); });
    }
  };
  return {
    /** @param {object} owner @param {() => boolean} live @param {() => Promise<void>} work
     * @returns {Promise<void> | null} */
    run(owner, live, work) {
      const state = owners.get(owner) ?? { pending: 0, active: 0 };
      if (closed || !live() || pending >= PENDING || state.pending >= PENDING_PER_OWNER) return null;
      pending++; state.pending++;
      owners.set(owner, state);
      /** @type {Promise<void>} */
      const done = new Promise((resolve) => queue.push({ owner, live, work, resolve }));
      drain();
      return done;
    },
    // A retired generation loses queued work immediately. Active crypto cannot
    // be cancelled: retain its slot until settlement, and fence its consumer.
    retire: drain,
    close() { closed = true; drain(); },
  };
};
