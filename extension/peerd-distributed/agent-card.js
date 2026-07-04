// @ts-check
// peerd-distributed/agent-card.js — the AGENT CARD: a peer advertising "I'm an
// agent, here's what I can do", so another agent can DISCOVER a capability
// before it asks (A2A's discovery pillar).
//
// We RHYME with Google A2A's Agent Card data model on purpose (owner call
// 2026-07-04): the same field vocabulary — name / description / version /
// skills[{id,name,description}] / capabilities — so a future adapter to a real
// A2A agent is a rename, not a rewrite. But we STRIP A2A's HTTP transport: A2A's
// card carries a `url` + HTTP auth schemes; ours carries a `did` (the mesh
// address) and no auth block — the mesh authenticates the sender by signature,
// there is no server to point a url at. This is the transport-independent core
// of A2A, nothing more.
//
// Same caps discipline as the app card (apps/meta.js) so a card stays cheap
// enough to ride presence/discovery liberally. Pure — validate/normalize only;
// the SIGNING + advertise happens in the offscreen base host.

export const MAX_CARD_NAME = 64;
export const MAX_CARD_DESC = 512;
export const MAX_SKILLS = 16;
export const MAX_SKILL_FIELD = 128;
export const MAX_CARD_BYTES = 4096;

export class CardRejectedError extends Error {
  /** @param {string} reason */
  constructor(reason) { super(reason); this.name = 'CardRejectedError'; }
}

/** @param {unknown} v @param {number} max */
const cappedString = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * @typedef {{ id: string, name: string, description: string }} Skill
 * @typedef {{
 *   name: string, description: string, version: string,
 *   did?: string, skills: Skill[],
 *   capabilities: { ask: boolean, streaming: boolean },
 * }} AgentCard
 */

/**
 * Normalize arbitrary input into a well-formed, capped AgentCard. Never throws —
 * coerces + clamps (an actor-authored card should degrade, not error). The `did`
 * is stamped by the host at publish time (the card's OWN did is trusted-side),
 * so it's optional here and dropped if not a did:key.
 * @param {any} input @returns {AgentCard}
 */
export const normalizeCard = (input) => {
  const src = input && typeof input === 'object' ? input : {};
  const skillsIn = Array.isArray(src.skills) ? src.skills.slice(0, MAX_SKILLS) : [];
  const skills = skillsIn
    .filter((/** @type {any} */ s) => s && typeof s === 'object')
    .map((/** @type {any} */ s, /** @type {number} */ i) => ({
      id: cappedString(s.id, MAX_SKILL_FIELD) || `skill-${i}`,
      name: cappedString(s.name, MAX_SKILL_FIELD),
      description: cappedString(s.description, MAX_SKILL_FIELD),
    }));
  const caps = src.capabilities && typeof src.capabilities === 'object' ? src.capabilities : {};
  return {
    name: cappedString(src.name, MAX_CARD_NAME),
    description: cappedString(src.description, MAX_CARD_DESC),
    version: cappedString(src.version, 32) || '0.1.0',
    ...(typeof src.did === 'string' && src.did.startsWith('did:key:') ? { did: src.did } : {}),
    skills,
    // We support ask (request/response) always; streaming is future (the fenced
    // inbound-wake is not yet an in-run stream). Report honestly.
    capabilities: { ask: true, streaming: false, ...(caps.ask === false ? { ask: false } : {}) },
  };
};

/**
 * Validate a normalized card is publishable: a non-empty name and within the
 * byte ceiling. Returns { ok, card } or throws CardRejectedError.
 * @param {any} input @returns {{ ok: true, card: AgentCard }}
 */
export const validateCard = (input) => {
  const card = normalizeCard(input);
  if (!card.name) throw new CardRejectedError('agent card: name is required');
  const bytes = new TextEncoder().encode(JSON.stringify(card)).length;
  if (bytes > MAX_CARD_BYTES) throw new CardRejectedError(`agent card: ${bytes} bytes > ${MAX_CARD_BYTES} ceiling`);
  return { ok: true, card };
};

/** Is this a well-formed card received FROM a peer (untrusted)? Coerce-and-check. Pure.
 * @param {any} input @returns {AgentCard | null} */
export const parsePeerCard = (input) => {
  try { return validateCard(input).card; }
  catch { return null; }
};
