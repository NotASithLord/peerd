// @ts-check
import { SAMPLE_INTERVAL_MS } from './rendezvous-profile.js';

export const NEIGHBOR_CANDIDATES = 32;
const CANDIDATE_TTL_MS = 120_000;
const LOCAL_TARGET = 4;
/**
 * One owner for one negotiated rendezvous generation. Candidate bytes, retry
 * state, active dials, sampling and timers are independently bounded.
 * @param {{ initial: string[], sample: (opts: {signal: AbortSignal}) => Promise<string[]>,
 * connect: (member: string, signal: AbortSignal) => Promise<void>,
 * known: (member: string) => boolean, localCount: () => number,
 * now?: () => number, random?: () => number, timers?: any, signal: AbortSignal }} opts
 */
export const createNeighborMaintenance = ({ initial, sample, connect, known, localCount,
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
      await Promise.allSettled(batch.map(async ([member, candidate]) => {
        candidate.retryAt = now() + SAMPLE_INTERVAL_MS;
        try { await connect(member, lifetime.signal); }
        catch { candidate.failures = Math.min(5, candidate.failures + 1); candidate.retryAt = now() + Math.min(60_000, 2_000 * 2 ** candidate.failures); }
        if (!stopped && known(member)) candidates.delete(member);
      }));
    } finally {
      running = false;
      if (!stopped && !signal.aborted) {
        const delay = again ? 0 : SAMPLE_INTERVAL_MS + Math.floor(random() * 2_000);
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
