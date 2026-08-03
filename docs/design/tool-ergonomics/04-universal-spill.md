# Design 4 — universal spill: one recovery path, one honest ceiling

## The problem

Two truncation facts from the audit:

1. **Exactly two spill paths exist.** `fetch_url` / `read_page mode:'content'`
   → web cache → `read_web_cache`; `script` `[VALUE]` → run cache →
   `read_run_cache`. Every other large-payload tool is **cap-and-lose**:
   `vm_boot`, `js_notebook` value, `page_code`, `a2a_run`, `site_client_run`,
   `js_read_file`, `app_read_file`, `app_list_files`, `read_state`, `snapshot`
   (partial), `read_pdf` (partial), `load_skill`. The elided middle is never
   stored anywhere.
2. **The caps fight each other.** Both spill readers page at 16,000 chars/call,
   but every tool result is then run through the global backstop
   `redact.js:42 DEFAULT_MAX_CHARS = 8000` at `agent-loop.js:874` — so **half
   of every recovered 16k page is immediately re-elided.** Per-tool budgets
   (`snapshot` 40k, `read_pdf` 50k, `fetch_url` 16k window) are largely theater
   below the 8k backstop.

The worst offenders are the guaranteed-loop tools: `js_read_file` /
`app_read_file` have NO cap, NO offset, NO spill — a 300k-char file returns
whole, gets 8k-redacted, and **re-calling returns the identical truncation**.
That is an infinite wasted-turn trap.

## The fix, in two parts

### 4a. Reconcile the ceiling (do this FIRST — it's the multiplier)

The spill readers exist to let the model page a large payload. Redacting their
output to 8k defeats them. Make the spill-reader path exempt from (or aligned
with) the global backstop:

- The cleanest fix: the global redact's 8,000 is a BACKSTOP for tools that
  *don't* paginate (its own header says so, `redact.js:38-41`). A tool that
  returns a deliberately-sized, paginated slice should not be re-cut. Give the
  redact a per-result opt-out or a higher ceiling for results that carry a
  paging footer / a `paged:true` meta marker, so a 16k `read_web_cache` /
  `read_run_cache` slice survives intact.
- Concretely: `redactToolResult` takes an optional `maxChars`; `agent-loop.js`
  passes a larger value (or `Infinity`/skip) when the dispatch result is flagged
  paged. The flag is set by the paging tools (a `meta.paged` or a sentinel).
  Keep the 8k default for everything else.
- Decide the paged ceiling deliberately: 16,000 to match the page size (one
  page in, one page out). Document that the model asked for this slice, so it
  is not untrusted-surprise volume — it's requested.

Guard: this must NOT become a firehose. Only EXPLICITLY-paged reader tools get
the raise; a normal tool returning 40k still gets 8k'd. And the fence stays:
`read_web_cache` / `read_run_cache` already `wrapUntrusted` their slices —
unchanged.

### 4b. One shared spill helper, applied to the cap-and-lose tools

Extract the duplicated spill logic (today split between `tools/web/spill.js`
and `tools/run-cache.js` + `read-run-cache.js`) into ONE reusable helper:

- `spillAndFooter({ store, key, text, budget, footerVerb, readerTool })` →
  `{ shown, footer, spilled }`. It caps `text` to a head/tail window, writes
  the full text to `store` under `key`, and returns a footer naming
  `readerTool`. This is literally what `spill.js:pagingFooter` +
  `script.js` spill do; generalize the shape.
- A generic `readSpill` tool (or extend the existing two) that pages any spill
  store by `{ key, offset, limit }` with the ownership-scoping and fencing
  `read_web_cache` / `read_run_cache` already implement. To avoid a THIRD
  reader tool (surface bloat — see design 6), prefer: reuse `read_run_cache`
  as the generic run/compute spill reader, and `read_web_cache` for web
  provenance. Route each spilling tool to whichever fits its provenance so we
  add ZERO new tools.

Then apply the helper to the cap-and-lose tools, in priority order:

