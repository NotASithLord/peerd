// @ts-check
// actor_list — the ONE discovery surface for everything you can message_actor.
//
// DESIGN-17/18 unified addressing into a single arg (message_actor `to`): a
// vm/notebook/app instance id, an open tab's id, an API integration's origin.
// This tool is the matching half — one enumeration of every addressable actor
// with a `type` discriminator, instead of five separate list calls
// (vm_list / js_list / app_list / list_tabs / list_integrations). One tool
// descriptor, one result blob: fewer turns and less context for the
// orchestrator, and a new actor type is just a new `type` value here.
//
// Each row is { type, handle, name, live, current, detail } — a UNIFORM shape so
// the columnar serializer densifies it (the context win). `handle` is exactly
// what you pass to message_actor's `to`. Sources fail SOFT and independently: a
// missing registry drops its rows and notes the gap, it never blanks the list.
//
// Scoping mirrors the tools it replaces: WebVMs/Notebooks/Apps are session-
// scoped (this chat's instances + which one is current), open tabs are global
// (denylisted tabs dropped — the same enumeration-leak fence as the old
// list_tabs), API integrations are the chat's formed ∪ keyed set.

import { originOfUrl, isDenylistedTab } from './dom-helpers.js';
import { serializeListResult } from './columnar.js';
import { escapeAttr } from '/shared/util.js';

/** @param {string} s @param {number} n @returns {string} */
const truncate = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

// A tab's `name` is the page-controlled document.title — UNTRUSTED. Harden it the
// same way the message_actor reply lead does (actor-messaging.js deliver): collapse
// whitespace (kill the newline vector), then escapeAttr (no surviving angle bracket
// → no forged fence/close tag laundered into the orchestrator's trusted context).
// why: this list is a TRUSTED tool result, not fenced — an un-sanitized title is
// the same injection source deliver and the web-actor naming already neutralize.
/** @param {string | undefined} title @returns {string} */
const safeTitle = (title) => escapeAttr(truncate((title || '').replace(/\s+/g, ' ').trim(), 60));

/**
 * One addressable actor, in the uniform shape every row shares.
 * @typedef {Object} ActorRow
 * @property {'webvm'|'notebook'|'app'|'tab'|'integration'} type
 * @property {string|number} handle   what to pass to message_actor `to`
 * @property {string} name            human label
 * @property {boolean} live           warm right now (instance has a tab / tab open / integration worked this chat)
 * @property {boolean} current        this chat's default of its type (instance default / active tab)
 * @property {string} detail          compact type-specific note (tab origin, integration keyed-ness, app tags, pinned)
 */

/**
 * A registry snapshot + its tab tracker, for one engine kind.
 * @typedef {Object} EngineSource
 * @property {'webvm'|'notebook'|'app'} type
 * @property {{ snapshot: (opts: { sessionId?: string }) => Promise<{ [k: string]: any, currentId?: string, currentVmId?: string }> } | undefined} registry
 * @property {{ getTabId: (id: string) => number | null | undefined } | undefined} tracker
 * @property {string} listKey         the array field in the snapshot (vms/notebooks/apps)
 * @property {string} currentKey      the snapshot field naming this chat's current instance id
 */

/**
 * Map one engine kind's snapshot into uniform rows. Pure. Returns [] when the
 * registry is unwired (e.g. a non-SW/test ctx) so the kind simply contributes
 * nothing rather than failing the whole call.
 * @param {EngineSource} src @param {string|undefined} sessionId @returns {Promise<ActorRow[]>}
 */
const engineRows = async (src, sessionId) => {
  if (!src.registry) return [];
  const snap = await src.registry.snapshot({ sessionId });
  const currentId = /** @type {Record<string, any>} */ (snap)[src.currentKey];
  const records = /** @type {Array<Record<string, any>>} */ (snap[src.listKey] ?? []);
  return records.map((r) => ({
    type: src.type,
    handle: r.id,
    name: r.name ?? r.id,
    live: src.tracker?.getTabId(r.id) != null,
    current: r.id === currentId,
    // detail: the one extra signal worth a column for this kind — tags for an
    // App, a pinned marker for VMs/Notebooks (otherwise empty so the column
    // stays cheap).
    detail: src.type === 'app'
      ? (Array.isArray(r.tags) ? r.tags.join(', ') : '')
      : (r.pinned ? 'pinned' : ''),
  }));
};

