# Design 1 — a durable workspace for `script`, and a spill path for big values

## Problem

`script` is the main agent's only code hand, and it is deliberately amnesiac:
every call is a fresh sealed worker with an ephemeral OPFS scratch at
`['peerd-jobs', jobId]`, nuked in the runner's `finally`
(`offscreen/job-runner.js`). Its `[VALUE]` block is capped at the source
(`tools/defs/value-block.js`) and the whole result is head+tail truncated by
the loop (`loop/redact.js`), with **nowhere to spill** — unlike `fetch_url`,
whose overflow goes to a cache the actor can page (`tools/web/spill.js`,
`tools/defs/read-web-cache.js`).

Net effect: the agent cannot stage intermediate data across turns, build a
dataset over several runs, or write a large result somewhere and page through
it. Bash's superpower is half "run commands", half "the environment persists".
We have the first half.

Two separable deliverables, one PR each:

- **1a. The workspace** — an opt-in durable OPFS root for `script`.
- **1b. The run cache** — spill oversized `[VALUE]`s and page them back.

---

## 1a. The workspace

### Shape

- New optional tool arg on `script`: `workspace: true` (default absent/false).
- When set, the SW-side tool passes `workspaceSessionId: ctx.session.sessionId`
  in the job opts (trusted side — the worker never names it; invariant 2).
- `_runJob` mounts `['peerd-workspace', workspaceSessionId]` as the OPFS root
  instead of `['peerd-jobs', jobId]`, and **skips the nuke** for workspace
  runs. `opfsHelpers` (`peerd-engine/opfs.js`) already takes an arbitrary
  root — no engine change needed.
- Worker API is unchanged: `peerd.self.readFile/writeFile/listFiles` just
  point at the durable root for that run. No new globals (DECISIONS #21
  spirit: no ambient magic; the *tool arg* is the visible switch).

Why opt-in rather than always-durable: the ephemeral default keeps
pure-compute runs reproducible and leak-free, and it matches the existing
"mint the capability only when the code wants it" pattern (`actorsOn` in
`tools/defs/script.js`). The tool description grows one sentence:
"pass `workspace: true` to run against your durable session workspace
(files persist across runs and turns; output re-enters fenced)."

### Scoping: session, not profile (for now)

