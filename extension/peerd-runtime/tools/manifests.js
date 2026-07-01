// @ts-check
// Per-session tool exposure manifests (ROADMAP "Tool exposure manifests
// per session").
//
// Registration stays GLOBAL (the SW registers every tool once); a session
// may opt into a NARROW exposed set via `session.toolManifest`:
//
//     { preset?: string, allow?: string[] }
//
// Absent = everything exposed — exactly today's behavior, so existing
// sessions are untouched. A manifest only ever NARROWS: it intersects
// with the main-agent hidden-tool rule (exposure.js) and with subagent
// tool narrowing (subagent/spawn.js); it can never re-expose a tool one
// of those layers removed.
//
// Enforced at BOTH layers, same pattern as the runner-only split:
//   1. descriptors — the SW intersects the main turn's descriptor list
//      with the manifest, so the model never SEES an excluded tool;
//   2. dispatch — the exposure gate (gates.js) refuses an excluded tool
//      BY NAME via ctx.toolAllow, so a hallucinated/injected call still
//      fails closed, with the refusal reason in the lineage.
//
// Pure module — data + value-in/value-out helpers only. Bun-testable.

/** @typedef {{ preset?: string, allow?: string[] }} ToolManifest */

// Named presets — DATA, deliberately literal so editing a preset is a
// one-line diff. Names must match registered tool names exactly; the
// in-browser suite checks every entry against the real registry, and the
// bun suite checks the runner-internals invariant below, so drift fails CI.
//
// INVARIANT (web actor): a preset that grants message_actor must also
// carry the web actor's DOM toolset (snapshot/read_page/click/type/...),
// because the web actor INHERITS the owner chat's toolManifest (spawn.js).
// Omit those and the actor is minted tool-less and can't drive its tab.
// The DOM tools stay hidden from the MAIN agent regardless (exposure.js
// filters first); listing them here only lets the ACTOR keep them.
export const TOOL_MANIFEST_PRESETS = Object.freeze({
  research: Object.freeze({
    description: 'web reads + search, page browsing (message a tab\'s actor), memory, introspection — no VM/JS/App, no file edits, no spawning',
    allow: Object.freeze([
      // web surface: fetch_url (the web actor's sessionless fetch) + capture.
      // web_search/call_api/read_article/submit_form were all removed — the web
      // actor searches by navigating to an engine + reading results, and reads via
      // fetch_url or its drive-a-tab DOM tools.
      'fetch_url', 'capture',
      // the main agent's browser surface: enumerate actors (instances/tabs/
      // integrations) + open a tab + message a tab's web actor to read or act.
      'actor_list', 'open_tab', 'message_actor',
      // page DOM toolset (inherited by the web actor, which DOES the page work —
      // see invariant above)
      'snapshot', 'read_page', 'read_state', 'watch_changes',
      'click', 'type', 'navigate', 'query_dom', 'page_keys', 'read_pdf', 'view',
      // memory
      'remember', 'read_memory',
      // sovereignty / sessions introspection
      'inspect_storage', 'inspect_audit_log', 'inspect_denylist',
      'inspect_provider_config', 'inspect_session_access',
      // temporal grounding
      'now', 'wait_until',
    ]),
  }),
  'browse-only': Object.freeze({
    description: 'passive browsing — read-only page access via a tab\'s actor, navigation, web reads; no page actions, no memory, no execution',
    allow: Object.freeze([
      // enumerate actors + open + message a tab's actor; the actor is held
      // READ-ONLY by this manifest (only the READ DOM tools below are allowed, so
      // it can observe but not click/type — the manifest constrains the actor too).
      'actor_list', 'open_tab', 'navigate', 'message_actor',
      // read-only DOM subset (observe, never mutate) — inherited by the web actor.
      'snapshot', 'read_page', 'read_state', 'query_dom', 'read_pdf', 'view',
      // web reads: fetch_url (the web actor's sessionless fetch)
      'fetch_url',
      // temporal grounding (reads)
      'now',
    ]),
  }),
});

/**
 * Normalize an untrusted manifest value into the canonical shape, or
 * null for "no manifest" (full exposure). Garbage-but-present input
 * (`{}`, wrong types) normalizes to an EMPTY manifest `{ allow: [] }`
 * rather than null — fail-closed: a corrupted record narrows to nothing,
 * it never silently widens back to everything.
 *
 * @param {unknown} input
 * @returns {ToolManifest | null}
 */
export const normalizeToolManifest = (input) => {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return { allow: [] };
  const rawPreset = /** @type {any} */ (input).preset;
  const rawAllow = /** @type {any} */ (input).allow;
  const preset = (typeof rawPreset === 'string' && rawPreset.trim().length > 0)
    ? rawPreset.trim()
    : undefined;
  const allow = Array.isArray(rawAllow)
    ? rawAllow.filter((n) => typeof n === 'string' && n.length > 0)
    : undefined;
  if (preset === undefined && allow === undefined) return { allow: [] };
  return {
    ...(preset !== undefined ? { preset } : {}),
    ...(allow !== undefined ? { allow } : {}),
  };
};

/**
 * Resolve a manifest to its effective allow-set.
 *
 *   null/absent          → null  (no manifest — everything stays exposed)
 *   { preset }           → the preset's tool names
 *   { allow }            → exactly those names
 *   { preset, allow }    → union (allow EXTENDS a preset, additive only)
 *   unknown preset       → contributes NOTHING (fail-closed: a stale or
 *                          corrupted preset name narrows to the explicit
 *                          allow list — possibly the empty set — never
 *                          back to the full registry)
 *
 * @param {unknown} toolManifest
 * @returns {Set<string> | null}
 */
export const resolveManifestAllow = (toolManifest) => {
  const manifest = normalizeToolManifest(toolManifest);
  if (!manifest) return null;
  /** @type {Set<string>} */
  const names = new Set();
  if (manifest.preset !== undefined) {
    // why: manifest.preset is an untrusted string; an unknown name yields
    // undefined (the fail-closed path documented above), so the index is
    // safe to widen here.
    const preset = /** @type {Record<string, { allow: readonly string[] }>} */ (TOOL_MANIFEST_PRESETS)[manifest.preset];
    if (preset) for (const n of preset.allow) names.add(n);
  }
  if (manifest.allow) for (const n of manifest.allow) names.add(n);
  return names;
};

/**
 * Short human label for the active manifest — UI chips + the exposure
 * gate's refusal reason. null when no manifest is set ("full").
 *
 * @param {unknown} toolManifest
 * @returns {string | null}
 */
export const manifestLabel = (toolManifest) => {
  const manifest = normalizeToolManifest(toolManifest);
  if (!manifest) return null;
  if (manifest.preset !== undefined) {
    const extra = manifest.allow?.length ? ` +${manifest.allow.length}` : '';
    return `${manifest.preset}${extra}`;
  }
  const n = manifest.allow?.length ?? 0;
  return `custom (${n} tool${n === 1 ? '' : 's'})`;
};

/**
 * Intersect a tool descriptor list with a resolved allow-set. A null
 * allow-set (no manifest) passes the list through unchanged — composes
 * after mainAgentDescriptors() in the SW's main-turn pipeline.
 *
 * @template {{ name: string }} T
 * @param {ReadonlyArray<T>} descriptors
 * @param {Set<string> | null} allow
 * @returns {T[]}
 */
export const filterDescriptorsByManifest = (descriptors, allow) =>
  (allow instanceof Set
    ? descriptors.filter((t) => allow.has(t.name))
    : [...descriptors]);
