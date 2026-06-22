# peerd V1 buildout — INTEGRATION LOG

Branch: local **`main`** (head `d2b08f1`), based on `65fbd3c`. **Not pushed.**
Final gate: `bun test ./tests` → **429 pass / 0 fail / 39 files**; full
`node --check` sweep of non-vendor extension JS → clean.

## How it ran
- 10 subagents, each in its own `feature/NN-*` git worktree off `65fbd3c`,
  built in parallel. Every one delivered DESIGN + real wired code + a green
  Bun test + DEV-NOTES on the first pass — **zero send-backs** were needed.
  Isolated test counts: 01:176, 02:165, 03:192, 04:205, 05:153, 06:159,
  07:171, 08:172, 09:168, 10:164.
- Test surface: an MCP-free **CDP harness** (`scripts/cdp/run-inbrowser-tests.mjs`,
  on the `v1-buildout` worktree) — headless Chrome over the DevTools Protocol,
  serving `extension/` over http. It works, and **found a pre-existing bug**
  (below). The primary gate is the Bun suite, strengthened mid-run by a
  resolver plugin (`tests/setup.ts`) that maps the browser's leading-slash
  imports so real extension modules import under Bun.

## Sequence (dependency order 01 → 10 → 03 → 02 → 06 → 07 → 04 → 09 → 08 → 05)
Integration happened in two phases because integration was started on two
lines in parallel (the human took `feature/04-commands` + infra onto `main`;
the agent integrated the other six on a `v1-buildout` base). They were then
consolidated onto `main`.

| Feature | Result | Combined suite | Conflicts resolved |
|---|---|---|---|
| 01 memory | landed | 176 | none (first) |
| 10 hooks | landed | 199 | index.js exports (keep-both) |
| 03 plan/act | landed | 250 | **dispatcher** (03 `decideAction` + 01 memory self-confirm + 10 pre/post hooks interleaved into one execute path), SW imports/handlers, app.js ConfirmModal (memory-diff branch + action-class wording), index.js |
| 02 edit | landed | 274 | SW imports |
| 06 cost | landed | 292 | sessions/store.js (`update` + `setCost` both kept), SW imports + pushState, app.js (CostMeter mount), styles.css |
| 07 skills | landed | 322 | index.js, system-prompt.js (`memoryBlock` + `skillsBlock`), SW (imports/boot/per-turn), app.js import |
| **consolidate** | merged `v1-buildout`→`main` (had 04 + Mithril 2.3.8 + resolver) | 386 | **agent/send** (04 composer expansion + 01 `/init` — `/init` short-circuits BEFORE composer), SW imports/boot/handlers, index.js. The interleaved handler-block seams (`composer/files`, `review/run`) each needed a re-added closing `},`. |
| 08 review | landed | 417 | index.js + tools/defs/index.js (keep-both) |
| 05 ralph | landed | **429** | index.js, app.js (RalphView import + a second nav button — fixed a collapsed `m('button.icon',{…})`), SW imports/boot/handlers |

## Reconciliation decisions (parent's calls, per brief §6)
- **09 auto-memory → subsumed into 01.** 01 and 09 independently built a
  `peerd-runtime/memory/` module (each with `store.js`/`index.js`, a `remember`
  tool, `{{MEMORY_BLOCK}}`). 01 is foundational and **already implements 09's
  full spec** (confirm-gated `remember` + the memory-diff `ConfirmModal` +
  prompt loading + export/delete), which is live in the 429-green build. Per
  §6 ("foundational owns the interface, the dependent adapts"), the standalone
  `feature/09-automem` branch was **not** merged as a duplicate module; its
  feature is delivered by 01. The branch is retained for reference. The one
  thing 09 carried that 01 lacks — a dedicated Settings memory-management UI —
  is a noted follow-up (01 has the routes).
- **Dispatcher execute path** is the load-bearing merge: order is now
  sync gates → async confirmation (03 `decideAction` by mode/tier; skipped for
  `primitive:'memory'` tools, which self-confirm — 01) → pre-tool-use hooks
  (10, fail-closed) → execute → post-tool-use hooks. Verified by the combined
  dispatcher/permissions/hooks/memory tests.
- **04↔07 command sources:** 04's `commandSources` is wired to the local store
  only. Merging 07's skill commands in (the `mergeSources([...])` adapter 04
  shipped) is left as a one-line SW follow-up to avoid a boot-ordering change
  during integration.

## Post-load UX fixes (after the first manual load)
- **Crash fixed:** `settings-view.js` spread **keyed** `.provider-key-row`
  vnodes into the `.card`'s otherwise-unkeyed array → Mithril "fragments must
  all have keys or none" → the whole panel died on navigation. Removed the
  keys (static rows). This also explains the "no API key" symptom — the key
  was always safe in the vault; the crashed UI just couldn't render its state.
- **Header overflow fixed:** the top bar overflowed the default panel width.
  The Plan/Act `ModeSelector` moved **out of the global header into the chat**
  (above the composer); the Ralph nav button + `/ralph` route/panel were
  removed.
- **Ralph simplified:** now a single **`/loop <goal>`** chat command
  (SW-handled) that seeds the goal, runs a planning pass, then builds — posting
  start/finish notes to the chat. Requires the Act tier = full-auto.

## Open issues for the human (before any push to public)
1. ~~Pre-existing base bug: in-browser runner broken (stale
   `inspectAuditLogTool` import)~~ **RESOLVED 2026-06-12** — the test
   deep-imports `tools/defs` now; the suite is green (442/0) and the CDP
   harness gates it headless in CI.
2. **No real-browser E2E was performed** by the build. Run `TEST-PLAN.md`.
3. ~~Lint can't run repo-wide (legacy `.eslintrc.cjs` vs ESLint v10)~~
   **RESOLVED** — flat `eslint.config.js` landed (commit `36da1bf`);
   `bun run lint` is green and CI runs it (now incl. `no-undef`).
4. **Follow-ups, partially done:** ~~07 skills as command sources~~
   **RESOLVED 2026-06-12** (registry `listCommands` + `mergeSources` in
   the SW); memory got an editable Context-view UI; user hooks still
   have routes but no Settings UI.
5. ~~`main` local and unpushed~~ **RESOLVED** — main is pushed; the ten
   feature branches and the `v1-buildout` worktree were deleted after
   integration (this log is the record).