Root by owning session id, mirroring how `scriptRuns` and the web-cache
ownership stamp are keyed (`tools/defs/read-web-cache.js` refuses another
session's key). Cross-session sharing is exactly the laundering channel the
heap split exists to prevent — don't build it. When Profiles land, the root
gains a profile prefix along with everything else.

### The fencing rule (the danger-zone call)

A workspace file is not reliably agent-authored: an earlier `workspace:true`
run may have written fetched bytes into it. This is the same reasoning that
made instance-file *reads* actor-only (owner call 2026-07-05, noted in
`tools/exposure.js`). But `script` is a *main-agent* tool, so the equivalent
containment isn't available — the fence is.

**Rule: any `workspace:true` run's output body is wrapped in
`wrapUntrusted` unconditionally**, origin label `script (workspace files)`
(joined with the existing egress/actors labels when both apply). Extend
`RunResult` with `usedWorkspace` (set host-side by the runner whenever the
job was workspace-mounted — not inferred from ops) and OR it into the fence
condition in `formatRunResult` (`tools/defs/script.js`).

Rejected refinement: fence only when the run performed an OPFS *read*. It
saves fences on write-only runs but makes the security property depend on
correctly classifying every relay op forever. Unconditional is one line and
survives new ops. Revisit only if fence fatigue shows up in the field.

### Hygiene and limits

- **Per-write cap** at the relay: refuse `opfs-request` writes over the same
  per-file ceiling `js_write_file` uses (`tools/defs/js-write-file.js`), so
  worker-side writes can't dodge the tool-side cap.
- **Total-size soft cap**: on workspace mount, `opfs.list()` and sum; over
  the ceiling (propose 200 MB), the run still executes but the result gets a
  tool-authored `[WORKSPACE OVER BUDGET — delete files]` line, and writes
  are refused for that run. Cheap, no new bookkeeping store.
- **Lifecycle**: nuke `['peerd-workspace', sid]` where the session is
  deleted (the SW session-delete route), alongside whatever else session
  deletion tears down. Also expose the workspace in the session's storage
  accounting if/where the UI grows one (follow-up, not this PR).

### What the agent sees

`listFiles` output and file reads arrive inside the run (fenced with the rest
of the output). No new main-agent read tool — the workspace is reached only
*through* `script`, keeping one entry point and zero new exposure rows. (A
`workspace_read` tool would be a second door through the fence; refuse the
temptation.)

---

## 1b. The run cache (value spill + paging)

### Shape

Mirror the web spill exactly, one tier down:

- New store `runCache` (IDB, SW-side), shaped like the web-extract cache:
  `{ key, ownerSessionId, fenced, originLabel, text, createdAt }`, LRU-capped
  at the same order of entries as the web spill (see `tools/web/spill.js` for
  the live number — reuse its eviction helper if it extracts cleanly).
- In `pushValueBlock` (`tools/defs/value-block.js`): today's truncation note
  stays, but the caller (`formatRunResult`) gains a spill step — when the
  serialized value exceeds the cap, write the FULL text to `runCache` under
  `run:<runId or toolUseId>` stamped with the session and the run's fence
  state, and append a footer naming the key and the paging tool.
- New main-agent tool `read_run_cache { key, offset, limit }`, a near-copy of
  `read_web_cache` (`tools/defs/read-web-cache.js`): same ownership refusal
  (`ownerSessionId` mismatch → refuse), same per-slice ceiling, same
  "page deliberately" description. One difference: fencing is *conditional* —
  the record's stored `fenced` flag decides whether the slice re-enters
  wrapped (a spilled value from a pure-compute run is the agent's own bytes;
  a spilled value from an egress/actors/workspace run is not).

### Exposure

`read_run_cache` is a plain main-agent tool (`sideEffect: 'read'`,
`origins: () => []`). It must ALSO be callable by whoever ran the code that
spilled — `js_notebook` results share `formatEvalResult`'s value block, so
the notebook actor wants it too. Add it to `ENGINE_ACTOR_TOOLS.notebook`
**only if** notebook spill is wired in the same PR; otherwise keep the first
PR `script`-only and let the ownership stamp (session-scoped) do the
containment either way.

### Explicitly out of scope

- Spilling `[CONSOLE]` — console is already advisory; a run wanting bulk
  output should `return` it or write a workspace file.
- Cross-run querying of the cache (grep-the-cache). The workspace is the
  place for durable data the agent wants to compute over; the cache is a
  window onto one oversized value.

---

## Touch points

| File | Change |
|---|---|
| `extension/peerd-runtime/tools/defs/script.js` | `workspace` arg; pass `workspaceSessionId`; fence on `usedWorkspace`; spill step in `formatRunResult` |
| `extension/offscreen/job-runner.js` | workspace mount + skip-nuke; per-write cap + budget check on `opfs-request`; set `usedWorkspace` |
| `extension/background/offscreen-js-client.js` | plumb the new job opts |
| `extension/peerd-runtime/tools/defs/value-block.js` | return overflow info instead of only truncating (pure change, keeps Bun-testability) |
| new `extension/peerd-runtime/tools/run-cache.js` | the store (injected-IDB shape, copy `site-clients/store.js` discipline) |
| new `extension/peerd-runtime/tools/defs/read-run-cache.js` | the paging tool |
| `extension/peerd-runtime/tools/defs/index.js` | register `read_run_cache` |
| `extension/background/service-worker.js` | inject `runCache` into tool ctx; session-delete → workspace nuke |
| `extension/peerd-runtime/permissions/policy.js` | nothing (read tool classifies as read) |

## Tests

- **Bun**: fence decision matrix (`usedWorkspace`/`usedEgress`/`usedActors`
  combinations) as a pure test over `formatRunResult`; `value-block` overflow
  contract; `run-cache` store over fake-indexeddb (copy the site-client
  store's test harness); ownership refusal in `read_run_cache`.
- **In-browser** (`extension/tests/`): job-runner mounts the workspace root,
  skips nuke, enforces the write cap; a second run sees the first run's file;
  session-delete nukes the subtree.
- **E2E**: one new state only if a UI surface changes (none planned).

## Open questions for the owner

1. 200 MB soft budget — right order of magnitude? (OPFS quota is
   origin-global; the browser will backstop us regardless.)
2. Should `workspace:true` runs *also* keep the ephemeral scratch mounted at
   a reserved subpath (e.g. `tmp/`, nuked per-run)? Proposed: no — one root,
   one rule; the agent can maintain its own `tmp/` convention.
3. Notebook value spill in 1b's first PR, or follow-up? Proposed: follow-up.
