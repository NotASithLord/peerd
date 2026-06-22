# Architecture change notice

> Pairs with `ARCHITECTURE.md`.

## NEWEST: Ralph removed; goal mode is the autonomous loop now (2026-06-22)

> Supersedes every "Ralph" reference below. The autonomous-loop story is
> now **goal mode** (`peerd-runtime/loop/goal-runner.js`).

The persistent fresh-context Ralph loop is **deleted in full** — the
`peerd-runtime/ralph/` module, the `ralph/*` SW routes, the RalphPanel /
ralph-format side-panel components, the `/loop` slash command, and
`docs/RALPH.md` / `docs/RALPH-DEV-NOTES.md`. In its place, the mode-row
**Goal toggle** (`sidepanel/components/mode-badge.js` `GoalToggle`) arms
the next message to start an autonomous run: the agent keeps taking
NORMAL turns in the MAIN chat (turn 1 is the user's goal as a visible
message; later turns are hidden `synthetic` continuation nudges) until it
calls the **`complete_goal`** tool (`tools/defs/complete-goal.js`,
exposed to the model only while a run is active via `tools/exposure.js`
`filterByGoalActive`), the user hits **Stop**, or a 40-turn safety cap is
reached. The work streams into the chat like a normal session — no hidden
per-iteration subagent, no backpressure gates, no plan file. Runs persist
to storage and resume on SW restart, keep running while the user is in
another chat, and auto-flip the session to Act + confirm-off for their
duration (restored on end). UI is `GoalToggle` plus a `GoalBar`
(`sidepanel/components/goal-bar.js`).

## EARLIER: dweb Phase 1 — rooms, gossip, the dwapp bridge, the commons (2026-06-13, branch `dweb/phase1`)

> Preview-channel only; the store build prunes `peerd-distributed/`
> entirely (unchanged boundary). On a dedicated branch, **not merged** —
> awaiting manual testing. Reframed by `docs/distributed/NORTH-STAR.md`
> (D-5…D-9); sequenced in `docs/distributed/ROADMAP.md` Phase 1; wire
> formats in `PROTOCOL.md §3.4/§3.6/§6.3/§6.4/§8.1`; new threat sections
> `THREAT-MODEL.md §12/§13`; placement in `ARCHITECTURE.md §8.1`.

- **Rooms replace the 2-peer dance.** `transport/signaling.js` reducer:
  `ROOM_CAP` 2 → 16, roster broadcast, targeted (`to`/`from`) opaque
  relay; the joiner always offers (no glare). Both server shells
  (`bun-server.mjs`, `worker.js`) inherit it — they only pass `to`
  through. `signaling-client.js` grows `openRendezvous()` (the room
  session) under the existing `connectViaSignaling()` (now its
  two-member case).
- **The mesh** (`transport/mesh.js`) — one authenticated link per member;
  envelope routing, liveness (ping/idle-drop), a connection budget, and
  the two server-optional control flows: `ROSTER` and **mesh-assisted
  signaling** (`RELAY`, one-hop, signer-only, immutable) — the
  kill-the-server beat. `transport/rooms.js` owns the join paths
  (rendezvous · mesh-assisted · invite-code).
- **Gossip** (`gossip/topic.js`, `presence.js`, `sync.js`) — a
  deliberately dumb room-scoped flooder (sig-keyed seen-cache, no hop
  counter, per-sender token bucket, per-did mute; payloads OPAQUE, D-7),
  liveness beacons, and late-join backfill for retained topics (have-list
  ⇄ verified original envelopes).
- **Persistent identity** — `identity/keypair.js` gains
  `loadIdentityMaterial` / `createPersistentIdentity` (vault secret
  `distributed/identity/v1`, vault-random seed; PRF derivation still
  Phase 3). IO injected; Bun-tested with a fake store.
- **App loader + the dwapp bridge** — `apps/loader.js` (verified bundle →
  engine App via an injected installer), `apps/bridge.js` (the frozen
  ~ten-op postMessage API; consent-gated join, install-confirmed-every-
  time, no key material crosses, no raw `sign()` — D-8), `room-host.js`
  (the assembled room: mesh + gossip + presence + sync + served content).
