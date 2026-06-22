# FEATURES — peerd, itemized

> The itemized **what's shipped** list, categorized by the five brand
> modules plus the chassis. One line per feature; the source dir is in
> backticks. For one-screen orientation see `MAP.md`, then `CLAUDE.md`.
>
> `peerd-distributed/` (the dweb) is **preview-channel only** — the store
> package prunes the whole module, so every dweb feature below is absent
> from a store build. Items not fully shipped are marked **(partial)** or
> grouped under a **Not yet** subsection per module so this stays honest.

---

## `p` peerd-provider — model adapters

The model-adapter seam: one `callModel`/registry streaming chat from
Anthropic, OpenRouter, Ollama, and an on-device WebGPU runner into a
single provider-agnostic event stream, plus the pure schema, cost,
context-window, error, failover, and GPU-fit helpers around it.

- **Provider registry + single `callModel` entry** — in-memory adapter map; runtime calls `callModel`/`listProviders` only, never importing adapters; `UnknownProviderError` on miss. `peerd-provider/registry.js`, `index.js`
- **Anthropic adapter (streaming chat)** — `POST /v1/messages`, SSE via `fromAnthropicStream`, dangerous-direct-browser-access ack, BYOK from vault; default `claude-sonnet-4-6`. `peerd-provider/adapters/anthropic.js`
- **Anthropic extended thinking (adaptive + legacy)** — model-keyed shape (4.6+/Fable = adaptive+effort, pre-4.6 = enabled+budget); replays signed thinking blocks on tool turns; surfaces reasoning deltas. `peerd-provider/format/`
- **Anthropic prompt caching (3 of 4 breakpoints)** — `cache_control:ephemeral` on system, last tool def, last message; cache read/write tokens parsed from `message_start`. `peerd-provider/format/`
- **OpenRouter adapter (OpenAI-compatible gateway)** — `POST /chat/completions` to openrouter.ai, BYOK, app-attribution headers, OpenAI wire format; default `openai/gpt-4o-mini`. `peerd-provider/adapters/openrouter.js`
- **OpenRouter live catalog + curated seed** — `listOpenRouterModels` reads `GET /models` (doubles as key-verify probe); `OPENROUTER_POPULAR` seed for the Settings picker. `peerd-provider/adapters/openrouter.js`
- **Ollama adapter (keyless local inference)** — `localhost:11434`, keyless (skips vault), 120s connect timeout for cold load, 404→`ollama pull` hint; default `qwen3:8b`. `peerd-provider/adapters/ollama.js`
- **Ollama live model inventory** — `listModels` reads `GET /api/tags` so pickers show actually-pulled models. `peerd-provider/adapters/ollama.js`
- **Ollama daemon-down legibility** — bare `TypeError` → `OllamaNotRunningError` with the `ollama serve` fix instead of "Failed to fetch". `peerd-provider/adapters/ollama.js`, `errors.js`
- **OpenAI-compatible SSE parser** — `fromOpenAiStream`: incremental `tool_calls` keyed by index with id/name backfill, finish-reason mapping, usage tally; shared by OpenRouter + Ollama. `peerd-provider/format/from-openai.js`
- **Internal-message schema conversion (both wire formats)** — `to-anthropic`/`to-openai` map the internal union per provider; image/pdf blocks, stripped sentinels, system-as-prepended-message. `peerd-provider/format/`
- **Orphan tool_use/tool_call repair** — synthesizes `is_error` results for tool calls left unpaired by mid-dispatch interruption; both formats. `peerd-provider/format/`
- **Transient-error retry with backoff** — 429/529/500/503 retry (3×) with retry-after/token-reset parsing + exponential fallback, capped 60s, abort-aware. `peerd-provider/adapters/`
- **Connect timeout + connection-drop retry** — guards only the initial headers (body streams untimed); retries bare-`TypeError` drops up to 3 tries, never mid-stream. `peerd-provider/connect-timeout.js`
- **Hard-limit vs transient classification** — `isUsageLimitResponse` (402 + billing/credit/quota) fails fast as `ProviderUsageLimitError` instead of burning retries. `peerd-provider/error-classify.js`, `errors.js`
- **Provider failover (switch-and-continue)** — `shouldFailover` classifies 500/503/529/usage-limit as cross-provider-recoverable; `planFailoverChain` orders deduped candidates. `peerd-provider/failover.js`
- **Page-reader runner-model resolution** — `resolveRunnerModel` picks runner model: user pin > local WebGPU > provider default (Haiku) > inherit. `peerd-provider/runner-model.js`
- **Client-side cost telemetry** — `DEFAULT_PRICING` rate table + `costOf`/`resolvePricing`; user-overridable, unknown-id degrades to honest `$0`. No network. `peerd-provider/pricing.js`
- **Context-window table + live resolution** — `DEFAULT_CONTEXT_WINDOWS` + `resolveContextWindow` (override > live > table); live windows from each provider's API. Drives the long-session trim trigger. `peerd-provider/context-window.js`, `model-window.js`
- **Ollama GPU-fit recommendation** — `probeGpuCapability` + pure `recommendOllamaModel` picks the largest qwen3 tier that fits, with confidence. `peerd-provider/ollama-recommend.js`
- **Local-model hardware capability gate** — `probeLocalModelCapability` + pure `judgeModelCapability` vs `MODEL_SPECS`; powers the Settings "Test" button. `peerd-provider/local-model-capability.js`

