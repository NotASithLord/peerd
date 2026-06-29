// @ts-check
// check — verify an assertion about a tab via a read-only browser-runner.
//
// You state an assertion ("the form was submitted successfully", "the cart has
// 3 items"); a read-only runner observes the page and returns a boolean verdict
// + a one-sentence rationale grounded in what it saw. This is also the
// LLM-judge primitive the eval harness uses. See docs/DO-GET-CHECK-DESIGN.md.

import { runRunner, readToolsetFor, READ_MAX_STEPS, CHECK_SUFFIX, parseCheckVerdict } from '../../runner/index.js';
import { wrapUntrustedRunner } from '../prompt-wrap.js';

/**
 * runRunner's resolved shape — see do.js for why this restates the contract.
 *
 * @typedef {{ ok: true, summary: string, tabUrl?: string, exceeded?: boolean }
 *   | { ok: false, error: string }} RunnerResult
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const checkTool = {
  name: 'check',
  // why: resource is a browser tab; dispatch records the runner mechanism.
  primitive: 'tab',
  dispatch: 'runner',
  description: [
    'Verify whether an assertion is TRUE of a browser tab — e.g. "the message',
    'was sent", "the form submitted successfully", "the cart contains 3 items".',
    'A focused READ-ONLY runner observes the page and returns a boolean verdict',
    'with a one-sentence rationale grounded in what it saw. Use this to confirm',
    'an action landed (e.g. after a `do`) without pulling page content into your',
    'context. Defaults to the active tab; pass tabId to target another.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      assertion: {
        type: 'string',
        description: 'The claim to verify about the page, in plain language.',
      },
      tabId: {
        type: 'integer',
        description: 'Optional tab id to check; defaults to the active tab.',
      },
    },
    required: ['assertion'],
  },
  // why: read — the runner only observes.
  sideEffect: 'read',
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.assertion !== 'string' || args.assertion.trim().length === 0) {
      return { ok: false, error: 'assertion_required' };
    }
    // fastPath: with a pre-seeded snapshot this is usually ONE model call.
    // The INSUFFICIENT fallback fires INSIDE runRunner, before the verdict
    // parse below — a thin snapshot re-runs the full loop rather than
    // letting fail-closed-false poison the check result.
    // why: runnerModel is a resolved page-reader model the SW injects onto ctx;
    // it isn't on the ToolContext typedef, so read it through an erased cast.
    // ('' = inherit chat model.)
    const runnerModel = /** @type {{ runnerModel?: string }} */ (ctx).runnerModel;
    const r = /** @type {RunnerResult} */ (await runRunner(args, ctx, {
      goal: args.assertion,
      toolset: readToolsetFor(ctx),
      promptSuffix: CHECK_SUFFIX,
      maxSteps: READ_MAX_STEPS,
      fastPath: true,
      argName: 'assertion', // so runRunner's empty-arg backstop labels it correctly
      model: runnerModel || ctx.settings?.runnerModel || undefined,
    }));
    if (!r.ok) return { ok: false, error: r.error };
    // Parse the verdict off the RAW summary (the leading true/false is peerd's
    // own determination — a boolean, nothing injectable). The free-text
    // RATIONALE is runner-derived and untrusted, so wrap THAT.
    const v = parseCheckVerdict(r.summary);
    const rationale = wrapUntrustedRunner({ tabUrl: r.tabUrl, goal: args.assertion, body: v.rationale || '(no rationale)' });
    return { ok: true, content: `${v.ok ? 'TRUE' : 'FALSE'} — ${rationale}` };
  },
};
