# peerd red-team suite

A runnable check on peerd's security claims. Each scenario takes an adversary from
[`docs/security/THREAT-MODEL.md`](../../docs/security/THREAT-MODEL.md), drives the
real defense function with hostile input, and records whether the defense held. The
scenarios run in CI, and re-running them re-checks the claim against the current
code.

## What this is, and what it is not

This is evidence, not proof. The suite is a set of runnable security probes for
peerd's core invariants. It is not a complete adversarial audit.

- Most probes run at the **unit level**: they import the real production defense
  function (the egress allowlist, the denylist matcher, the SSRF guard, the
  capability strip, the gate functions, the realm seal, the bundle verifier) and
  drive it with hostile input. That proves a specific capability path is denied.
- The real Worker and iframe realm escapes cannot run in a Bun process; they are
  verified in the in-browser CDP suite (see scenario 06's `verifiedBy`).
- What the suite does **not** prove: that arbitrary real-world prompt-injection
  workflows cannot manipulate the user, poison durable memory, mislead a
  confirmation prompt, or induce a bad action that is not itself blocked by a
  gate. Those are architectural and UX questions; the threat model names the
  relevant residual risks rather than claiming they are closed.

The honest posture is: peerd has a formal threat model and CI-gated red-team
probes for its core security invariants. It is not a claim that peerd is immune
to prompt injection.

## Contents

| File | Role |
|------|------|
| `harness.ts` | The `Scenario` and `Probe` types, the runner, and the report formatter. |
| `scenarios/NN-*.ts` | One attack per file. Each `run()`s its probes against real code. |
| `index.ts` | The ordered catalog every consumer imports. |
| `red-team.test.ts` | The CI gate. `bun test ./tests` fails if any probe leaks. |
| `report.ts` | Writes `docs/security/RED-TEAM-RESULTS.md`. |

## The scenarios

| # | Attack | Defense exercised (real code) |
|---|--------|-------------------------------|
| 01 | Malicious page exfiltrates the API key | `safeFetch` exact-origin allowlist and redirect fail-closed |
| 02 | Malicious page induces a cross-origin fetch | sensitive-origin denylist and origin-bound credential gate |
| 03 | Malicious page summarizes secrets into model context | actor-loop credential custody, model-call function strip, untrusted-data fence |
| 04 | Malicious peer sends a hostile bundle | content address, Ed25519 signature, amplification guard, card caps |
| 05 | Malicious MCP server or peer poisons tools | sender gate, mesh-op validation, signing consent |
| 06 | Malicious iframe, remote module, or sandboxed code escapes | Notebook realm seal, remote-graph restricted profile and output fence, App-iframe shim, WebVM HTTP bridge |
| 07 | Private-network URL attempts SSRF | `isPrivateOrLocalHost` guard and redirect fail-closed |
| 08 | Prompt-injection benchmark versus browser-use agents | actor tool-context credential stripping, exposure and tier gates, Plan mode, denylist, fence |
| 09 | Hostile page content steers reads, writes, or egress | content disarmament, user-generated-content confirmation, egress checks |
| 10 | A moved or redirected tab retasks a web actor | origin lock, landing checks, trusted terminal reply |
| 11 | Login orchestration captures a credential | verified affordance, fixed confirmation, user-held authentication factor |
| 12 | Contributor Metrics collects without consent | versioned consent, bounded schema, exact-sender routes, no uploader |
| 13 | Page content retargets a stored site client | exact-origin client custody at gate, tool, and worker relay boundaries |

### Scenario 05 and MCP

peerd ships no MCP client. The only `mcp` string in `extension/` is a substring
inside vendored `moonshine.js`. The "malicious MCP server, tool poisoning" vector is
mapped onto peerd's real untrusted-tool-metadata surface, which is the A2A and
inbound-mesh path (agent-cards and peer messages). The scenario proves the analogous
defenses. See the scenario's `mcpMapping` field and the threat model.

## Two tiers

Most scenarios are the unit tier: they import a pure or near-pure defense function
and run it in the Bun harness. Scenario 06 also names an in-browser tier
(`verifiedBy`). The real Worker and iframe realm escape is proven by the CDP suite
(`extension/tests/unit/red-team/`, `notebook-seal.test.js`, `job-runner.test.js`),
which a Bun process cannot spawn.

## Running it

```sh
bun test ./tests/red-team        # the CI gate. Every probe must be blocked.
bun run red-team:report          # regenerate docs/security/RED-TEAM-RESULTS.md
```

The report distinguishes fully held scenarios from partial coverage with named
platform residuals, and exits non-zero if any scoped probe leaked.

## Adding a scenario

1. Write `scenarios/NN-name.ts` exporting a `Scenario` whose `run()` drives the real
   defense (import it by relative path from `extension/`) and records a `Probe` per
   hostile vector via `blocked(...)` or `leaked(...)`.
2. Import it in `index.ts`.
3. Point `threatModelRef` at an `INV-N` in the threat model.
4. `bun test ./tests/red-team` must stay green, and `bun run red-team:report`
   refreshes the published matrix.

### Honesty rule

A scenario asserts a defense that actually exists. Do not add a passing check on an
undefended surface. Those belong in the threat model's residual-risk section, not
here. If a surface is only partly defended, probe the part that holds and describe
the boundary in the evidence and the threat model.
