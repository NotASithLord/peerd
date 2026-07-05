# peerd red-team suite

An **empirical** answer to "is peerd actually safe?" — a catalog of attack
scenarios, each one casting an adversary from
[`docs/security/THREAT-MODEL.md`](../../docs/security/THREAT-MODEL.md) as
executable code that drives the **real** defense function with hostile input and
records whether the defense held.

A security claim nobody can run is a slogan. This suite makes peerd's claims
testable: every scenario is wired to CI, and re-running it re-proves the claim
against the current code.

## What's here

| File | Role |
|------|------|
| `harness.ts` | The `Scenario` / `Probe` shape and the runner + report formatter. |
| `scenarios/NN-*.ts` | One attack per file; each `run()`s its probes against real code. |
| `index.ts` | The ordered catalog every consumer imports. |
| `red-team.test.ts` | The **CI gate** — `bun test ./tests` fails if any probe leaks. |
| `report.ts` | Writes `docs/security/RED-TEAM-RESULTS.md` — the published proof. |

## The scenarios (the brief, made executable)

| # | Attack | Defense proven (real code exercised) |
|---|--------|--------------------------------------|
| 01 | Malicious page exfiltrates the API key | `safeFetch` exact-origin allowlist + redirect fail-closed |
| 02 | Malicious page induces a cross-origin fetch | sensitive-origin denylist + origin-bound credential gate |
| 03 | Malicious page summarizes secrets into model context | keyless actor heap + model-call function strip + untrusted-data fence |
| 04 | Malicious peer sends a hostile bundle | content-address + Ed25519 signature verify + amplification guard + card caps |
| 05 | Malicious MCP server / peer poisons tools | sender gate (inbound wall + lineage taint) + mesh-op validation + signing consent |
| 06 | Malicious iframe / sandboxed code escapes | Notebook realm seal + App-iframe shim + WebVM HTTP bridge |
| 07 | Private-network URL attempts SSRF | `isPrivateOrLocalHost` guard + redirect fail-closed |
| 08 | Prompt-injection benchmark vs. browser-use agents | keyless heap + exposure/tier gates + Plan mode + denylist + fence |

> **On scenario 05 and MCP:** peerd ships **no MCP client** (verified — the only
> `mcp` string in `extension/` is a coincidental substring in vendored
> `moonshine.js`). The "malicious MCP server → tool poisoning" vector is therefore
> mapped onto peerd's real untrusted-tool-metadata surface: the A2A / inbound-mesh
> path (agent-cards + peer messages). The scenario proves the **analogous**
> defenses. See the scenario's `mcpMapping` field and the threat model.

## Two tiers

Most scenarios are **unit tier**: they import a pure/near-pure defense function
and run it live in the Bun harness. Scenario 06 also names an **in-browser tier**
(`verifiedBy`) — the real Worker/iframe realm escape is proven by the CDP suite
(`extension/tests/unit/red-team/`, `notebook-seal.test.js`, `job-runner.test.js`),
which a Bun process cannot spawn.

## Running it

```sh
bun test ./tests/red-team        # the CI gate — every probe must be blocked
bun run red-team:report          # regenerate docs/security/RED-TEAM-RESULTS.md
```

The report prints a per-scenario summary and exits non-zero if any probe leaked,
so it doubles as a stricter local check.

## Adding a scenario

1. Write `scenarios/NN-name.ts` exporting a `Scenario` whose `run()` drives the
   **real** defense (import it by relative path from `extension/`) and records a
   `Probe` per hostile vector via `blocked(...)` / `leaked(...)`.
2. Import it in `index.ts`.
3. Point `threatModelRef` at an `INV-N` in the threat model.
4. `bun test ./tests/red-team` must stay green; `bun run red-team:report` refreshes
   the published matrix.

### Honesty rule

A scenario asserts a defense that **actually exists**. Do not manufacture a green
checkmark on an undefended surface — those belong in the threat model's **Known
residual risks** section, not here. If a surface is only partially defended, probe
the part that holds and describe the boundary in the evidence and the threat model.
