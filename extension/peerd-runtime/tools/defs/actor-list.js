// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// actor_list — the ONE discovery surface for everything you can message_actor.
//
// DESIGN-17/18 unified addressing into a single arg (message_actor `to`): a
// vm/notebook/pod/app instance id, an open tab's id, an API integration's origin.
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

import { originOfUrl } from '../../browser-authority/dom-helpers.js';
import { serializeListResult } from './columnar.js';
import { safeTitle } from '../prompt-wrap.js';

// A tab's `name` is the page-controlled document.title — UNTRUSTED, and this list
// is a TRUSTED tool result with no fence telling the model to treat it as data.
// `safeTitle` (tools/prompt-wrap.js) is the shared hardener: collapse whitespace,
// disarm, truncate, escape. It moved next to the other untrusted-text primitives
// because inspect's session_access hands over the SAME field and had drifted to a
// bare truncate — one definition, so the two surfaces cannot diverge again.

/**
 * One addressable actor, in the uniform shape every row shares.
 * @typedef {Object} ActorRow
 * @property {'webvm'|'notebook'|'pod'|'app'|'tab'|'integration'} type
 * @property {string|number} handle   what to pass to message_actor `to`
 * @property {string} name            human label
 * @property {boolean} live           warm right now (instance has a tab / tab open / integration worked this chat)
 * @property {boolean} current        this chat's default of its type (instance default / active tab)
 * @property {string} detail          compact type-specific note (tab origin, integration keyed-ness, app tags, pinned)
 */

/**
 * An authority-filtered registry snapshot for one engine kind.
 * @typedef {Object} EngineSource
 * @property {'webvm'|'notebook'|'pod'|'app'} type
 * @property {Array<Record<string, any>>} records
 * @property {string|null} currentId
 * @property {string[]} liveIds
 */

/**
 * Map one authority-filtered engine snapshot into uniform rows. Pure.
 * @param {EngineSource} src @returns {ActorRow[]}
 */
const engineRows = (src) => src.records.map((r) => ({
    type: src.type,
    handle: r.id,
    name: r.name ?? r.id,
    live: src.liveIds.includes(r.id),
    current: r.id === src.currentId,
    // detail: the one extra signal worth a column for this kind — tags for an
    // App, a pinned marker for VMs/Notebooks (otherwise empty so the column
    // stays cheap).
    detail: src.type === 'app'
      ? (Array.isArray(r.tags) ? r.tags.join(', ') : '')
      : src.type === 'pod' && r.persistent === false
        ? 'ephemeral · closing deletes files'
        : (r.pinned ? 'pinned' : ''),
  }));

/**
 * Shape one bounded authority roster for model and code consumers.
 * @param {{engines?:EngineSource[],tabs?:Array<Record<string,any>>,
 * integrations?:Array<{origin:string,keyed:boolean,formed:boolean}>,
 * restrictedTabsHidden?:number,unavailable?:string[],actorIsolation?:any}} roster
 */
export const shapeActorRoster = (roster = {}) => {
    /** @type {ActorRow[]} */
    const actors = [];
    const unavailable = Array.isArray(roster.unavailable) ? [...roster.unavailable] : [];
    const restrictedTabsHidden = Number(roster.restrictedTabsHidden) || 0;
    for (const src of roster.engines ?? []) actors.push(...engineRows(src));

    // Open tabs are already authority-filtered. Presentation and title
    // hardening remain semantic work in this controller-owned definition.
    // why: leaking a denylisted tab's id/origin would hand a prompt-injected
    // agent the exact handle to drive a bank/email tab via message_actor; the
    // agent can't target what it can't enumerate (same fence as the old
    // list_tabs; resolveTargetTab refuses them too).
    for (const t of roster.tabs ?? []) {
      actors.push({
        type: 'tab',
        handle: t.id,
        name: safeTitle(t.title),
        live: true,
        current: !!t.active,
        detail: originOfUrl(t.url),
      });
    }

    // API integrations — the chat's formed ∪ keyed origins. Optional capability
    // (absent in tests / non-SW dispatch) → simply contributes no rows.
    for (const i of roster.integrations ?? []) {
      actors.push({
        type: 'integration',
        handle: i.origin,
        name: i.origin,
        live: !!i.formed,
        current: false,
        detail: i.keyed ? 'keyed' : 'unkeyed',
      });
    }

    // Group by type for an at-a-glance read; current-first within a type. Stable
    // otherwise (registry/query order preserved).
    const TYPE_ORDER = { webvm: 0, notebook: 1, pod: 2, app: 3, tab: 4, integration: 5 };
    actors.sort((a, b) => {
      const byType = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
      if (byType !== 0) return byType;
      return (b.current ? 1 : 0) - (a.current ? 1 : 0);
    });

    const structured = {
      refs: actors.map((actor) => ({
        ref: String(actor.handle), type: actor.type, name: actor.name,
        live: actor.live, current: actor.current, detail: actor.detail,
      })),
      ...(restrictedTabsHidden > 0 ? { deniedCount: restrictedTabsHidden } : {}),
      ...(unavailable.length > 0 ? { unavailable: [...unavailable] } : {}),
    };
  return {
      ok: true,
      // why a second shape: actor_list's columnar content is optimized for a
      // language-model turn; code needs values it can filter/map without
      // scraping presentation text. The dispatcher preserves this host-only
      // field while the model loop continues to ingest only `content`.
      structured,
      content: serializeListResult({
        count: actors.length,
        actor_execution: roster.actorIsolation ?? {
          status: 'unsupported', host: null,
          reason: 'Actor isolation capability was not provided.', retryable: false,
        },
        // Tell the agent SOMETHING was withheld so it doesn't loop hunting for a
        // tab it can see in the browser but not here.
        ...(restrictedTabsHidden > 0 ? { restricted_tabs_hidden: restrictedTabsHidden } : {}),
        ...(unavailable.length > 0 ? { unavailable } : {}),
        actors,
      }, 'actors'),
  };
};

/** @type {import('/shared/tool-types.js').Tool} */
export const actorListTool = composeTool("actor_list", {
  execute: async (_args, ctx) => {
    // why: the controller receives one bounded, authority-filtered directory;
    // browser APIs and engine registries never cross the kernel boundary.
    const c = /** @type {{ actorDirectory?: { readRoster: () => Promise<any> } }} */ (
      /** @type {unknown} */ (ctx)
    );
    const roster = c.actorDirectory?.readRoster
      ? await c.actorDirectory.readRoster()
      : {};
    return shapeActorRoster(roster);
  },
});
