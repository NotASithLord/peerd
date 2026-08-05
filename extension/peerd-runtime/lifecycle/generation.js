// @ts-check
// Service-worker generations — the "authority does not survive restart" lever.
//
// Every SW start mints a new generation; every piece of transient authority
// (actor grants, relay tokens, approval tokens, resource leases, tab
// ownership) is stamped with the generation that minted it. After a
// restart, authority from any other generation is refused — re-derived from
// durable policy, never resumed by assumption. This is contract guarantee 3
// (security authority does not expand after recovery) and 7 (a SW restart
// never silently extends credential/approval/capability lifetimes).
//
// Pure: the nonce is injected (the shell passes crypto.randomUUID()), the
// clock is a parameter. No IO.

/**
 * @typedef {Object} Generation
 * @property {number} seq   monotonic across restarts (persisted by the shell)
 * @property {string} id    unguessable per-start identifier
 * @property {number} mintedAt  epoch ms
 */

/**
 * Mint the next generation. `previous` is the durable record of the last
 * generation (or null on first run); `nonce` is injected entropy so two
 * restarts can never collide even if the persisted seq write was lost.
 *
 * @param {Generation | null | undefined} previous
 * @param {{ nonce: string, now: number }} deps
 * @returns {Generation}
 */
export const mintGeneration = (previous, { nonce, now }) => {
  if (typeof nonce !== 'string' || nonce.length < 8) {
    throw new TypeError('mintGeneration: nonce must be at least 8 chars of injected entropy');
  }
  const prevSeq = typeof previous?.seq === 'number' && Number.isFinite(previous.seq)
    ? previous.seq
    : 0;
  const seq = Math.max(0, Math.floor(prevSeq)) + 1;
  return Object.freeze({ seq, id: `gen-${seq}-${nonce}`, mintedAt: now });
};

/**
 * Authority stamped by a generation: grants, approval tokens, leases,
 * ownership records. Validity is exact-id equality — a seq match alone is
 * not enough (a lost seq write could repeat a number; the nonce cannot).
 *
 * @typedef {Object} StampedAuthority
 * @property {string} generationId
 * @property {number} [expiresAt]  epoch ms; absent = no time bound
 */

/**
 * Is a piece of stamped authority still valid under the current generation?
 * Fails closed: missing stamp, unknown generation, or an expired window all
 * refuse. A SW restart therefore cannot extend any lifetime — the new
 * generation invalidates every prior stamp wholesale.
 *
 * @param {StampedAuthority | null | undefined} authority
 * @param {{ generation: Generation, now: number }} ctx
 * @returns {{ valid: boolean, reason: string }}
 */
export const authorityValid = (authority, { generation, now }) => {
  if (!authority || typeof authority.generationId !== 'string') {
    return { valid: false, reason: 'no generation stamp; authority refused' };
  }
  if (authority.generationId !== generation.id) {
    return {
      valid: false,
      reason: `stale generation (${authority.generationId} != ${generation.id}); `
        + 'authority must be re-derived from durable policy',
    };
  }
  if (typeof authority.expiresAt === 'number' && now >= authority.expiresAt) {
    return { valid: false, reason: 'authority window expired' };
  }
  return { valid: true, reason: 'current generation, within window' };
};

/**
 * Partition a batch of stamped records into live and stale under the
 * current generation — the startup sweep that releases prior-generation
 * tab/actor/Worker/engine ownership (§5.3 step 5) and refuses stale relay/
 * approval tokens (step 7).
 *
 * @template {StampedAuthority} T
 * @param {T[]} records
 * @param {{ generation: Generation, now: number }} ctx
 * @returns {{ live: T[], stale: Array<{ record: T, reason: string }> }}
 */
export const sweepStaleAuthority = (records, ctx) => {
  /** @type {T[]} */ const live = [];
  /** @type {Array<{ record: T, reason: string }>} */ const stale = [];
  for (const record of Array.isArray(records) ? records : []) {
    const { valid, reason } = authorityValid(record, ctx);
    if (valid) live.push(record);
    else stale.push({ record, reason });
  }
  return { live, stale };
};

/**
 * Actor-generation gate: messages/events from a prior actor generation are
 * discarded, so an old run can never send events into a new one (§7.3).
 * Exact match, fail closed on garbage.
 *
 * @param {{ generation?: unknown }} message
 * @param {number} currentActorGeneration
 */
export const acceptActorMessage = (message, currentActorGeneration) =>
  typeof message?.generation === 'number'
  && Number.isFinite(currentActorGeneration)
  && message.generation === currentActorGeneration;
