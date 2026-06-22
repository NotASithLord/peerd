# peerd — STATUS

**peerd is 0.x — experimental beta** (breaking changes likely; no "V1"
commitment — see `ROADMAP.md`). The initial feature buildout is
**COMPLETE and integrated on `main`**: 9 of 10 planned features landed
and wired (01 memory, 02 edit, 03 plan/act, 04 commands, 05 ralph,
06 cost, 07 skills, 08 review, 10 hooks). Feature **09 auto-memory was never
integrated** — feature 01 already implemented its spec, and the
`feature/09-automem` branch has since been **deleted**; don't hunt for it.

**2026-06-12 roadmap wave: COMPLETE.** The entire ROADMAP backlog was
worked in four agent waves + overseer passes in one day: trust-mode
axis removed (Plan/Act + denylist carry safety; Plan permits pure URL
loads, DECISIONS #16), header decluttered, Ollama adapter + GPU-fit
recommendation, audit retention cap, vault blob → IDB, Argon2id as the
ONLY passphrase KDF (pre-release PBKDF2 deleted — DECISIONS #17),
engine robustness (tab-close interrupt, per-VM queue, rootfs TOFU
pin), JS-sandbox realm seal, model connection-drop retries, Firefox
parity + universal no-CDP DOM-walk snapshot fallback, concurrent
READ-wave dispatch, per-session /system, onboarding + default profile,
hooks tab + Ralph panel, Act tiers → one confirm toggle (DECISIONS
#18), cross-device passkeys (security keys + PRF honesty), denylist
editor v2 (search + confirmed remove), auto-memory suggestions,
rolling trim compression, per-session tool manifests (/tools), shell
boot console + ANSI wordmark across all three engine tabs, minimal
self-describing time context. Remaining backlog: deliberately-deferred
items only (local-webgpu triggers, VM image build-out, multi-profile
namespacing, engine residuals, dweb track) + user-side validation
(real Firefox, store creds, billing).

Current gates: Bun suite **1045 pass / 0 fail** (`bun test ./tests`);
in-browser suite **549 pass / 0 fail** headless via the CDP harness
(`scripts/cdp/`); strict typecheck of the bun suite (`bun run typecheck`)
clean; ESLint, dweb-boundary, and generated-file drift checks clean;
all four channel/browser artifacts package (Firefox preview unsigned —
AMO creds are a user-only item).

Historical record of the integration: `v1-deliverables/INTEGRATION-LOG.md`.
Live work board: `TODO.md`.
