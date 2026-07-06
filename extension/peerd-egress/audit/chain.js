// @ts-check
// audit/chain.js — the audit log's tamper-evidence hash chain (R4).
//
// Each appended entry carries `chain` = SHA-256 over (the previous
// entry's chain ‖ this entry's canonical core). A separate tiny head
// record (audit_meta store) pins the id+chain of the NEWEST entry, so
// verification detects all four naive tamperings: a rewritten entry
// (its own chain no longer matches), a deleted middle entry (its
// successor's chain no longer matches), a truncated tail (head record
// disagrees with the last entry), and a reordered log (uuidv7 order and
// chain order diverge). Retention pruning stays legal: only the OLDEST
// entries are removed, and the first retained entry's chain is accepted
// as the anchor.
//
// Honest scope (the threat model's R4 wording matches): this is
// tamper-EVIDENT, not tamper-PROOF. An attacker with code execution in
// the extension origin can recompute the whole chain forward and update
// the head; without a secret the origin does not hold, no in-origin
// scheme can prevent that. What this closes is silent, cheap
// tampering — and it makes the debug bundle's audit slice a checkable
// artifact rather than a claim.
//
// Pure over injected values (crypto.subtle is compute, not IO) —
// bun-tested without a browser.

/** The audit_meta record that pins the newest entry. */
export const CHAIN_HEAD_KEY = 'audit_chain_head';

const encoder = new TextEncoder();

/** @param {ArrayBuffer} buf */
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The canonical byte string a chain hash covers. Fixed field order —
 * object-key order must never be able to change the hash.
 * @param {{ id: string, when: number, type: string, sessionId?: string, details?: object }} entry
 */
export const canonicalCore = (entry) => [
  entry.id,
  String(entry.when),
  entry.type,
  entry.sessionId ?? '',
  entry.details === undefined ? '' : JSON.stringify(entry.details),
].join(''); // unit separator — cannot appear in uuidv7/type, unambiguous joins

/**
 * chain(entry) = SHA-256(prevChain ‖ US ‖ canonicalCore(entry)) as hex.
 * @param {string} prevChain  the previous entry's chain ('' for the genesis entry)
 * @param {{ id: string, when: number, type: string, sessionId?: string, details?: object }} entry
 */
export const computeChainHash = async (prevChain, entry) => {
  const bytes = encoder.encode(`${prevChain}${canonicalCore(entry)}`);
  return hex(await crypto.subtle.digest('SHA-256', bytes));
};

/**
 * Verify a retained slice of the log against its embedded chain and the
 * head record. Entries must be in insertion (uuidv7) order — exactly what
 * auditLog.list() returns.
 *
 * @param {Array<Record<string, any>>} entries
 * @param {{ id?: string, chain?: string } | null} [head]  the audit_meta head record
 * @returns {Promise<{ ok: boolean, checked: number, unchained: number, reason?: string, brokenAtId?: string }>}
 *   ok=false only on a DETECTED inconsistency. Entries written before the
 *   chain existed carry no `chain` and are reported (unchained), not failed —
 *   an upgrade must not brand every existing install as tampered.
 */
export const verifyChain = async (entries, head = null) => {
  const chained = entries.filter((e) => typeof e.chain === 'string');
  const unchained = entries.length - chained.length;
  // Legacy entries are only legal as a PREFIX (they predate the feature);
  // a chainless entry AFTER a chained one is an insertion or a strip.
  const firstChained = entries.findIndex((e) => typeof e.chain === 'string');
  if (firstChained !== -1) {
    for (let i = firstChained; i < entries.length; i++) {
      if (typeof entries[i].chain !== 'string') {
        return { ok: false, checked: 0, unchained, reason: 'unchained entry after a chained one', brokenAtId: entries[i].id };
      }
    }
  }
  let checked = 0;
  for (let i = 0; i < chained.length; i++) {
    // The first retained chained entry is the anchor: its predecessor may
    // have been pruned (or be a legacy entry), so its own hash is trusted
    // as the chain's start. Every later link is recomputable.
    if (i > 0) {
      const expected = await computeChainHash(chained[i - 1].chain, /** @type {any} */ (chained[i]));
      if (expected !== chained[i].chain) {
        return { ok: false, checked, unchained, reason: 'chain mismatch (rewritten or deleted entry)', brokenAtId: chained[i].id };
      }
    }
    checked++;
  }
  if (head?.chain && chained.length > 0) {
    const last = chained[chained.length - 1];
    if (head.id !== last.id || head.chain !== last.chain) {
      return { ok: false, checked, unchained, reason: 'head mismatch (truncated tail)', brokenAtId: last.id };
    }
  }
  if (head?.chain && chained.length === 0 && entries.length >= 0) {
    // A head exists but no chained entries survive: legal only if the whole
    // retained window predates... no — the head tracks the newest entry,
    // which is never pruned. A head with no chained entries means the tail
    // was deleted.
    return { ok: false, checked, unchained, reason: 'head present but no chained entries (tail deleted)' };
  }
  return { ok: true, checked, unchained };
};
