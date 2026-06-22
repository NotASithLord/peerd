# peerd — Roadmap

> **Status: 0.x — experimental beta.** peerd drives your browser,
> executes code, and holds your API keys locally. It works, but it is
> early: **breaking changes are likely**, storage formats may move, and
> you should use it with care. There is no "V1" commitment yet — the
> version stays in the 0.x range until the surface stabilizes, and
> version numbers get assigned as features land, not planned in advance.
>
> Two sections: **Shipped** (what actually exists on `main`, ordered
> foundation-up) and **Backlog** (everything else, as a flat to-do list
> with no version pinning). Pair with `CLAUDE.md` (orientation),
> `ARCHITECTURE.md` (modules), and `docs/DECISIONS.md` (recorded
> tradeoffs).

---

## Shipped

What's real on `main` today, ordered by the dependency stack
(chassis → egress → provider → engine → runtime → distributed).

### Chassis & distribution packaging
- MV3 extension, **no build step** — load `extension/` unpacked; the
  browser runs the source as-is.
- **Dual-distribution** from one tree: `peerd` (store; dweb pruned) and
  `peerd preview` (GitHub Releases; dweb on, signed, auto-updating).
  Generated manifest + channel-config per channel (`bun run gen:dev`),
  drift-checked.
- **CI**: bun tests, ESLint (incl. `no-undef`), dweb-boundary check,
  generated-file drift, the 2×2 channel/browser artifact matrix, and a
  headless in-browser job (the CDP harness).
- Service worker as wiring + per-route handlers; offscreen keepalive;
  side panel (Mithril) behind a single-row header
  (`wordmark · preview · ☰ · + · ▤ · ⚙ · 🔒`; the Context view hosts
  the Memory / Activity / Denylist / Skills tabs, `/skills` aliases
  in). Two test surfaces — Bun (terminal) and the in-browser runner
  (headless via CDP); both green in CI.

### peerd-egress (security)
- **Vault**: passphrase **and** WebAuthn PRF / Touch ID unlock — same
  data key from either path. Passphrase KDF is **Argon2id, the only
  one** (vault.v2: 64 MiB single-lane, RFC 9106 profile, params
  recorded per-wrap with DoS rails on stored descriptors; vendored
  hash-wasm, SHA-pinned). The pre-release PBKDF2 path and its lazy
  migration were deleted same-day (`docs/DECISIONS.md` #17 — 0.x, no
  installs, no compat code). Idle auto-lock (45 min
  default, user-settable, 0 = never); manual Lock button. Passkeys are
  cross-device: enrollment offers the platform authenticator (Touch ID /
  Windows Hello) AND security keys (YubiKey/FIDO2, cross-platform
  attachment, transports recorded for clean unlock prompts), with PRF
  honesty — an authenticator that can't do PRF fails enrollment with a
  clear error rather than minting a credential that can't unlock;
  ceremonies covered by real CDP virtual-authenticator tests. DK mirrored to
  `chrome.storage.session` so an MV3 SW restart doesn't re-prompt. The
  blob lives in IndexedDB (loss-proof, read-back-verified migration off
  `chrome.storage.local` — hygiene, not a security change).
- **safeFetch** hardcoded provider allowlist; **webFetch** with an SSRF
  / private-network guard (structural IPv6 incl. IPv4-mapped + NAT64),
  redirect fail-close, and a denylist backstop.
- **Denylist**: 164-pattern shipped seed + a full user editor — add,
  search (live filter with n-of-N), and confirmed remove (user patterns
  truly delete; seed patterns disable reversibly with built-in
  provenance shown louder); every mutation audited.
- Append-only **audit log** (UUIDv7) with **capped retention** — 20k
  entries default (channel-overridable), pruned oldest-first, amortized
  to one count per 256 appends; SW **sender authentication** on every
  message and port surface.

### peerd-provider
- **Anthropic** adapter: streaming `tool_use`, prompt-cache breakpoints,
  adaptive thinking on 4.6+ models, 429/500/503/529 retry with
  header-aware backoff, the dangerous-direct-browser-access ack.
