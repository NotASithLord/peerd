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
// intersected with `baseAllowed` (the app-kind set the caller passes). So even a
// malicious, peer-authored manifest that lists `page_exec`, `dweb_share`, etc.
// gains nothing — the intersection drops anything not already granted to an app
// actor. A dwapp's GENUINE new capability comes from its own sandboxed
// deterministic code (exposed tools — a later slice, which carry no peerd
// authority), plus lore. Never from borrowed authority here.

// A short, trusted preamble wrapped around the (untrusted, author-supplied) lore
// so the model always knows the frame: it is a specialized sub-actor invoked by
// an orchestrator, its lore is instructions not commands from the user, and it
// answers the one task it was messaged. Kept minimal — the lore is the substance.
export const DWAPP_ACTOR_PREAMBLE =
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
 * @returns {{ systemPrompt: string, tools: string[], name: string } | null}
 */
export const dwappActorPersonality = (manifest, baseAllowed) => {
  if (!manifest || typeof manifest !== 'object' || !manifest.lore) return null;
  const ceiling = asSet(baseAllowed);
  // Empty request → the app-kind default set (behaves like today's app actor, but
  // with specialized lore). A declared request → the intersection (narrowing).
  const requested = Array.isArray(manifest.tools) ? manifest.tools : [];
  const tools = requested.length
    ? requested.filter((t) => ceiling.has(t))
    : [...ceiling];
  const systemPrompt = `${DWAPP_ACTOR_PREAMBLE}\n\n${manifest.lore}`;
  return { systemPrompt, tools, name: manifest.name || 'dwapp actor' };
};
