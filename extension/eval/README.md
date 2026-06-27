# peerd eval harness

Turns "does it work?" into a number. Runs a suite of real web/agent tasks
against the **live** peerd agent loop and scores the end state — so you can
measure whether a change actually helped instead of vibing it.

## How it works

`runner.js` is an automated user. For each task it:

1. `session/reset` → fresh session,
2. navigates the active tab to the task's `startUrl`,
3. `agent/send` the task prompt (driving the real SW loop, gates, tools, model),
4. awaits the turn (`turn/streaming: false` on the side-panel port),
5. captures the **end state** — final tab URL/title/text + the agent's last
   answer + which tools ran + steps/tokens/duration,
6. runs the task's `check(state)` → pass/fail.

It tests peerd exactly as a human triggers it — nothing is mocked.

## Running it

1. Load the extension (`chrome://extensions`, dev mode, load unpacked).
2. Open the side panel and **unlock the vault** (the loop needs the provider key).
   Use a cheap model if you want — the suite is 30 tasks × a few turns each.
   (The two `vm-*` tasks boot a Linux VM and dominate wall-clock; the long
   `multitab-*`/`edit-file-*` tasks run many turns. Budget accordingly.)
3. Open the harness page:
   `chrome-extension://<your-extension-id>/eval/runner.html`
   (extension id is on the `chrome://extensions` card).
4. Click **Run all tasks**. Watch the log; the **scorecard** (passRate +
   avg steps/tokens/duration) prints at the end and to the devtools console.
5. Don't touch the side panel mid-run — this page owns the SW port.

## Reading the score

