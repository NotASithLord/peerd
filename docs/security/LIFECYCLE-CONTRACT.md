# Lifecycle and recovery contract

Browser extension service workers, tabs, workers, and sandbox processes can stop
without warning. peerd treats an interruption as a state to reconcile, not as a
generic failure or permission to repeat work.

## Operation outcomes

Every tool dispatch is classified by replay risk. The service worker arms
lifecycle tracking before it creates a tool context. Conditional and
non-idempotent actions cannot start unless their durable record starts
successfully. Pure reads, budgeted reads, and idempotent writes may continue
without a record if lifecycle storage fails because their class rules provide a
safe retry path. Long-lived resource creation also continues untracked today.
That is a gap: an interruption can leave an unrecorded orphan, and recreating
it can mint a duplicate. An idempotent write can still have an unknown landed
effect, but any retry must reuse its original idempotency key.

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
  duplicate guard recognizes the same tool-call ID, not the same intent. A
  resumed autonomous goal can therefore verify and issue a semantically similar
  action under a new ID without a new user instruction. This remains a gap.
- Long-lived resources may be recreated from durable records. Their process
  state and transient grants are not restored.

If lifecycle storage is unavailable, peerd refuses conditional and
non-idempotent actions instead of running them without a recovery record.
Resource creation does not yet fail closed in that condition. Stop prevents
later automatic resumption. Positive evidence of a completed effect remains
completed even if Stop arrived afterward.

Startup reconciliation does not replay the old tool call. It settles the record
and adds a read-once recovery block to the owning root chat's next model turn.
An uncertain action says to check the target before repeating it. Recovery
notices are also written to the audit trail.

Two additional recovery-notice gaps remain. Deleting or archiving a session
currently marks all of its nonterminal records cancelled and removes their
pending notices, including a
dispatched action whose outcome was not proven. Also, the immediate user-facing
recovery note is not routed to a specific chat, although the next-turn model
notice and audit record are. Until those paths are fixed, verify the external
target before deleting or archiving an interrupted session.

Current source: `extension/peerd-runtime/lifecycle/retry-class.js`,
`extension/peerd-runtime/lifecycle/tool-retry-class.js`,
`extension/peerd-runtime/lifecycle/dispatch-tracking.js`, and
`extension/peerd-runtime/lifecycle/boot.js`.

## Resource recovery

The live engine contract is narrower than the operation contract:

- Engine tabs that survive a service-worker restart are rediscovered by their
  tab trackers.
- A WebVM, Notebook, or App recorded as live whose tab did not survive is
  reported as a lost resource. The audit log and the owning root chat's next
  model turn receive the notice. The immediate visible note may appear in the
  currently active chat until user-note routing is fixed.
- Saved files and registry metadata remain. Live process state is lost and is
  not reported as resumed.

The detailed policies in
`extension/peerd-runtime/lifecycle/resource-recovery.js` are pure, tested
recovery planners. They cover driven-tab revalidation, Notebook result labels,
WebVM filesystem verification, and App sandbox rebuilds. They are not called by
the production shell yet. Do not rely on those policies as shipped guarantees.

Current live source: `extension/peerd-runtime/lifecycle/engine-liveness.js`,
engine tab trackers, and the engine orphan sweep in
`extension/background/service-worker.js`.

## Stored data and upgrades

Each registered durable store has its own schema version and durability class. A
first-run profile is stamped without being treated as corrupt. If a stamp is
newer than the running peerd version or malformed, the live guard classifies the
store read-only. Shared key-value and IndexedDB adapters refuse mapped writes,
and injected guards cover the skills and App-body databases. OPFS workspace
writes do not yet consult this guard.

The forward migration driver is pure and tested but is not called by the
production shell yet. It supports checkpointed steps, preserves the original
input on failure, and refuses undeclared field removal. Until that driver is
wired to each store, peerd does not promise automatic migration from a future
older schema stamp.

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
