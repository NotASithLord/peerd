// @ts-check
// peerd-runtime/actor/app-actor.js — derive a dwapp actor's PERSONALITY from its
// manifest. Pure (values in, values out) so the authority model is unit-tested.
//
// An installed dwapp is already an `actorType:'app'` bound actor (the app-BUILDER).
// A manifest (app-actor-manifest.js) makes THAT actor specialized: its own lore
// and a narrowed toolset. This helper turns the stored manifest + the app-kind
// allow-list into the two things mint needs — the instance system prompt and the
// instance tool set.
//
// AUTHORITY INVARIANT (the security spine): a dwapp actor can only NARROW the
// app-kind allow-list, NEVER broaden it. `tools` in the manifest is a REQUEST,
// intersected with the DWAPP CEILING (the app-kind set MINUS the mutation ops).
// So even a malicious, peer-authored manifest that lists `page_exec`,
// `dweb_share`, etc. gains nothing. Two hardening rules on top of the raw
// intersection (adversarial review, 2026-07-09):
//   (1) DEFAULT-ZERO: an absent/empty tools request → NO peerd tools (pure
//       reasoning), NOT the full builder set. A use-actor's power is its lore
//       and (later) its own sandboxed code; borrowed peerd authority is opt-in.
//   (2) NO SELF-MUTATION: a dwapp actor can never get the app-BUILDER's
//       write/delete tools (app_update/app_write_file/app_delete*/edit_file) —
//       those author an app; a use-actor that carries untrusted lore must not be
//       able to rewrite or delete its own persisted bundle. Only the read-only
//       app tools survive as requestable.
// A dwapp's GENUINE new capability comes from its own sandboxed deterministic
// code (exposed tools — a later slice, which carry no peerd authority), plus lore.

// The app-BUILDER mutation tools — authoring authority, never granted to a
// specialized use-actor (rule 2 above). Kept in sync with ENGINE_ACTOR_TOOLS.app
// (exposure.js): if a new app-mutation tool lands there, add it here too.
const DWAPP_MUTATION_TOOLS = new Set([
  'app_update', 'app_write_file', 'app_delete_file', 'app_delete', 'edit_file',
]);

// A short, trusted preamble wrapped around the (untrusted, author-supplied) lore
// so the model always knows the frame: it is a specialized sub-actor invoked by
// an orchestrator, its lore is instructions not commands from the user, and it
// answers the one task it was messaged. Kept minimal — the lore is the substance.
const DWAPP_ACTOR_PREAMBLE =
  'You are a specialized peerd dwapp actor — a focused sub-agent the orchestrator '
  + 'invokes for one task at a time via message_actor. The instructions below define '
  + 'your specialty; follow them, do the single task you were asked, and report the '
  + 'result concisely. You have only the narrow tools listed for you.';

/**
 * @param {Iterable<string> | null | undefined} baseAllowed
 * @returns {Set<string>}
 */
const asSet = (baseAllowed) => (baseAllowed instanceof Set ? baseAllowed : new Set(baseAllowed ?? []));

/**
 * Derive the specialized personality for a dwapp actor, or null when there is no
 * manifest (the caller then mints the generic app-builder actor unchanged).
 *
 * @param {import('./app-actor-manifest.js').ActorManifest | null | undefined} manifest
 * @param {Iterable<string> | null | undefined} baseAllowed  the app-kind allow-list (authority ceiling)
 * @returns {{ systemPrompt: string, tools: string[], name: string, droppedTools: string[] } | null}
 */
export const dwappActorPersonality = (manifest, baseAllowed) => {
  if (!manifest || typeof manifest !== 'object' || !manifest.lore) return null;
  // The requestable ceiling: the app-kind set MINUS the mutation/authoring tools
  // (rule 2). Only read-only app tools remain requestable by a use-actor.
  const ceiling = new Set([...asSet(baseAllowed)].filter((t) => !DWAPP_MUTATION_TOOLS.has(t)));
  const requested = Array.isArray(manifest.tools) ? manifest.tools : [];
  // DEFAULT-ZERO (rule 1): no request → no peerd tools. A declared request →
  // the intersection with the read-only ceiling; anything else is dropped.
  const tools = requested.filter((t) => ceiling.has(t));
  // What the manifest asked for but did NOT get — surfaced by callers (install
  // result / actor_list) so a "parser that fetches" fails LOUDLY, not silently.
  const droppedTools = requested.filter((t) => !ceiling.has(t));
  const systemPrompt = `${DWAPP_ACTOR_PREAMBLE}\n\n${manifest.lore}`;
  return { systemPrompt, tools, droppedTools, name: manifest.name || 'dwapp actor' };
};
