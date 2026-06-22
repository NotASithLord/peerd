// @ts-check
// get — read a value off a tab via a read-only browser-runner.
//
// You ask for a value in plain language ("the price of the cheapest item",
// "the count of unread emails"); a read-only runner observes the page and
// returns just that value. You never see the accessibility tree or page text —
// only the answer. See docs/DO-GET-CHECK-DESIGN.md.

import { runRunner, READ_TOOLSET, READ_MAX_STEPS, GET_SUFFIX } from '../../runner/index.js';
import { wrapUntrustedRunner } from '../prompt-wrap.js';

/**
 * runRunner's resolved shape — see do.js for why this restates the contract.
 *
 * @typedef {{ ok: true, summary: string, tabUrl?: string, exceeded?: boolean }
 *   | { ok: false, error: string }} RunnerResult
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const getTool = {
  name: 'get',
  // why: resource is a browser tab; dispatch records the runner mechanism.
  primitive: 'tab',
  dispatch: 'runner',
  description: [
    'Read a specific value off a browser tab by asking for it in plain language',
    '— e.g. "the price of the cheapest item in this list", "the count of unread',
    'emails", "the heading of the article". A focused READ-ONLY runner observes',
    'the page and returns just that value (or NOT_FOUND with a reason). It does',
    'not click, type, or navigate. Use this instead of taking a snapshot and',
    'reading the page yourself — it keeps page content out of your context.',
    'Defaults to the active tab; pass tabId to target another.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The value to read off the page, in plain language.',
      },
      tabId: {
        type: 'integer',
        description: 'Optional tab id to read from; defaults to the active tab.',
      },
    },
    required: ['query'],
  },
  // why: read — the runner only observes (READ_TOOLSET has no click/type/nav).
  sideEffect: 'read',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.query !== 'string' || args.query.trim().length === 0) {
      return { ok: false, error: 'query_required' };
    }
    // fastPath: with a pre-seeded snapshot this is usually ONE model call.
    // ctx.runnerModel is the resolved page-reader model (pin → local WebGPU →
    // provider fast default like Haiku → inherit); '' means inherit the chat
    // model. runRunner retries on the inherited model if it struggles.
    // why: runnerModel is a resolved page-reader model the SW injects onto ctx;
    // it isn't on the ToolContext typedef, so read it through an erased cast.
    const runnerModel = /** @type {{ runnerModel?: string }} */ (ctx).runnerModel;
    const r = /** @type {RunnerResult} */ (await runRunner(args, ctx, {
      goal: args.query,
      toolset: READ_TOOLSET,
      promptSuffix: GET_SUFFIX,
      maxSteps: READ_MAX_STEPS,
      fastPath: true,
      argName: 'query', // so runRunner's empty-arg backstop labels it correctly
      model: runnerModel || ctx.settings?.runnerModel || undefined,
    }));
    if (!r.ok) return { ok: false, error: r.error };
    // why: the value came off an untrusted page — wrap it so the main agent
    // treats it as data, not a command.
    return { ok: true, content: wrapUntrustedRunner({ tabUrl: r.tabUrl, goal: args.query, body: r.summary || '(runner returned no value)' }) };
  },
};