- **OpenRouter** adapter (OpenAI-compatible gateway).
- **Ollama** adapter — keyless fully-local inference over the same
  OpenAI format layer; live model inventory from `/api/tags` in the
  model picker; a WebGPU/deviceMemory capability probe recommends the
  largest fitting model in Settings (with the `ollama pull` hint);
  "daemon not running" maps to a legible `ollama serve` fix; $0
  pricing keeps the CostChip honest.
- Local pricing table (+ override) with a catalog-parity test;
  per-session provider+model; in-chat model picker.

### peerd-engine (Sandboxes — four execution kinds: three tab-hosted + a headless worker)
- **WebVM** (CheerpX Linux) — own disk, bash, POSIX; HTTP egress routed
  through `peerd-egress` via bash wrappers. Robustness: tab-close
  interrupts pending RPCs (no 90s stall), per-VM FIFO command queue
  (no concurrent-run clobber, lanes detach on interrupt), TOFU
  integrity pin on the streamed rootfs (fail-closed on drift). Boot
  console + live terminal share one monochrome-phosphor shell look
  (ANSI wordmark banner).
- **Notebook** (Web Worker + OPFS) — realm-sealed: bridged
  `fetch` (`peerd.egress.fetch`) pinned non-configurable, natives deleted off the
  prototype chain, every raw network primitive (XHR / WebSocket(+Stream)
  / EventSource / WebTransport / sendBeacon / importScripts / nested
  Worker) hard-blocked, with `connect-src 'none'` as the second fence
  (CDN module imports remain a documented script-src feature);
  **App** (stored HTML in a sandboxed, opaque-origin iframe). Each has a registry + tab tracker +
  RPC client. CodeMirror editor shared by the JS/App tabs.
- **Headless worker** (`js_run`) — the same sealed Notebook worker run
  offscreen with no tab (ephemeral, no registry), for the agent's own
  quick compute / code mode. A distinct kind, same substrate as a Notebook.

### peerd-runtime (the agent)
- **Agent loop**: streaming, multi-step tool dispatch, extended
  thinking, Stop/steer mid-turn, MAX_STEPS=100, boundary-safe history
  trim, screenshot redaction. **Concurrent dispatch**: consecutive
  READ-class calls in a turn run as parallel waves (never hoisted past
  a write; confirm-gated calls never race), results re-assembled in
  emitted order.
- **Six-gate dispatcher** with full lineage: persona (real Plan/Act via
  `decideAction`), exposure (real runner-only enforcement at dispatch),
  origin (denylist), confirmation (async, policy-driven), egress
  (allowlist pre-hook + safeFetch), audit. Pre/post **tool-use hooks**.
- **Tool inventory and exposure split** (itemized in `FEATURES.md`;
  live counts come from the source): introspection, DOM/page tools,
  sessions, VM/JS/App families, web tools, memory, edit, review, skills,
  `spawn_subagent`.
- **do/get/check** two-layer browser runner — a clean-context subagent
  holds the low-level DOM tools and returns a fenced, untrusted summary,
  keeping page content out of the main context. Speed work landed:
  snapshot pre-seeding, one-shot get/check, `runnerModel` override,
  ephemeral-runner persistence diet. **Scripting is the DEFAULT browser
  path on store-Chrome and Firefox** (CDP ships preview/dev only): a
  DOM-walk pseudo-snapshot serves the same tool contract whenever the
  debugger pool is unavailable (store-Chrome / Firefox / setting off),
  with `walkId`/selector click·type, a `world:'MAIN'` `read_state`
  fallback, and the runner told its channel up front; the genuinely
  CDP-only tools (`page_exec` on Trusted-Types pages, `page_keys`) return
  channel-agnostic `debugger_unavailable` errors.
