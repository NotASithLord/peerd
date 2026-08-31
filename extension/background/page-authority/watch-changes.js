// watch_changes: start/poll a persistent DOM-mutation watcher on a tab.
//
// The per-action `result` (in click/type) captures a ~400ms window around
// ONE action. This is the continuous variant: a MutationObserver that
// lives in the page and accumulates a rolling delta log, so the agent can
// catch ASYNC changes that land AFTER the action window: slow results,
// websocket / live updates, notifications, lazy loads: that a snapshot or
// the per-action result would miss. (DOM nav Phase 2 streaming.)
//
// Injected via chrome.scripting (ISOLATED world: MutationObserver sees the
// shared DOM) so it carries NO debugger banner during continuous watching.
// Opt-in per tab and time-scoped (resets on navigation), per the perf
// constraint: never a firehose on a tab the agent isn't watching.

import {
  originOfUrl,
  resolveTargetTab,
  scriptingTarget,
  summarizeMutations,
  wrapUntrusted,
} from '/peerd-runtime/browser-authority.js';

/** @type {Readonly<{execute:(args:any,ctx:any)=>Promise<any>}>} */
export const watchChangesTool = Object.freeze({

  execute: async (args, ctx) => {
    const tab = await resolveTargetTab(args, ctx);
    if (!tab?.id) return { ok: false, error: 'no_target_tab' };
    let res;
    try {
      const out = await ctx.scripting.executeScript({ target: scriptingTarget(tab), func: watchInjected });
      res = out?.[0]?.result;
    } catch (e) {
      return { ok: false, error: `watch_inject_failed: ${e?.message ?? String(e)}` };
    }
    if (!res) return { ok: false, error: 'watch_returned_nothing' };
    const body = res.started
      ? 'watching started: baseline set. Call watch_changes again to see what changed since now.'
      : `changes since last look: ${summarizeMutations(res.changes) ?? 'no DOM change detected'}`;
    return {
      ok: true,
      content: wrapUntrusted({ origin: originOfUrl(tab.url), tool: 'watch_changes', body }),
    };
  },
});

// Runs in the page (ISOLATED world). Idempotent: creates the observer +
// rolling delta sets on first call (stored on a window global so they
// survive across injections), drains + clears on every call. Navigation
// tears down the page → the global is gone → next call re-baselines.
function watchInjected() {
  'use strict';
  function desc(n) {
    var t = n.tagName ? n.tagName.toLowerCase() : '';
    var role = n.getAttribute && n.getAttribute('role');
    var label = (n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('placeholder')))
      || ((n.innerText || '').trim().slice(0, 40));
    return (role || t) + (label ? ' "' + label + '"' : '');
  }
  if (window.__peerd_watch) {
    return { started: false, changes: window.__peerd_watch.drain() };
  }
  var added = new Set(), removed = new Set(), attr = new Set();
  var obs = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'childList') {
        m.addedNodes.forEach(function (n) { if (n.nodeType === 1) added.add(desc(n)); });
        m.removedNodes.forEach(function (n) { if (n.nodeType === 1) removed.add(desc(n)); });
      } else if (m.type === 'attributes') {
        attr.add(desc(m.target) + ' @' + m.attributeName);
      }
    }
  });
  obs.observe(document.body, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['aria-expanded', 'aria-checked', 'aria-disabled', 'disabled', 'value', 'class', 'hidden', 'aria-hidden', 'aria-selected'],
  });
  window.__peerd_watch = {
    obs: obs,
    drain: function () {
      var r = {
        added: Array.from(added).slice(0, 12),
        removed: Array.from(removed).slice(0, 12),
        attr: Array.from(attr).slice(0, 12),
        counts: { added: added.size, removed: removed.size, attr: attr.size },
      };
      added.clear(); removed.clear(); attr.clear();
      return r;
    },
  };
  return { started: true, changes: { added: [], removed: [], attr: [], counts: { added: 0, removed: 0, attr: 0 } } };
}