- **passRate** is the headline. Compare it before/after a change.
- **the token split** is the efficiency picture, and it's deliberately *not*
  one number. A single collapsed total conflates two very different things:
    - **avgFreshTokens** (`avgInputTokens` + `avgOutputTokens`) — full-price
      input+output. This is the real $ driver *and* the real context-window
      pressure. **This is the number to drive down.**
    - **avgCacheReadTokens** — the static system-prompt + ~50 tool schemas (the registered set),
      re-read every turn but billed at ~10% of input. A big number here is
      cheap and expected; it is *not* the same problem as fresh bloat.
    - **avgCostUsd** — actual `$/task`, computed client-side from the local
      pricing table. The honest answer to "is this expensive?" (spoiler: a
      46k-"token" turn that's mostly cache-read costs a fraction of a cent).
  Why this matters: it tells you whether a high token count is a **dollar**
  problem (drive down fresh) or just a large-but-cached static block (leave
  it). Optimizing the wrong one is wasted effort.
- **avgSteps / avgDurationMs** round out efficiency.
- **failures** list the `id` + `detail` so you can see *why* each failed.

## Catching regressions (baseline diff)

peerd has no deploy step to hang "run evals on every deploy" off (eve's
model), and no backend to stash a shared baseline in — so the regression
loop is local and explicit, which is the only honest shape for a BYOK,
in-browser agent (your score is tied to *your* model + key + page state):

1. Run the suite, eyeball it, then **Pin as baseline** (stored in
   `localStorage`, survives reloads).
2. Change a thing — a system-prompt tweak, a model swap, a tool change.
3. **Run all tasks** again. The harness shows a **Δ vs baseline** line and,
   loudly, any **regressions** — tasks that were passing and now aren't.
   Fixes (newly passing) are credited too.

`score.compare(before, after)` is the pure function behind that line: it
returns `{ regressions, fixes, passRateDelta, freshTokensDelta,
runnerTokensDelta, costUsdDelta, stepsDelta, durationMsDelta }`. Deltas are
`after − before`, so a positive `passRateDelta` and a **negative**
`costUsdDelta`/`freshTokensDelta` are the wins. Regressions are derived from
each scorecard's `failures` id set, so the diff assumes the same `tasks.js`
across both runs.

## The task suite

30 tasks, all objective, grouped by what they probe:

- **Single-skill browser probes** — click→nav, type+submit, search→article
  (`wikipedia-search`, `wiki-search-babbage`), `get`-extraction
  (`get-count`, `get-framework`, `get-wiki-born`, `get-byron-death`,
  `get-example-heading`), the `check` verdict tool (`check-assertion`),
  a textarea round-trip (`selenium-textarea-submit`), and a new-tab probe
  (`open-tab-title`).
- **Compute** — the agent's own substrate, no web page: headless-worker math
  with non-memorizable answers (`js-sum-squares`, `js-json-extract`,
  `js-array-stats`, `js-base64`), a Notebook build+run (`notebook-fib`), and
  two WebVM shell tasks (`vm-python`, `vm-arithmetic`).
- **Grounding** — the clock tool (`clock-now`) and the memory READ path
  (`read-memory`). (We deliberately don't probe `remember` — writes are
  confirm-gated and this headless runner can't answer a confirmation prompt,
  so it would stall. Same reason `app_*` rendered-output and live web-search
  tasks are held back — see *Limits / next*.)
- **Long, multi-step** — tasks that force the snapshot→act→snapshot→act loop
  across many tool calls (where the do/get/check layering's benefit or any
  regression shows up most): `wiki-hop` + `wiki-hop-reverse` (multi-hop nav),
  `selenium-multifield` (three field types), `multitab-compare-births` (two
  tabs + reason over them), and `edit-file-flow` (create→run→`edit_file`→re-run).
- **Adversarial honesty** — the do/get/check contract is HONEST reporting, so
  these probe whether the agent SAYS it can't rather than fabricating success:
  `do-honest-failure` (nonexistent button), `get-honest-missing-field`
  (nonexistent form field), `no-fabricate-fact` (a phone number that isn't on
  the page), and `nav-no-such-article` (an article that doesn't exist).

Every check keys on objective, path-independent end state (final URL / title /
submitted query string / a deterministic answer string + the tool trace).
Targets stay on proven-stable hosts (Wikipedia, the Selenium demo form,
example.com) so the suite doesn't add live-drift flakiness.

## Adding a task

Add to `tasks.js`. Keep checks **objective** and on the **end state**
(path-independent):

```js
{
  id: 'my-task',
  title: 'short label',
  startUrl: 'https://…',          // or null to start wherever
  prompt: 'what to ask peerd',
  timeoutMs: 75_000,
  // state: { tabUrl, tabTitle, tabText, answer, steps, tools[], tokens, durationMs, error }
  check: (s) => includesCI(s.tabUrl, 'expected') ? ok('detail') : no('what went wrong'),
}
```

Check helpers live in `score.js`: `includesCI(haystack, needle)`, `ok`/`no`,
and `usedAny(s.tools, ['get', 'js_run'])` — assert the agent took the right
PATH (used `get` to inspect rather than guessing, ran code to compute) where
the value alone wouldn't prove it. Prefer answers that are **non-memorizable**
(a computed total, a base64 string) or **page-dependent** so a tool assertion
isn't punishing a correct-but-recalled answer. For honesty/refusal tasks, use
the shared `honest(answer, claimRe, detail)` helper in `tasks.js`: it passes
unless a fabrication pattern fires *without* a hedge (lenient by design — never
false-fail a correct refusal).

## Limits / next

- **Hard checks only (objective).** Open-ended tasks ("summarize X") want an
  **LLM-judge** variant (send task + end state to the model, ask yes/no) — a
  clean follow-up. A ready first candidate is a value-extraction task (verified
  live: "what is the Eiffel Tower's height in metres" → 330 m); it was kept out
  of the objective suite on purpose because answer-extraction is softer than a
  URL/query-string check, and it's the natural seed for the judge variant.
- **Deliberately held back** (need infra this headless runner doesn't have):
  `remember` and any other confirm-gated tool would stall waiting on a
  confirmation prompt this automated "user" can't answer; `app_*` rendered
  output isn't visible in the end state (the App runs in its own opaque-origin
  iframe); a live `fetch_url` (or the web actor driving a tab) is nondeterministic
  and egress-gated. These are better served by the LLM-judge variant
  and a richer end-state capture — the "Tier 2 / comparison" direction.
- The pure parts (`score.js` aggregate/compare) are unit-tested under Bun;
  the runner needs a real browser + unlocked vault, so it's run by hand
  (that's the nature of an end-to-end web-agent eval).
