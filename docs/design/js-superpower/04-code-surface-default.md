# Design 4 — code-surface default decision

## Decision

Keep the tab web actor on the discrete `tools` surface by default, and keep
`message_actor` as the scalar one-delegation shortcut. Prefer code for compound
orchestration: fan-out, reply-dependent chains, retry, filtering, and
aggregation.

This is a fail-closed measurement decision, not a rejection of the code-first
direction. The code bridge has the expected round-trip advantage, but the
available deterministic evidence cannot establish model reliability. The
contract scorer therefore refuses to remove the scalar tool. The web code arm
also deliberately omits nested `site_client_run`: nesting a sealed site job
inside `page_code` can deadlock the bounded relay pool. Until a qualifying live
model bench clears both reliability and capability-fit gates, changing the
default would be ahead of the evidence.

The live defaults remain in `packaging/default-settings.mjs`; generated channel
files must continue to come from the generation scripts.

## Evidence and gate

`bun run eval:actors` runs the deterministic five-scenario protocol matrix and
prints all decision metrics. Protocol evidence may verify bridge semantics and
turn consolidation, but can never authorize removing `message_actor`.

A provider-backed experiment can be scored with:

```sh
bun run eval:actors --evidence=/path/to/actor-ab.json
```

The evidence bundle must carry provider, model, prompt-revision, and repetition
provenance plus one-to-one paired rows for both arms. Each scenario records task
success, model turns, tokens, elapsed time, inner operations, and recovery where
applicable. `extension/eval/actor-orchestration-score.js` owns the minimum
replication and the predeclared decision rule; incomplete or hand-relabeled
protocol rows fail closed.

Removal is permitted only when code is reliability-noninferior on the scalar
case and overall, recovery does not regress, and compound turns improve by the
declared materiality threshold. Otherwise the scalar shortcut stays.

## Web-surface bench

The existing provider-backed web harness remains the authority for a later
default flip:

```sh
bun scripts/cdp/run-eval-bench.mjs --actor-surface=tools
bun scripts/cdp/run-eval-bench.mjs --actor-surface=code
```

Use the same model, tasks, and repetitions for both arms. Compare task success
first, then tokens per completed task, wall time, and the failure taxonomy from
`scripts/cdp/diagnose-page-code.mjs`. The code arm must not lose task success;
token savings alone are not enough.

The capability-manifest tests enforce the current intentional difference:
every direct tab-web operation except nested `site_client_run` has a generated
`page.*` mapping to the same gated tool. Functional E2E states exercise both the
direct actor path and `script + actors.call` through real worker/SW/actor heaps,
but the faked model wire makes those protocol evidence, not model-performance
evidence.

## Revisit condition

Revisit the default only with a qualifying paired dataset from at least the
representative provider coverage required by the benchmark policy. If the code
arm earns the flip, change preview/dev first, regenerate derived files, preserve
the settings escape hatch, and let store follow only after field time.
