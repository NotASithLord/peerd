# JS-superpower designs — closing the gap to "the agent writes code"

> Point-in-time proposals (2026-08). Each file is one implementable design.
> Once a design lands, the code is the spec — cull or shrink the doc to a
> pointer in the landing PR. Do not let these accrete into a parallel truth.

## Context

Harnesses like Claude Code get their reach from ONE tool: write bash into a
persistent, batteries-included environment. peerd's analogue is writing
JavaScript, and the audit (2026-08, this branch) found the bet already
placed — eight code-execution surfaces on one sealed-worker substrate, each
capability-profiled (`engine-tabs/notebook-tab/worker-source.js`,
`offscreen/job-runner.js`) — but the *ergonomics* trailing the architecture:

- **Ahead of the bash harnesses:** capability-scoped code lanes (double-
  enforced, in-realm + host relay), delegation-from-code (`script`'s `actors`
  client), provenance fencing on run output, agent-derived durable site
  clients (DESIGN-19), `peerd:wasi`.
- **Behind:** no durable workspace for the main agent's code hand; no
  library story (no HTML parsing in the worker); the #119 code surface still
  an off-by-default experiment; oversized results truncate with nowhere to
  spill; several wired-but-dead or placeholder seams.

## The designs, in priority order

| # | Design | One-liner | Danger zone? |
|---|--------|-----------|--------------|
| 1 | [script-workspace](01-script-workspace.md) | Durable, session-scoped OPFS workspace + result spill/paging for `script` | sandbox boundary (fencing) |
| 2 | [std-web-extract](02-std-web-extract.md) | `extract` option on the worker's bridged fetch (reuse readability/turndown) + grow `peerd:std` | no (reuses audited path) |
| 3 | [module-imports-via-egress](03-module-imports-via-egress.md) | Make remote module imports real AND audited (or delete the claim) | egress |
| 4 | [code-surface-default](04-code-surface-default.md) | Run the #119 bench, call the bet, flip preview default | no |
| 5 | [provider-call](05-provider-call.md) | Wire `peerd.provider.call` — model calls from inside a script, quota-gated, keyless | runner boundary |
| 6 | [toolbox](06-toolbox.md) | `peerd:toolbox/<name>` — agent-authored reusable modules, generalizing the site-client pattern | sandbox boundary |
| 7 | [loop-polish](07-loop-polish.md) | VM stderr split, dead streaming plumbing, headless `distributed` fast-fail, `script` gate class | gates (one line) |

## Dependency notes

- 1, 2, 3, 4, 7 are independent of each other; any can land first.
- 5 wants the cost-telemetry hookup decided up front (it spends the user's
  key from inside a run) — smallest surface after 7, biggest policy question.
- 6 reuses 1's fencing rule ("durable files are untrusted-influenced by
  default") and the site-client store shape; land after 1, ideally after the
  team has lived with 1 for a while.
- 4 is mostly *process* (bench + flip); the code change is a default.

## Shared invariants every design must keep

These are the load-bearing walls the audit confirmed; no design below may
weaken them:

1. **The seal stays the first import** and capability profiles stay enforced
   twice — in-realm and at the host relay. New capabilities are new `caps`
   flags, refused-by-default at both layers.
2. **The worker never names its own authority.** Owner/session identity,
   roots, and profiles ride the SW→offscreen job params
   (`offscreen/job-runner.js`), never worker-supplied args.
3. **Provenance fencing travels with the bytes.** Anything a run returns
   that could carry non-agent-authored content re-enters the model fenced
   (`wrapUntrusted`), matching the `usedEgress`/`usedActors` precedent in
   `tools/defs/script.js`.
4. **Exposure changes go through `tools/exposure.js` + the gate**
   (`tools/gates.js`), never descriptor filtering alone.
5. **Store channel stays dweb-free** and never widens: nothing here touches
   `peerd-distributed/`.
