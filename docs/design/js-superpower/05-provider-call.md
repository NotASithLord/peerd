# Design 5 — wire `peerd.provider.call`: model calls from inside a script

## Problem

`peerd.provider.call` sits in the sealed worker as a throwing placeholder
(`engine-tabs/notebook-tab/worker-source.js` — "needs quota + explicit
grant"). Wiring it is the "bash spawning `claude -p`" analogue: classify /
extract / summarize steps INSIDE a data pipeline, map-reduce over rows with
a sub-model call, grade candidates in a loop — the class of script that
today requires surfacing all intermediate data back into the main context.

The custody pattern is already proven: actor workers call the model through
an SW relay that adds the key server-side (`background/offscreen-actor-client.js`
`'actor/model-call'`; the worker never holds `getSecret`/`safeFetch`). This
design is that relay, re-scoped to a script run.

## Shape

### Worker API (v1, deliberately minimal)

```js
const { text } = await peerd.provider.call({
  system?: string,
  prompt: string,          // OR messages: [{role, content}] — one of the two
  model?: string,          // default: the session's configured model
  maxTokens?: number,      // clamped by the relay
});
```

Text in, text out. **No tool use, no streaming, no thinking budget** — a
sub-call that could itself call tools would be an agent loop inside a
capability we can't see into; that is what `peerd.runtime.runAgent` (a real,
gated, depth-capped actor) is for. The two surfaces stay distinct on
purpose: `provider.call` = pure text transform, `runAgent` = delegation.

### Capability gating (both walls, per the shared invariants)

- New caps flag `provider: false` in `DEFAULT_WORKER_CAPS` — off by default
  everywhere.
- Enabled ONLY by the `script` and `js_notebook` tool paths (the agent's
  own-compute lanes), and — mirroring the `actorsOn` pattern in
  `tools/defs/script.js` — only when the code actually references
  `peerd.provider` (keeps non-using runs on the short compute wall-clock
  and mints nothing they don't need).
- Hard-refused at BOTH walls for `page_code`, `site_client_run`, and
  `a2a_run` profiles: those lanes execute code that is either
  page-influenced, stored-untrusted-provenance, or peer-facing — handing
  any of them the user's paid key is exactly the escalation the profiles
  exist to prevent.
- In-realm: absent surface throws; host relay: new `provider-request`
  handler in `offscreen/job-runner.js` refuses unless the job params carry
  the flag (host-supplied, never worker-supplied).

### The relay route

New SW route `script/model-call`, modeled line-for-line on
`actor/model-call`:

- Verifies the `runId`/owner against the live run registry (`scriptRuns`) —
  a call from a dead or foreign run is refused.
- Resolves provider + model from the OWNING SESSION's settings; an explicit
  `model` arg must resolve within the user's configured providers
  (`peerd-provider/registry.js`) or is refused — the worker cannot name an
  arbitrary endpoint.
- Adds `getSecret` + `safeFetch` SW-side. The key never enters the worker
  or the offscreen document.
- Stamps cost telemetry with the parent session id and a `sub_call` marker
  so the cost view attributes spend to the turn that caused it.

### Quota (the policy decision this design exists to force)

Per-RUN ceilings enforced at the relay, counted SW-side keyed by `runId`:

- max sub-calls per run (propose 20),
- max total output tokens per run (propose a ceiling in the same order as
  one normal turn's budget),
- per-call `maxTokens` clamp.

Overflow returns a structured refusal the script can catch
(`ProviderQuotaError`), not a worker kill — a fan-out script should be able
to degrade gracefully. No cross-run daily budget in v1; the cost view +
Stop are the existing levers, and a standing budget belongs to the cost
module when Profiles land.

### Provenance

The sub-model's OUTPUT is generated from whatever the code fed it. The run's
existing fence logic already covers the dangerous cases: if the run pulled
web bytes or actor replies (`usedEgress`/`usedActors`), its whole output —
including anything the sub-model said about those bytes — re-enters fenced.
A pure-compute run's sub-call output is the agent's own working. So: **no
new fence condition**, but set a `usedProvider` flag on `RunResult` anyway
and render a fence-safe `[MODEL CALLS n | tokens t]` line in
`formatRunResult` — the orchestrator (and the user reading the transcript)
should always see that money moved.

### Abort

Sub-calls ride the run's abort: Stop → `abortHeadless` already kills the
worker; the relay must also abort in-flight provider fetches for that
`runId` (`AbortController` per call, registered with the run entry —
the same plumbing shape `scriptRuns.register` uses for actor asks).

## Touch points

| File | Change |
|---|---|
| `extension/engine-tabs/notebook-tab/worker-source.js` | wire `peerd.provider.call` bridge (guarded by caps flag); keep `listModels` a placeholder |
| `extension/offscreen/job-runner.js` | `provider-request` relay handler, caps-gated, forwards to SW |
| `extension/background/offscreen-js-client.js` | plumb opts |
| `extension/background/service-worker.js` | `script/model-call` route (copy the actor relay's custody shape); quota counters on the run registry |
| `extension/peerd-runtime/tools/defs/script.js` | mint flag on `peerd.provider` reference; timeout tower interaction (a sub-calling run needs the delegation-sized wall-clock, same as `actorsOn`) |
| `extension/peerd-runtime/tools/defs/js-create.js` / `code-style-note.js` | one paragraph of lore: when to sub-call vs when to `runAgent` |
| cost module (`peerd-runtime/`) | `sub_call` attribution row |

## Tests

- **Bun**: quota accounting (pure counter logic); args validation/refusal
  matrix; `formatRunResult`'s `[MODEL CALLS]` line.
- **In-browser**: relay refuses without the caps flag; refuses a foreign
  `runId`; a stubbed provider round-trip returns text into the worker;
  Stop aborts an in-flight sub-call.
- **E2E verify loop**: one state with the model wire faked (the CDP Fetch
  fake already intercepts provider bytes) exercising a script that
  sub-calls once — proves custody end to end in the real SW.

## Open questions

1. Quota numbers (20 calls / turn-order token ceiling) — owner call.
2. Confirm posture: should the FIRST `provider.call` in a session require a
   user confirm (like the web-write confirm), given it spends money the
   user attributed to chat turns? Proposed: no prompt, but the cost view
   line is non-negotiable; revisit if field complaints.
3. `js_notebook` in v1 or script-only first? Proposed: script-only first,
   notebook follows once quota shape survives contact.
