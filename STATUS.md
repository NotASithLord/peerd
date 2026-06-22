# peerd — STATUS

**peerd is 0.x — experimental beta** (breaking changes likely; no "V1"
commitment). The initial feature buildout is
**COMPLETE and integrated on `main`**.

- **What's shipped** — the itemized, module-categorized catalog is
  `FEATURES.md` (the canonical list; don't re-derive it here).
- **What's still ahead** — the (version-free) backlog is tracked in
  GitHub Issues; forward-looking feature specs live in `docs/specs/`.
- **How the integration happened** — `v1-deliverables/INTEGRATION-LOG.md`
  records the per-feature landing and the four-wave 2026-06-12 roadmap
  sweep. Note: feature **09 auto-memory was never shipped separately** —
  feature 01 already implemented its spec, and the `feature/09-automem`
  branch was deleted; don't hunt for it.

Current gates: Bun suite **1045 pass / 0 fail** (`bun test ./tests`);
in-browser suite **549 pass / 0 fail** headless via the CDP harness
(`scripts/cdp/`); strict typecheck of the bun suite (`bun run typecheck`)
clean; ESLint, dweb-boundary, and generated-file drift checks clean;
all four channel/browser artifacts package (Firefox preview unsigned —
AMO creds are a user-only item).

Live work board: `TODO.md`.