/** @type {import('/shared/tool-types.js').Tool} */
export const actorListTool = {
  name: 'actor_list',
  primitive: 'subagent',
  description: [
    'Enumerate EVERY actor you can address with message_actor, in one call.',
    'Returns a row per actor with: type (webvm | notebook | app | tab |',
    'integration), handle (pass it as message_actor `to`), name, live (has a',
    'warm tab / open page right now), current (this chat\'s default of that',
    'type — what an instance op defaults to), and detail (a tab\'s origin, an',
    'integration\'s keyed-ness, an app\'s tags). Use it to decide whether to',
    'reuse an existing instance/tab or spawn fresh, and to find the handle to',
    'message. (The general "web" actor is always addressable as to:"web" and',
    'is not listed here. App full-text search is app_search.)',
  ].join(' '),
  schema: { type: 'object', properties: {} },
  sideEffect: 'read',
  origins: () => [],

  execute: async (_args, ctx) => {
    // why: the engine registries / tab trackers / integration list ride the
    // opaque SW-injected ctx (not on the base ToolContext typedef); narrow each
    // to the surface this tool reads.
    const c = /** @type {{
     *   vmRegistry?: any, vmTabTracker?: any,
     *   jsRegistry?: any, jsTabTracker?: any,
     *   appRegistry?: any, appTabTracker?: any,
     *   tabs?: { query: (q: Record<string, unknown>) => Promise<Array<Record<string, any>>> },
     *   listApiIntegrations?: () => Promise<Array<{ origin: string, keyed: boolean, formed: boolean }>>,
     *   denylist?: string[],
     *   session?: { sessionId?: string },
     * }} */ (/** @type {unknown} */ (ctx));
    const sessionId = c.session?.sessionId;

    /** @type {ActorRow[]} */
    const actors = [];
    /** @type {string[]} */
    const unavailable = [];   // sources that threw — surfaced, never silently dropped
    let denylistedTabsHidden = 0;

    /** @type {EngineSource[]} */
    const engines = [
      { type: 'webvm', registry: c.vmRegistry, tracker: c.vmTabTracker, listKey: 'vms', currentKey: 'currentVmId' },
      { type: 'notebook', registry: c.jsRegistry, tracker: c.jsTabTracker, listKey: 'notebooks', currentKey: 'currentId' },
      { type: 'app', registry: c.appRegistry, tracker: c.appTabTracker, listKey: 'apps', currentKey: 'currentId' },
    ];
    for (const src of engines) {
      try { actors.push(...await engineRows(src, sessionId)); }
      catch (e) { unavailable.push(`${src.type}: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`); }
    }

    // Open tabs — GLOBAL (not session-scoped), denylisted tabs dropped entirely.
    // why: leaking a denylisted tab's id/origin would hand a prompt-injected
    // agent the exact handle to drive a bank/email tab via message_actor; the
    // agent can't target what it can't enumerate (same fence as the old
    // list_tabs; resolveTargetTab refuses them too).
    if (c.tabs?.query) {
      try {
        const all = await c.tabs.query({});
        const denylist = c.denylist ?? [];
        for (const t of all) {
          if (isDenylistedTab(t.url, denylist)) { denylistedTabsHidden++; continue; }
          actors.push({
            type: 'tab',
            handle: t.id,
            name: safeTitle(t.title),
            live: true,                 // it's an open tab by construction
            current: !!t.active,
            detail: originOfUrl(t.url),
          });
        }
      } catch (e) { unavailable.push(`tab: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`); }
    }

    // API integrations — the chat's formed ∪ keyed origins. Optional capability
    // (absent in tests / non-SW dispatch) → simply contributes no rows.
    if (typeof c.listApiIntegrations === 'function') {
      try {
        const integrations = await c.listApiIntegrations();
        for (const i of integrations) {
          actors.push({
            type: 'integration',
            handle: i.origin,
            name: i.origin,
            live: !!i.formed,           // worked this chat == warm
            current: false,             // integrations have no "current" default
            detail: i.keyed ? 'keyed' : 'unkeyed',
          });
        }
      } catch (e) { unavailable.push(`integration: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`); }
    }

    // Group by type for an at-a-glance read; current-first within a type. Stable
    // otherwise (registry/query order preserved).
    const TYPE_ORDER = { webvm: 0, notebook: 1, app: 2, tab: 3, integration: 4 };
    actors.sort((a, b) => {
      const byType = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
      if (byType !== 0) return byType;
      return (b.current ? 1 : 0) - (a.current ? 1 : 0);
    });

    return {
      ok: true,
      content: serializeListResult({
        count: actors.length,
        // Tell the agent SOMETHING was withheld so it doesn't loop hunting for a
        // tab it can see in the browser but not here.
        ...(denylistedTabsHidden > 0 ? { denylisted_tabs_hidden: denylistedTabsHidden } : {}),
        ...(unavailable.length > 0 ? { unavailable } : {}),
        actors,
      }, 'actors'),
    };
  },
};