**Not yet**

- **Local WebGPU adapter (on-device runner)** — keyless `$0` shim re-yielding the offscreen Gemma engine's token stream as `ProviderEvents` (parses `<tool_call>` into tool-use events); engine bridge injected via `setLocalGenerate`, errors cleanly until the SW wires it at boot. `peerd-provider/adapters/local-webgpu.js` **(partial)**
- **OpenAI native adapter** — not present; OpenRouter covers OpenAI models meanwhile (no `adapters/openai.js`). `peerd-provider/index.js` **(planned)**

---

## `e` peerd-egress — security spine

Encrypted secret vault (passphrase + passkey), egress allowlist/SSRF
guards, sensitive-site denylist, confirmation protocol, append-only
audit log, and the storage primitives the rest of the extension is
built on.

- **Encrypted secret vault (AES-GCM DK + AES-KW wrap)** — per-secret AES-GCM-256 under a 256-bit data key, AES-KW-wrapped at rest; every `getSecret` does a fresh decrypt, plaintext never cached. `peerd-egress/vault/`
- **Passphrase unlock with Argon2id KDF** — `vault.v2` wraps the DK under an Argon2id (memory-hard) KEK with fresh salt + full cost descriptor; Argon2id is the only passphrase KDF (PBKDF2 v1 deleted). `peerd-egress/vault/`
- **WebAuthn PRF unlock (Touch ID / Windows Hello / security key)** — passkey-first init, enroll/unlock/disable PRF, passphrase+PRF as alternative wraps of the same DK; platform + roaming authenticators. `peerd-egress/vault/`
- **Recovery passphrase for passkey-first vaults** — `setRecoveryPassphrase` adds a passphrase wrap non-destructively; `disablePrf` refuses to strip the last unlock factor. `peerd-egress/vault/`
- **Idle auto-lock (default ON, 45min, settable)** — timer armed/reset on `touch()`; `0` = never; DK dropped on lock. `peerd-egress/vault/`
- **DK survives SW restart via `chrome.storage.session`** — unwrapped DK mirrored (RAM-only, cleared on browser close) so an MV3 idle-restart resumes unlocked; `attemptResume` restores it. `peerd-egress/vault/`, `storage/session-cache.js`
- **Vault blob home in IDB with verified migration** — blob lives in the IDB `vault` store with a one-time copy/read-back/verify migration off `storage.local`; falls back + retries on failure. `peerd-egress/vault/`
- **`safeFetch` — provider-endpoint egress allowlist** — exact-origin allowlist (no wildcards) wrapping the credentialed provider path; denies off-list, fails closed on any 3xx redirect, audits denials. `peerd-egress/fetch/`
- **Hardcoded provider allowlist** — frozen origin set: Anthropic, OpenAI, OpenRouter, Ollama loopback; changing requires editing the file. `peerd-egress/fetch/allowlist.js`
- **`webFetch` — open-web egress wrapper** — allowlist-free path for web tools: http/https only, private-network block, denylist, redirect fail-closed; audits `web_fetch` + denials. `peerd-egress/fetch/web-fetch.js`
- **SSRF / private-network guard** — blocks loopback/LAN/link-local incl. inet_aton encodings, IPv6 (`::1`, ULA, IPv4-mapped/NAT64), `*.localhost`/`*.local`; honest that DNS rebinding is out of scope. `peerd-egress/fetch/private-network.js`
- **Sensitive-site denylist matcher** — boundary-safe (exact host or leading `*.subdomain` only, no substring bugs); flattens categorised JSON; normalizes/validates user patterns fail-closed. `peerd-egress/denylist/`
- **Seed denylist (164 patterns, 8 categories)** — banks_us, brokers, crypto_exchanges, wallets, health_us, government, password_managers, identity; apex + subdomain wildcard listed per site. `peerd-egress/denylist/default.json`
- **Confirmation coordinator (SW ↔ side panel)** — async user-confirm protocol that always settles: auto-deny on broken channel/timeout, pending-count badge, late-joiner replay, broadcast-dismiss. `peerd-egress/confirm/protocol.js`
- **Append-only audit log with capped retention** — IDB append/list, in-house id+timestamp, amortized prune (every 256 appends) to a 20k cap; UUIDv7 keys keep order. `peerd-egress/audit/`
- **Storage primitives (kv / idb / session-cache)** — `chrome.storage.local` kv, thin IDB wrapper (9-version schema, batched/ranged ops, single-blob adapter), and ephemeral session wrapper. `peerd-egress/storage/`

**Not yet**

- **User-added provider endpoints** — `safeFetch` reads a runtime allowlist (hardcoded + user-added), but the per-host runtime grant/confirmation flow to ADD endpoints isn't built here. `peerd-egress/fetch/safe-fetch.js` **(partial)**
- **Session-scoped confirm grants** — blanket per-session approvals live in SW memory (origin-blind, die with SW); the persistent origin-scoped `tool_grants` store is a documented follow-up (store declared only). `peerd-egress/confirm/protocol.js` **(partial)**

---

## `e` peerd-engine — execution sandboxes

