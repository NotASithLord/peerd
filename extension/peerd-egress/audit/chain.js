// @ts-check

/** The audit_meta record that pins the newest entry. */
export const CHAIN_HEAD_KEY = 'audit_chain_head';

const encoder = new TextEncoder();
const SEP = '\x1f'; // ASCII unit separator — never appears in ids/types

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
].join(SEP); // SEP-joined so distinct field tuples can never collide into one string

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
    if (i > 0) {
      const expected = await computeChainHash(chained[i - 1].chain, /** @type {any} */ (chained[i]));
      if (expected !== chained[i].chain) {
        return { ok: false, checked, unchained, reason: 'chain mismatch (rewritten or deleted entry)', brokenAtId: chained[i].id };
      }
    }
    checked++;
  }
  if (chained.length > 0 && !head?.chain) {
    return { ok: false, checked, unchained, reason: 'head record missing (tail truncation or head deletion)' };
  }
  if (head?.chain && chained.length > 0) {
    const last = chained[chained.length - 1];
    if (head.id !== last.id || head.chain !== last.chain) {
      return { ok: false, checked, unchained, reason: 'head mismatch (truncated tail)', brokenAtId: last.id };
    }
  }
  if (head?.chain && chained.length === 0) {
    return { ok: false, checked, unchained, reason: 'head present but no chained entries (tail deleted)' };
  }
  return { ok: true, checked, unchained };
};
