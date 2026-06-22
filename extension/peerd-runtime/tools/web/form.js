// @ts-check
// submit_form — fill fields and (optionally) submit. Always a tab.
//
// sideEffect: 'mutate_external' — submission talks to a backend the
// user has no other guardrail against. The confirmation gate fires;
// the user sees "Submit form on example.com?" before the click.
//
// V1 model: pass `{ tabId | url, fields: { selector: value }, submitSelector? }`.
//   - tabId  → fill in the existing tab (default to active when both missing)
//   - url    → open a fresh tab (visibility per settings), fill, submit
//              there; tab stays open afterward so the user can see the
//              response

import { sleep } from '/shared/util.js';
import { resolveTargetTab, originOfUrl } from '../defs/dom-helpers.js';
import { openWebTab, submitFormInTab, readTabContent } from './primitives.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const submitFormTool = {
  name: 'submit_form',
  primitive: 'tab',
  description: [
    'Fill form fields by CSS selector and optionally click a submit',
    'button. Operates on the active tab by default; pass `tabId` to',
    'target a specific tab, or `url` to open a fresh tab first.',
    'Confirmation required — the user sees what is about to be',
    'submitted.',
  ].join(' '),
  schema: {
    type: 'object',
    required: ['fields'],
    properties: {
      fields: {
        type: 'object',
        description: 'Map of CSS selector to string value.',
        additionalProperties: { type: 'string' },
      },
      submitSelector: {
        type: 'string',
        description: 'Optional: CSS selector for the submit button to click after fill.',
      },
      tabId: { type: 'integer', description: 'Target tab id; defaults to active.' },
      url:   { type: 'string',  description: 'If provided, opens a fresh inactive tab first.' },
    },
  },
  sideEffect: 'mutate_external',
  origins: (args, ctx) => {
    const out = [];
    if (args?.url) {
      const o = originOfUrl(args.url);
      if (o) out.push(o);
    }
    if (ctx?.activeTab?.origin) out.push(ctx.activeTab.origin);
    return [...new Set(out)];
  },
  execute: async (args, ctx) => {
    if (!args?.fields || typeof args.fields !== 'object') {
      return { ok: false, error: 'fields_required' };
    }
    if (Object.keys(args.fields).length === 0) {
      return { ok: false, error: 'fields_empty' };
    }

    let tabId = null;
    try {
      if (typeof args.url === 'string' && args.url) {
        let parsed;
        try { parsed = new URL(args.url); }
        catch { return { ok: false, error: `invalid_url: ${args.url}` }; }
        if (!/^https?:$/.test(parsed.protocol)) {
          return { ok: false, error: `unsupported_scheme: ${parsed.protocol}` };
        }
        const opened = await openWebTab(args.url, ctx);
        tabId = opened.tabId;
      } else {
        const tab = await resolveTargetTab(args, ctx);
        if (!tab?.id) return { ok: false, error: 'no_target_tab' };
        tabId = tab.id;
      }

      const report = await submitFormInTab(
        tabId,
        args.fields,
        args.submitSelector ?? null,
        ctx,
      );

      // If a submit was performed, give the page a brief moment then
      // re-read to capture the new state. We deliberately don't wait
      // for full load — many sites are SPAs and won't change url.
      let postSubmit = null;
      if (report.submitted) {
        await sleep(750);
        try { postSubmit = await readTabContent(tabId, ctx); }
        catch { postSubmit = null; }
      }

      return {
        ok: true,
        content: JSON.stringify({
          tabId,
          fields: report.fields,
          submitted: report.submitted,
          postSubmit: postSubmit ? {
            url:   postSubmit.url,
            title: postSubmit.title,
            text:  postSubmit.text?.slice(0, 2000) ?? '',
          } : null,
        }, null, 2),
      };
    } catch (e) {
      return { ok: false, error: `submit_failed: ${/** @type {{ message?: string }} */ (e)?.message ?? e}` };
    }
    // why: we deliberately do NOT close the tab after submit. The user
    // may want to see the response in their actual browser — closing
    // would silently undo a state change. Active-tab work that opens
    // its own tab leaves it open; the user closes it when they want.
  },
};