The metadata registries, persistence, and composition machinery behind
peerd's four sandboxes (WebVM, Notebook, App, headless `js_run`). The
runtimes live in `*-tab/` and `offscreen/`; this module is the catalog +
shared utilities.

- **WebVM registry (CheerpX Linux catalog)** — persistent CheerpX-Debian VM catalog; each record carries an immutable per-VM IDB disk-overlay key + pinned/lastUsedAt + a per-session current-VM pointer. `peerd-engine/vm-registry.js`
- **Notebook registry (sealed JS worker catalog)** — persistent Notebook catalog (OPFS root `/peerd-notebooks/<id>/`), same persistence/session-default shape as VM. `peerd-engine/notebook-registry.js`
- **App registry (opaque-origin iframe artifact catalog)** — user-facing HTML apps: tags, entryFile, favorite, provenance (local/imported/dweb), thumbnail, dweb-version slot, shared flag; `searchMetadata()`. `peerd-engine/app-registry.js`
- **Shared registry factory** — one `createRegistry` backs all three kinds: CRUD, single-key persistence, stale-pointer auto-clear, allowlisted patch fields; per-kind diffs injected. `peerd-engine/registry-factory.js`
- **Notebook module resolver** — pure import-graph rewriter: relative static/dynamic imports → host-realm blob URLs (recursive, cycle-detecting); `peerd:std` builtins mapped; entry export-stripping + import hoisting for IIFE exec. `peerd-engine/module-resolver.js`
- **OPFS file helpers** — rooted per-instance read/write/delete/list/nuke usable in any context; no cached dir handle (survives SW restart). `peerd-engine/opfs.js`
- **App composition (multi-file → single HTML)** — inlines tag-relative `<link>`/`<script src>`, shims `new Worker('x')` to blob workers, `<base target=_blank>` + strip-meta-refresh guards. Pure. `peerd-engine/app-compose.js`
- **CodeMirror editor (Notebook + App edit mode)** — reusable OPFS-rooted editor: file-tree, CM6, debounced auto-save, undeletable pinned entry file, create/delete dialogs. `peerd-engine/editor.js`
- **`.peerd` artifact export/import** — build/open/inspect bundle envelopes for app/notebook/vm-recipe over `/shared/bundle` (canonical manifest + 256KiB content-addressed chunks, 64MB rail). v1 envelopes UNSIGNED. `peerd-engine/export.js`
- **Per-VM FIFO command queue** — pure keyed-lane serializer so concurrent `vm_run` calls can't clobber the single bash capture buffer; lanes detach on tab-close. `peerd-engine/command-queue.js`
- **WebVM HTTP-native networking cores (vm-net)** — pure logic behind the VM egress chokepoint: stdout-sentinel wire codec, denylist-gated `webFetch` orchestration, git-auth injection, IDB cache policy, capability banner, apt shims. `peerd-engine/vm-net/`
- **VM package/git control-ops** — host-side resolvers staging deps: git clone (snapshot archive, github/gitlab + private via vault), npm/yarn/pnpm, pip (pure-python), gem (pure-ruby). apt-get + native C builds unavailable. `peerd-engine/vm-net/control-ops.js`
- **Socket-stub guardrails** — ssh/scp/nc/telnet/ping/rsync become clear bash error stubs (no raw TCP/UDP/ICMP) rather than hangs. `peerd-engine/vm-net/socket-stubs.js`
- **Per-VM IndexedDB rootfs overlay** — read/write block overlay (one IDB DB per install) over the streamed read-only base image so disk survives restarts; `reset()` wipes it. `peerd-engine/overlay.js`
- **Typed engine error taxonomy** — `VMNotReady`/`BootFailed`/`RunTimeout`/`NetworkDenied`/`TabClosed`, `ArtifactTooLarge`, `EnvelopeFormat`/`Integrity` for precise sandbox failure signaling. `peerd-engine/errors.js`

**Not yet**

- **TOFU rootfs integrity pin** — pure decision logic: trust-on-first-use pin of base-image size + first-64KiB SHA-256, verified each boot, fails closed on drift. Head-only by construction — a faithful-head/tampered-tail host is an acknowledged residual gap. `peerd-engine/image-pin.js` **(partial)**
- **App body IDB store** — IDB store for full HTML bodies + linear-scan search; works but reserved for a future SNAPSHOT tier (not the OPFS hot path), so not re-exported. `peerd-engine/app-store.js` **(partial)**
- **Custom/persisted VM images** — every VM boots the same hardcoded stock Debian; no `VmRecord.image` field and no shared read-only base cache yet. `peerd-engine/README.md` **(planned)**

---

## `r` peerd-runtime — the agent brain

The streaming tool-using agent loop, the policy-gated dispatcher + tool
inventory, the do/get/check browser runner, sessions, subagents,
permissions, memory, edit, skills, review, composer, cost, clock, voice,
transfer, ralph, profiles — pure-core/injected-IO so the SW stays thin.

