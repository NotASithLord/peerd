// @ts-check
// Command sources — aggregation + the feature-07 (skills) adapter.
//
// A "command source" is anything that can supply `/commands`. V1 ships
// one source: the local `.peerd/commands/` store (command-store.js).
// Feature 07 (skills) is being built in parallel; skills can EXPOSE
// commands, and the integration contract is deliberately thin:
//
//     commandSources.list() → Promise<Array<{ name, body, description? }>>
//
// This file defines that contract and a combinator. The integrator wires
// 07's skill registry in by passing an extra source whose list() reads
// the registry. Until then, the local store works standalone — the
// slash-parser / @-resolver / palette do not depend on 07 at all.

/**
 * @typedef {Object} CommandSource
 * @property {() => Promise<Array<{ name: string, body: string, description?: string }>>} list
 */

/**
 * Wrap the local command store as a CommandSource.
 * @param {{ list: () => Promise<any[]> }} store   from createCommandStore
 * @returns {CommandSource}
 */
export const localStoreSource = (store) => ({
  list: async () => (await store.list()).map((r) => ({
    name: r.name, body: r.body, description: r.description ?? '',
  })),
});

/**
 * Adapter for feature-07's skill registry. A skill exposes zero or more
 * commands; we surface each as `/<command-name>`. The registry shape is
 * 07's to define — we depend only on a `listCommands()` that returns
 * `{ name, body, description? }`. If 07 lands a different method name,
 * change the one call here; nothing else in feature-04 moves.
 *
 * @param {{ listCommands?: () => Promise<any[]> } | null | undefined} skillRegistry
 * @returns {CommandSource}
 */
export const skillRegistrySource = (skillRegistry) => ({
  list: async () => {
    if (!skillRegistry?.listCommands) return [];
    const cmds = await skillRegistry.listCommands();
    return (cmds ?? []).map((c) => ({
      name: c.name,
      body: c.body,
      description: c.description ?? 'from a skill',
    }));
  },
});

/**
 * Merge multiple sources into one. Earlier sources WIN on name collision
 * (local store overrides a skill-provided command of the same name), so
 * a user can always shadow a skill command by authoring their own. The
 * merged list is name-sorted and deduped.
 *
 * @param {CommandSource[]} sources
 * @returns {CommandSource}
 */
export const mergeSources = (sources) => ({
  list: async () => {
    /** @type {Map<string, { name: string, body: string, description?: string }>} */
    const seen = new Map();
    for (const src of sources) {
      /** @type {Array<{ name: string, body: string, description?: string }>} */
      let items = [];
      // why: one failing source (e.g. 07 not yet wired) must not blank the
      // whole palette — degrade to the sources that do work.
      try { items = await src.list(); } catch { items = []; }
      for (const it of items) {
        if (it && typeof it.name === 'string' && !seen.has(it.name)) {
          seen.set(it.name, it);
        }
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  },
});
