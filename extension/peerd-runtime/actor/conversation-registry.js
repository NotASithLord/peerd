// @ts-check
// conversation-registry.js — standing peer conversations over the mesh.
//
// Today's a2a is single-shot: one ask → one reply → the correlation entry
// is deleted, and an inbound peer message wakes the dweb actor to report
// to the USER, never back to the peer. A standing conversation is a
// THREAD keyed by a `convId` that survives many turns: each side can send
// again, the prior turns are the actor's context, and the actor's answer
// goes BACK to the peer (per-conversation consent, mirroring a2a first
// contact).
//
// This module is the pure state core — a capped, TTL-evicted map of
// conversation threads. IO (sending DMs, the consent prompt, the actor
// turn) stays in the SW; here we only hold and shape thread state, so the
// whole lifecycle is bun-testable. Same posture as dweb-inbound-rate-cap.
//
// Bounds (the SW is keepalive-pinned, peers are untrusted): a cap on live
// conversations (oldest-idle evicted), a cap on turns kept per thread
// (oldest turns dropped — the actor needs recent context, not the whole
// history), and a TTL so an abandoned thread is reclaimed. A peer cannot
// grow SW memory without limit.

export const MAX_CONVERSATIONS = 32;
export const MAX_TURNS_PER_CONVERSATION = 20;
export const CONVERSATION_TTL_MS = 30 * 60_000; // 30 min idle → reclaimed
export const CONVERSATION_TURN_MAX_CHARS = 4000;

/** @param {unknown} s @param {number} n */
const clip = (s, n) => {
  const str = typeof s === 'string' ? s : String(s ?? '');
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
};

/**
 * @param {{ now?: () => number, newConvId?: () => string, maxConversations?: number, maxTurns?: number, ttlMs?: number }} [opts]
 */
export const createConversationRegistry = ({
  now = Date.now,
  newConvId,
  maxConversations = MAX_CONVERSATIONS,
  maxTurns = MAX_TURNS_PER_CONVERSATION,
  ttlMs = CONVERSATION_TTL_MS,
} = {}) => {
  /** @typedef {{ role: 'peer'|'self', message: string, ts: number }} Turn */
  /** @type {Map<string, { convId: string, did: string, turns: Turn[], startedAt: number, lastTs: number, replyConsent: boolean }>} */
  const conversations = new Map();
  let idSeq = 0;
  const mkConvId = newConvId ?? (() => `conv-${now().toString(36)}-${(idSeq += 1).toString(36)}`);

  // Reclaim idle/expired threads on every write so the map stays bounded
  // with no read-path cost (the dweb-inbound-rate-cap pattern).
  const sweep = () => {
    const cutoff = now() - ttlMs;
    for (const [id, c] of conversations) {
      if (c.lastTs < cutoff) conversations.delete(id);
    }
    while (conversations.size > maxConversations) {
      // evict the oldest-idle thread
      let oldestId = null; let oldestTs = Infinity;
      for (const [id, c] of conversations) {
        if (c.lastTs < oldestTs) { oldestTs = c.lastTs; oldestId = id; }
      }
      if (oldestId == null) break;
      conversations.delete(oldestId);
    }
  };

  /** @param {{ convId: string, did: string }} c */
  const pushTurn = (c, /** @type {'peer'|'self'} */ role, /** @type {string} */ message) => {
    const entry = conversations.get(c.convId);
    if (!entry) return;
    entry.turns.push({ role, message: clip(message, CONVERSATION_TURN_MAX_CHARS), ts: now() });
    if (entry.turns.length > maxTurns) entry.turns.splice(0, entry.turns.length - maxTurns);
    entry.lastTs = now();
  };

  return {
    /**
     * Open a NEW outgoing conversation with a peer (the local side started it).
     * @param {string} did @param {string} firstMessage
     * @returns {{ convId: string }}
     */
    open: (did, firstMessage) => {
      const convId = mkConvId();
      const t = now();
      conversations.set(convId, { convId, did, turns: [], startedAt: t, lastTs: t, replyConsent: false });
      pushTurn({ convId, did }, 'self', firstMessage);
      sweep();
      return { convId };
    },

    /**
     * Adopt an INBOUND conversation a peer opened (its envelope carried a
     * convId we don't know yet). Idempotent: a repeat convId returns the
     * existing thread. Returns whether this was a fresh adoption (the SW
     * uses that to decide whether to ask for reply consent).
     * @param {string} convId @param {string} did
     * @returns {{ fresh: boolean }}
     */
    adopt: (convId, did) => {
      const existing = conversations.get(convId);
      if (existing) {
        // why the did check: a convId is a bearer token on the wire; only the
        // peer that owns the thread may extend it. A mismatch is a new,
        // separate thread under a fresh id, never a hijack of this one.
        if (existing.did !== did) return { fresh: false };
        return { fresh: false };
      }
      const t = now();
      conversations.set(convId, { convId, did, turns: [], startedAt: t, lastTs: t, replyConsent: false });
      sweep();
      return { fresh: true };
    },

    /** Record a turn on a known thread (role: who spoke). @param {string} convId @param {'peer'|'self'} role @param {string} message */
    record: (convId, role, message) => {
      const c = conversations.get(convId);
      if (!c) return false;
      pushTurn(c, role, message);
      sweep();
      return true;
    },

    /** The peer a conversation belongs to, or null. @param {string} convId */
    didFor: (convId) => conversations.get(convId)?.did ?? null,

    /** Whether a thread exists and belongs to `did` (wire-safety check). @param {string} convId @param {string} did */
    ownedBy: (convId, did) => conversations.get(convId)?.did === did,

    /** Mark that the user granted reply consent for this thread. @param {string} convId */
    grantReplyConsent: (convId) => { const c = conversations.get(convId); if (c) c.replyConsent = true; },

    /** Whether replies to the peer are already consented for this thread. @param {string} convId */
    hasReplyConsent: (convId) => conversations.get(convId)?.replyConsent === true,

    /** The recent turns for the actor's context (copy), oldest first. @param {string} convId */
    turnsFor: (convId) => (conversations.get(convId)?.turns ?? []).map((t) => ({ ...t })),

    /** Drop a thread (revocation / peer blocked). @param {string} convId */
    close: (convId) => conversations.delete(convId),

    /** Drop every thread with a peer (dweb_block cascade). @param {string} did */
    closeDid: (did) => {
      for (const [id, c] of conversations) if (c.did === did) conversations.delete(id);
    },

    _size: () => conversations.size,
  };
};
