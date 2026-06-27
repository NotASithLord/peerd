// @ts-check
// open_tab — open a new browser tab, optionally pre-loaded with a URL.
//
// This is mutate_external in spirit (it changes user-visible browser
// state), so it's gated: Plan refuses it (clicks/new tabs aren't pure
// reads — pure URL loads via navigate/open_tab are the lone Plan
// exception, see docs/DECISIONS.md #16), and Act can route it through a
// confirmation prompt per the denylist + confirmActions policy.

import { originOfUrl } from './dom-helpers.js';

/**
 * A browser tab as surfaced by browser.tabs.create.
 * @typedef {Object} BrowserTab
 * @property {number} [id]
 * @property {string} [url]
 * @property {string} [pendingUrl]
 */

/**
 * Options accepted by browser.tabs.create (subset this tool sets).
 * @typedef {Object} CreateOpts
 * @property {boolean} active
 * @property {number} [windowId]
 * @property {string} [url]
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const openTabTool = {
  name: 'open_tab',
  primitive: 'tab',
  description: [
    'Open a new browser tab. Pass url to pre-load it; omit for a blank',
    'new tab. The tab opens in the BACKGROUND and a "go there" card appears in',
    'the chat — peerd never yanks the user to a new tab; they click to go.',
    "Returns the new tab id. To have the web actor work this tab, message_actor",
    "with to:'<that tabId>' — do NOT combine open_tab with to:'web', which opens its",
    "OWN tab. For a fresh web task, skip open_tab and just message_actor to:'web'",
    'with the goal (it opens a tab itself only if it decides to render).',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Optional absolute URL to load. Must include scheme.',
      },
    },
  },
  sideEffect: 'mutate_external',
  origins: (args) => {
    const dest = originOfUrl(args?.url);
    return dest ? [dest] : [];
  },

  execute: async (args, ctx) => {
    // why background, always: a tab peerd opens no longer steals the user away
    // (DESIGN-12, owner 2026-06-18). It opens quietly and ctx.announceTab drops a
    // "go there" card in the chat — the user's click focuses it AND opens the side
    // panel (the click is the only gesture Chrome lets us open the panel in).
    // Co-locate with the tab the agent is working in: a new tab opens in the
    // active tab's window, not a random last-focused one. No-op for normal use
    // (active tab is already in the current window); it keeps eval/headless tabs
    // together in their own window instead of leaking into the user's.
    /** @type {CreateOpts} */
    const opts = { active: false };
    // why: activeTab.windowId is not on the ActiveTab contract slot; read it
    // off a narrowed view so we can co-locate the new tab with the agent's.
    const activeWindowId = /** @type {{ windowId?: number }} */ (ctx.activeTab ?? {}).windowId;
    if (activeWindowId != null) opts.windowId = activeWindowId;
    if (args?.url) {
      try {
        const u = new URL(args.url);
        if (!u.protocol.startsWith('http')) {
          return { ok: false, error: `unsupported_scheme: ${u.protocol}` };
        }
        opts.url = u.toString();
      } catch {
        return { ok: false, error: `invalid_url: ${args.url}` };
      }
    }
    // why: ctx.tabs is the opaque `Object` contract slot; narrow to create().
    const tabsApi = /** @type {{ create: (opts: CreateOpts) => Promise<BrowserTab> }} */ (ctx.tabs);
    // why: noteTab / hintPullIn are optional SW-injected context extras not on
    // the ToolContext contract slot.
    const ctxExtras = /** @type {{ noteTab?: (id: number | undefined, label?: string) => Promise<unknown>, hintPullIn?: (id: number | undefined, url: string) => unknown }} */ (ctx);
    /** @type {BrowserTab} */
    let tab;
    try { tab = await tabsApi.create(opts); }
    catch (e) {
      return { ok: false, error: `tabs_create_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}` };
    }
    try { await ctxExtras.noteTab?.(tab.id, opts.url || 'a new tab'); }
    catch (e) { console.debug('[open_tab] noteTab failed', e); }
    // why: a peerd-opened web page can't carry the pull-in button, so it gets the
    // informational reminder instead (the SW injects it once the tab is visible).
    // Only for real URL opens — a blank new tab has nothing to orient toward.
    if (opts.url) { try { ctxExtras.hintPullIn?.(tab.id, opts.url); } catch (e) { console.debug('[open_tab] hintPullIn failed', e); } }
    return {
      ok: true,
      content: JSON.stringify({
        tabId: tab.id,
        url: tab.url || tab.pendingUrl || args?.url || '',
      }, null, 2),
    };
  },
};
