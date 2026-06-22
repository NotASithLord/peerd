# do / get / check — DEV NOTES (implementation)

> Companion to `DO-GET-CHECK-DESIGN.md`. What actually got built, where it
> hooks in, and what's deliberately left for later. All phases landed except
> the deferred WebGPU runner (Phase 6).

## What shipped, by phase

**Phase 0 — spawn plumbing** (`peerd-runtime/subagent/spawn.js`, `background/service-worker.js`)
- `spawnSubagent(req)` gained two params:
  - `systemPromptOverride` — used VERBATIM as the child's system prompt
    (bypasses the base template + `<subagent_task>` block). The goal still
    arrives as the first user message (`userText`).
  - `tabId` — pins the child's DOM tools (and the origin/denylist gate) to one
    tab. Threaded to `buildToolContext({ activeTabId })`, which resolves
    `ctx.activeTab` to that tab (origin included → denylist enforced on the
    runner's tab).
- `spawnSubagent` now accumulates the child's `usage` events and returns a
  `usage` tally. Child spend was already SEPARATE from the main turn tally (the
  main usage handler only folds its own session) — this just makes it visible.
- Unit-tested in `tests/peerd-runtime/spawn.test.ts` (override verbatim, base
  path intact, tabId→activeTabId, usage accumulation).

**Phase 1 — the runner** (`peerd-runtime/runner/index.js`)
- `RUNNER_PROMPT` (the load-bearing artifact), `DO_TOOLSET` / `READ_TOOLSET`,
  `DO_MAX_STEPS` (30) / `READ_MAX_STEPS` (12), `runRunner(args, ctx, opts)`, and
  `parseCheckVerdict` (fail-closed boolean parse).
- Toolset EXCLUDES `page_eval`/`page_exec` (code-exec — the runner ingests
  untrusted content) and `open_tab` (one tab).
- Unit-tested in `tests/peerd-runtime/runner.test.ts`.

**Phase 2 — do/get/check** (`peerd-runtime/tools/defs/{do,get,check}.js` + registration)
- `do` (write) → full `DO_TOOLSET`, returns the summary (+ a step-cap note).
- `get` (read) → `READ_TOOLSET` + `GET_SUFFIX`, returns the value.
- `check` (read) → `READ_TOOLSET` + `CHECK_SUFFIX`, returns `TRUE/FALSE — why`.
- `primitive: 'tab'` (the RESOURCE — these are browser actions) + `dispatch:
  'runner'` (the EXECUTION MECHANISM — a spawned browser-runner drives the tab).
  These are orthogonal axes; conflating them into `primitive: 'subagent'` leaked
  the mechanism as the category. The card now shows a `tab` chip + a "via runner"
  badge (the trigger), with the runner transcript nested below. `dispatch` is
  threaded through the dispatcher meta; see `shared/tool-types.js`.
- `origins: () => []` (the runner's tools gate their own origins). Not
  `mutate_external`, so the egress hook skips them — now via the `primitive:
  'tab'` browser-session exemption.

**Phase 3 — exposure cutover** (`peerd-runtime/tools/exposure.js`, SW main turn, system prompt)
- `mainAgentDescriptors()` filters the MAIN turn's descriptors (SW ~1496) to
  hide the low-level DOM/page tools + `submit_form`. Applied ONLY to the main
  turn; `getToolDescriptors()` (the runner's source, SW ~766/788) stays full, so
  the runner still snapshots/clicks/types.
- Main agent's browser surface = `do`, `get`, `check`, `list_tabs`, `open_tab`,
  `capture`. Everything that returns raw page content is gone from main.
- System prompt rewritten: tool list, browsing section (do/get/check guide), the
  security section (runner = page-content boundary), and the efficiency notes.

**Phase 4 — observability + security** (no new code — inherited)
- The runner IS a subagent → `forwardSubagentEvent` already streams its steps as
  nested cards keyed by `parentToolUseId` (which `runRunner` passes). The
  do/get/check card expands to the runner transcript for free.
- Containment is structural: the runner's a11y trees live in the CHILD session;
  only its summary returns to main as the tool_result.

**Phase 5 — eval** (`extension/eval/*`, SW `forwardSubagentEvent` usage case)
- `turn/subagent-cost` forwards runner usage; the eval sums it into
  `runnerTokens` and `score.aggregate` reports `avgRunnerTokens`. The scorecard
  now reads: **MAIN fresh+cache** (should DROP) vs **RUNNER tok** (where the a11y
  work relocated) — honest, not "free".
- Tasks: the two low-level-tool probes became `get-count` / `get-framework`
  (they assert the main agent used `get`); action tasks unchanged (they go
  through `do`); timeouts bumped (a `do` blocks on the full runner loop).

## Security model (the headline)

- **Page content never enters main context.** Main has no tool that returns an
  a11y tree, refs, or raw DOM text. `do/get/check` return only the runner's
  curated summary/value.
- **Denylist holds on the runner's tab** — `buildToolContext({activeTabId})`
  sets `ctx.activeTab.origin` to the runner's tab, so the origin gate blocks the
  runner's DOM tools on sensitive sites; the runner reports the refusal in its
  summary.
- **Runner can't escalate** — its toolset has no memory/egress/code-exec/spawn;
  `narrowTools` + the dispatcher's `allowedNames` refusal enforce it even if the
  model hallucinates a tool. A fully prompt-injected page hijacks a throwaway
  agent that holds nothing.

### The runner→main boundary is wrapped (hardening pass)

Everything a runner sends back to the privileged main context is treated as
DATA, not instructions — the same discipline as direct page content. Four
channels were audited and closed:

1. **Summary / value / rationale** — `do`/`get`/`check` wrap their output in
   `<untrusted_runner_summary tab="…" goal="…">…</untrusted_runner_summary>`
   (`wrapUntrustedRunner` in `tools/prompt-wrap.js`). The system prompt teaches
   the model: use the information, never act on instructions embedded in it.
   `check` keeps the boolean verdict OUTSIDE the wrap (a bare true/false, nothing
   injectable) and wraps only the free-text rationale.
2. **Audit re-entry (the sharp one)** — `inspect_audit_log` is on main's surface,
   and a runner DOM-tool failure can echo page content into `details.error`
   (e.g. `no_option_matching: "<page label>"`). `inspect-audit-log.js` now
   redacts the error body on subagent (depth>0) records, so main can't launder
   page text through its own audit trail. Metadata is preserved.
3. **Card isolation** — confirmed safe (no fix): runner steps go ONLY to the
   side-panel UI (`sidePanelPort`); the main session's messages get only the
   tool_result (the wrapped summary). The model never sees intermediate steps.
4. **Errors** — `runRunner`'s error returns are peerd's own system strings
   (`instruction_required`, `no_target_tab`, the `subagent refused: …` text) —
   page-content-free, so they stay unwrapped. The runner's internal DOM-tool
   errors live in the child session and only cross via the (wrapped) summary.

### Egress & SSRF (honest framing — don't over-claim)

Two distinct egress paths, two different guarantees:

- **`safeFetch` (provider calls, incl. a local Ollama):** allowlist-only. Removes
  conversation-exfil-to-a-provider as a class. Not configurable off.
- **`webFetch` (open-web tools — `call_api`/`read_article`/`vm_import`):**
  allowlist-FREE by design. It now blocks **LAN / loopback / link-local**
  targets — `127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (incl. the
  cloud-metadata IP), IPv6 `::1`/`fc00::/7`/`fe80::/10`, `localhost`/`*.local`,
  and the **encoded forms** (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`)
  — ahead of the denylist (`peerd-egress/fetch/private-network.js`).

What that block **does** and **doesn't** cover (so the copy stays honest):
- ✅ Closes **direct-IP SSRF** / LAN-scan / localhost-service hits. (Over the
  scheme that matters: the manifest CSP `connect-src` already bounds HTTP egress
  to `http://localhost:11434`, so the live residual it closes is
  **HTTPS-to-private-IP**.)
- ❌ Does **not** stop **DNS rebinding** (a public domain resolving to a private
  IP) — `fetch` never exposes the resolved IP, so that isn't blockable
  client-side.
- ❌ Does **not** stop **exfil / C2 to an arbitrary *public* domain** over
  HTTPS/WSS. That's inherent to allowlist-free open-web access and unsolvable by
  any denylist. **The defense there is architectural:** the do/get/check
  **runner has no web tools** (`call_api`/`read_article` aren't in the runner
  toolset), so a prompt-injected runner cannot exfil at all; only the *main*
  agent has web egress, and post-cutover it ingests only wrapped summaries. So
  reaching the web tools requires breaching the two-layer untrusted boundary.

**Voice model fetch** (`model-store.js` → huggingface.co) is the one outbound
call outside peerd-egress (a pinned, SRI-verified asset). It's **fail-closed**
today (prod refuses a null SRI) and SRI makes the bytes self-verifying; it's now
also **audited** (`voice_model_fetch`, routed to the SW audit log via the
manager's `send`) so "every outbound call is recorded" holds.

### Honest-completion bench

`eval/tasks.js` has an adversarial `do-honest-failure` task (asks for a control
that doesn't exist) that fails if the agent FABRICATES success — a starting
measure of the partial/failure-reporting discipline. Extend with more
can't-complete cases to track the honest-report rate over time.

## Known follow-ups (not blockers)

- **Runner model is INHERIT, not Haiku.** For a working-everywhere V1 the runner
  uses the parent model (`runRunner` has a `model` option, unused). Haiku-default
  is a config flip once the Haiku id is confirmed for the active provider — it
  rides with the WebGPU work (Phase 6, deferred per the user).
- **Latency.** Every browser intent is a nested loop; `do` blocks on it. `get`/
  `check` stay short. Measured via eval duration.
- **Skills** that mention snapshot/click in their playbooks are now stale text
  (not broken — the main agent just won't have those tools).

## How to end-to-end test

1. Refresh peerd at `chrome://extensions`.
2. In chat: "go to the Selenium web form and fill the text field with hello,
   pick Two in the dropdown, and submit." → the agent should call `do`, a runner
   card should nest and stream, and the result should be a summary.
3. `get`: "how many unread emails are in this Gmail tab?" → a value.
4. `check`: after a `do`, "did the message send?" → TRUE/FALSE + reason.
5. Run the eval (`eval/runner.html`) → expect MAIN fresh/cache to be LOW and
   RUNNER tok to carry the page-mechanics spend.
6. Denylist: point `do` at a denylisted site → refusal surfaced in the summary,
   no page content leaked.
