# Local-first personal-data agent

> Forward-looking spec. The agent walks the user's **authenticated** web accounts
> in-session, builds a searchable index of them **on device**, and answers
> questions over it — **with zero bytes leaving the machine**.

## What it is

"How much did I spend on X across all my cards last year?" — answered from the
user's own logged-in accounts (order history, statements, calendar, receipts:
surfaces with **no API or export**), where the index of that most-sensitive data
is **physically incapable of being exfiltrated**.

A cloud agent (Operator and friends) would have to ingest those accounts into its
server to index them — the exact trust transfer peerd refuses. This is the most
defensible "only-possible-on-peerd" direction: it dies if you remove any one of
in-session browser context, on-device sandboxed compute, or no-backend.

## It is assembled from shipped primitives — no new engine

| Role | Primitive (all shipped) | Files |
|---|---|---|
| **Harvest** | the `do`/`get`/`check` runner reads the authenticated tab in-session; the disposable, tab-pinned runner subagent is the prompt-injection boundary (page text never reaches the main context) | `peerd-runtime/runner/index.js`, `tools/defs/{do,get,check}.js`, `dom/walk-injected.js` |
| **Store** | a durable Notebook OPFS subtree at `['peerd-notebooks', <id>]` written via `peerd.self.writeFile` — persists across worker runs | `notebook-tab/notebook-tab.js`, `peerd-engine/notebook-registry.js`, `peerd-engine/opfs.js` |
| **Query** | **code-mode**: `js_notebook` runs a filter/aggregate script over the JSONL in the realm-sealed worker — no new tool | `tools/defs/js-notebook.js`, `notebook-tab/worker-source.js`, `peerd:std` |
| **Orchestration** | goal mode drives a durable multi-account sweep that survives SW eviction (`goal.runs.v1` mirror + resume) | `peerd-runtime/loop/goal-runner.js` |

**Net-new is a data layout + a skill recipe, not an engine.** The one piece of
shipped code this needs — general JSONL/record helpers — landed with this spec:
`parseJsonl` / `toJsonl` / `dedupeBy` in `peerd:std` (`notebook-tab/notebook-std.js`).

## The query engine is already here (the key finding)

`js_notebook` runs an async body in the **realm-sealed** worker with
`peerd.self.read/write/listFiles` (OPFS) + the `peerd:std` stdlib + module
imports, and `return <value>` flows back as the tool result. That *is* "write a
script that filters/aggregates an OPFS index and returns the answer." Use
`js_notebook`, **not** `js_run` — `js_run`'s OPFS is nuked after every call
(`offscreen/job-runner.js`); a durable index must live in a stable Notebook.

A convenience `query_index` tool is **deferred** (pure ergonomics, same trust
surface) — only if the agent burns tokens re-emitting boilerplate.

## Data model

One JSON object per real-world item, one per line (JSONL):

```json
{"id":"amazon:112-7766","source":"amazon","capturedAt":1719273600000,"date":"2025-11-03","merchant":"Amazon","title":"USB-C cable 2-pack","amount":12.99,"currency":"USD","raw":"Order #112-7766 … $12.99"}
```

- `id` = the source's own stable key, namespaced — the dedupe + incremental-sync cursor.
- `amount` major units; `currency` ISO; `date` the transaction date; `capturedAt` when we harvested.
- `raw` keeps the source text so a schema change can re-parse without re-walking the site.

OPFS layout under the index Notebook's `['peerd-notebooks', <id>]` subtree:

```
records/<source>.jsonl   append-only, one record per line (records/orders.jsonl for the MVP)
meta/cursors.json        { "amazon": { "lastSeenId": "…", "lastRunAt": … } }
lib/index.js             optional query helper module, imported across runs
```

**Append = read-modify-write** (OPFS writes are whole-file): read existing →
`parseJsonl` → `dedupeBy([...existing, ...fresh], 'id')` (idempotent, existing
wins) → `toJsonl` → write back. **Query = linear scan** (`parseJsonl` →
`filter`/`groupBy`/`sum`) — sub-second over thousands of rows in the worker, no DB.

## Privacy invariants (what makes exfiltration impossible)

