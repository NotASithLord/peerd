// @ts-check
// background/dweb-inbound-rate-cap.js — the dweb agent's inbound wake rate cap.
//
// Inbound mesh DMs wake the dweb agent, and every wake can spend money (a model
// call). The cap MUST bind before that call — a spamming or Sybil peer can mint
// did:keys for free, so the limit is BOTH per-did (a single peer can't flood) and
// global (the whole inbox can't drain the user's budget). why extracted from the
// SW: it's a pure stateful limiter (timestamps + a counter), so the sliding-window
// + eviction behavior is Bun-testable with an injected clock instead of Date.now.
//
// The per-did map is swept on each admit: dids are free/Sybil, so without eviction
// it would grow monotonically over the keepalive-pinned SW. Bounded by the admit
// rate, so at most a few dozen live keys ever.

/**
 * @param {Object} [opts]
 * @param {() => number} [opts.now]           injectable clock (default Date.now)
 * @param {number} [opts.perDidPerMinute]     max wakes per did in a sliding minute (default 3)
 * @param {number} [opts.perHourGlobal]       max wakes across all dids per hour (default 30)
 */
export const makeDwebInboundRateCap = ({ now = Date.now, perDidPerMinute = 3, perHourGlobal = 30 } = {}) => {
  /** @type {Map<string, number[]>} per-did wake timestamps (sliding minute) */
  const byDid = new Map();
  let hour = { windowStart: 0, count: 0 };

  /** Admit an inbound wake from `did`? Records the wake when it returns true.
   *  @param {string} did @returns {boolean} */
  const allow = (did) => {
    const nowMs = now();
    const times = (byDid.get(did) ?? []).filter((t) => nowMs - t < 60_000);
    if (times.length >= perDidPerMinute) return false;             // per-did minute cap
    if (nowMs - hour.windowStart > 3_600_000) hour = { windowStart: nowMs, count: 0 };
    if (hour.count >= perHourGlobal) return false;                 // global hour cap
    times.push(nowMs);
    byDid.set(did, times);
    hour.count += 1;
    // Sweep dids whose timestamps have all aged out, so the map can't grow
    // without limit on the long-lived SW.
    for (const [k, ts] of byDid) {
      if (k !== did && !ts.some((t) => nowMs - t < 60_000)) byDid.delete(k);
    }
    return true;
  };

  return { allow, _liveDids: () => byDid.size };
};
