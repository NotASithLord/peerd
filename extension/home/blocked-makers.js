// @ts-check
// home/blocked-makers.js - pure rules for makers the user blocked, shared by
// Discover and Contacts.
//
// A block is the user's own choice, stored by the SW ('dweb/peer-block'). No
// sends, no DOM: these map its replies to the states the views draw. Bun tests
// pin each rule. why its own module: Contacts loads with Home, and Discover's
// model stays out of that first load.

/**
 * The makers a 'dweb/blocked-peers' reply lists, by full did, or null when the
 * reply is not a list: the caller then keeps what it knew.
 * @param {unknown} reply
 * @returns {Set<string>|null}
 */
export const blockedSet = (reply) => {
  const list = /** @type {{ok?:unknown, blocked?:unknown}|null} */ (reply && typeof reply === 'object' ? reply : null);
  return list?.ok === true && Array.isArray(list.blocked)
    ? new Set(list.blocked.filter(did => typeof did === 'string')) : null;
};

/**
 * What a block, an unblock or a saved name did, as the user reads it.
 * why a stored policy is done: the host reads the stored policy again by
 * itself, so a live host that did not confirm in time still applies it.
 * Unknown stays neutral: the change may or may not have happened.
 * @param {unknown} reply
 * @returns {'done'|'failed'|'unknown'}
 */
export const effectOutcome = (reply) => {
  const result = /** @type {{ok?:unknown, durable?:unknown, outcomeKnown?:unknown}|null} */ (
    reply && typeof reply === 'object' ? reply : null);
  if (result?.ok === true || result?.durable === true) return 'done';
  return result?.outcomeKnown === false ? 'unknown' : 'failed';
};

/**
 * Apps whose maker the user blocked leave every Discover list.
 * @template {{publisher?:string}} T
 * @param {T[]} apps @param {ReadonlySet<string>} blocked
 * @returns {T[]}
 */
export const withoutBlocked = (apps, blocked) => blocked.size
  ? apps.filter(app => typeof app.publisher !== 'string' || !blocked.has(app.publisher)) : apps;

/**
 * The Contacts rows for blocked makers, in the order the list names them: the
 * name the user saved for that did, else its short key. A name gets its first
 * letter; a key its first two characters, as the frame draws them.
 * @param {Iterable<string>} dids @param {ReadonlyMap<string, string>} names saved names by full did
 * @returns {{did:string, name:string|null, key:string, letter:string}[]}
 */
export const blockedRows = (dids, names) => [...dids].map(did => {
  const name = names.get(did) ?? null;
  const key = did.slice(-8);
  return { did, name, key, letter: name ? (Array.from(name)[0] ?? '?').toUpperCase() : key.slice(0, 2) };
});
