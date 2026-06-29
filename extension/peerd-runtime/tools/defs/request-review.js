// @ts-check
// request_review — spawn a clean-context reviewer over the current diff.
//
// THIN tool wrapper. All orchestration lives in
// peerd-runtime/review/orchestrator.js; the SW binds makeRequestReview and
// injects the bound `requestReview` into the tool context. Here we resolve
// the diff source, hand off, and format the structured summary for the model.
//
// The reviewer is a SECOND agent with a CLEAN context (it never sees this
// conversation) and READ-ONLY tools (it cannot edit — the writer stays the
// single writer).

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
export const requestReviewTool = {
  name: 'request_review',
  primitive: 'subagent',
  description: [
    'Spawn a clean-context reviewer to critique a diff and return a',
    'STRUCTURED summary (verdict, severity, issues with suggested fixes).',
    'The reviewer is a SECOND agent that has NOT seen this conversation —',
    'a fresh, skeptical pair of eyes — and it is READ-ONLY (it cannot edit,',
    'click, navigate, or run code; you remain the only writer). Use it',
    'after you finish a non-trivial change to catch bugs, security issues,',
    'and convention violations you rationalized past.',
    '',
    'Provide the diff one of three ways: pass `before`/`after` file-tree',
    'snapshots (the standalone path), pass an explicit `diff` changeset, or',
    'omit both to review changes since the last checkpoint (when the',
    'checkpoint adapter is wired). Optional `focus` steers the review.',
    '',
    'Returns the reviewer verdict (approve | request_changes | comment),',
    'the worst severity, and the list of issues with fixes. Incorporate the',
    'issues into your next edits; the full reviewer transcript is in the',
    'side panel by expanding this card.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      before: {
        type: 'object',
        description: 'Optional. {path: content} snapshot BEFORE your changes. With `after`, the reviewer diffs them.',
        additionalProperties: { type: 'string' },
      },
      after: {
        type: 'object',
        description: 'Optional. {path: content} snapshot AFTER your changes.',
        additionalProperties: { type: 'string' },
      },
      diff: {
        type: 'object',
        description: 'Optional. Explicit changeset {files:[{path,status,before,after}]} if you already have one.',
      },
      since: {
        type: 'string',
        description: 'Optional. Checkpoint ref to diff since (when the checkpoint adapter is wired). Omit for the latest.',
      },
      focus: {
        type: 'string',
        description: 'Optional. Steer the reviewer ("focus on the auth path", "check accessibility").',
      },
    },
    required: [],
  },
  // why: read — the tool itself mutates nothing. It spawns a reviewer whose
  // tools are all read-only and whose only output is a text summary. No
  // edits escape; the writer stays the single writer.
  sideEffect: 'read',
  origins: () => [],

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
};

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
  return text;
};
