// @ts-check
// Clean-context review orchestrator.
//
// This is the imperative shell that turns "review this diff" into a spawned
// reviewer agent + a parsed structured summary. It REUSES the existing
// subagent machinery (peerd-runtime/subagent/spawn.js) rather than standing
// up a second orchestrator:
//
//   - clean context: spawnSubagent({ task }) already creates a FRESH child
//     session whose only input is `task`. The reviewer never sees the
//     parent's messages — that's the clean-context property, for free.
//   - read-only enforcement: we pass `tools: readOnlyToolNames(...)` so the
//     reviewer is NARROWED to read-only tools at the descriptor level (what
//     it sees), and we wrap dispatch so any non-read call fails closed (what
//     it can do). The writer remains the single writer.
//   - structured summary: the reviewer's final text is parsed by
//     parseReviewSummary into {verdict, severity, issues[], fixes}.
//
// Everything IO is injected (spawnSubagent, getToolDescriptors, audit,
// and optionally feature 02's checkpoints + feature 03's permissions). That
// keeps this unit-testable in Bun with a mock spawn.

import { readOnlyToolNames, intersectReadOnly } from './read-only.js';
import { renderDiffForReview, fromCheckpointDiff, synthesizeDiff } from './diff.js';
import { buildReviewTask } from './prompt.js';
import { parseReviewSummary } from './schema.js';

/**
 * Build a review orchestrator bound to its IO deps. The SW calls this once
 * at boot and injects the bound `requestReview` into the tool context (for
 * the request_review tool) and exposes it on the `review/run` route.
 *
 * @param {Object} deps
 * @param {(req: object) => Promise<{ result: string, sessionId: string|null, toolCalls: number, durationMs: number, exceeded?: true, refused?: true }>} deps.spawnSubagent
 *   The EXISTING bound spawnSubagent from makeSpawnSubagent. We do not
 *   re-implement spawning; we call it with a read-only tool subset.
 * @param {() => Array<{ name: string, sideEffect?: string }>} deps.getToolDescriptors
 *   Full registered descriptors (with sideEffect) — the read-only filter input.
 * @param {(entry: object) => Promise<unknown>} [deps.appendAudit]
 * @param {{ diffSince: (ref?: string) => Promise<any> | any }} [deps.checkpoints]
 *   Feature 02 adapter. Optional — when absent, callers pass a diff/snapshots.
 * @param {{ readOnlyTools: () => Iterable<string> }} [deps.permissions]
 *   Feature 03 adapter. Optional — when present, intersected with the local
 *   read-only set so neither gate can widen the other.
 * @param {() => number} [deps.now]
 */
export const makeRequestReview = (deps) => {
  const {
    spawnSubagent,
    getToolDescriptors,
    appendAudit = async () => {},
    checkpoints,
    permissions,
    now = Date.now,
  } = deps;

  /**
   * Resolve the changeset to review, in priority order:
   *   1. explicit `diff` (already a Changeset)
   *   2. explicit before/after snapshots → synthesize
   *   3. feature 02 `checkpoints.diffSince(ref)` → adapt
   *
   * @param {ReviewRequest} req
   * @returns {Promise<import('./diff.js').Changeset | null>}
   */
  const resolveChangeset = async ({ diff, before, after, since }) => {
    if (diff && Array.isArray(diff.files)) return diff;
    if (before || after) return synthesizeDiff(before ?? {}, after ?? {});
    if (checkpoints && typeof checkpoints.diffSince === 'function') {
      return fromCheckpointDiff(await checkpoints.diffSince(since));
    }
    return null;
  };

  /**
   * @typedef {Object} ReviewRequest
   * @property {string} parentSessionId        who requested the review
   * @property {number} [parentDepth]          spawner depth (child = +1)
   * @property {import('./diff.js').Changeset} [diff]   explicit changeset
   * @property {Record<string,string>} [before]        snapshot (synthesize path)
   * @property {Record<string,string>} [after]
   * @property {string} [since]                checkpoint ref (feature 02 path)
   * @property {string} [focus]                reviewer focus hint
   * @property {number} [maxSteps]
   * @property {string} [parentToolUseId]      links the parent's card → reviewer session
   */

  /**
   * @param {ReviewRequest} req
   * @returns {Promise<{ ok: boolean, summary: import('./schema.js').ReviewSummary | null, sessionId: string|null, parseError?: string, error?: string, reviewerToolCalls?: number, durationMs?: number }>}
   */
  const requestReview = async (req) => {
    const {
      parentSessionId, parentDepth = 0, focus,
      maxSteps = 12, parentToolUseId,
    } = req;
    const start = now();

    const changeset = await resolveChangeset(req);
    if (!changeset) {
      // why null summary: error paths carry no review; callers gate on `ok`
      // (and `!out.summary`) before reading it — see request-review.js.
      return { ok: false, error: 'no_diff_source', summary: null, sessionId: null };
    }
    if (changeset.files.length === 0) {
      // Nothing to review — short-circuit without burning a model call.
      return {
        ok: true,
        sessionId: null,
        summary: { verdict: 'approve', severity: 'info', issues: [], summary: 'No files changed.' },
        reviewerToolCalls: 0,
        durationMs: now() - start,
      };
    }

    // ---- Read-only enforcement (layer 1: what the reviewer SEES) --------
    const descriptors = getToolDescriptors();
    const local = readOnlyToolNames(descriptors);
    const allowed = intersectReadOnly(
      local,
      permissions?.readOnlyTools ? permissions.readOnlyTools() : null,
    );

    appendAudit({
      type: 'review_requested',
      details: {
        parentSessionId, files: changeset.files.length,
        readOnlyTools: allowed.length, focus: focus ?? null,
      },
    }).catch(() => {});

    const diffText = renderDiffForReview(changeset);
    const task = buildReviewTask({ diffText, focus });

    // ---- Spawn the reviewer through the EXISTING machinery -------------
    // tools: `allowed` → the spawn's narrowTools intersects this with the
    // registry, giving the reviewer a clean session scoped to read-only
    // tools. No shared context: the child sees only `task`.
    //
    // Layer 2 (what it can DO): the spawn machinery already refuses any
    // tool outside the granted subset at dispatch — the subset narrowing
    // is the enforcement; the reviewer never gets a write tool to call.
    const out = await spawnSubagent({
      task,
      tools: allowed,
      maxSteps,
      parentSessionId,
      parentDepth,
      parentToolUseId,
      // why: a reviewer that tried to spawn its own children would escape
      // the read-only contract; spawn already strips spawn_subagent unless
      // allowRecursion, and `allowed` never contains it, so this is moot —
      // but we keep it explicit for the integrator reading this call.
      allowRecursion: false,
    });

    if (out.refused) {
      // why null summary: refusal carries no review; callers gate on `ok`
      // (and `!out.summary`) before reading it — see request-review.js.
      return { ok: false, error: out.result, summary: null, sessionId: out.sessionId ?? null };
    }

    const parsed = parseReviewSummary(out.result);

    appendAudit({
      type: 'review_completed',
      details: {
        parentSessionId, reviewerSessionId: out.sessionId,
        verdict: parsed.summary.verdict, severity: parsed.summary.severity,
        issues: parsed.summary.issues.length,
        parseOk: parsed.ok, exceeded: out.exceeded ?? false,
      },
    }).catch(() => {});

    return {
      ok: parsed.ok,
      summary: parsed.summary,
      sessionId: out.sessionId ?? null,
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
      reviewerToolCalls: out.toolCalls,
      durationMs: now() - start,
      ...(out.exceeded ? { exceeded: true } : {}),
    };
  };

  return requestReview;
};