- **The commons** — `apps/commons/index.html`, the Phase 1 demo dwapp
  (feed + live block-LWW document + presence + connectivity HUD). Ships
  as the signed seed app (`apps/seed.js`) AND installs peer-to-peer.
- **Core wiring (preview-gated)** — SW routes `dweb/identity-material`,
  `dweb/audit`, `dweb/app-install`, `dweb/open-commons` (`loadDweb()`,
  gated `DWEB_ENABLED && settings.dwebEnabled`); `app-tab/app-tab.js`
  hosts the bridge + consent bar for dwapps (apps carrying `dweb`
  metadata); `app-registry`/`app-client` carry an optional `dweb`
  provenance field; the options dweb section opens commons. **Placement:
  the room host lives in the app-tab PAGE** (lifetime = tab), not the
  offscreen doc — that's the Phase 2+ always-on model
  (`ARCHITECTURE.md §8.1`).
- **Gates green**: typecheck, ESLint, dweb-boundary, 1097 bun tests
  (+28 new dweb tests: signaling rooms, identity, mesh/rooms incl. the
  kill-the-server + boundary-rule cases, gossip/presence/sync, ICE
  diagnostics). The byte-level WebRTC path stays browser-verified (the
  honest Bun boundary) — see `docs/distributed/PHASE1-TESTING.md`.

## EARLIER: resume notes + reasoning-effort dial (2026-06-12, late night)

- **Interrupted reasoning is now resumable**
  (`peerd-runtime/loop/resume-notes.js`, pure + Bun-tested; wired into
  the agent loop's per-step history build). Previously an interrupted
  turn (steer abort / output-token truncation / provider error) left NO
  trace in the next request — the API strips prior-turn thinking
  server-side AND the format layer drops thinking-only assistant
  messages — so the model restarted identical reasoning from scratch.
  Now such turns ride the next request as bounded (~3000-char tail)
  visible "partial working notes … resume rather than restart" text;
  tool-use turns are untouched (their signed thinking replay is an API
  requirement). This also upgrades the max_tokens auto-continue into a
  true resume.
- **`settings.reasoningEffort` (Anthropic `output_config.effort`),
  default `'medium'`** — deliberately below the platform default; see
  `docs/DECISIONS.md` #19 for the owner rationale. Dialed from the chat
  mode row (`EffortDial`, next to Plan/Act) or Settings — one global
  value, snapshotted at turn start. Junk values (only reachable via a
  crafted transfer import) are normalized to the default at the use
  site. Anthropic chats only: the dial hides on sessions bound to
  providers that don't honor effort (OpenRouter ignores the reasoning
  object entirely today — unified-reasoning support is a TODO.md item;
  Ollama has no effort concept), and pushState now carries the
  session's bound `provider` so the panel can gate such affordances.
- **Iterative-app-build steering sharpened**: a hard rule hoisted into
  the system prompt's top identity region (first tool call BEFORE
  detailed design when asked to build an app) and `app_create`'s
  description now opens with the trigger phrasing. Steering-only;
  efficacy is a field question — the effort default above is the
  mechanical half of the fix.
