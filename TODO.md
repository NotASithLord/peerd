# peerd — V1 board

Kanban-style work tracker. Columns are time horizons. Within each,
items roughly ordered by sequence.

Architecture is in `ARCHITECTURE.md`. Recent breaking changes in
`ARCHITECTURE-CHANGES.md`. Per-decision rationale in `docs/DECISIONS.md`.
Planned work and backlog live in GitHub Issues.

---

## 📓 Field-test findings — 2026-06-05

First end-to-end usage test of the chat + tools pipeline (Touch ID
unlock → voice input → Gmail "mark Martin emails as read" task).
Vault, voice, navigation, read_page, scroll, and screenshot all
worked. Failure mode was **context volume**, not correctness.

**Symptom.** After a handful of tool calls in one session — including
one `capture` (screenshot) — the next turn 429'd:

    Provider 'anthropic' HTTP 429: rate_limit_error — 30,000 input
    tokens per minute exceeded.

**Why it happened.** Anthropic Tier 1 is 30k input tokens/min. The
turn that 429'd was likely sending:

  - System prompt (small)
  - Tool definitions for ~20 registered tools (~3k tokens baseline)
  - Full message history including the screenshot's base64 dataUrl
    from `capture` (a single 1280px PNG is easily 100KB base64 ≈
    25-30k tokens) — this is the single biggest line item
  - Multiple `read_page` results (~1k tokens each, kept verbatim)
  - The new user message

One screenshot alone can saturate the tier; cumulative tool results
across multiple turns easily push past it.

**Status:** ALL mitigations shipped. Screenshot bytes and over-long
tool results are stripped from persisted history AND from the re-send
to the model (`peerd-runtime/loop/redact.js`, applied in
`agent-loop.js`); the Anthropic adapter caches system + tools +
last-message (3 of 4 breakpoints); `trimHistory`
(`peerd-runtime/loop/trim.js`) is the sliding-window backstop; and the
token meter ships as the CostChip. Cards kept below as record.

### [x] Strip screenshot bytes from message history — DONE *(highest leverage)*

`captureTool` returns `{ dataUrl: "data:image/png;base64,…" }` in the
tool_result content block. That block gets stored in the session and
re-sent on every subsequent turn. Fix:

  - In the session persistence step (peerd-runtime/loop/agent-loop.js),
    rewrite tool_result blocks whose content includes a base64
    `data:image/` URL: replace the dataUrl with a sentinel
    (`<screenshot stripped: 234 KB, retained in UI cache>`) before
    persisting and before re-sending to the model.
  - The side panel keeps the full bytes in a separate IndexedDB cache
    keyed by tool_use_id so the user can still expand the result and
    see the image. Model only ever sees the metadata.
  - V1.1+ vision-aware turns can opt back in by sending the bytes ONCE
    in the turn they were captured, then stripping on persist.

This single fix probably eliminates 90% of the 429 surface today.

### [x] Truncate large tool results in history — DONE *(quality of life)*

Same idea, broader: any tool_result content over N chars (start with
8000) gets truncated to `head + tail + '<… N chars elided>'` when
written to session storage. Live turn still sees the full result. The
historical re-send sees the trimmed version. Affects read_page bursts
on big SPAs, verbose VM output, web_search with long pages.

### [x] Tool-definition cache breakpoint — DONE *(rate-limit relief)*

We already mark system prompt + tools as cacheable in the Anthropic
adapter. Confirm the cache breakpoint placement is right (after tool
defs, before the conversation), and add a third breakpoint after the
last assistant+user pair so long conversations re-use most of the
window. Estimated 50% rate-limit headroom on long sessions. ~50 LOC.

### [x] Sliding-window history trim — DONE *(backstop)*

`peerd-runtime/loop/trim.js` (`trimHistory`) is applied in the agent
loop before each model call: under the soft cap it's a no-op; over it,
the oldest turns collapse to a single synthesized summary message.

### [x] User-visible token meter — DONE *(shipped as the CostChip)*

Per-turn/per-session token + cost telemetry in the side panel (feature
06), with a hard spend limit (`spendLimitUsd`) on top.

---

## 🚧 Now — one card at a time

