# DESIGN-17 P0 — dev notes (as-built)

Implementation record for DESIGN-17 P0 "resident tab agents"
(`DESIGN-17-resident-agents.md` is the design; this is what landed and why).
**Behind `shared/flags.js` `RESIDENT_TAB_AGENTS` (default OFF)** — with the flag
off the gate/descriptor/prompt/orchestrator changes are inert and instance tools
stay on the main agent exactly as before.

## What landed (the P0 deliverables)

- **`kind:'resident'`** — third `SessionKind`. A resident self-describes via two
  REVERSE-pointer fields on its session record (`instanceId`, `residentKind`);
  the FORWARD pointer (`residentSessionId`) lives on the engine registry record.
- **The capability tier** (`tools/exposure.js` + `tools/gates.js`):
  - `RESIDENT_MUTATING_TOOLS` — the tiered set, refused for any non-resident ctx.
  - `residentAllowedTools(kind)` — the resident's POSITIVE allow-list (refuses any
    non-kind tool from a resident — keyless/narrow runner model).
  - The per-instance pin (default-inject the bound id in the turn-driver wrapper;
    gate-reject a mismatching explicit id).
  - `residentTierGate` is a pure, flag-INJECTED function so the boundary proof
    holds with `flagOn:true` regardless of the source const.
- **The closure strip** (`subagent/spawn.js` `CAPABILITY_CONSUMERS`) — the engine
  clients/registries added (flag-gated) so a non-resident child loses any it
  wasn't granted; the resident ctx is built keyless via `restrictCtxCapabilities`.
- **The binding** (`registry-factory.js` `setResidentSession`/`getResidentSession`).
- **`message_resident`** (`subagent/resident-messaging.js` + the tool) — the
  async-subagents mailbox specialized: `runWhenIdle` serialization, P0 sender gate,
  per-sender runaway guard, SW-captured correlation, wrapUntrusted reply re-entered
  into the SENDER via `runWhenIdle(senderSessionId)`.
- **The kind-aware turn branch** (`loop/turn-driver.js`) + the resident system-
  prompt block (`loop/system-prompt.js`).
- **Ephemeral confirm**, **/chats hiding**, **delete-archive**, all in the SW.

## Key decisions / deviations from a literal reading of the spec

1. **Only MUTATION is tiered; reads stay global.** The spec says the tier is
   "vm_*, app_*, js_* except js_run", but its own invariant is "reads stay global;
   only mutation is tiered." So `RESIDENT_MUTATING_TOOLS` is the MUTATING set only
   — `vm_boot`, `vm_write_file`, `vm_import`, `vm_delete`, `js_notebook`,
   `js_write_file`, `js_delete`, `app_update`, `app_write_file`, `app_delete_file`,
   `app_delete`, **`edit_file`**. The read tools (`js_read_file`, `app_read_file`,
   `app_list_files`) and the create/catalog/open tools (`vm_create`, `vm_list`,
   `js_create`, `js_list`, `app_create`, `app_list`, `app_open`, `app_search`) +
   `js_run` stay on the main agent (no chicken-and-egg: main bootstraps an
   instance, then delegates via `message_resident`). A resident's own allow-list
   includes its kind's reads too (so it can read what it edits).

2. **`edit_file` is in the tier.** It's a real cross-kind App/Notebook write path
   (`kind` + `targetId`); leaving it off would be a complete mutation bypass. Its
   pin args are `targetId` (the instance) and `kind` (forced to the resident's).

3. **Lazy mint at `message_resident` time** (faithful to Move 1's "lazy — on the
   first operation that needs a resident") — avoids touching every create /
   client-auto-create site. The mint binds BOTH directions and sets the resident
   session as the instance's session-default so id-less tools resolve the bound
   instance.

4. **Resident permission posture:** the resident inherits the spawning chat's
   RESOLVED Plan/Act mode + confirm, stored EXPLICITLY (no silent widening to the
   global default — the subagent guardrail-3 precedent), layered with ephemeral
   confirm (never a standing `yes_session`).

5. **Keyless resident tool ctx:** built via `restrictCtxCapabilities` so the
   resident's TOOLS have no path to getSecret/safeFetch/spawn/memory. The loop
   still gets the provider key off-ctx via the turn driver (same as a subagent).
   Residual P0 surface: a WebVM resident keeps `webFetch` via `vm_import` (the
   spec's named exfil surface) — kept for VM functionality; documented, to be
   revisited with the untrusted-input posture (P1+).

6. **`synthetic` is now threaded onto the tool ctx** (buildToolContext →
   `ctx.synthetic`). Without it the `!synthetic` half of the P0 sender gate was
   inert (a goal-mode synthetic continuation in the active chat would have passed).

7. **Async-only at P0.** `sync?` is deferred (the detailed spec mechanism is the
   async re-entry); the tool is async — its reply arrives as a later fenced wake.

8. **`onTabClosed` generalization is doc-only for js/app** — only the VM client
   owns a per-instance command queue to interrupt; Notebook/App are
   request/response with a per-call timeout, so there's nothing to generalize
   beyond the tracker-mapping drop already done.

## Tests

- `tests/peerd-runtime/exposure.test.ts` — the tool sets + the gate
  (`residentTierGate`, flag-injected) in both directions + the per-instance pin +
  reads-stay-global + the flag-OFF wiring proof.
- `tests/peerd-runtime/resident-messaging.test.ts` — sender gate, happy-path
  correlation, error-still-wakes, both runaway caps.
- `extension/tests/unit/peerd-runtime/dispatcher.test.js` — the full-chain
  boundary test (flag-aware).

## Still ahead (P1+, not in this change)

The conversational surface (talk to a resident), the unattended path (once the
inbound clamp lands), per-kind tuned model tiers, the Phase-2 worker relocation,
and durable resume — all per the spec's Phasing.
