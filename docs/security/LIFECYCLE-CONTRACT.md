# Lifecycle and recovery contract

Browser extension service workers, tabs, workers, and sandbox processes can stop
without warning. peerd treats an interruption as a state to reconcile, not as a
generic failure or permission to repeat work.

## Operation outcomes

Every tool dispatch is classified by replay risk. The service worker arms
lifecycle tracking before it creates a tool context. Conditional actions,
non-idempotent actions, and long-lived resource creation cannot start unless
their durable record starts successfully. Pure reads, budgeted reads, and
idempotent writes may continue without a record if lifecycle storage fails
because their class rules provide a safe retry path. An idempotent write can
still have an unknown landed effect, but any retry must reuse its original
idempotency key.

After an interruption:

- Pure reads are safe to retry.
- Reads that spend network or model budget require a new attempt with current
  credentials and available budget.
- Idempotent writes may be retried only with the original idempotency key.
- Conditional actions dispatched without proof of their outcome require
  external verification.
- The lifecycle reconciler does not replay a non-idempotent tool call. If peerd
  cannot prove whether one completed, it reports `outcome_unknown` and tells the
  next model turn to verify the target before repeating it. The deterministic
  duplicate guard recognizes the same tool-call ID. Autonomous goal
  continuations also stop while that session has an unresolved uncertain
  action. A new user turn must verify or deliberately resolve the uncertainty.
- Engine catalog records and stored files remain available after host loss.
  peerd does not automatically recreate the lost process or restore transient
  grants.

If lifecycle storage is unavailable, peerd refuses conditional actions,
non-idempotent actions, and resource creation instead of running them without a
recovery record. Stop prevents later automatic resumption. Positive evidence
of a completed effect remains completed even if Stop arrived afterward.

Startup reconciliation does not replay the old tool call. It settles the record
and adds a read-once recovery block to the owning root chat's next model turn.
An uncertain action says to check the target before repeating it. Recovery
notices are also written to the audit trail.

Deleting or archiving a session cannot erase a possible past effect.
Pre-dispatch work is cancelled, completed work remains completed, and a
dispatched action without proof of outcome remains `outcome_unknown` with its
verification notice.

Immediate recovery notes are passive and session-scoped. A note is shown only
while its owning chat is open, and it is removed if the user switches chats.
The next-turn model notice remains durable and read-once.

Current source: `extension/peerd-runtime/lifecycle/retry-class.js`,
`extension/peerd-runtime/lifecycle/tool-retry-class.js`,
`extension/peerd-runtime/lifecycle/dispatch-tracking.js`, and
`extension/peerd-runtime/lifecycle/boot.js`.

## Resource recovery

The live engine contract is narrower than the operation contract:

- Engine tabs that survive a service-worker restart are rediscovered by their
  tab trackers.
- A WebVM, Notebook, or App recorded as live whose tab did not survive is
  audited and reported to its owning root chat. Multiple losses from one boot
  produce one passive notice for that chat. A separate bounded receipt enters
  the next model turn using engine IDs instead of user or peer supplied names.
- The report names the affected resources and distinguishes stored files and
  resource details from lost processes and in-memory state. It does not include
  tool arguments or resource contents.
- Recovery reports do not recreate an engine host or replay work.

The tracker currently identifies survival by the presence of a matching host
tab. It does not distinguish a continuously running tab from a browser-restored
tab whose page heap restarted. A restored tab can therefore lose in-memory
state without producing a resource-loss report. Do not treat tracker discovery
alone as proof that process state survived a full browser restart.

Current live source: `extension/peerd-runtime/lifecycle/engine-liveness.js`,
`extension/peerd-runtime/lifecycle/resource-recovery.js`, engine tab trackers,
and the engine orphan sweep in
`extension/background/service-worker.js`.

## Stored data and upgrades

Each registered durable store has its own schema version and durability class. A
first-run profile is stamped without being treated as corrupt. If a stamp is
newer than the running peerd version, older than the supported schema, or
malformed, the live guard classifies the store read-only. Shared key-value and
IndexedDB adapters refuse mapped writes, and injected guards cover the skills
and App-body databases. Notebook tabs and durable headless workspaces consult
the same live guard before every OPFS mutation. Reads do not create missing
workspace roots and remain available while writes are blocked.

The forward migration driver is pure and tested but is not called by the
production shell yet. It supports checkpointed steps, preserves the original
input on failure, and refuses undeclared field removal. Until a concrete plan is
wired for a store, an older stamp is read-only and the original data is retained.

Exports identify device-bound state that cannot move to another install. A
portable export must not silently imply that tabs, engine handles, local
workspace roots, or device-bound keys moved with it.

Current live source: `extension/peerd-runtime/lifecycle/store-registry.js`,
`extension/peerd-runtime/lifecycle/write-guard.js`, service-worker boot, and the
transfer code. The unwired migration core is
`extension/peerd-runtime/lifecycle/store-version.js`.

## How to audit it

Run the lifecycle test suite with:

```sh
bun test ./tests/peerd-runtime/lifecycle
```

The fault-injection tests stop work at dispatch, settlement, reconciliation,
generation, migration-core, restart, and notification boundaries. Historical
fixtures exercise profiles from earlier releases, mixed storage shapes, unknown
fields, channel differences, store readers, transfer inspection, and downgrade
refusal. Boundary tests verify that uncertain writes do not execute when
tracking is unavailable and that replay identity survives operation-log
compaction.

Relevant tests and historical inputs live under
`tests/peerd-runtime/lifecycle/`. Test names and fixture contents are the live
inventory.
