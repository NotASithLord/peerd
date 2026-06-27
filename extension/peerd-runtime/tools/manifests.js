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
// INVARIANT (do/get/check): those tools dispatch to a browser-runner
// child whose toolset INTERSECTS this manifest (spawn.js). A preset that
// grants `do` must therefore also carry the runner's DO_TOOLSET, and one
// that grants get/check the READ_TOOLSET (runner/index.js) — otherwise
// the runner spawns tool-less and every do/get/check call dies. The
// runner internals stay hidden from the MAIN agent regardless
// (exposure.js filters first); listing them here only lets the RUNNER
// keep them.
export const TOOL_MANIFEST_PRESETS = Object.freeze({
  research: Object.freeze({
    description: 'web reads + search, page browsing (message a tab\'s resident), memory, introspection — no VM/JS/App, no file edits, no spawning',
    allow: Object.freeze([
      // web surface: fetch_url (the web resident's sessionless fetch) + capture.
      // web_search/call_api/read_article/submit_form were all removed — the web
      // actor searches by navigating to an engine + reading results, and reads via
      // fetch_url or its drive-a-tab DOM tools.
      'fetch_url', 'capture',
      // the main agent's browser surface: open/enumerate tabs + message a tab's
      // web resident to read or act (do/get/check are folded into the resident).
      'list_tabs', 'open_tab', 'message_resident',
      // do/get/check stay for SUBAGENTS (they can't message residents); the main
      // agent has them folded into the tab's resident by the cutover.
      'do', 'get', 'check',
      // page DOM toolset (inherited by the web resident, which DOES the page work):
      // DO_TOOLSET ∪ READ_TOOLSET (see invariant above)
      'snapshot', 'read_page', 'read_state', 'watch_changes',
      'click', 'type', 'navigate', 'query_dom', 'page_keys', 'read_pdf',
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
    description: 'passive browsing — read-only page access via a tab\'s resident, navigation, web reads; no page actions, no memory, no execution',
    allow: Object.freeze([
      // open/enumerate + message a tab's resident; the resident is held READ-ONLY
      // by this manifest (only the READ DOM tools below are allowed, so it can
      // observe but not click/type — the manifest constrains the resident too).
      'list_tabs', 'open_tab', 'navigate', 'message_resident',
      'get', 'check',   // subagent read path (the main agent reads via the resident)
      // READ_TOOLSET only (observe, never mutate) — inherited by the web resident.
      'snapshot', 'read_page', 'read_state', 'query_dom', 'read_pdf',
      // web reads: fetch_url (the web resident's sessionless fetch)
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