1. **The query realm has no raw network primitive.** The realm seal
   (`notebook-neutralizers.js`) deletes `fetch`/XHR/WebSocket/EventSource/
   `sendBeacon`/Cache/nested-Worker, as the worker's first static import, before
   any agent code. A query script *cannot* open a socket.
2. **The one egress hole is the audited, denylist/SSRF-gated bridge**
   (`peerd-egress/fetch/web-fetch.js`): https-only, private-network blocked,
   denylist (banks/health/password-managers), redirect-fails-closed, every call
   audited. Even a prompt-injected query script reaches only non-sensitive public
   hosts, and it's logged.
3. **No backend, no telemetry, no upload path.** The index is OPFS files on disk.
4. **Harvest keeps raw page text out of the exfiltratable surface** — `do`/`get`
   return only a summary; the runner has no egress/code/memory/spawn tools.
5. **The index lives in the Notebook tab, not headless `js_run`** — so it gets
   *both* the realm seal AND the page CSP `connect-src 'none'`.

**Never allowed:** adding the index's sensitive hosts to `safeFetch`'s allowlist
(it's provider-endpoints-only); wiring any new egress capability onto the worker
surface; shipping the dweb in this package (no P2P publish path that could leak).

## MVP slice + build order

**MVP (one account, one metric):** "Index my Amazon orders and tell me what I
spent last year." Open the orders tab → `get`-harvest the visible rows → shape
records → `js_notebook` append to `records/orders.jsonl` (deduped) → `js_notebook`
query: filter last year, sum `amount`, return "$1,247.86 across 38 orders" + a
monthly `peerd:std` table.

- **Slice 0 — pure, bun-tested — ✅ DONE (this PR):** the JSONL/record helpers in
  `peerd:std` (`parseJsonl`/`toJsonl`/`dedupeBy`) + tests.
- **Slice 1 — pure, bun-testable:** the record-shaping function (a `get` summary →
  array of records), with fixtures.
- **Slice 2 — live extension:** durable round-trip — `js_notebook` append to a
  stable id, second run reads + sums (proves the OPFS subtree persists). The
  durability assertion bun can't reach.
- **Slice 3 — live + CDP:** the harvest step against a fixture order page.
- **Slice 4 — live + goal mode:** the full sweep as a **skill**
  (`peerd-runtime/skills/`); add a goal-mode state to `scripts/cdp/states.mjs`
  and drive end-to-end via `e2e:verify`; assert `goal.runs.v1` survives an SW
  restart.
- **Slice 5 — deferred:** the `query_index` convenience tool (only if Slices 2–4
  show boilerplate waste).

## Hard parts (honest)

- **Extraction brittleness / scale:** `do`/`get` return an NL summary, not
  structured rows — record-shaping is the agent assembling rows, brittle across
  layouts/locales and token-expensive at volume. The MVP sidesteps it (one
  source, one page); a future `get`-as-JSON return shape is the real fix.
- **Query without a DB:** linear JSONL scan; fine for thousands of rows. Reach for
  per-source/date-partitioned files before a vendored MiniSearch / wasm-SQLite
  (which needs `vendor/` + `SOURCE.txt`).
- **Re-sync:** no built-in paginate-N-pages loop; multi-page walking is goal mode
  repeating `do`/`navigate`. Dedupe **must** key on the source's stable id; some
  surfaces lack one.
- **No-CDP channel:** store-Chrome's DOM-walk is top-frame-only, synthetic input,
  iframe-blind — fine for top-frame order lists, degrades on Gmail/bank.
- **Consent / scope of authority:** the agent reads the user's most sensitive
  sessions; needs explicit per-source consent and a clear "which surfaces may be
  walked" surface. A product-trust requirement, not just eng.

## Ships to store-Chrome

The trust property and data path are store-clean — realm seal, egress
denylist/SSRF bridge, OPFS, `js_notebook`, `do`/`get`/`check` are all in the store
package; **the dweb is not involved**. No new host permissions, no new egress hole
(the index path is OPFS-only, never touches `fetch`). Demo on **preview/CDP** for
the cleanest harvest; the store-Chrome question is purely harvest *fidelity per
source*, not the trust invariant.
