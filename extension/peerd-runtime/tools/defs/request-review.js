// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// request_review — spawn a clean-context reviewer over the current diff.
//
// THIN tool wrapper. All orchestration lives in
// peerd-runtime/review/orchestrator.js; the SW binds makeRequestReview and
// injects the bound `requestReview` into the tool context. Here we resolve
// the diff source, hand off, and format the structured summary for the model.
//
// The reviewer is a SECOND agent with a CLEAN context (it never sees this
// conversation) and READ-ONLY tools (it cannot edit — the writer stays the
// single writer). See docs/REVIEW.md and DESIGN additions.

import { wrapUntrusted } from '../prompt-wrap.js';

// why: the summary is re-sent on every subsequent parent turn, so cap the
// rendered text. The full reviewer transcript is in the side panel by
// expanding this card.
const MAX_RESULT_CHARS = 64 * 1024;

// why: the review orchestrator slot (requestReview) + lineage fields (toolUseId,
// session.depth) are SW-injected outside the base ToolContext; narrow ctx to them.
// The result shape mirrors makeRequestReview's documented @returns
// (review/orchestrator.js), plus the `exceeded` flag formatReviewSummary reads.
/** @typedef {import('/peerd-runtime/review/schema.js').ReviewSummary} ReviewSummary */
/**
 * @typedef {{
 *   ok: boolean, summary: ReviewSummary | null, sessionId: string | null,
 *   parseError?: string, error?: string, exceeded?: boolean,
 *   reviewerToolCalls?: number, durationMs?: number,
 * }} ReviewResult
 */
/**
 * @typedef {{
 *   parentSessionId: string, parentDepth: number, parentToolUseId?: string,
 *   before?: unknown, after?: unknown, diff?: unknown, since?: string, focus?: string,
 * }} ReviewRequest
 */
/**
 * @typedef {{
 *   requestReview?: (req: ReviewRequest) => Promise<ReviewResult>,
 *   toolUseId?: string,
 *   session?: { sessionId?: string, depth?: number },
 * }} ReviewCtx
 */

/** @type {import('/shared/tool-types.js').Tool} */
export const requestReviewTool = composeTool("request_review", {

  execute: async (args, ctx) => {
    // why: narrow ctx to the SW-injected review orchestrator + lineage slots.
    const rctx = /** @type {ReviewCtx} */ (/** @type {unknown} */ (ctx));
    if (typeof rctx.requestReview !== 'function') {
      return { ok: false, error: 'review_orchestrator_unavailable' };
    }
    const parentSessionId = rctx.session?.sessionId;
    if (!parentSessionId) return { ok: false, error: 'no_parent_session' };

    const out = await rctx.requestReview({
      parentSessionId,
      parentDepth: rctx.session?.depth ?? 0,
      parentToolUseId: rctx.toolUseId,
      before: args?.before,
      after: args?.after,
      diff: args?.diff,
      since: typeof args?.since === 'string' ? args.since : undefined,
      focus: typeof args?.focus === 'string' ? args.focus : undefined,
    });

    if (!out.ok && out.error && !out.summary) {
      return { ok: false, error: out.error };
    }
    return { ok: true, content: formatReviewSummary(out) };
  },
});

/** @type {Record<string, string>} */
const SEV_MARK = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };

/** @param {ReviewResult} out */
const formatReviewSummary = (out) => {
  // why: formatReviewSummary is only called after the execute guard rules out
  // the (ok:false, summary:null) case, so summary is present here; the cast
  // erases the residual null the broad ReviewResult type still allows.
  const s = /** @type {ReviewSummary} */ (out.summary);
  const reviewerSession = out.sessionId ? ` (reviewer session ${out.sessionId})` : '';
  const stepCapNote = out.exceeded ? ' — REVIEWER HIT STEP CAP, summary may be partial' : '';
  const lines = [
    `Review verdict: ${s.verdict.toUpperCase()} — worst severity: ${s.severity}${reviewerSession}${stepCapNote}`,
  ];
  if (out.parseError) {
    lines.push(`(note: reviewer output was not cleanly structured — ${out.parseError})`);
  }
  if (s.summary) lines.push('', s.summary);

  if (s.issues.length === 0) {
    lines.push('', 'No issues found.');
  } else {
    lines.push('', `${s.issues.length} issue(s):`);
    for (const it of s.issues) {
      const mark = SEV_MARK[it.severity] ?? '⚪';
      const locationNote = it.location ? `  (${it.location})` : '';
      lines.push('', `${mark} [${it.severity}] ${it.title}${locationNote}`);
      if (it.detail) lines.push(`    ${it.detail}`);
      if (it.fix) lines.push(`    fix: ${it.fix}`);
    }
  }

  let text = lines.join('\n');
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated — expand the card for the full review]`;
  }
  // FENCE the reviewer's output before it lands in the parent's context.
  //
  // why: every line above is MODEL-AUTHORED by the reviewer, and the reviewer's
  // whole input is a diff — untrusted content by construction (review/read-only.js
  // header). On a parse failure review/schema.js hands up to 2000 chars of RAW
  // reviewer text through as `summary`, so a crafted diff's instructions can ride
  // out of the reviewer verbatim. The PARENT is the one context that holds a
  // channel (message_actor → the web actor → fetch_url), so an unfenced review
  // summary is the single place diff-borne text could steer something outward.
  // The reviewer itself has no egress (spawn narrows it off the main-agent
  // surface and restrictCtxCapabilities strips the closures), which is why this
  // is a hardening rather than a live hole — but a two-model-hop route is exactly
  // what the fence exists for, and it costs one call.
  return wrapUntrusted({
    origin: 'request_review (reviewer model output, derived from an untrusted diff)',
    tool: 'request_review',
    body: text,
  });
};