1. **`js_read_file` / `app_read_file`** (highest — the infinite-loop trap).
   Add `offset` + `limit` params AND spill: a large read returns a head window
   + a footer pointing at a reader (run-cache provenance). Now a re-read can
   page instead of re-truncating. This is the Hermes "read limit 500→2000"
   fix, done properly (paged, not just a bigger cap).
2. **`vm_boot`** stdout/stderr — spill the full output, footer names the
   reader. (Complements the shims; a 100k build log becomes pageable.) Note:
   the model can also `| head` in-VM, but spill is the zero-knowledge fix.
3. **`js_notebook` value / `page_code` / `a2a_run` / `site_client_run`** — these
   already share `formatRunResult` / `pushValueBlock` with `script`; the spill
   lives in `script.execute`, not the shared formatter. Move the spill into the
   shared value path so all value-returning run tools inherit it (js_notebook
   was explicitly noted as having the cap but NOT the spill).
4. **`app_list_files` / `app_search`** — add `offset`/paging rather than a hard
   20/whole-list cut.
5. **`load_skill`** — a skill body up to 64k gets 8k-redacted today; page it (or
   at minimum spill it) so a large skill is fully reachable. (Composes with
   design 6's load_skill dedup.)

Scope discipline: 4a + items 1–3 are the high-value core and should be ONE
coherent change. Items 4–5 can be a follow-up commit if the diff grows —
`log()` what's deferred.

## Store hygiene

Both existing spill stores are 40-entry LRUs. Extending spill to more tools
raises pressure. Keep the LRUs but confirm the eviction is per-owner-safe (the
web cache already owner-scopes; run-cache owner-scopes per design 1b of the
prior batch). Do NOT raise the 40 blindly — measure. A shared helper makes the
cap a single constant to tune.

## Touch points

| File | Change |
|---|---|
| `extension/peerd-runtime/loop/redact.js` | per-result `maxChars` / paged opt-out (4a) |
| `extension/peerd-runtime/loop/agent-loop.js` | pass the paged flag/ceiling to `redactToolResult` (4a) |
| `extension/peerd-runtime/tools/web/spill.js` + `tools/run-cache.js` | extract the shared `spillAndFooter` helper (4b) |
| `extension/peerd-runtime/tools/defs/value-block.js` + `script.js` | move the value spill into the shared value path so js_notebook/page_code/a2a/site_client inherit it |
| `extension/peerd-runtime/tools/defs/js-read-file.js`, `app-read-file.js` | offset/limit + spill (item 1) |
| `extension/peerd-runtime/tools/defs/vm-boot.js` | spill stdout/stderr (item 2) |
| `extension/peerd-runtime/tools/defs/read-run-cache.js` / `read-web-cache.js` | (reuse as generic readers; raise page size to match 4a) |

## Tests

- **Bun**: `spillAndFooter` pure — caps correctly, footer names the reader,
  full text recoverable via a fake store; the paged-ceiling logic in redact
  (a paged result survives at 16k, a normal result still 8k'd); value-path
  spill shared across script/js_notebook (a large js_notebook value now spills
  + footers, matching script).
- **In-browser**: `js_read_file` on a >window file returns a head + footer;
  paging with `offset` returns the tail; `vm_boot` on a large stdout spills and
  pages. (Real OPFS / real VM.)

## Measurement (design 5)

Truncation-forced second calls are a wasted-turn class. Design 5 can count
"tool result truncated with no recovery offered" → after 4b that class
shrinks. The Hermes analogue ("44% of truncated reads become single-call") is
exactly this metric; assert it moves.

## Open questions

1. Reuse the two existing readers vs. one generic `read_cache`? Recommend
   reuse (zero new tools; provenance-appropriate fencing already differs).
2. 4a ceiling for paged results — 16,000 (match page size) vs. higher.
   Recommend 16,000; document "you asked for this slice."
3. Defer items 4–5 (list/search/skill paging) to a follow-up commit?
   Recommend yes if the core diff is already large; `log()` the deferral.