- Subagents (depth-bounded); sessions store; clock — per-turn `<time>`
  is minimal and self-describing (absolute now + plain-words coarse
  elapsed since the user's previous message, only when notable; the
  event recorder and the SW-lifetime checkpoint tools were ripped out
  2026-06-12 as context bloat that confused models in the field);
  composer (slash commands + @-refs; enabled skills surface as
  `/<name>`); Plan/Act permissions with ONE
  confirm-actions toggle (the three Act tiers collapsed 2026-06-12 —
  `docs/DECISIONS.md` #18; ON = every non-read confirms, OFF = runs
  until halted; legacy actTier records read forever, never written;
  Ralph's unattended gate restated as Act + confirmations off, same
  force) (Plan also permits pure URL loads — `navigate`/`open_tab`
  only, never clicks — per `docs/DECISIONS.md` #16);
  **per-session tool manifests** (`/tools research|browse-only|full` —
  presets as data; enforced fail-closed at BOTH descriptor filtering
  and dispatch, inherited by subagents as an authority bound that
  intersects, never escalates; rename-drift guard pins preset names to
  the registry); **auto-memory** (wrap-up extraction on real session
  lifecycle seams proposes durable notes as pending suggestions in
  Context → Memory — approve/dismiss each, never auto-written, frugal
  by prompt, spend-capped); **rolling trim summaries** (long-session
  compression: the trim summary incorporates prior state, persists on
  the session record, structured facts/decisions/open-threads via an
  optional cheap call with a mechanical fallback that never blocks);
  cost telemetry + hard spend limit; clean-context review subagent; Ralph persistent loop (`/loop`);
  search/replace edit + per-turn workspace snapshots (review's
  diff-since substrate ONLY — all user-facing rollback removed
  2026-06-12, owner call; see the resolved /undo+/redo entry below); progressive-disclosure skills
  (remote install gated off for store); file-based AGENTS.md memory +
  `/init`; settings export/import; **per-session `/system`
  instructions** (append-only `<session_instructions>` block, never
  inherited by subagents); **default profile + first-run onboarding**
  ("Hello, I'm peerd" with the peerd.ai cursor, inline-editable peer
  name shown in chat transcripts, skippable basic-facts seeding into a
  frugally-expanded USER doc); **hooks management tab** in Context
  (built-ins visibly always-on with reasons; user hooks toggle/remove,
  audited); **Ralph status panel** in chat (goal, iteration, state,
  Stop).
- **Voice**: one Moonshine model (WASM, SRI-pinned) + Web Speech
  fallback, hosted in the offscreen doc.

### peerd-distributed (preview channel only)
- **dweb Phase 0**: Ed25519 did:key identity, codec, content addressing,
  signed bundle transfer over WebRTC scaffolding, and a pure signaling
  reducer shared with the `signaling-node/` server shells. Isolated
  behind `shared/dweb-interface.js` + a channel-gated loader; absent from
  store artifacts. Detail in `docs/distributed/ROADMAP.md`.

---

## Backlog

A flat to-do list — **not** version-pinned. Rough order is near-term
value, not a commitment; we assign versions as things land.

- [ ] **Firefox — runtime validation + the unclosable gaps.** The
      parity PASS landed 2026-06-12 (API guards, AMO metadata, and the
      DOM-walk pseudo-snapshot as the universal no-CDP fallback). As of
      2026-06-13 that fallback is also the DEFAULT path on the store
      Chrome package (which ships without `debugger`), not just Firefox /
      advanced-automation-off; channel-agnostic `debugger_unavailable` tool
      errors. Remaining: side-load on real Firefox and exercise
      the flows (user-side; no Firefox in the dev loop here), and the
      permanent gaps stay permanent — Trusted-Types `page_exec` and
      trusted synthetic input have no Firefox API.

- [x] ~~**`/undo` + `/redo`**~~ — **RESOLVED 2026-06-12: don't build
      generalized turn rollback** (`DESIGN-09-undo-redo.md`), and —
      same day, owner call — ALL user-facing rollback came out with it:
      the `/undo`+`/checkpoint` composer commands, the `edit/*` panel
      routes, the Checkpoints bar, and the manager's dead
      undo/restore methods. Workspace snapshots remain solely as
      review's `diffSince` substrate. Revisit only with a real design
      for undoing live state (DOM above all — non-trivial); git
      history holds the deleted half.
- [ ] **Multi-profile** — the full isolation story: per-profile vault
      namespacing (own KEK), denylist, skills, memory, sessions;
      encrypted profile export/import. The DEFAULT profile + onboarding
      landed 2026-06-12 in the multi-profile shape (peerd-runtime/
      profiles/ store; editable peer name with the peerd.ai cursor;
      skippable basic-facts seeding into a USER doc the agent expands
      very frugally) — this item is the namespacing on top.

- [ ] **Engine robustness — residuals.** Landed 2026-06-12: tab-close
      interrupt (pending RPCs reject promptly with `VMTabClosedError`),
      per-VM FIFO command queue (`peerd-engine/command-queue.js`), and a
      trust-on-first-use rootfs pin (first 64 KiB SHA-256 + total size
      per image URL; mismatch fails boot closed). Still open: per-block
      hash manifest + custom block device for FULL stream verification
      (pairs with the peerd-built image, `docs/engine/VM-IMAGE.md`);
      shared read-only WebVM base-image cache to dedupe per-VM copies
      (`vm-tab.js TODO(shared-base-cache)` — settle CheerpX overlay
      nesting first).
- [ ] **Local in-browser inference (`local-webgpu`) — DEFERRED**
      (2026-06-12 feasibility study: `docs/LOCAL-INFERENCE.md`).
      Re-evaluate when ALL hold: (1) the Ollama adapter has shipped and
      proven the local-model demo, (2) per-session tool-exposure
      manifests exist so a local session can run a trimmed ~6-tool
      surface instead of all 45, (3) a ≤2 GB q4f16 instruct model shows
      reliable function calling over that trimmed set. Scope when
      built: Transformers.js, **WebGPU-only** (the old "WASM fallback"
      promise is cut — 2–5 tok/s is unusable), hosted in the offscreen
      doc, weights as SRI-pinned data downloads per the Moonshine
      pattern; positioned as "local quick mode", not the full agent
      loop. Zero-install is the only value left once Ollama ships —
      today it would be a 1.33 GB download into a sluggish agent that
      fumbles 45-tool selection; that fails the "works well" bar.
      DONT do anything else here:

### Larger bets (own track, no slot yet)
- [ ] **Gateway** — message peerd from outside the browser (Signal,
      Telegram, generic SMTP) and get responses back.
- [ ] **Safari port** — needs Mac app packaging.
- [ ] **Native messaging bridge** to local desktop apps (Slack, Linear).
- [ ] **Cloud / proxy mode** — a BYOK alternative for enterprise.

---

## Decentralization (dweb) — separate research track

Preview-channel only, research-grade, and large enough to be its own
program rather than a backlog line. Phase 0 shipped (above). The track
was **re-architected 2026-06-12** around four owner frames —
dependency floor, peers-do-everything, the IPv6/STUN-only bet (no
TURN, ever), and demo-rooted design — recorded in
**`docs/distributed/NORTH-STAR.md`**. Next up is Phase 1, "rooms &
live collaboration": N-peer rooms, topic gossip + sync, the dwapp
permission bridge, and the **commons** demo app (public post feed +
live co-edited document behind one `peerd://` link, with the
rendezvous server killable mid-session). The DHT, async messaging,
and curation now sequence *behind* that demo in
**`docs/distributed/ROADMAP.md`**, which remains the source of truth
for this track. Not version-pinned against the core product.

---

## Out of scope, possibly forever

- **A separate browsing context for the agent.** peerd's thesis is that
  the *user's own* browser sessions are the runtime; a clean room
  defeats the point.
- **A backend.** peerd is local-only by construction. Distributed is
  peer-to-peer, never client-to-server.
- **Telemetry.** The audit log is local-only and never leaves the device.
