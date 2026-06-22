// @ts-check
// peerd-distributed/transport/ice.js — connectivity telemetry (D-5).
//
// peerd's connectivity story is direct-or-honest-failure (NORTH-STAR T3):
// host candidates (IPv6 the bet) + public-STUN reflexive for IPv4 NATs,
// NO TURN tier, ever. What that buys must be MEASURED, in two places:
//
//   connectionPath(pc)        — after connect: which path actually won
//                               ('direct-ipv6' on stage is the bet, visible)
//   DirectPathUnavailableError — on failure: WHY, with a candidate-type
//                               summary on both ends. This is also the
//                               telemetry that arms or disarms the D-5
//                               revisit trigger (>~1-in-5 pair failures).
//
// why no "prefer IPv6" knob here: RTCPeerConnection exposes none. ICE's
// own pair priorities (RFC 8421 interleaving, host>srflx) already favor
// direct IPv6 when both ends have it — our job is to OBSERVE honestly,
// not to pretend we steer.

/** @typedef {{ host4: number, host6: number, host6ll: number, srflx: number, prflx: number, relay: number, mdns: number }} CandidateSummary */

export class DirectPathUnavailableError extends Error {
  /** @param {{ local?: CandidateSummary, remote?: CandidateSummary }} [ends] */
  constructor({ local, remote } = {}) {
    /** @param {CandidateSummary | undefined} s */
    const fmt = (s) =>
      s ? `host6:${s.host6} host6ll:${s.host6ll} host4:${s.host4} srflx:${s.srflx} mdns:${s.mdns} relay:${s.relay}` : 'unknown';
    // "IPv6 but link-local only" is the common confuser — call it out explicitly.
    const llOnly = local && remote && local.host6 === 0 && remote.host6 === 0 && (local.host6ll || remote.host6ll);
    const tail = llOnly ? 'and only LINK-LOCAL IPv6 (fe80::, does not route across networks).' : 'with no global IPv6 path.';
    super(
      `no direct path between peers — local[${fmt(local)}] remote[${fmt(remote)}]. `
      + `peerd ships no TURN relay (NORTH-STAR D-5): no routable path — symmetric-NAT IPv4 ${tail} `
      + 'This failure is surfaced, not silently relayed.',
    );
    this.name = 'DirectPathUnavailableError';
    this.local = local;
    this.remote = remote;
  }
}

// Count candidate types in an SDP blob. Pure — the unit-testable half of
// the diagnostics (the live half is getStats, browser-only).
/**
 * @param {string} [sdp]
 * @returns {CandidateSummary}
 */
export const summarizeCandidates = (sdp = '') => {
  // host6 = GLOBAL (routable) IPv6; host6ll = link-local (fe80::, does NOT route
  // across networks — Chrome emits these even with no global IPv6, which is why
  // a failure can show "IPv6 candidates" yet still have no IPv6 PATH).
  /** @type {CandidateSummary} */
  const sum = { host4: 0, host6: 0, host6ll: 0, srflx: 0, prflx: 0, relay: 0, mdns: 0 };
  for (const line of String(sdp).split(/\r?\n/)) {
    const m = line.match(/^a=candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\S+)/);
    if (!m) continue;
    const [, addr, typ] = m;
    if (typ === 'host') {
      if (addr.toLowerCase().endsWith('.local')) sum.mdns += 1;
      else if (addr.includes(':')) { if (/^fe80/i.test(addr)) sum.host6ll += 1; else sum.host6 += 1; }
      else sum.host4 += 1;
    } else if (typ in sum) {
      sum[/** @type {keyof CandidateSummary} */ (typ)] += 1;
    }
  }
  return sum;
};

/** @param {string | undefined} addr */
const famOf = (addr) => (addr && String(addr).includes(':') ? 'ipv6' : 'ipv4');

/**
 * Read the selected candidate pair off a live RTCPeerConnection and name
 * the path: 'direct-ipv6' | 'direct-ipv4' | 'direct-ipv4-srflx' | … |
 * 'unknown' (stats not settled / unsupported shape). Best-effort by
 * design — the HUD shows 'unknown' rather than guessing.
 */
/** @param {RTCPeerConnection} pc */
export const connectionPath = async (pc) => {
  try {
    const stats = await pc.getStats();
    /** @type {Map<string, any>} */
    const byId = new Map();
    stats.forEach((/** @type {any} */ s) => byId.set(s.id, s));
    /** @type {any} */
    let pair = null;
    // Chrome: transport.selectedCandidatePairId; Firefox: pair.selected.
    stats.forEach((/** @type {any} */ s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
    });
    if (!pair) {
      stats.forEach((/** @type {any} */ s) => {
        if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s;
      });
    }
    if (!pair) return { path: 'unknown' };
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    const fam = famOf(local?.address ?? local?.ip ?? remote?.address ?? remote?.ip);
    const types = [local?.candidateType, remote?.candidateType];
    const kind = types.includes('relay') ? 'relay'
      : types.some((t) => t === 'srflx' || t === 'prflx') ? 'srflx'
      : 'host';
    return {
      path: kind === 'host' ? `direct-${fam}` : `direct-${fam}-${kind}`,
      family: fam,
      local: local?.candidateType ?? 'unknown',
      remote: remote?.candidateType ?? 'unknown',
    };
  } catch {
    return { path: 'unknown' };
  }
};
