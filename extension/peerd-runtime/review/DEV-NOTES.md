# Feature 08 — Clean-context review subagent (DEV-NOTES)

## Entry points

| Path | Role |
|---|---|
| `peerd-runtime/review/index.js` | module public API (re-exported from `peerd-runtime/index.js`) |
| `peerd-runtime/review/orchestrator.js` | `makeRequestReview(deps)` → bound `requestReview(req)`; `reviewerToolGuard` |
| `peerd-runtime/review/schema.js` | `parseReviewSummary`, `worstSeverity`, `SEVERITIES`, `extractJsonBlock` |
| `peerd-runtime/review/read-only.js` | `readOnlyToolNames`, `isReadOnlyTool`, `intersectReadOnly` |
| `peerd-runtime/review/diff.js` | `synthesizeDiff`, `fromCheckpointDiff`, `renderDiffForReview` |
| `peerd-runtime/review/prompt.js` | `buildReviewTask` (clean-context prompt + checklist + schema) |
| `peerd-runtime/tools/defs/request-review.js` | `request_review` tool (thin wrapper) |
| `background/service-worker.js` | binds `makeRequestReview`, injects `ctx.requestReview`, adds `review/run` route |
| `tests/peerd-runtime/review.test.ts` | Bun tests (31, green) |

## How it uses spawn.js

`makeRequestReview` takes the SW's already-bound `spawnSubagent` (from
`makeSpawnSubagent`) as a dependency and calls it with:

```js
spawnSubagent({
  task: buildReviewTask({ diffText, focus }),  // diff + checklist + schema
  tools: intersectReadOnly(readOnlyToolNames(descriptors), perms?.readOnlyTools?.()),
  maxSteps,
  parentSessionId, parentDepth, parentToolUseId,
  allowRecursion: false,
});
```

No loop / store / gate / audit duplication. The clean context is the fresh
child session spawn already creates; we just don't pass parent history.

## Structured-summary schema

`{ verdict: 'approve'|'request_changes'|'comment', severity: <worst>,
summary?: string, issues: [{severity, title, detail?, location?, fix?}] }`.
`severity` is **derived** from issues, not trusted from the model.
`parseReviewSummary` never throws — malformed output → well-formed fallback
with `parseError` set.

## Read-only enforcement

`sideEffect: 'read'` on the tool descriptor is the lever. Layer 1 (SEES):
`readOnlyToolNames` filters the granted subset. Layer 2 (DOES):
`reviewerToolGuard` refuses non-read calls at dispatch, fails closed on
unknowns. `spawn_subagent` + `request_review` are always denied even though
the latter is read-classified.

## Feature 02 + 03 adapters

- **02 (checkpoints):** bind `checkpoints: { diffSince(ref) }` in
  `makeRequestReview`. `fromCheckpointDiff` normalizes the result. Standalone
  fallback: pass `before`/`after` snapshots → `synthesizeDiff`.
- **03 (permissions):** bind `permissions: { readOnlyTools() }`.
  `intersectReadOnly` narrows the local floor further (intersection only).

Both are commented placeholders at the SW binding today:

```js
const requestReview = makeRequestReview({
  spawnSubagent,
  getToolDescriptors: () => listTools().map((t) => ({ name: t.name, sideEffect: t.sideEffect })),
  appendAudit: auditLog.append,
  // checkpoints: feature02Adapter,   // wire when feature 02 lands
  // permissions: feature03Adapter,   // wire when feature 03 lands
});
```

## Integrator wiring (checklist)

1. SW import: `makeRequestReview` from `/peerd-runtime/index.js`. ✅ done
2. SW bind after `spawnSubagent`. ✅ done
3. Inject `requestReview` into `buildToolContext`'s returned ctx. ✅ done
4. `review/run` route for the `/review` command + sandbox shim. ✅ done
5. `request_review` registered via `BUILTIN_TOOLS`. ✅ done
6. **When feature 02 lands:** uncomment + bind `checkpoints`.
7. **When feature 03 lands:** uncomment + bind `permissions`. Also: route
   `request_review`'s own exposure through 03 so Read-persona sessions can
   still invoke a reviewer (it's read-only, so it should be allowed in Read).
8. **UI (V1.x):** a side-panel review card rendering the issues table; today
   it reuses the nested subagent-transcript rendering via `parentToolUseId`.

## V1.x gaps

- No auto-trigger at turn end (parent-policy decision).
- No auto-apply of fixes (writer applies; reviewer only reports).
- No dedicated review-card UI (reuses subagent transcript for now).
- No multi-reviewer ensemble.
- Browser-native deep-inspection (open the changed App, read its DOM/console)
  is available via the read-only toolset but not yet scripted into the
  prompt as a mandatory step — left as reviewer discretion.

## Tests

`bun test ./tests/peerd-runtime/review.test.ts` — 31 pass. Covers: read-only
narrowing exposes NO write tools; call-time guard fails closed; schema
parse/validate incl. malformed + over-optimistic-approve override; diff
synth/adapt/render; and a mocked reviewer run end-to-end (clean-context task,
read-only grant, structured summary, 02/03 adapters, refusal, fallback).
Full suite: `bun test ./tests` → 172 pass.
