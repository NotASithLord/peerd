// @ts-check
// Established-link policy is separate from the ICE/HELLO governor. Only the
// local room owner assigns exploration ownership; wire/info fields never do.
export const NEIGHBOR_GRACE_MS = 60_000;
export const NEIGHBOR_ROTATION_MS = 30_000;
export const TRANSFER_PROTECTION_MS = 30_000;
/** @typedef {{ did: string, locallySelected: boolean, admittedAt: number,
 * protectedUntil: number, busy: boolean }} Neighbor */
/** @param {{ peers: Neighbor[], budget: number, locallySelected: boolean, now: number, lastRotation: number }} input
 * @returns {{ allowed: boolean, evict?: string }} */
export const establishedAdmission = ({ peers, budget, locallySelected, now, lastRotation }) => {
  const inbound = peers.filter((peer) => !peer.locallySelected);
  const reserved = Math.min(2, Math.max(0, budget - 1));
  const inboundFull = !locallySelected && inbound.length >= budget - reserved;
  if (peers.length < budget && !inboundFull) return { allowed: true };
  if (now - lastRotation < NEIGHBOR_ROTATION_MS) return { allowed: false };
  // Keep locally selected diversity when admitting unsolicited neighbors.
  // Local exploration may eventually rotate a local edge, but prefers inbound
  // slots; every replacement is authenticated and rate limited, never a ban.
  const candidates = (inboundFull || inbound.length ? inbound : peers)
    .filter((peer) => now - peer.admittedAt >= NEIGHBOR_GRACE_MS
      && (!peer.busy || now >= peer.protectedUntil))
    .sort((a, b) => a.admittedAt - b.admittedAt || a.did.localeCompare(b.did));
  return candidates[0] ? { allowed: true, evict: candidates[0].did } : { allowed: false };
};