- **Streaming agent loop (orchestrator)** — async-generator turn loop: assistant stub → stream text/reasoning/tool-use deltas → dispatch → tool_result round, capped at `MAX_STEPS=100`. `loop/agent-loop.js`
- **Concurrent multi-tool batching** — consecutive READ-class calls (+ `spawn_subagent`) run in parallel, everything else stays serial single-writer. `loop/tool-batch.js`
- **Auto-resume of interrupted turns** — detects an SW-reclaimed mid-flight turn and drives a synthetic continuation via `RESUME_NUDGE`. `loop/resume-detect.js`, `resume-notes.js`
- **Per-session turn slots** — steer-live aborts stay scoped to one chat; streams in other conversations survive navigation/new sends; `runWhenIdle` backs async subagents. `loop/turn-slots.js`
- **Long-session context compression** — rolling trim-summary core + post-turn enrichment shell (cheap-call) + lineage body compaction. `loop/trim.js`, `rolling-summary.js`, `summary-enrichment.js`, `lineage-compaction.js`
- **System prompt + temporal grounding render** — templated assembly with `MEMORY_BLOCK` + clock temporal block. `loop/system-prompt.js`, `clock/context.js`
- **File attachments (image + PDF)** — pure classify/validate/strip core with size+count caps, shared by SW/side panel/loop, fail-closed. `loop/attachments.js`
- **Policy-gated tool dispatcher** — runs tool calls through the policy checks and hook chain defined in code; confirmation is async, audit logs all, and every result carries lineage. `tools/dispatcher.js`, `gates.js`, `tools/hooks/`
- **Tool registry** — register/get/list/clear surface; `index.js` is the module public API. `tools/registry.js`
- **Built-in tool inventory** — `BUILTIN_TOOLS`: inspect, DOM/page/tab, VM, Notebook (`js_*`), App (`app_*`), `edit_file`, `spawn_subagent`, do/get/check, memory, `request_review`, `read_pdf`, dweb; + clock + web + `load_skill`. `tools/defs/index.js`
- **Tool exposure split (main vs runner-only)** — main-agent-hidden / instance-gated / dweb-gated descriptor filtering; low-level DOM tools runner-only, dweb tools preview-gated. `tools/exposure.js`
- **Pre/post-tool-use hooks** — fail-closed lifecycle hooks around `execute()`; egress-allowlist ships as a default pre-hook; user hooks compile from markdown. `tools/hooks/`
- **Untrusted-content prompt wrapping** — `wrapUntrusted` fences page/tool text against prompt injection. `tools/prompt-wrap.js`
- **do/get/check browser runner** — disposable browser-runner subagent (narrowed DO/READ toolset, one tab, no memory/egress/code/spawn) — the security boundary; main agent sees only a text summary. `runner/index.js`, `tools/defs/`
- **DOM navigation engine** — a11y-tree serializer, ref registry, diffable snapshots; CDP capture when wired else `chrome.scripting` DOM-walk pseudo-snapshot (same contract), MAIN-world state read. `dom/`
- **Sessions store** — persistence/CRUD over injected storage; typed session shape. `sessions/`
- **Subagents (sync, depth-bounded)** — `makeSpawnSubagent`: depth cap (`MAX_DEPTH=5`), tool narrowing, output cap, final-text extraction. `subagent/spawn.js`
- **Async (non-blocking) subagents** — spawn returns a handle, result re-enters parent as a synthetic wake turn; `subagent_tasks`/`cancel` surface. `subagent/async-subagents.js`
- **Cheap one-shot clean-context calls** — `tools:[]` spawn with spend-limit preflight + cost fold into parent; backs auto-memory + trim enrichment. `subagent/cheap-call.js`
- **Permissions (Plan/Act)** — pure `decideAction`: Plan blocks side-effecting tools (permits pure URL loads), Act defers auto-vs-ask; confirm-actions toggle. `permissions/`
- **Memory (file-based AGENTS.md)** — hierarchical-scope store + pure core, always-loaded line budget, `/init` drafter+orchestrator, confirm-gated `remember`/`read_memory`. `memory/`
- **Auto-memory extraction** — wrap-up extraction → pending suggestions → user-approved append to user doc, with thresholds + dedupe. `memory/auto-memory.js`, `suggestions.js`
- **Edit (SEARCH/REPLACE) + checkpoints** — parse/apply edit blocks (`edit_file`), snapshot store, checkpoint manager with `diffSince`, write-permission adapter. `edit/`
- **Review subagent** — `makeRequestReview`: clean-context read-only reviewer (read-only tool intersection), diff synthesis (incl. from checkpoint), severity parsing. `review/`
- **Composer (slash commands + @-refs + palette)** — parse commands/args/refs, palette fuzzy-filter, command store, tab/file ref resolvers; skills surface as `/<name>`. `composer/`
- **Cost/usage telemetry** — pure token accumulator + per-turn tracker: fold usage, persist session total, push live meter, fire hard spend-limit halt once. `cost/`
- **Clock (temporal grounding + tools)** — `buildTemporalBlock` for the prompt + `now` / `wait_until` tools. `clock/`
- **Voice (local transcription)** — voice manager + model store + engine picker (Moonshine WASM, Web Speech fallback) + MicButton; offscreen-hosted. `voice/`
- **Transfer (settings export/import)** — pure build/inspect/apply export shaping + passphrase encrypt/decrypt for cross-install migration. `transfer/`
- **Ralph persistent fresh-context loop** — read plan → pick one task → spawn fresh-context iteration → backpressure gates (lint/test/build/console/dom) → commit; resumable via plan+LoopState. `ralph/`
- **Skills (progressive disclosure)** — parse `SKILL.md`, store+registry, install from local/git/manifest, `load_skill` tool. Remote install flag-gated off for store. `skills/`
- **Web tool policy** — `WEB_TOOLS` (`call_api`, `read_article`, `web_search`, `submit_form`, `capture`) with fetch-vs-tab escalation heuristics. `tools/web/`
- **PDF reading (`read_pdf`)** — pdf.js text-layer extraction with opt-in SRI-pinned OCR engine + page assembly. `pdf/`, `tools/defs/read-pdf.js`
- **Contacts (per-peer overlay)** — did-keyed contacts store (name/notes/tags) + read-time known-peers + activity aggregation from App catalog + audit log. `contacts/`
- **Sandbox tools (VM / Notebook / App / `js_run`)** — `vm_*`, `js_*` (Notebook sealed worker + headless `js_run`), `app_*` (opaque-iframe dwapps) families dispatched through gates. `tools/defs/`
- **dweb tools** *(preview-channel only)* — `dweb_share`/`discover`/`install`/`peers`/`block` + guide; exposure-gated to `DWEB_ENABLED` channels, invisible to the agent on a store build. `tools/defs/`, `tools/exposure.js`

