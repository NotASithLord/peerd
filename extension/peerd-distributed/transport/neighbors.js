// @ts-check
import { SAMPLE_INTERVAL_MS } from './rendezvous-profile.js';
import { RoutingAdmissionBusyError } from './neighbor-policy.js';

export const NEIGHBOR_CANDIDATES = 32;
const CANDIDATE_TTL_MS = 120_000;
const LOCAL_TARGET = 4;
/**
 * One owner for one negotiated rendezvous generation. Candidate bytes, retry
 * state, active dials, sampling and timers are independently bounded.
 * @param {{ initial: string[], sample: (opts: {signal: AbortSignal}) => Promise<string[]>,
 * connect: (member: string, signal: AbortSignal) => Promise<void>,
 * known: (member: string) => boolean, localCount: () => number, parallelism?: () => number,
 * now?: () => number, random?: () => number, timers?: any, signal: AbortSignal }} opts
 */
export const createNeighborMaintenance = ({ initial, sample, connect, known, localCount, parallelism = () => LOCAL_TARGET,
  now = Date.now, random = Math.random, timers = globalThis, signal }) => {
  /** @type {Map<string, {expires: number, retryAt: number, failures: number}>} */
  const candidates = new Map();
  const lifetime = new AbortController();
  let stopped = false, running = false, again = false;
  let sampleAt = now() + SAMPLE_INTERVAL_MS;
  /** @type {any} */
  let timer;
  /** @param {string[]} members */
  const remember = (members) => {
    for (const member of members) {
      if (known(member)) continue;
      if (!candidates.has(member) && candidates.size >= NEIGHBOR_CANDIDATES) candidates.delete(/** @type {string} */ (candidates.keys().next().value));
      const prior = candidates.get(member);
      candidates.set(member, { expires: now() + CANDIDATE_TTL_MS, retryAt: prior?.retryAt ?? 0, failures: prior?.failures ?? 0 });
    }
  };
  const stop = () => { stopped = true; lifetime.abort(); timers.clearTimeout(timer); candidates.clear(); signal.removeEventListener('abort', stop); };
  const cycle = async () => {
    if (stopped || signal.aborted) return;
    if (running) { again = true; return; }
    running = true;
    const startedAt = now();
    timers.clearTimeout(timer);
    try {
      for (const [member, candidate] of candidates) if (candidate.expires <= now() || known(member)) candidates.delete(member);
      if (now() >= sampleAt) {
        sampleAt = now() + SAMPLE_INTERVAL_MS + Math.floor(random() * 2_000);
        try {
          const members = await sample({ signal: lifetime.signal });
          if (stopped || signal.aborted) return;
          remember(members);
        } catch { /* outage and cooldown are availability, not misconduct */ }
      }
      if (stopped || signal.aborted) return;
      // Keep exploring slowly at the target too: a full table must not become
      // an arrival-order monopoly. Established admission owns rotation limits.
      const available = Math.max(1, LOCAL_TARGET - localCount());
      const batch = [...candidates].filter(([member, candidate]) => !known(member) && candidate.retryAt <= now()).slice(0, Math.min(LOCAL_TARGET, available));
      // why: parallel dials must fit provisional routing ownership, not merely
      // the native ICE ceiling. Recompute after each settlement so a first
      // committed link can unlock parallel exploration on a larger table.
      /** @type {Set<Promise<void>>} */
      const active = new Set();
      let cursor = 0;
      /** @param {string} member @param {{expires:number,retryAt:number,failures:number}} candidate */
      const launch = (member, candidate) => {
        candidates.delete(member);
        candidates.set(member, candidate);
        const work = (async () => {
          candidate.retryAt = now() + SAMPLE_INTERVAL_MS;
          try { await connect(member, lifetime.signal); }
          catch (error) {
            // why: our own provisional reservation can refuse this attempt even
            // when the remote is healthy. Retain existing failure debt without
            // charging another remote failure; retry only at ordinary cadence.
            if (error instanceof RoutingAdmissionBusyError) candidate.retryAt = now() + SAMPLE_INTERVAL_MS;
            else { candidate.failures = Math.min(5, candidate.failures + 1); candidate.retryAt = now() + Math.min(60_000, 2_000 * 2 ** candidate.failures); }
          }
          if (!stopped && known(member)) candidates.delete(member);
        })();
        active.add(work);
        void work.then(() => active.delete(work), () => active.delete(work));
      };
      while (cursor < batch.length || active.size) {
        if (stopped || signal.aborted) break;
        // why: a stale contact can consume an entire sample interval. Finish
        // already-owned dials, then resample instead of serially spending a
        // full transport deadline on every remaining stale batch member.
        if (cursor > 0 && now() - startedAt >= SAMPLE_INTERVAL_MS) break;
        const limit = Math.max(1, Math.min(LOCAL_TARGET, parallelism()));
        while (cursor < batch.length && active.size < limit && !stopped && !signal.aborted) {
          const [member, candidate] = batch[cursor++];
          launch(member, candidate);
        }
        if (active.size) await Promise.race(active);
      }
      await Promise.allSettled(active);

    } finally {
      running = false;
      if (!stopped && !signal.aborted) {
        // why: a departed contact can consume the whole dial deadline. Adding
        // another full interval afterward stalls discovery of returning peers.
        // Keep cycles non-overlapping and retain each candidate's retry debt.
        const delay = again ? 0 : Math.max(0, startedAt + SAMPLE_INTERVAL_MS + Math.floor(random() * 2_000) - now());
        again = false;
        timer = timers.setTimeout(() => { void cycle(); }, delay);
      }
    }
  };
  remember(initial);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  return { start: cycle, wake: () => { void cycle(); }, stop,
    stats: () => ({ candidates: candidates.size, running, stopped }) };
};
