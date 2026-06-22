// @ts-check
// do — perform a high-level action on a tab via a browser-runner.
//
// You (the main agent) issue INTENT ("compose an email to Mark about Q3").
// A disposable runner drives the page (snapshot → act → observe) and returns a
// plain-text summary of what changed. You never see the accessibility tree,
// element refs, or the action trace — only the summary. See
// docs/DO-GET-CHECK-DESIGN.md and peerd-runtime/runner/index.js.

import { runRunner, DO_TOOLSET, DO_MAX_STEPS, DO_SUFFIX } from '../../runner/index.js';
import { wrapUntrustedRunner } from '../prompt-wrap.js';

/**
 * runRunner's resolved shape. why: runner/index.js is not // @ts-check'd, so
 * its inferred return widens `summary`/`error` to `string | undefined`; this
 * typedef restates the actual contract (ok:true carries a summary; ok:false an
 * error message) so the dispatch wrappers below type cleanly.
 *
 * @typedef {{ ok: true, summary: string, tabUrl?: string, exceeded?: boolean }
 *   | { ok: false, error: string }} RunnerResult
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const doTool = {
  name: 'do',
  // why: the RESOURCE is a browser tab (not "subagent" — that conflated the
  // resource axis with the execution mechanism). `dispatch: 'runner'` records
  // that it's carried out by spawning a browser-runner, surfaced as its own
  // dimension so the card reads "tab · via runner" with the runner transcript
  // nested. See docs/DO-GET-CHECK-DESIGN.md.
  primitive: 'tab',
  dispatch: 'runner',
  description: [
    'Perform a high-level action on a browser tab by stating your INTENT in',
    'plain language — e.g. "fill in the login form with <user> and submit",',
    '"compose an email to Mark with subject Q3", "add the first result to the',
    'cart". A focused runner drives the page for you (it sees the accessibility',
    'tree, picks elements, clicks and types) and returns a concise summary of',
    'what it did and what changed. You do NOT take snapshots or click/type',
    'yourself — describe the goal and let the runner handle the mechanics.',
    'Defaults to the active tab; pass tabId to target another. If the runner',
    'only partially completes the goal, its summary says so — read it and decide',
    'the next step (do not blindly re-issue the same instruction onto a',
    'half-changed page).',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description: 'What to accomplish on the tab, in plain language. State the GOAL, not low-level steps.',
      },
      tabId: {
        type: 'integer',
        description: 'Optional tab id to act on; defaults to the active tab. Get ids from list_tabs.',
      },
    },
    required: ['instruction'],
  },
  // why: write, NOT mutate_external — the egress-allowlist hook gates only
  // mutate_external tools (submit_form, vm_boot, …); do/get/check are spawn
  // wrappers, so any network/DOM effect happens INSIDE the runner's child
  // session and is gated by the child's own six gates (incl. the denylist
  // origin gate, pinned to this tab). 'write' also means Plan mode blocks `do`.
  sideEffect: 'write',
  // The runner's tools declare their own origins (the pinned tab); this wrapper
  // touches none directly.
  origins: () => [],

  execute: async (args, ctx) => {
    if (typeof args?.instruction !== 'string' || args.instruction.trim().length === 0) {
      return { ok: false, error: 'instruction_required' };
    }
    // DO_SUFFIX makes the runner re-observe and verify the end state before it
    // reports done — closes the premature-"done" failure (DO-GET-CHECK §8.1).
    const r = /** @type {RunnerResult} */ (await runRunner(args, ctx, { goal: args.instruction, toolset: DO_TOOLSET, promptSuffix: DO_SUFFIX, maxSteps: DO_MAX_STEPS }));
    if (!r.ok) return { ok: false, error: r.error };
    // why: the runner's summary is UNTRUSTED — wrap it so the main agent treats
    // it as data, not commands (a prompt-injected page can steer what it says).
    // The step-cap note is peerd's own (trusted), so it sits OUTSIDE the wrap.
    const wrapped = wrapUntrustedRunner({ tabUrl: r.tabUrl, goal: args.instruction, body: r.summary || '(runner returned no summary)' });
    const note = r.exceeded
      ? '\n\n(note: the runner hit its step cap — the result above may be incomplete.)'
      : '';
    return { ok: true, content: wrapped + note };
  },
};