**Not yet**

- **Per-session tool manifests + `/tools`** — presets-as-data + resolve/filter enforced in gates; `/tools` command works. Per-PROFILE binding still ahead. `tools/manifests.js`, `manifest-command.js` **(partial)**
- **Profiles (default-profile shape)** — single `default` record (peerName + onboarding latch); store API is multi-profile-shaped but nothing is namespaced yet. `profiles/` **(partial)**
- **Schedule / cron** — not in this module; only clock's `wait_until` timer exists. Scheduled tasks are an SW/chassis concern per design. **(planned)**

---

## `d` peerd-distributed — the dweb (preview-channel only)

> Every feature here ships in the preview channel only. The store
> package prunes the entire module and CI verifies zero dweb traces.

An always-on P2P base network — did:key identity, signed content
addressing, a WebRTC mesh + Kademlia DHT + gossip, the dwapp bridge, and
a serverless peer-to-peer app store — exposed to core via a single
`DwebClient`.

- **Ed25519 did:key identity** — ephemeral or vault-persistent (32-byte seed) identities; non-extractable keys, sign/verify, `did:key:z` encode/decode. `peerd-distributed/identity/`
- **base58btc codec** — base58 encode/decode underpinning did:key multibase. `peerd-distributed/codec/base58.js`
- **`peerd://` content addressing** — parse/format `peerd://<did>/<hash>[/path]` authored + pure-content-addressed URIs; hash is 64-hex SHA-256 of the manifest. `peerd-distributed/content/uri.js`
- **Signed chunked manifests** — build+sign domain-tagged Ed25519 manifests committing to ordered chunk hashes; verify sig + publisher attribution. `peerd-distributed/content/manifest.js`, `chunk.js`
- **Bundle pack/unpack** — app file-map ↔ payload bytes (delegates to `/shared/bundle`). `peerd-distributed/content/bundle.js`
- **Liability-firewall content store** — announce-set store: serves a chunk only if it belongs to an explicitly announced manifest; refcounted unannounce revokes serving. `peerd-distributed/content/store.js`
- **Point-to-point bundle transfer** — publisher responder + consumer `fetchBundle`: JSON-framed MANIFEST/CHUNK serve, α=3 parallel, every chunk hash-verified. `peerd-distributed/content/transfer.js`
- **Multi-provider swarm fetch** — pull one bundle striped across many providers with per-chunk failover; tamper = treated as a miss. `peerd-distributed/content/swarm.js`
- **Locality-blind connector** — `connect(peer)` tries transports cheapest-first (inproc/broadcast/webrtc) returning a uniform Channel; happy-eyeballs. `peerd-distributed/transport/connect.js`
- **Authenticated room mesh** — HELLO-authenticated links, signed-envelope routing, liveness sweep, connection budget (16), control rate-limit, ROSTER + one-hop signed RELAY. `peerd-distributed/transport/mesh.js`, `session.js`, `envelope.js`
- **Room join + always-on reconnect** — `joinRoom` via rendezvous (joiner-offers, no glare), mesh-assisted relayed dials, auto-reconnect-with-backoff; ICE path telemetry per link. `peerd-distributed/transport/rooms.js`, `ice.js`
- **Pure signaling rendezvous reducer** — `signalingStep(state,event)→{state,actions}`: per-kind capped rooms, opaque SDP relay, never inspects payload. Shared verbatim with `signaling-node/`. `peerd-distributed/transport/signaling.js`
- **WebRTC transport (trickle ICE)** — `RTCPeerConnection` data channels with trickle signaling; same-machine mDNS-loopback rewrite. Browser/device-verified. `peerd-distributed/transport/transports/webrtc.js`
- **Kademlia DHT** — PING/FIND_NODE/FIND_VALUE/STORE + ADD/GET_PROVIDERS, iterative α-parallel lookup, reachable-only routing table over signed mesh envelopes; offscreen-hosted. `peerd-distributed/dht/`
- **Signed DHT records (BEP-44)** — mutable items keyed by pubkey+salt, monotonic anti-rollback seq, domain-separated sigs; self-signed provider records. `peerd-distributed/dht/records.js`
- **Gossip flood (topic pubsub)** — dumb flooder: signature-keyed seen-cache dedup, per-sender token bucket, per-did mute, opaque payloads. `peerd-distributed/gossip/topic.js`
- **Presence beacons** — heartbeat liveness on a reserved topic carrying display-name meta; join/leave with expiry + anti-flap suppression. `peerd-distributed/gossip/presence.js`
- **Late-join topic sync** — retained-topic backfill: have-list exchange on each new link, missing signed envelopes re-verified before ingest. `peerd-distributed/gossip/sync.js`
- **Direct 1:1 messaging** — point-to-point over one mesh link, never flooded; signed but unsealed (sealed-box deferred). `peerd-distributed/messaging/direct.js`
- **Always-on base network** — one offscreen peer-node joined to the well-known lobby (`peerd/base/1`); composes mesh+gossip+presence+sync+direct+content+DHT; `snapshot()` for the home Network view. `peerd-distributed/base-network.js`, `peer-node.js`
- **Sovereign discovery plane** — subscribe/snapshot/stream/unsubscribe metadata propagation (no ambient flood); rate-limited, publisher-signed inner cards, transitive over consented edges; on/off, ban, tombstone. `peerd-distributed/apps/discovery.js`
- **DWAPP_META app cards + bounded Library** — signed cards (stable `dwapp_id`, no-downgrade seq, size caps); Library is a bounded no-downgrade cache with popularity=availability eviction. `peerd-distributed/apps/meta.js`, `library.js`
- **Peer-to-peer app store** — `publishApp`/`fetchApp` (publisher-first → seeders → bounded DHT)/`seedApp`/`unshareApp`: serverless Share/Discover/Install over the shared mesh. `peerd-distributed/base-network.js`
- **Verified bundle installer** — `installAppBundle` re-verifies commitment+signature, enforces app type, bounded file count/size (50MB/256), rejects unsafe paths; hands a clean file-map to the engine. `peerd-distributed/apps/loader.js`
- **dwapp bridge (sandbox API v0)** — frozen postMessage RPC for opaque-origin dwapps: consent-gated join, presence, publish/subscribe/retain/history, dm-send, mute, announce, publish/install-app; never exposes key material. `peerd-distributed/apps/bridge.js`
- **Commons seed app** — built-in `commons` dwapp ships as files in the preview artifact and installs into the engine App runtime first-run (bootstrap before the network exists). `peerd-distributed/apps/seed.js`
- **DwebClient core boundary + agent tools** — `createDwebClient` is the single surface core reaches via `loadDweb`; wired to the SW route + offscreen host and the 7 agent dweb tools. `peerd-distributed/client.js`, `background/routes/dweb.js`

