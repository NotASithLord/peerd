# Design 4 — call the #119 bet: bench the code-surface web actor and flip the preview default

## Problem

PR #119 built the code-surface web actor — `page_code`, a Playwright-shaped
`page.*` REPL replacing discrete DOM tool calls — as an A/B arm behind
`webActorActionSurface`, default `'tools'` in BOTH channels
(`packaging/default-settings.mjs`, validated in
`background/settings-patch.js`, UI in `options/sections/behavior.js`).
The measurement machinery exists (`scripts/cdp/run-eval-bench.mjs`,
`scripts/cdp/run-om2w.mjs`, `scripts/cdp/diagnose-page-code.mjs`,
`scripts/cdp/fixtures/web-suite.mjs`). The bet just hasn't been called.
A vision this central shouldn't sit at default-off indefinitely.

This is a process design more than a code design.

## The bench protocol

1. **Arms**: `tools` vs `code`, same model, same web-suite fixtures + om2w
   tasks. N runs per task per arm (pick N from observed variance — run 5,
   widen if the confidence interval straddles the decision).
2. **Metrics**, in decision order:
   - task success rate (the gate — code must not lose),
   - tokens per completed task (the expected win: fewer round-trips),
   - wall-clock per task,
   - failure taxonomy from `diagnose-page-code.mjs` (selector strictness
     rejections, stale-snapshot thrash, timeout kills) — the fix list.
3. **Decision rule** (proposed): flip preview if code-arm success is within
   noise of tools-arm AND tokens/task improves ≥20%; hold and fix the top
   failure class otherwise, then re-run. Publish the numbers in the flip PR.

## The flip (when earned)

- `packaging/default-settings.mjs`: `webActorActionSurface` default becomes
  channel-keyed — `'code'` for preview/dev, `'tools'` for store. The
  channel-defaults plumbing already exists (`CHANNEL_DEFAULTS`); this is a
  value change, not new machinery. Regenerate via `bun run gen:dev` — no
  hand edits to generated files.
- Settings UI copy (`options/sections/behavior.js`): drop the
  "— experiment" suffix on the code option once it's a default somewhere;
  the toggle itself STAYS (an escape hatch is cheap and the A/B plumbing is
  already tested).
- Store channel follows only after preview field time — a store flip is its
  own later one-line PR with its own justification.
- E2E: the verify-loop states that drive the web actor
  (`scripts/cdp/states.mjs`) must pass under the new preview default; add a
  `--only` state exercising one `page_code` round if none does yet.

## Risks

- The code surface's strictness contract (single-match selectors, short
  scripts, re-snapshot) is prompt-carried (`loop/system-prompt.js`
  `WEB_CODE_LORE`); a default flip exposes it to every model/provider a
  user brings, not just the benched one. Mitigation: bench at least one
  non-Anthropic provider from the registry before flipping; the toggle is
  the fallback.
- Session transcripts recorded under one surface replay oddly under the
  other if a user flips mid-history — already true of the setting today;
  no new handling.

## Touch points

`packaging/default-settings.mjs`, `options/sections/behavior.js`,
`scripts/cdp/states.mjs` (possibly), regenerated `shared/channel-config.js`
via gen. Nothing in `peerd-runtime/` — the surface machinery is done.

## Open questions

1. Agree the ≥20% token threshold / within-noise success gate?
2. Which second provider to bench (OpenRouter-served open model?) — cheapest
   representative of "bring your own model" reality.