WebVM **shipped** — CheerpX is vendored (`extension/vendor/cheerpx/`),
the host runs in the VM tab, and the agent drives it via
`vm_boot`/`vm_list`/`vm_create`/`vm_import`/`vm_write_file`/`vm_delete`
(the tool is `vm_boot`, not the old working name `vm_run`). See Done.

Current focus: the **2026-06-12 roadmap wave** — working the entire
backlog (GitHub Issues) top to bottom. Landed so far: trust-mode removal
(+ Plan URL-load carve-out, DECISIONS #16), header declutter, Ollama
adapter + GPU-fit recommendation, audit retention cap, vault blob →
IDB, boot-console shell restyle, DESIGN-09 (undo/redo: don't build),
VM-IMAGE scoping, LOCAL-INFERENCE deferral. In flight: engine
robustness, JS-sandbox sealing, loop features (concurrent dispatch,
custom system prompts, auto-memory, context compression), per-session
tool manifests, onboarding/default profile, hooks + goal-mode UI,
Firefox parity, Argon2id.

## ⏭ Next — V1 critical path

### [x] Firefox parity pass — LANDED 2026-06-12

API guards + AMO `data_collection_permissions` metadata + the DOM-walk
pseudo-snapshot as the universal no-CDP fallback. As of 2026-06-13 this
is the DEFAULT path on the store Chrome package too (ships without
`debugger`), not just Firefox / advanced-automation-off — and `read_state`
gained a `world:'MAIN'` selector fallback so it works without CDP. The
genuinely CDP-only tools (`page_exec` on Trusted-Types pages, `page_keys`)
say WHY they're unavailable with channel-agnostic wording. Remaining
user-side: side-load on a real Firefox and exercise the flows. Permanent
gaps stay permanent
(Trusted-Types `page_exec`, trusted synthetic input — no Firefox API).

### [ ] OpenAI native adapter *(deprioritized)*

OpenRouter already covers OpenAI models via one key, and Ollama now
covers local. A native OpenAI adapter is one format-layer reuse away
when demand shows up; until then the manifest stays minimal (store
policy: never request what the shipped version doesn't use).

## 🧹 Followups — out of critical path

These don't block shipping but are tracked.

- [x] **Memory-hard vault KDF (Argon2id, vault.v2) — LANDED 2026-06-12**
      despite the earlier deprioritization (the roadmap wave reached it):
      vendored hash-wasm Argon2id (SHA-pinned, registry-cross-checked),
      64 MiB single-lane RFC 9106 profile, params-as-data with DoS rails
      on stored descriptors, lazy migration on successful passphrase
      unlock, PBKDF2 v1 wraps verified forever, PRF path untouched.

- [ ] **Provider-endpoint add flow.** Skeleton mentioned in
      `peerd-egress/fetch/safe-fetch.js` comments. UI for adding a
      custom provider endpoint to the safeFetch allowlist with a
      one-click confirm. Lives in `peerd-provider/registry.js`.
- [ ] **OpenRouter unified reasoning support.** The OpenRouter adapter
      accepts-but-ignores the whole `reasoning` object (adapters/
      openrouter.js) — no extended thinking, and the new reasoningEffort
      dial is hidden on OpenRouter chats (chat-view gates on the session
      provider). OpenRouter supports `{"reasoning": {"effort": ...}}`
      with xhigh/high/medium/low/minimal/none (NO 'max' — clamp ours to
      xhigh; Anthropic-model mapping is budget_tokens = max_tokens ×
      0.2/0.5/0.8/0.95). Real scope, not a quick patch: stream-parse
      `delta.reasoning`, and STORE + REPLAY `reasoning_details` blocks
      in tool loops for Anthropic-via-OpenRouter or tool_use turns 400 —
      the likely reason the adapter punted originally.
- [ ] **Panel-side confirm-prompt queue.** With per-session turn slots
      (2026-06-12) a BACKGROUND chat's turn can raise a confirm while
      the viewed chat shows its own — the panel renders last-writer-
      wins, so the hidden prompt auto-denies after 120s (fail-closed,
      safe, but silent). Queue prompts in the panel and label each
      with its chat title.
- [ ] **`.editorconfig`** to nail down line endings and indent.

**Cleared in the 2026-06-12 sweep** (verified done or obsolete, kept
for the record): DESIGN.md saved (the 90KB real one is at `DESIGN.md`);
CDP headless harness + CI wiring (both live — `scripts/cdp/` runs as
its own CI job); `originsAuthorized` gate integration (obsolete — the
trust-mode axis was REMOVED, see `docs/DECISIONS.md` #16);
message-history cache breakpoint (3-of-4 breakpoints ship in the
Anthropic adapter); sliding-window history trim (`loop/trim.js`);
WebVM egress plumbing (bash wrappers route through `peerd-egress`);
denylist editor view (ships in Context view with user overlay);
session-scoped tool grants (ship with confirmations); /verify skill
stub (obviated — the skills system shipped as feature 07).

## 🔭 Later

Versions are no longer pinned in advance (0.x until the surface
stabilizes). The single source of truth for
everything not on this board is **GitHub Issues**; the dweb
research track lives in `docs/distributed/ROADMAP.md`.

## ✅ Done — recent first

- [x] **Demo-polish pass (alpha first-impression).** `feat/demo-polish`:
      (1) **Markdown rendering** for assistant replies via a
      dependency-free, injection-safe renderer (`shared/markdown.js`).
      (2) **Opt-in action confirmations** — the dispatcher's async
      confirmation step + the `peerd-egress/confirm` round-trip, gated by
      `settings.confirmActionsEnabled` (default OFF for a low-friction
      demo), with a `ConfirmModal` and session-scoped grants.
      (3) **Logs view** (`/logs`) surfacing the audit log + active
      denylist to the user. (4) **OpenRouter provider** (OpenAI-compatible
      gateway) selectable in Settings, per-session provider/model.
      (5) **Honest `capture` contract** — bytes were already stripped by
      `redact.js`, so the tool/prompt no longer claim the model can
      "see" screenshots; `capture` is a show-the-user tool.
      (6) **click/type caveat** documented (synthetic events; escalate to
      page_keys/page_exec on bot-detection SPAs).

- [x] **WebVM (CheerpX Linux) — third execution kind.** CheerpX vendored
      under `extension/vendor/cheerpx/`; host runs in the VM tab; agent
      drives it via `vm_boot`/`vm_list`/`vm_create`/`vm_import`/
      `vm_write_file`/`vm_delete`. HTTP egress (curl/wget/git) routed
      through `peerd-egress` via bash wrappers. Persistent IDB overlay
      per VM. (Tool is `vm_boot`; the old `vm_run` working name is dead.)

- [x] **Notebook + App execution kinds.** Notebook (Web Worker +
      OPFS, `peerd.egress.fetch` shimmed) and App (stored multi-file HTML in a
      sandboxed iframe) — each its own tab, registry, tab tracker, and
      tool family (`js_*` / `app_*`). (Formerly "JS Sandbox"; renamed #23.
      The headless `js_run` worker was added later, #25.)

- [x] **Subagents.** Depth-bounded `spawn_subagent` (the model's way to
      decompose/parallelize its own work — one chip per call) plus
      `peerd.runAgent` for artifacts that embed their own agent (an App's
      chat box, NOT orchestration fan-out); nested transcripts render
      inline. Real implementation (`peerd-runtime/subagent/`), not a stub.

- [x] **Voice in/out.** Local transcription via Moonshine (WASM, SRI-
      pinned, OPFS-cached) with a Web Speech fallback, hosted in the
      offscreen doc.

- [x] **Distributed Phase 0.** Signed app-bundle transfer over WebRTC
      (identity/transport/content/codec scaffolding) — the dweb wedge;
      still V2-scope beyond the wedge.

- [x] **WebAuthn / Touch ID unlock — Touch ID is the default; passphrase
      is the recovery fallback.** `peerd-egress/vault/webauthn.js`
      wraps `navigator.credentials.create/get` with the PRF extension;
      the side panel runs the ceremony (only document context with
      WebAuthn access) and ships the 32-byte PRF output to the SW,
      which imports it directly as an AES-KW KEK and wraps the same DK
      as a second blob alongside the passphrase wrap. `vault.v1` grows
      `wrappedDK_prf` + `credentialId` + `prfSalt`; either unlock path
      recovers an equivalent DK so any secret encrypted under one path
      decrypts under the other. SW exposes a combined
      `vault/initializeWithPrf` so first-run is atomic (ceremony stays
      bound to the form-submit gesture; rollback on enroll failure).
      First-run UI leads with "Set up with Touch ID" + recovery
      passphrase when WebAuthn is available; falls back to
      passphrase-only setup otherwise. Unlock UI leads with "Unlock
      with Touch ID"; "Use recovery passphrase" reveals the passphrase
      form. Settings has enroll/disable for existing passphrase-only
      vaults. New `PrfNotEnrolledError` / `PrfUnlockFailedError`;
      `prfEnrolled` surfaced in pushState. 11 new tests cover enroll →
      lock → PRF-unlock roundtrip, passphrase fallback after enroll,
      idempotent re-enroll, wrong-bytes/no-enroll error paths, and
      at-rest secrecy of the PRF output itself.

- [x] **Auto-scroll to bottom on new messages.** Bottom-aware heuristic
      with 150px threshold replaces the broken tail-growth check.
      *(`93abb97`)*
- [x] **Stop button + abortable turns + always-typeable input + MAX_STEPS
      25 → 100.** AbortController in SW, signal flows through
      `runUserTurn` → `callModel` → `safeFetch` → native fetch. Send
      mid-stream auto-aborts the previous turn and steers. Cap-hit no
      longer emits synthetic error — last assistant gets stopReason
      `max_steps`. *(`54fd969`)*
- [x] **Personal-account auth unblocked + prompt-cache system+tools +
      read_page payload trim.** Removed `accounts.google.com` etc. from
      identity denylist. Cache_control:ephemeral on system + last tool
      cuts rate-limit pressure ~90% on repeat turns. read_page text cap
      8000 → 4000. *(`8c5dd5e`)*
- [x] **DOM tools: read_page, click, type, navigate, list_tabs,
      open_tab.** chrome.scripting injection; `<untrusted_web_content>`
      wrapping on read_page; native value setter in type bypasses
      React's interceptor; navigate has a 30s timeout. Manifest
      `<all_urls>` host permission mandatory. *(`8258049`)*
- [x] **Tool-call rendering: inline lineage, primitive badge,
      collapsible result.** Hides the tool-result user bubbles
      (transport artifact); pairs tool_use blocks with their results by
      tool_use_id. Gate marks ✓/✗ with reasons on hover.
      Color-coded primitive badge matches wordmark. *(`de4d53c`)*
- [x] **Agent loop tool integration + Anthropic adapter tool_use.**
      Inner multi-step loop; SSE tool_use parsing; tool_result blocks
      on user messages; cache breakpoints on system+tools. *(`8ed308b`)*
- [x] **Tool layer: registry, dispatcher with 6 gates, 5 introspection
      tools.** persona/exposure stubs + origin/confirm/egress/audit
      active. inspect_provider_config / _storage / _session_access /
      _denylist / _audit_log — one per §02 claim. *(`1e23b48`)*
- [x] **Project docs at root + CLAUDE.md + ARCHITECTURE rewrites.**
      `docs/` moved to root; CLAUDE.md added; ARCHITECTURE.md §0/§1/§2
      rewritten; ARCHITECTURE-CHANGES.md captures recent breaks.
      *(`cee33ec`)*
- [x] **Keepalive heartbeats fix the SW death loop.** Bidirectional
      heartbeat traffic on the offscreen port keeps the SW alive past
      30s idle. *(`9c4827d`)*
- [x] **DK persistence in chrome.storage.session.** SW death is now
      harmless — unlock prompts fire once per browser session, not
      once per SW lifetime. *(`63d18bc`)*
- [x] **Multi-session UI + auto-lock disabled.** /chats route with
      session list + per-row archive; session title auto-derived from
      first user message; vault.autoLockMs:0 disables idle re-lock.
      *(`a771a6d`)*
- [x] **Sessions and profiles move to peerd-runtime.** Distributed
      becomes dweb-only; orchestration containers in runtime.
      *(`1e2e561`)*
- [x] **Five-module architecture (peerd-*).** Reorganized around the
      brand wordmark. SW becomes pure wiring. *(`d741da8`)*
- [x] **Rename Lattice → peerd.** *(`f7d7876`)*
- [x] **V1 foundation scaffold.** Vault, egress, denylist, storage,
      SW + offscreen keepalive, side panel skeleton with Mithril,
      in-browser test framework. *(`2728465`)*