**Not yet**

- **DHT per-hop relay dialer** — `makeDhtDialer` relays to an unlinked lookup contact through the broker that vouched for it (one-hop); only fires beyond a full-mesh lobby, path unwired in places — cold cross-mesh provider lookups are best-effort. `peerd-distributed/client.js` **(partial)**
- **Store-and-forward / E2E sealed messaging** — X25519 SealedBox for offline relay-stored DMs is the deliberate next step; not implemented (directs need a live link). `peerd-distributed/messaging/direct.js` **(planned)**

---

## Chassis — the MV3 extension skeleton

The Manifest V3 skeleton hosting the five modules: SW wiring + message
routing, the offscreen long-lived host, the Mithril chat UIs (side panel
+ full-page home), settings, the per-execution-kind tab pages,
permission grant surfaces, the live eval harness, and shared
helpers/stubs/vendored deps.

### Service worker + routing

- **Service-worker wiring + DI assembly** — single SW entry imports every `peerd-*` barrel, builds concrete instances + per-call tool/state contexts, drives the agent turn. `extension/background/service-worker.js`
- **Message dispatcher + route modules** — `makeDispatcher` fans one `runtime.onMessage` surface to ~80 deps-injected route handlers (vault, providers, sessions, settings, skills, memory, denylist, engine, hooks, ralph, contacts, dweb, system, local-model). `extension/background/routes/`, `shared/messaging.js`
- **Sender-trust guard on the privileged RPC surface** — `isTrustedSender` gates the dispatcher so only extension-origin senders reach privileged routes. `extension/shared/sender-trust.js`
- **MV3 keepalive via offscreen port + heartbeat** — offscreen doc holds an `sw-keepalive` port with a heartbeat so the SW survives the 30s idle timer during active sessions. `extension/offscreen/offscreen.js`
- **Per-lifetime SW state stores** — settings/session/ui-ports/local-model/profile held behind tiny deps-injectable stores instead of module-level `let`s. `extension/background/settings-store.js`, `session-state.js`, `local-model-state.js`, `profile-state.js`, `ui-ports.js`
- **Auto-resume of SW-reclaimed turns** — `detectInterruptedTurn` + `RESUME_NUDGE` re-drive a turn the SW reclaimed mid-flight after termination. `extension/background/service-worker.js`
- **Idle auto-lock + provider/session deps** — vault idle auto-lock default-on (45min, settable) wired via idle interval; DK dies with the SW (clears session grants). `extension/background/service-worker.js`

### Affordances + confirmation