- **Onboarding redesigned** (owner nitpicks pass): the peer name wears
  the five brand letterform colors — typed names inherit the cycle —
  via an IN-FLOW colored mirror under a transparent-text `<input>`
  that owns the caret (exact glyph-width for any charset; see
  onboarding-view.js EDITING MECHANICS); a type-and-delete tease
  advertises editability (stops permanently on interaction; never
  starts under reduced motion); the name/call-me fields merged into
  one ("what should I call you" — `seedUserDocBody` is now
  `{callMe, notes}`, no compat per DECISIONS #17); facts fields wear
  the composer's one-box treatment; long names scale the headline
  instead of overflowing. Adversarially reviewed (2 agents) + visually
  verified; tease cadence (`TEASE`) is export-mutable for tests.

## per-session turn slots (2026-06-12, night)

- **In-flight turns are now one slot PER SESSION, not one global slot**
  (`peerd-runtime/loop/turn-slots.js`, pure + Bun-tested; the SW binds
  it). Previously a single `AbortController` meant sending a message in
  ANY chat aborted whatever was streaming in any other chat — switching
  conversations and chatting there silently killed the first stream.
  Now: steer-live (send-into-streaming-chat aborts + re-prompts) and
  the Stop button are scoped to their own session; turns in other
  conversations keep running in the background.
- **The side panel is session-aware about turn lifecycle**: `pushState`
  carries per-session `streaming` truth (switching back to a live chat
  re-arms the spinner/Stop), and `turn/streaming`/`turn/cost`/loop-level
  `turn/error` events carry `sessionId` with the panel reducers guarded
  by the same convention as `applyDelta` — a background chat's pulses,
  cost ticks, banners, and `turn/state` pushes never repaint the chat
  being viewed. The SW's `activeSession` cache refresh after a turn is
  likewise guarded to the still-current session.
- Confirm prompts from background turns still fail closed (coordinator
  is multi-prompt, 120s auto-deny); a panel-side prompt QUEUE (instead
  of last-writer-wins display) is a documented follow-up in TODO.md.

## trust-mode removal + roadmap wave (2026-06-12, later the same day)

- **The trust-mode axis (Open/Scoped/Paranoid) is GONE.**
  `peerd-egress/trust/` deleted (`MODES`, `DEFAULT_MODE`,
  `needsConfirmation`, the never-wired `originsAuthorized`), the
  `mode` field is out of the session schema / tool context / pushState
  / subagent inheritance / system prompt, and the read-only ModeBadge
  is unmounted. Plan/Act + the denylist carry the safety weight.
  Anywhere ARCHITECTURE.md still narrates trust modes (personas
  rationale, migration table), read it as historical. New in its
  place: **Plan permits pure URL loads** — `PLAN_NAVIGATION_TOOLS =
  {navigate, open_tab}` in `permissions/policy.js`, never clicks
  (`docs/DECISIONS.md` #16).
- **`peerd-runtime/loop/undo.js` (listed below as V1.1) will NOT be
  built** — generalized turn rollback failed feasibility
  (`DESIGN-09-undo-redo.md`); workspace undo already ships via
  checkpoints.
- **Vault blob moved to IndexedDB** (store `'vault'`, DB v3) with a
  read-back-verified, loss-proof lazy migration
  (`vault/blob-migration.js` is the pure table). `chrome.storage.local`
  is the legacy home, auto-scrubbed after a verified copy.
- **Audit log is capped** — `audit/retention.js` (pure policy, 20k
  default via `CHANNEL_DEFAULTS.auditLogMaxEntries`), pruned oldest-first
  in `audit/log.js`, amortized one count per 256 appends.
- **`peerd-provider` grew `adapters/ollama.js`** (keyless local
  inference, OpenAI format layer, live `/api/tags` inventory) +
  `ollama-recommend.js` (pure GPU-fit tier table + injected-navigator
  probe). `http://localhost:11434` restored to manifest CSP
  connect-src in `manifests/base.json` (all channels).
- **Header decluttered**: Skills is a Context-view tab; `/skills`
  route aliases to `/logs?tab=skills`. ModeBadge gone with the trust
  axis.
- **vm-tab boot console restyled as a live shell** (dmesg log + prompt
  line + caret; monochrome phosphor; the orb and the wordmark letters
  are the page's only color — that pairing is now the brand rule, see
  CLAUDE.md stylistic shorthand). xterm theme matched.

## Store-readiness merge + thin-wiring restoration (2026-06-12)

One integration day, four structural changes:

- **store-readiness landed on main.** Egress hardening (webFetch
  redirect fail-close, structural-IPv6 SSRF parsing, JS-sandbox exfil
  neutralizers, target-tab denylist), full-surface SW sender auth,
  vault idle auto-lock (45min default, `vaultAutoLockMs` setting), a
  user off switch for the Chrome-debugger automation path (CORRECTED
  post-merge: Chrome refuses `debugger` in optional_permissions and
  silently omits it, so the permission is REQUIRED again and the off
  switch became the `advancedAutomationEnabled` setting + nudge), and
  the Chrome Web Store posture (icons, narrowed per-channel
  CSP, pruned host permissions). Manifest changes live in
  `manifests/*.json` — the branch's direct `extension/manifest.json`
  edits were re-expressed for the generated-manifest system.
- **The SW sheds orchestration.** Autonomous-loop driving (then Ralph's
  `makeRalphDriver`; since 2026-06-22 the goal runner,
  `peerd-runtime/loop/goal-runner.js`), per-turn cost tracking
  (`makeTurnCostTracker`, peerd-runtime/cost/turn-tracker.js), and the
  /init flow (`makeInitOrchestrator`, peerd-runtime/memory/) are
  factories with injected IO; the SW constructs them once and routes
  into them. ESLint now runs `no-undef` over extension/ so a deleted
  binding can't silently survive (nothing executes the SW in tests).
- **Denylist grew a user overlay.** Effective list = (seed − disabled)
  ∪ added, persisted at `denylist.user.v1`, edited from the Context
  view, audited as `denylist_added` / `denylist_removed`.
- **Review + skills wired through.** `checkpointMgr.diffSince()` backs
  request_review's `since` path; enabled skills surface as `/<name>`
  composer commands via the registry's `listCommands()`.

## Dual-distribution packaging system (June 2026)

peerd now ships two channels from this one tree — **peerd** (store
packages; `peerd-distributed/` is structurally absent from the artifact)
and **peerd preview** (GitHub Releases, dweb enabled, signed,
auto-updating). What changed for day-to-day work:

- `extension/manifest.json` and `extension/shared/channel-config.js` are
  **generated** (`bun run gen:dev`); sources are `manifests/*.json` and
  `packaging/default-settings.mjs`. CI fails on drift.
- **Nothing outside `peerd-distributed/` may import it** — not even its
  `index.js`. Core uses `shared/dweb-interface.js` (types + stub)
  and `loadDweb()` from `shared/dweb-loader.js`. Enforced by
  ESLint + `bun run check:boundary` + a post-package artifact grep.
- Channel-conditional behavior flows ONLY through `CHANNEL_DEFAULTS` /
  `DWEB_ENABLED` from `/shared/channel-config.js`.
- Full story: `PACKAGING.md`.

## TL;DR

The **d** module (`peerd-distributed`) used to own sessions and profiles. It no longer does.

- `peerd-runtime` (r, green) now owns sessions and profiles in addition to agent loop, tools, skills, memory.
- `peerd-distributed` (d, magenta) is now the dweb module only. Mostly empty in V1 by design.

## Why

Old mapping forced sessions/profiles into distributed to give it V1 content. Sessions/profiles are orchestration containers (runtime concern); distributed is the dweb between peerd instances. Cleaner: orchestration in runtime, dweb in distributed, distributed honestly empty in V1.

## What moved

| Was | Now |
|---|---|
| `peerd-distributed/sessions/` | `peerd-runtime/sessions/` |
| `peerd-distributed/profiles/` | `peerd-runtime/profiles/` |

Move files if you've already created them in old paths. Update imports. Public API for sessions/profiles is now `from 'peerd-runtime'`.

## New in peerd-runtime

- `peerd-runtime/personas/` — V1.1 — Read vs Act personas. Orthogonal to trust modes. Persona decides whether the agent can act at all; trust mode decides how aggressively.
- `peerd-runtime/loop/undo.js` — V1.1 — turn-level rollback for `/undo` `/redo`. Walks per-turn effects journal in reverse. Out of scope: external state (network requests, downloads).

## New in peerd-distributed

- `peerd-distributed/transport/protocols/share-session.js` — V2.3 — shareable session link, view-only or fork-to-act.

## peerd-distributed V1 state

Essentially empty:

    // peerd-distributed/index.js  (V1)
    export const VERSION = 'unimplemented — dweb surface reserved for V2+';

Per-phase grows: V2.2 gateway, V2.3 identity+transport, V2.5 discovery, V3.0 swarm, V3.x dwapp. Don't put session/profile/runtime code here.

## Updated dependency graph

    Layer 3 — dweb          :  peerd-distributed  (composes Layer 2 across instances)
    Layer 2 — orchestration :  peerd-runtime       (loop, tools, sessions, profiles, skills, memory)
    Layer 1 — capabilities  :  peerd-provider  |  peerd-egress  |  peerd-engine

Distributed depends on runtime (eventually), not the other way.
