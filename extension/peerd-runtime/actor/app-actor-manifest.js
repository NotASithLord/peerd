// @ts-check
// peerd-runtime/actor/app-actor-manifest.js — the DWAPP ACTOR MANIFEST.
//
// With the actor model (every tab/instance is owned by an actor), an installed
// dwapp becomes a BOUND ACTOR the orchestrator invokes via message_actor. What
// turns a generic `app` actor (peerd's built-in app-BUILDER) into a SPECIALIZED
// capability is this manifest — carried IN the app's file bundle as
// `peerd.actor.json`, so it is covered by the same content hash a shared dwapp is
// signed under. This lives in peerd-runtime (a CORE module, not the dweb one):
// an app can declare an actor whether or not it ever touches the dweb, so the
// concept is core, and core code must not import the dweb module (the boundary
// rule — and the store build prunes that module entirely).
//
// The manifest declares the actor's PERSONALITY, not new authority:
//   - lore        the system prompt / specialized instructions its mini agent-loop runs under
//   - skills[]    advertised capabilities (Agent Card vocabulary — rhymes with the dweb
//                 agent-card so a dwapp's skills can later surface on the mesh for discovery)
//   - tools[]     a REQUEST for peerd tools, honored only against a TIGHT ceiling at
//                 mint time (app-actor.js dwappActorPersonality): a dwapp actor may
//                 request ONLY the READ-ONLY app tools and gets NOTHING by default. It can
//                 NEVER get network/DOM/dweb/spawn tools, nor the app-BUILDER write/delete
//                 tools — a "parser that fetches" is NOT expressible; a dwapp is a
//                 specialized REASONER over the inputs the orchestrator hands it (and, a
//                 later slice, its own sandboxed code), not an autonomous agent with
//                 borrowed authority. An untrusted, peer-authored manifest thus gains
//                 nothing it wasn't allowed; requests outside the ceiling are dropped and
//                 surfaced as droppedTools so the failure is legible, never silent.
//
// Pure — validate/normalize only. Coerce-and-clamp on the untrusted (peer) path so a
// hostile bundle degrades to a safe manifest instead of throwing deep in install.

// Caps — mirror the dweb agent-card so the two capability descriptors stay legible together.
export const MAX_ACTOR_NAME = 64;
export const MAX_ACTOR_DESC = 512;
export const MAX_ACTOR_LORE = 8192;        // the system prompt — bigger than a card field, still bounded
export const MAX_ACTOR_SKILLS = 16;
export const MAX_SKILL_FIELD = 128;
export const MAX_ACTOR_TOOLS = 32;
export const MAX_TOOL_NAME = 64;
export const MAX_MANIFEST_BYTES = 16_384;  // whole-manifest ceiling (bundle-side, not the 4 KB card cap)

export class ActorManifestRejectedError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`dwapp actor manifest rejected: ${reason}`);
    this.name = 'ActorManifestRejectedError';
  }
}

/** @param {unknown} v @param {number} max */
const cappedString = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * @typedef {{ id: string, name: string, description: string }} ActorSkill
 * @typedef {{
 *   name: string,
 *   description: string,
 *   lore: string,
 *   skills: ActorSkill[],
 *   tools: string[],
 * }} ActorManifest
 */

/**
 * Normalize arbitrary input into a well-formed, capped ActorManifest. Never
 * throws — coerces + clamps (a peer-authored manifest should degrade, not error).
 * `tools` are de-duplicated + capped; the intersection with the actual allow-list
 * happens at mint time, so junk tool names here are harmless.
 * @param {any} input @returns {ActorManifest}
 */
export const normalizeActorManifest = (input) => {
  const src = input && typeof input === 'object' ? input : {};
  const skillsIn = Array.isArray(src.skills) ? src.skills.slice(0, MAX_ACTOR_SKILLS) : [];
  const skills = skillsIn
    .filter((/** @type {any} */ s) => s && typeof s === 'object')
    .map((/** @type {any} */ s, /** @type {number} */ i) => ({
      id: cappedString(s.id, MAX_SKILL_FIELD) || `skill-${i}`,
      name: cappedString(s.name, MAX_SKILL_FIELD),
      description: cappedString(s.description, MAX_SKILL_FIELD),
    }));
  const toolsIn = Array.isArray(src.tools) ? src.tools : [];
  const tools = [...new Set(
    toolsIn
      .filter((/** @type {any} */ t) => typeof t === 'string' && t.length > 0)
      .map((/** @type {string} */ t) => t.slice(0, MAX_TOOL_NAME)),
  )].slice(0, MAX_ACTOR_TOOLS);
  return {
    name: cappedString(src.name, MAX_ACTOR_NAME),
    description: cappedString(src.description, MAX_ACTOR_DESC),
    lore: cappedString(src.lore, MAX_ACTOR_LORE),
    skills,
    tools,
  };
};

/**
 * Validate a normalized manifest is usable: a non-empty name AND non-empty lore
 * (the lore is what makes it a specialized actor — without it there is no
 * personality to mint), and within the byte ceiling. Returns { ok, manifest } or
 * throws ActorManifestRejectedError.
 * @param {any} input @returns {{ ok: true, manifest: ActorManifest }}
 */
export const validateActorManifest = (input) => {
  const manifest = normalizeActorManifest(input);
  if (!manifest.name.trim()) throw new ActorManifestRejectedError('name is required');
  if (!manifest.lore.trim()) throw new ActorManifestRejectedError('lore is required (the actor has no personality without it)');
  const bytes = new TextEncoder().encode(JSON.stringify(manifest)).length;
  if (bytes > MAX_MANIFEST_BYTES) throw new ActorManifestRejectedError(`${bytes} bytes > ${MAX_MANIFEST_BYTES} ceiling`);
  return { ok: true, manifest };
};

/**
 * Parse a manifest received inside an UNTRUSTED bundle (a peer's dwapp, or a
 * local app's `peerd.actor.json`). Coerce-and-check; returns null when absent or
 * unusable (the dwapp is then just a plain app, never an actor). Never throws.
 * @param {any} input @returns {ActorManifest | null}
 */
export const parseActorManifest = (input) => {
  if (input == null) return null;
  try { return validateActorManifest(input).manifest; }
  catch { return null; }
};

// The conventional filename a dwapp bundle uses to declare its actor. Read from
// the app's file set at create/install; absent → the app is not an actor.
export const ACTOR_MANIFEST_FILE = 'peerd.actor.json';

/**
 * Extract + parse the actor manifest from a dwapp's file map (filename → text).
 * The bundle is JSON text under ACTOR_MANIFEST_FILE. Returns null when the file
 * is absent or not usable — the safe default (a plain app). Never throws.
 * @param {Record<string, string> | null | undefined} files
 * @returns {ActorManifest | null}
 */
export const actorManifestFromFiles = (files) => {
  if (!files || typeof files !== 'object') return null;
  const raw = files[ACTOR_MANIFEST_FILE];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return parseActorManifest(parsed);
};