- **Toolbar icon + keyboard command open the side panel** — `action.onClicked` + `commands.onCommand` (Cmd/Alt+Shift+P) synchronously open the side panel, falling back to home. `extension/manifest.json`, `background/panel-affordance.js`
- **Pending-confirm action badge** — numeric amber toolbar badge while confirm prompts are pending so a waiting agent is visible with the panel hidden. `extension/background/service-worker.js`
- **Confirm coordinator round-trip (SW ↔ all surfaces)** — broadcasts `confirm/request` to every open UI port, auto-denies on no channel or 120s timeout, plus session-grant cache + web-write gate. `extension/background/service-worker.js`
- **Multi-surface UI-port registry + state broadcast** — `uiPorts` registry streams session state + `surfaces/changed` to side panel AND home equally (DESIGN-12), no favored singleton. `extension/background/ui-ports.js`
- **Side-panel close affordance** — `closePanel` works around Chrome's missing `sidePanel.close()` by toggling `setOptions` enabled false/true. `extension/background/service-worker.js`

### Side-panel chat UI

- **Side-panel Mithril chat UI** — full chat surface: long-lived SW port, router/mount, streaming-delta reducer, voice manager; pure projection of SW state. `extension/sidepanel/`
- **Shared pure chat reducer** — `reduceChat(state,msg)→state` folds SW pushes; reused verbatim by side panel + home, Bun-testable. `extension/sidepanel/chat-reducer.js`
- **Composer with slash-commands + @-refs** — input-bar textarea + command-palette popup autocompletes `/commands` and `@references`. `extension/sidepanel/components/input-bar.js`, `command-palette.js`
- **Plan/Act mode selector** — `ModeSelector` above the composer drives the persona gate (Plan refuses side-effecting tools). `extension/sidepanel/components/mode-badge.js`
- **Cost meter chip** — per-turn/per-session token + cost metering as a `CostChip`. `extension/sidepanel/components/cost-meter.js`
- **Vault gate (passkey-first unlock)** — first-run/locked gate: WebAuthn PRF default factor, optional recovery passphrase added later. `extension/sidepanel/components/vault-gate.js`
- **First-run onboarding** — shown once per profile after vault setup: name your AI peer before first chat. `extension/sidepanel/components/onboarding-view.js`
- **Sessions view (list/switch/archive)** — chat session list at `/chats`, new-chat, switch, archive via `session/*` routes. `extension/sidepanel/components/sessions-view.js`
- **Skills management view** — list/install/remove skills; remote sources gated behind `REMOTE_SKILL_INSTALL` (paste-only when off). `extension/sidepanel/components/skills-view.js`
- **Denylist editor view** — in-panel denylist add/remove with format helpers (user overlay over seed). `extension/sidepanel/components/denylist-view.js`
- **Hooks view** — in-panel surface for pre/post tool-use hooks state. `extension/sidepanel/components/hooks-view.js`
- **Ralph loop panel** — renders persistent fresh-context loop state pushed over `ralph/*` events; halt button. `extension/sidepanel/components/ralph-panel.js`
- **Async subagent status bar** — self-hiding bar pinning in-flight async `spawn_subagent` tasks (DESIGN-11). `extension/sidepanel/components/async-tasks-bar.js`
- **Injection-safe Markdown renderer** — hand-rolled MD→HTML (no third-party lib) for assistant replies, hardened against untrusted-web-content influence. `extension/shared/markdown.js`

### Full-page home SPA

- **Full-page home SPA (chat + sections)** — standalone tab SPA: left rail switches Chat (equal live view of the same SW session) / Library / Discover / Network / Contacts / Lab; pop-to-side. `extension/home/home.js`
- **Library section** — human front-door to persisted Apps: open/favorite/rename/export/delete over the IDB catalog + OPFS the agent's `app_*` tools share. `extension/home/library-section.js`
- **Network section (peer graph)** *(preview-only)* — live animated radial peer graph of the always-on base network + lobby/DHT facts. `extension/home/network-section.js`
- **Discover section (p2p app store)** *(preview-only)* — apps peers share over the mesh appear here; one-click fetch+verify+install into Library. `extension/home/discover-section.js`
- **Contacts section** *(preview-only)* — name/annotate known did:key peers with persisted names + shared-history summary. `extension/home/contacts-section.js`
- **Lab / eval section (A/B model bench)** — pit two main+runner model configs head-to-head on real web tasks through the actual agent loop; embeds the eval engine. `extension/home/eval-section.js`
- **Peer-notifications feed** *(preview-only)* — bounded dismissible feed from offscreen `dweb/notify` (new peer / new app), read by the home bell + in-chat banner; inert on store. `extension/shared/peer-notifications.js`

### Options + settings

- **Options full-tab settings page** — self-fetching snapshot page (not the live port), refetch on focus, sections for providers/vault/behavior/costs/voice/ocr/memory/activity/transfer/dweb/local-models/git-credentials. `extension/options/`
- **Export & import (cross-install migration)** — explicit migration between installs incl. store↔preview isolated storage via `transfer/export`, `inspectImport`, import routes. `extension/options/sections/transfer.js`
- **Git credentials vault store** — per-host bearer tokens for private git clone in the WebVM, stored in the same encrypted vault as API keys. `extension/options/sections/git-credentials.js`
- **Activity / audit viewer** — read-only human window onto the audit spine (severity/free-text filters) mirroring `inspect_audit_log`. `extension/options/sections/activity.js`

