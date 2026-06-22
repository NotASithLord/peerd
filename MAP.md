# MAP — peerd at a glance

> The one-screen orientation map. **What** each part is, **where** it
> lives, and **when** it acts on its own. For the *why* and the deep
> contracts, read `CLAUDE.md` → `ARCHITECTURE.md` → `DESIGN.md` (in that
> order). This file is the index, not the manual; if it disagrees with
> `ARCHITECTURE.md` on structure, that doc wins.

The wordmark **is** the architecture: five colored letters, five modules,
one dependency direction (higher depends on lower).

```
p  cyan     peerd-provider/      model adapters (the LLM connection)
e  red      peerd-egress/        security (vault · allowlist · denylist · audit)
e  amber    peerd-engine/        execution sandboxes (WebVM · Notebook · App · headless)
r  green    peerd-runtime/       the orchestrator (agent loop · tools · sessions · …)
d  magenta  peerd-distributed/   the dweb (P2P mesh · DHT · dwapps) — preview channel only
                                   └ nothing outside this dir imports it (store prunes it)
```

---

## The tree, annotated

```
extension/
├── background/          chassis: service worker — message routing + DI + lifecycle wiring
│                          (thin per-route handlers; logic lives in modules)
├── offscreen/           chassis: long-lived work with no tab (voice, headless js_run, dweb mesh)
├── sidepanel/           chassis: the chat UI (Mithril) — the user's surface
├── home/ · options/     chassis: new-tab / settings surfaces
├── vm-tab/ ·            chassis: one tab page per visible execution kind
│   notebook-tab/ ·        (WebVM · Notebook · App) — the host, not the isolate
│   app-tab/
├── permissions/         chassis: user-gesture grant pages (e.g. mic permission)
├── eval/                live end-to-end eval harness — "does it work?" as a number
│                          + baseline diff (regression detection; no backend)
├── shared/              cross-cutting glue: dweb interface/stub, channel-config (generated)
├── vendor/              third-party code (SOURCE.txt each; no npm runtime)
├── tests/               in-browser tests (DOM, chrome.*, IDB) — runner.html, headless via CDP
│
├── peerd-provider/      [p] model adapters
│   ├── adapters/          Anthropic · OpenRouter · Ollama (OpenAI later)
│   └── format/           schema conversions, streaming
│
├── peerd-egress/        [e] security — everything depends on this; built first
│   ├── vault/            passphrase + WebAuthn-PRF unlock; idle auto-lock
│   ├── fetch/            safeFetch — the egress chokepoint (provider allowlist + SSRF guard)
│   ├── denylist/         origin denylist (seed + user overlay)
│   ├── confirm/          async, policy-driven confirmation
│   ├── audit/            append-only audit log (capped 20k, pruned oldest-first)
│   └── storage/          IDB / chrome.storage wrappers
│
├── peerd-engine/        [e] execution sandboxes — registries (the isolate; a tab hosts it)
│                          vm-registry · notebook-registry · app-registry · module-resolver · opfs
│
├── peerd-runtime/       [r] the orchestrator — most of the agent lives here
│   ├── loop/            the agent loop (turns, streaming, tool dispatch)
│   ├── tools/           tool inventory + the six-gate dispatcher
│   │     defs/            ~52 BUILTIN_TOOLS, one file each
│   │     dispatcher.js    persona → exposure → origin → confirmation → egress → audit
│   │     exposure.js      registration vs exposure split (runner-only vs main-agent)
│   │     manifests.js     per-session tool manifests (capability presets as data)
│   │     hooks/           pre/post tool-use (fail-closed; egress rides the pre-hook)
│   │     web/             web tool policy (web_search, read_article, call_api, …)
│   ├── runner/ + dom/   do/get/check — the main agent's ONLY browser surface;
│   │                      low-level DOM tools are runner-only (disposable browser-runner)
│   ├── sessions/        sessions as the primary primitive
│   ├── subagent/        depth-bounded recursion, tool narrowing, output cap
│   ├── permissions/     Plan/Act (decideAction — Plan refuses side-effecting tools)
│   ├── memory/          file-based AGENTS.md memory; /init scanner; confirm-gated remember
│   ├── edit/            edit_file SEARCH/REPLACE + checkpoints (diffSince)
│   ├── skills/          progressive disclosure via load_skill
│   ├── review/          request_review — clean-context read-only reviewer
│   ├── composer/        slash commands + @-refs
│   ├── cost/            per-turn/session token + USD metering; hard spend limit
│   ├── clock/           temporal grounding (now, wait_until)
│   ├── voice/           local transcription (Moonshine WASM + Web Speech fallback)
│   ├── transfer/        session export/import (.peerd)
│   ├── ralph/           /loop — SW-restart-resumable goal loop (acts on its own ⟵)
│   └── profiles/        per-profile namespacing (partly backlog)
│
└── peerd-distributed/   [d] the dweb (preview channel only)
    ├── identity/        Ed25519 did:key
    ├── codec/ content/  signed content addressing + chunked bundle transfer
    ├── transport/       WebRTC mesh
    ├── dht/ gossip/     Kademlia content directory + presence/gossip
    ├── messaging/       signed direct channels
    └── apps/            dwapps (namespaced sub-protocols) + the p2p app store
```

Outside `extension/`: `signaling-node/` (dweb
rendezvous), `manifests/` + `packaging/` (the dual-distribution build —
store vs preview; `bun run gen:dev` generates `manifest.json` +
`channel-config.js`), `tests/` (Bun, pure logic), `scripts/`, and the
design-record docs (`DESIGN-*.md`, `docs/`, `specs/`).

---

## When does it act on its own?

Almost everything in peerd is **synchronous with an attended browser** — a
turn runs because the user sent a message. The exceptions, today and
soon, are worth knowing because they carry the most safety design:

| Surface | Trigger | Attended? | Where |
|---|---|---|---|
| A turn | user sends a message | yes | `peerd-runtime/loop/` |
| **Ralph `/loop`** | a persistent goal, re-entered each SW cold start | runs unattended, but **started** attended; commits via gates | `peerd-runtime/ralph/` |
| **Scheduled tasks** | a `chrome.alarms` wake at/after time T | **fully unattended** — `ctx.unattended` fail-closed; preview/read-only by default | `peerd-runtime/schedule/` *(spec'd, see `specs/FEATURE-SCHEDULED-TASKS.md`)* |

The rule for anything that acts unattended: it can never widen its own
permissions, every byte it reads from the web is `wrapUntrusted`-fenced,
and it routes through the same egress chokepoint (`safeFetch`) as an
attended turn. No backend, no new egress path — that's what makes the
chokepoint a real boundary.

---

## The non-negotiables (one line each — full list in `CLAUDE.md`)

- **Vanilla JS, ES modules, no build step.** Load unpacked → refresh.
- **`index.js` is each module's public API.** Deep imports from outside are lint-forbidden.
- **The dweb boundary.** Nothing outside `peerd-distributed/` imports it; core uses the stub in `shared/`.
- **Functional core, imperative shell.** Reducers/policy are pure; IO is injected.
- **Generated files aren't hand-edited.** `manifest.json`, `shared/channel-config.js` come from `bun run gen:dev`.
- **The brand is the architecture.** A sixth top-level `peerd-*` directory is a smell — reconsider instead.
