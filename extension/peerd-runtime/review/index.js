// @ts-check
// peerd-runtime/review — clean-context review subagent (feature 08).
//
// A SECOND agent instance with NO shared context that reviews the writer's
// diff and returns a STRUCTURED summary {verdict, severity, issues[], fixes}.
// Implemented over the EXISTING subagent machinery (subagent/spawn.js): the
// reviewer is a spawned child with a clean session and a READ-ONLY tool
// subset. The writer stays the single writer. See docs/REVIEW.md.

export { makeRequestReview } from './orchestrator.js';
export {
  parseReviewSummary, worstSeverity, SEVERITIES,
} from './schema.js';
export {
  readOnlyToolNames, isReadOnlyTool, intersectReadOnly,
} from './read-only.js';
export {
  renderDiffForReview, synthesizeDiff, fromCheckpointDiff,
} from './diff.js';
export { buildReviewTask } from './prompt.js';
