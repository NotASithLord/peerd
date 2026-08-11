# Design 4 — code-surface default decision

## Decision

Make the tab web actor code-first in preview/dev and keep store on the discrete
`tools` surface while field evidence accumulates. A browser without the
offscreen sealed-worker host falls back to tools at runtime, regardless of its
package default. Keep `message_actor` as the scalar one-delegation shortcut;
prefer `actors.call` for compound orchestration such as fan-out,
reply-dependent chains, retry, filtering, and aggregation.

The web bridge is Playwright-shaped because that vocabulary is common in model
training data, but every call still translates into the existing gated tool.
Code changes composition and round trips, not authority. `site_client_run`
remains outside `page_code`: nesting a sealed site job inside a sealed page job
can deadlock the bounded relay pool.

Persist the stable layer, not the volatile one. Existing origin-pinned site
clients hold learned API request shapes and can be read, repaired, and rerun as
the API evolves. Page/UI scripts stay short and disposable: observe, run a few
Playwright-shaped actions for rendering/login/gaps, observe again, then rewrite
the next small script against the current page. Do not add a durable DOM-routine
library until field evidence shows repeated script rewriting is a material cost
that outweighs its code-custody and stale-selector machinery.

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

The provider-backed web harness remains the authority for comparing the two
surfaces and deciding whether store should follow:

```sh
bun scripts/cdp/run-eval-bench.mjs --actor-surface=tools
bun scripts/cdp/run-eval-bench.mjs --actor-surface=code
```

Use the same model, tasks, and repetitions for both arms. Compare task success
first, then tokens per completed task, wall time, and the failure taxonomy from
`scripts/cdp/diagnose-page-code.mjs`. The code arm must not lose task success;
token savings alone are not enough.

The capability-manifest tests enforce the intentional difference: every direct
tab-web operation except nested `site_client_run` has a generated `page.*`
mapping to the same gated tool. Functional E2E states exercise both the direct
actor path and `script + actors.call` through real worker/SW/actor heaps, but the
faked model wire makes those protocol evidence, not model-performance evidence.

## Revisit condition

Revisit the store default only with a qualifying paired dataset from the
representative provider coverage required by the benchmark policy. Preserve the
settings escape hatch and runtime fallback; store follows only after field time.

Do not remove the model-facing `message_actor` descriptor merely for symmetry.
`actors.call` is an awaited OTP-style call, not a cast. A later removal first
needs a genuine delivery-ack-only `actors.cast`, semantic parity in cancellation,
lineage, audit, and mailbox behavior, and a measured non-inferiority result.