### Offscreen host

- **Offscreen document host** — long-lived doc hosting the keepalive port, DOM sanitizer, voice transcriber, WebVM/runtime hosting; lazily created with justification. `extension/offscreen/offscreen.js`
- **Headless JS job runner (`js_run`)** — runs the agent's quick-compute in the SAME sealed worker as the Notebook but offscreen with no tab, ephemeral OPFS, egress relayed through audited SW routes. `extension/offscreen/job-runner.js`
- **Offscreen PDF text extraction** — `read_pdf` via pdf.js text layer offscreen, auto-escalating to Tesseract OCR when the opt-in engine is installed; fail-closed; bytes untrusted. `extension/offscreen/pdf-extract.js`
- **Offscreen dweb base-network host** *(preview-only)* — always-on lobby (mesh/gossip/DHT/presence) hosted offscreen so the network outlives any tab; reaches the module only via the `loadDweb` stub; inert on store. `extension/offscreen/dweb-base.js`

### Engine tab pages

- **WebVM tab (CheerpX Linux)** — a discrete WebVM per tab: CheerpX+bash+xterm in-page, agent commands via marker protocol, HTTP marker calls back to SW egress/audit. `extension/vm-tab/vm-tab.js`
- **Notebook tab (sealed JS worker IDE)** — per-Notebook host: CodeMirror+file-tree+OPFS editor, fresh-run sealed worker per eval with realm seal + `peerd.*` surface, rich output render, `peerd:std` imports. `extension/notebook-tab/`
- **App tab (opaque-origin iframe runner)** — trusted parent shell composes OPFS files into a sandboxed `runner.html` iframe (render) or overlays the shared editor (edit); hash-passed launch params for dweb deep-links. `extension/app-tab/`
- **Tab trackers + RPC clients per engine kind** — background trackers/clients map VM/Notebook/App tabs to registry instances and proxy agent tool calls into the right tab page. `extension/background/vm-tab-tracker.js`, `notebook-tab-tracker.js`, `app-tab-tracker.js`
- **Pull-in-peerd affordance on engine tabs** — floating button on VM/Notebook/App pages opens the window-global side panel so the chat follows you onto an agent-spawned tab. `extension/shared/pull-in-peerd.js`

### Permissions, eval, shared, vendor

- **Mic-permission grant page** — dedicated classic-script tab page that calls `getUserMedia` on a click so the mic prompt surfaces reliably; grant inherited by panel/offscreen. `extension/permissions/mic.js`
- **CDP debugger pool** — `chrome.debugger` connection pool for the advanced automation path; channel-gated required permission (preview/dev, stripped from store). `extension/background/debugger-pool.js`
- **Live eval harness (engine + standalone runner)** — drives the REAL agent stack against a task suite over the sidepanel port, captures end-state, scores; shared by Lab + standalone runner page. `extension/eval/`
- **Dweb interface stub + channel-gated loader** — core programs against `shared/dweb-interface` types + stub; `dweb-loader` is the SOLE file naming the module path (dynamic import gated on `DWEB_ENABLED`), store-swapped for a stub. `extension/shared/dweb-interface.js`, `dweb-loader.js`
- **Generated channel-config (store/preview split)** — `CHANNEL`/`DWEB_ENABLED`/`CHANNEL_DEFAULTS` frozen constants generated by `gen:dev`; the single switch core reads for dweb gating + default settings. `extension/shared/channel-config.js`
- **Shared chassis helpers** — open-home (focus-or-create), open-options, source-level flags, messaging dispatcher, util/bytes, errors, tool-types, settings-patch. `extension/shared/`
- **Shared bundle codec (content-addressing)** — bundle/canonical/chunk/manifest/bytes helpers for signed content-addressed transfer (the one `/shared/bundle` path used absolutely, incl. by the site). `extension/shared/bundle/`
- **Vendored third-party runtime** — no-build vendored deps with `SOURCE.txt` provenance: mithril, codemirror, xterm, cheerpx, pdfjs, tesseract, transformers, onnxruntime-web, moonshine-js, vad-web, argon2, simple-icons, browser-polyfill. `extension/vendor/`

**Not yet**

- **On-device WebGPU local model host** — Gemma-4-E2B via Transformers.js + ORT-Web on WebGPU offscreen; vendored runtime, weights stream from HF + Cache-API cached; driven by the SW local-webgpu adapter. Owner load-test pending (cannot run in CI). `extension/offscreen/local-model.js` **(partial)**

---

## Tool inventory source of truth

Do not pin registered-tool or exposed-tool counts in prose. They change as
tool definitions, channel flags, and exposure rules evolve.

The current inventory is assembled from `peerd-runtime/tools/defs/index.js`,
`tools/web/index.js`, `clock/tools.js`, and the service-worker wiring that
adds `load_skill`. Main-agent exposure is decided by `tools/exposure.js` and
the active channel config. The invariant to preserve is qualitative: low-level
DOM/page tools stay runner-only, the main agent reaches pages through
`do`/`get`/`check`, and dweb tools are invisible where `DWEB_ENABLED` is false.
