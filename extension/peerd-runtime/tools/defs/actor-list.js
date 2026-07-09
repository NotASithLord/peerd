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

// A dwapp actor's specialty line for the `detail` column — its description +
// skills, so the orchestrator can route to it. record.actor is UNTRUSTED (a
// traded dwapp's manifest is author-controlled), and this list is a TRUSTED,
// non-fenced tool result — so EVERY field is run through safeTitle (escapeAttr +
// whitespace-collapse + clamp), same as a page-controlled tab title.
// why the " · " marker (middot, not comma): a plain app's detail is its tags
// joined with ", ", so "actor · …" is a signal a tag list can NEVER produce —
// the actor-graph model keys off exactly this prefix to flag a dwapp actor
// without a false positive from an app that happens to be tagged "actor".
/** @param {any} a @returns {string} */
const actorDetail = (a) => {
  const rest = [];
  const desc = safeTitle(a?.description);
  if (desc) rest.push(desc);
  const skills = Array.isArray(a?.skills)
    ? a.skills.map((/** @type {any} */ s) => s?.name).filter(Boolean).slice(0, 4).join(', ')
    : '';
  if (skills) rest.push(`skills: ${safeTitle(skills)}`);
  return `actor · ${rest.length ? rest.join(' · ') : 'specialized'}`;
};

/**
 * One addressable actor, in the uniform shape every row shares.
 * @typedef {Object} ActorRow
 * @property {'webvm'|'notebook'|'app'|'tab'|'integration'} type
 * @property {string|number} handle   what to pass to message_actor `to`
 * @property {string} name            human label
 * @property {boolean} live           warm right now (instance has a tab / tab open / integration worked this chat)
 * @property {boolean} current        this chat's default of its type (instance default / active tab)
 * @property {string} detail          compact type-specific note (tab origin, integration keyed-ness, app tags, pinned, or a dwapp actor's specialty — its detail begins "actor · …")
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
  return records.map((r) => {
    // A dwapp actor: an App whose bundle declared a peerd.actor.json (app-client
    // stores it as record.actor). Surface its specialty so delegation isn't blind.
    const dwapp = src.type === 'app' && r.actor && typeof r.actor === 'object' ? r.actor : null;
    return {
      type: src.type,
      // Names are user/peer-controlled → sanitize like a tab title (untrusted in
      // this trusted, non-fenced result). A dwapp actor prefers its manifest name.
      handle: r.id,
      name: safeTitle((dwapp && typeof dwapp.name === 'string' && dwapp.name) || r.name || r.id),
      live: src.tracker?.getTabId(r.id) != null,
      current: r.id === currentId,
      // detail: a dwapp actor's specialty (description + skills); else the one
      // extra signal worth a column — tags for an App, a pinned marker otherwise.
      detail: dwapp
        ? actorDetail(dwapp)
        : src.type === 'app'
          ? (Array.isArray(r.tags) ? safeTitle(r.tags.join(', ')) : '')
          : (r.pinned ? 'pinned' : ''),
    };
  });
};

/** @type {import('/shared/tool-types.js').Tool} */
export const actorListTool = {
  name: 'actor_list',
  primitive: 'spawned',
  description: [
    'Enumerate EVERY actor you can address with message_actor, in one call.',
    'Returns a row per actor with: type (webvm | notebook | app | tab |',
    'integration), handle (pass it as message_actor `to`), name, live (has a',
    'warm tab / open page right now), current (this chat\'s default of that',
    'type — what an instance op defaults to), and detail (a tab\'s origin, an',
    'integration\'s keyed-ness, an app\'s tags). An app whose detail begins "actor ·"',
    'is a SPECIALIZED dwapp actor — the rest of its detail names the capability it',
    'provides; prefer message_actor-ing it over doing that work yourself. Use this list to decide',
    'whether to reuse an existing instance/tab or spawn fresh, and to find the',
    'handle to message. (The general "web" actor is always addressable as to:"web" and',
    'is not listed here; likewise the mesh operator, when enabled, is always',
    'addressable as to:"dweb". App full-text search is app_search.)',
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
