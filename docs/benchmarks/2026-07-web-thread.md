# The web thread, measured: Online-Mind2Web, the code-REPL A/B, and the content pipeline

*A point-in-time benchmark report, July 2026. Numbers below are from the dated runs cited
in each section — re-run the commands to reproduce; the harness lives in this repo.*

peerd's premise makes web benchmarks awkward on purpose: **the agent runs entirely in your
browser** — BYOK, no backend, no hosted scraper, no telemetry. Every result below was
produced by the shipping extension driving real pages, measured by infrastructure that is
itself in this repo. As far as we know, peerd is the only *browser-extension* agent
publishing numbers on a public web-agent benchmark.

---

## 1. The baseline: Online-Mind2Web, first 30 tasks

[Online-Mind2Web](https://github.com/OSU-NLP-Group/Online-Mind2Web) (OSU, 2026) is the
credible public benchmark for live-web agents: 300 tasks on real sites, judged by the
benchmark's own WebJudge (o4-mini, ~86% human agreement). We built a full adapter — gated
dataset importer (pinned revision `6aa56e07`), schema-v2 trajectory exporter with per-step
after-action screenshots, sharded/resumable driver, and a scoring wrapper that runs the
authors' own judge.

**peerd (Opus 4.8, tool-call surface): 8/30 = 26.7%.**

Context: browser-use's independently verified score is ~40% (full 300, Princeton HAL);
purpose-built hosted agents report ~88%. A 30-task subset carries roughly ±8pp noise. The
honest positioning is not "we beat everyone" — it's *the first extension-native number on
this benchmark, with the failure taxonomy that says exactly where the next points are*:

| Failure mode (22 fails; categories overlap) | Count | Meaning |
|---|---|---|
| Hit the 25-step cap mid-task | 6 | step-inefficiency, not capability |
| Near-cap thrash (20–25 steps) | 3 | same |
| Incomplete final action | 9 | found the info, skipped add-to-cart / a filter |
| Wrong/other | 7 | genuine misses |

Categories are **non-exclusive** — a task that ran to the cap *and* skipped its final action
is counted under both, so the column sums above the 22 fails rather than partitioning them.

Budget exhaustion dominates. **Efficiency is the lever**, which drove both experiments below.

## 2. The A/B: does writing code beat calling tools? (PR #119)

Hypothesis (after Aside's approach): the web actor drives pages better by *writing
Playwright-style JS* (`page.goto/click/fill` in a sealed, capability-stripped REPL) than by
emitting discrete tool calls — fewer round-trips, fewer cap deaths.

On drift-free local fixtures, the code arm won. On the same 30 live OM2W tasks, judged
identically:

| | tool-call | code-REPL |
|---|---|---|
| Pass rate | **26.7%** (8/30) | 20.7% (6/29)† |
| Median steps/task | 11 | 14 |
| 25-step-cap deaths | 6 | 8 |
| Tasks won that the other arm lost | 2 | **0** |

† One code-arm run did not complete scoring (harness hang, see §4), so 29 of the 30 tasks
were scored in that arm; the tool-call arm scored all 30.

**Verdict: the code arm loses on live sites.** Long blind scripts drift when pages change
under them; the write-code-then-look loop costs more round-trips than it saves. The code
surface ships default-off as an experimental setting; the durable value is the harness and
the measurement integrity work (an earlier 33.3% code-arm reading was a recording artifact
— the judge couldn't see inside `page_code` calls — caught, fixed, retracted).

Negative results with the infrastructure that produced them are how the numbers stay
believable.

## 3. The content pipeline: extraction + spill-and-page (PR #187, merged)

The failure taxonomy says budget exhaustion; the biggest budget hole was `fetch_url`
returning up to 16k chars of **raw HTML** — boilerplate ate the window, and everything past
16k was silently discarded. Hosted agents solve this with scraping APIs (Firecrawl et al.);
peerd can't and won't — so the fix is **client-side**: Mozilla Readability + Turndown,
vendored and pinned, extracting the readable core as markdown in the extension's offscreen
document. Oversized bodies now **spill-and-page**: full text stored locally, the model sees
a head+tail window plus the exact paging call to read on.

Measured on a fetch-task suite (Haiku 4.5, before/after on adjacent commits):

| | before (raw HTML) | after (extraction + paging) |
|---|---|---|
| Pass rate | 60% (3/5) | **100% (5/5)** |
| Cost per **solved** task | $0.0557 | **$0.0444 (−20%)** |
| Actor tokens, pages that fit the budget | — | **−57–59%** |
| Actor tokens, oversized pages | — | higher — *by design* |

The split is the story: where a page fits, extraction cuts tokens ~57–59%. Where it
doesn't, the old behavior was *cheap because it was broken* — the agent answered from a
truncated head and failed. Paging spends more tokens to be correct, which is where the
+40pp pass rate comes from. Known rough edge: one task showed a paging loop (flagged for
tuning; BM25 query-relevant excerpting is the planned next step).

## 4. What the benchmarks fixed on the way

Running honest benchmarks against a real extension surfaced real product bugs, all fixed:

- **"New chat" leaked live actors** — `session/reset` never stopped the abandoned
  session's delegated work; zombie actors accumulated until the whole extension stalled.
- **A hung page could hang an actor forever** — an un-timed CDP call is abort-immune
  (product fix tracked in #176; the harness works around it).
- **Async scoring** — a delegated task's answer arrives on a *later* turn than the
  delegation ack; scoring at first-idle graded the ack (and bled real answers into the
  next task's window).
- Plus: a provider 400 on models without adaptive thinking, invisible actor spend in the
  cost telemetry, and assorted harness robustness (deadline-bounded awaits, Chrome
  recycling, screenshot integrity validation).

## Reproduce

```bash
# Online-Mind2Web (needs HF_TOKEN for the gated dataset, an Anthropic key to run,
# an OpenAI key to judge):
bun scripts/cdp/om2w/fetch-tasks.mjs
bun scripts/cdp/run-om2w.mjs --model=claude-opus-4-8 --offset=0 --count=30 [--actor-surface=code]
bun scripts/cdp/om2w/score.mjs --run=6aa56e07[-code]

# The content-pipeline before/after (any Anthropic key):
bun run eval:bench -- --provider=anthropic --model=claude-haiku-4-5 --suite=fetch [--baseline=<scorecard>]

# $0 integrity checks (no keys):
bun scripts/cdp/diagnose-page-code.mjs
bun scripts/cdp/diagnose-actor-spend.mjs
bun run eval:bench:smoke
```

Primary sources: the A/B verdict and per-task data on
[PR #119](https://github.com/NotASithLord/peerd/pull/119), the extraction measurements on
[PR #187](https://github.com/NotASithLord/peerd/pull/187).
