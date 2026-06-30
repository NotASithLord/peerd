# peerd roadmap

> **Status: DRAFT — a proposal for ratification, not a committed plan.**
> Distilled from owner discussions so we have a shared compass. **@NotASithLord
> owns the direction** — nothing here is decided until he ratifies it. Edit,
> reorder, or reject anything. It's a living document: it tracks what's *next*,
> never what already exists (for that, read the code).

## Why this exists

Growing stars and contributors, several plausible directions, and a real risk of
getting pulled in all of them at once. This is the compass — what we're betting
on and in what order — so day-to-day work has somewhere to point. The prose specs
were intentionally purged ("the code is the spec"); this is *forward direction*,
not a spec of what's built.

## The invariants (these don't move)

Every item below must clear this bar — it's the moat, not a preference:

- **Runs entirely in the user's browser. No backend, no account, no telemetry.
  Bring-your-own-key.** This is in the README, `CLAUDE.md`, and the manifest.
- **No build step.** Vanilla JS + ES modules; the browser runs what we wrote.
- **Sandboxed by default.** The egress allowlist (`safeFetch`/denylist) + Plan/Act
  gates + append-only audit are the safety spine.
- **The code is the spec.**

Anything that breaks these — monetization, metrics, enterprise — is out of scope
*by construction* until it's redesigned to fit them.

## Now — store-readiness + field hardening

The actor-model refactor landed and the 0.x line is in store-readiness polish.
The near-term work:

- **Actor-model rough edges** — the async-everything lifecycle (Stop cascade,
  durable reply mailbox, vault-lock durability, slot-race). A localized set is in
  flight; the async-messaging core is the next tranche (coordinated with the
  in-progress resident rework).
- **Packaged-build correctness** — the v0.2 black-screen class is now guarded
  end-to-end (boot every packaged page + the static/import/asset checks).
- **Store submission** — Chrome + Firefox packaging and listings.

## The funnel — website → extension → browser

The acquisition path Ariel wants fleshed out, plus the contributor on-ramp.

- **Website** (separate repo, `NotASithLord/peerd-site`) — reorganize toward
  *marketable*: live demos, less prose. Currently verbose.
- **A discrete on-ramp** — the **game** idea as an interactive entry point that
  pulls people from the site into the extension.
- **Contributor on-ramp** — `CONTRIBUTING.md` + a first batch of `good first
  issue`s shipped; keep seeding them as contributors arrive.
- **[OWNER DECISION] Metrics.** We want to understand adoption *without* breaking
  the no-backend / no-telemetry promise. Free today: the Chrome Web Store, Firefox
  AMO, and GitHub dashboards (downloads, stars) — zero code. Anything richer
  (in-product usage) would have to be local-only / explicit opt-in / never phone
  home — its own deliberate design, not a quick add.

## The big bet — peerd as an AgentOS

Ariel's framing: *we already have most of what a headless-Chrome / peerd solution
needs for self-hosted, secure, enterprise agent environments — sandboxes by
default, better capabilities. A better AgentOS.*

Already substrate (extend, don't rebuild):

- Three sandbox kinds (WebVM / Notebook / App) + the headless worker, each
  isolated; plus the VM networking layer.
- CDP-based browser automation + the headless CDP harness.
- The security spine an enterprise needs: egress allowlist, Plan/Act, audit
  lineage.

The gap to the story (needs design):

- A **headless / programmatically-driven runner** (peerd without the side panel).
- **Per-environment isolation / multi-tenant** — rides Profiles (below).
- **[OWNER DECISION]** Is this a near-term bet or the north star? It's big enough
  to deserve its own design pass and an explicit call on sequencing vs the funnel.

## Platform backlog

Let each land with deliberate design — don't front-run. (Sourced from the
`CLAUDE.md` "still ahead" list.)

- **Profiles** — the foundation exists (a profile store + model, wired in). The
  remaining work is per-profile namespacing of vault, denylist, skills, memory,
  and sessions. Unlocks multi-tenant (and the AgentOS bet).
- **Per-profile tool manifests** — the per-*session* layer shipped (`/tools`
  presets); binding a manifest to a *profile* rides Profiles.
- **OpenAI provider adapter** — OpenRouter covers most vendors meanwhile; the
  manifest deliberately doesn't pre-declare hosts the shipped version doesn't use.
- **The dweb's next reach** — agent-to-agent over the mesh, richer dwapps, global
  discovery. Preview-channel only.

## Monetization (a constraint, not a feature)

Must not break no-backend / no-account / BYOK. Lightest path: document OpenRouter
prepaid credits. A branded "free credits" funnel, *if ever* needed, is a separate
opt-in, off-by-default, key-vending proxy in its **own repo** — never a peerd
proxy that sees prompts.

## How to use this doc

- **@NotASithLord ratifies.** Edit / reorder / reject freely; the `[OWNER
  DECISION]` markers are the open calls.
- Items are *direction*, not commitments or dates.
- When something ships, the **code** is the record — this doc only tracks what's
  next.

---

_DRAFT — pending ratification._
