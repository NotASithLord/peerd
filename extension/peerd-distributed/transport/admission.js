// @ts-check
// why: room-local limits multiply when several rooms share one browser heap.
// Reserve before ICE construction, retaining ownership through authentication.
export class AdmissionError extends Error {
  /** @param {string} reason */
  constructor(reason) { super(`peer admission ${reason}`); this.name = 'AdmissionError'; this.reason = reason; }
}

/**
 * @param {{ active?: number, perScope?: number, reservedOutbound?: number,
 * queued?: number, queuedPerScope?: number, timeoutMs?: number }} [opts]
 */
export const createAdmissionGovernor = ({ active = 8, perScope = 4, reservedOutbound = 2,
  queued = 64, queuedPerScope = 16, timeoutMs = 15_000 } = {}) => {
  if (![active, perScope, reservedOutbound, queued, queuedPerScope, timeoutMs].every(Number.isSafeInteger)
    || active < 2 || perScope < 2 || reservedOutbound < 1 || reservedOutbound >= active
    || queued < 0 || queuedPerScope < 0 || timeoutMs < 1) throw new AdmissionError('invalid limits');
  /** @typedef {{ records: Set<Entry>, running: number, inbound: number, closed: boolean }} Scope */
  /** @typedef {{ scope: Scope, key: string, direction: string, controller: AbortController,
   * started: boolean, settled: boolean, task: (signal: AbortSignal) => Promise<any>,
   * resolve: (value?: any) => void, reject: (error: any) => void, promise: Promise<any>,
   * timer?: ReturnType<typeof setTimeout>, external?: AbortSignal, cancel: () => void }} Entry */
  /** @type {Entry[]} */
  const waiting = [];
  let running = 0;
  let inbound = 0;
  /** @param {Entry} e */
  const canStart = (e) => !e.scope.closed && running < active && e.scope.running < perScope
    && (e.direction === 'outbound' || (inbound < active - reservedOutbound && e.scope.inbound < perScope - 1));
  /** @param {Entry} e @param {any} [error] @param {any} [value] */
  const finish = (e, error, value) => {
    if (e.settled) return;
    e.settled = true;
    clearTimeout(e.timer);
    e.external?.removeEventListener('abort', e.cancel);
    const index = waiting.indexOf(e);
    if (index !== -1) waiting.splice(index, 1);
    e.scope.records.delete(e);
    // Abort synchronously releases native resources before another task starts.
    e.controller.abort();
    if (e.started) {
      running--; e.scope.running--;
      if (e.direction === 'inbound') { inbound--; e.scope.inbound--; }
    }
    // A synchronous replacement may claim the released slot before queued
    // work drains (crossing relay offers use this to retain just one channel).
    queueMicrotask(drain);
    if (error) e.reject(error); else e.resolve(value);
  };
  /** @param {Entry} e */
  const start = (e) => {
    e.started = true;
    running++; e.scope.running++;
    if (e.direction === 'inbound') { inbound++; e.scope.inbound++; }
    clearTimeout(e.timer);
    e.timer = setTimeout(() => finish(e, new AdmissionError('timed out')), timeoutMs);
    try { Promise.resolve(e.task(e.controller.signal)).then((v) => finish(e, null, v), (err) => finish(e, err)); }
    catch (err) { finish(e, err); }
  };
  const drain = () => {
    // why: oldest eligible scope progresses; the per-scope ceiling prevents a
    // noisy room from occupying every active or queued slot in the heap.
    let index;
    while ((index = waiting.findIndex(canStart)) !== -1) start(/** @type {Entry} */ (waiting.splice(index, 1)[0]));
  };
  return {
    stats: () => ({ active: running, inbound, queued: waiting.length }),
    createScope() {
      /** @type {Scope} */
      const scope = { records: new Set(), running: 0, inbound: 0, closed: false };
      return {
        candidateCapacity: perScope + queuedPerScope,
        /** @param {string} key */
        pending: (key) => [...scope.records].find((entry) => entry.key === key)?.promise,
        /** @param {string} key */
        supersede(key) {
          const entry = [...scope.records].find((candidate) => candidate.key === key);
          if (entry) finish(entry, new AdmissionError('superseded'));
        },
        /** @param {string} key @param {'inbound'|'outbound'} direction
         * @param {(signal: AbortSignal) => Promise<any>} task @param {AbortSignal} [signal] */
        run(key, direction, task, signal) {
          if (scope.closed || signal?.aborted) return Promise.reject(new AdmissionError('cancelled'));
          if ([...scope.records].some((e) => e.key === key)) return Promise.reject(new AdmissionError('duplicate'));
          // Inbound offers are not queued: their ICE stream has already begun,
          // and retaining arbitrary remote offers would consume the dial queue.
          const eligible = canStart(/** @type {Entry} */ ({ scope, direction }));
          if (!eligible && (direction === 'inbound' || waiting.length >= queued
            || scope.records.size - scope.running >= queuedPerScope)) return Promise.reject(new AdmissionError('overloaded'));
          /** @type {(value?: any) => void} */
          let resolve = () => {};
          /** @type {(error: any) => void} */
          let reject = () => {};
          const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
          /** @type {Entry} */
          const entry = { scope, key, direction, task, resolve, reject, promise, controller: new AbortController(),
            started: false, settled: false, external: signal, cancel: () => finish(entry, new AdmissionError('cancelled')) };
          scope.records.add(entry);
          signal?.addEventListener('abort', entry.cancel, { once: true });
          if (eligible) start(entry);
          else {
            waiting.push(entry);
            entry.timer = setTimeout(() => finish(entry, new AdmissionError('queue timed out')), timeoutMs);
          }
          return promise;
        },
        close() {
          scope.closed = true;
          for (const entry of [...scope.records]) finish(entry, new AdmissionError('cancelled'));
        },
      };
    },
  };
};

export const roomAdmission = createAdmissionGovernor();
// why: bound Promise.all ownership as well as the scheduler's internal queue.
export const MAX_ADMISSION_CANDIDATES = 32;
