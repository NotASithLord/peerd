# Peerd — Module Architecture

> **HISTORICAL — predates several changes (banner added 2026-06-21).** The
> module shape (five peerd-* modules) still holds, but treat specifics here
> as historical and defer to `CLAUDE.md` for current orientation. In
> particular: there is no `content/` directory — DOM work happens via
> injected functions, not a persistent content script; the permissions
> module is `peerd-runtime/permissions/`, not `personas/` or
> `peerd-egress/trust/`; the trust-mode axis (Open/Scoped/Paranoid) was
> REMOVED (safety is Plan/Act + `confirmActions` + the denylist); peerd is
> 0.x with no "V1"/"V2" commitment; and `peerd-distributed` is now a live
> offscreen mesh + DHT + p2p app store, not "mostly empty".
>
> **Companion to:** `DESIGN.md` (V1 architecture).
> **Audience:** Claude Code. This doc supersedes the file-layout sections of
> the V1 design doc — wherever this and the V1 doc disagree on directory
> structure or module organization, this doc wins. Behavioral and security
> requirements in the V1 doc still apply unchanged.
> **Goal:** reorganize the extension codebase around five top-level modules
> that mirror the five-letter wordmark. The brand is the architecture.

---

## Philosophy: borrow what's useful, discard what's not

Peerd is not "OpenCode in a browser" or "Hermes for browsers." It's its own
thing — a complete agent harness designed *for* the browser context, not
ported into it. This document and the codebase organization reflect that.

The pattern is to borrow what's been proven useful by mature terminal
harnesses, and to discard what doesn't make sense in browser context.

**Borrowed:** sessions as primary primitive, trust modes, Read/Act personas,
tool registration vs exposure, skills as markdown files, scoped memory,
/undo+/redo, decentralized web (dweb) patterns, AGENTS.md-style project
context, session sharing via link, trajectory export. These transfer
cleanly because they operate on the agent loop and on the user's mental
model, both of which exist regardless of platform.

**Discarded:**

- **MCP servers for web access.** OpenCode and Hermes use MCP because they
  can't talk to the DOM. Peerd is in the browser. The agent already has the
  user's session state, login, search history, and personalization. Opening
  a tab to google.com and reading targeted DOM nodes is the better tool
  than calling out to an MCP web-search server — same structured-result
  benefit, no protocol overhead, no context tax from verbose tool
  definitions, and the result is shaped by the user's actual web identity.
  Peerd implements its own structured DOM extraction tools (`web_search`,
  `read_page`, `query_selector`) using the accessibility tree and selector
  queries. MCP remains available as a V2+ optional plugin type for
  *non-web* services that genuinely have no browser-reachable surface.

- **External execution backends (SSH, Docker, Singularity, Modal).** WebVM
  is enough. Adding remote-execution targets violates the "client-side
  everything" promise and creates security surface peerd otherwise avoids.

- **Multi-platform render targets (TUI, native desktop, IDE).** Peerd is
  browser-only by design. The browser IS the runtime; rendering elsewhere
  defeats the entire thesis.

- **Centralized credential gateways.** Hermes has `hermes portal info` for
  managed multi-provider credentials. Peerd's vault is local-only and
  WebAuthn-secured. Adding a managed-credential layer reintroduces the
  middleware peerd exists to eliminate.

**The test for any borrowed pattern.** Does the browser context make this
a *better* tool, *worse* tool, or *equivalent* tool? If better or equivalent
with less complexity, peerd does it natively. If worse, peerd skips it or
ports a deliberately scoped version. The default is to skip — every borrowed
pattern carries maintenance and conceptual debt, and peerd's wedge is
specifically the things terminal harnesses cannot do.

---

## 0. The bet

The wordmark has five colored letters: **p e e r d**. Each letter maps to a
real subsystem in the codebase. The wordmark *is* the architecture diagram.
Anyone reading the brand sees the system; anyone reading the system
navigates by the brand.

| Letter | Color | Module | Role |
|--------|-------|--------|------|
| **p** | cyan `#00B7EB` | **peerd-provider** | Model adapters. The connection to whichever LLM the user picked. |
| **e** | red `#EF4444` | **peerd-egress** | The security layer. Vault, allowlist, denylist, audit. (Trust modes removed 2026-06-12 — Plan/Act carries that axis.) |
| **e** | amber `#F59E0B` | **peerd-engine** | Execution instances. Sandboxes: four kinds (DESIGN.md §8.5). Three are hosted in a visible tab — WebVMs (sandboxed Linux), Notebooks (sealed JS worker + OPFS), Apps (opaque-origin iframe). The fourth, the headless worker (`js_run`), runs the Notebook's sealed worker offscreen with no tab. The sandbox is the isolate; a tab is one way to host it (DECISIONS #25). |
| **r** | green `#22C55E` | **peerd-runtime** | The orchestrator. Agent loop, tools, skills, memory, sessions, profiles. |
| **d** | magenta `#D946EF` | **peerd-distributed** | The dweb. P2P, swarms, DHT discovery, dwapps. The forward-looking surface. Mostly empty in V1; the namespace reserved for V2+. |

This mapping is **locked**. The semantic meaning of each color is fixed in
the homepage's design system (see `index.html` palette section), and any
future module reorganization must preserve it. If a new feature doesn't
fit any of the five, the discussion is whether the feature belongs at all
— not whether the five should grow to six.

---

## 1. Module composition

Modules form a layered dependency graph. Higher layers depend on lower
ones; never the reverse.

```
                  ┌───────────────────────────────────┐
   Layer 3        │       peerd-distributed          │   d  (magenta)
   dweb           │  (P2P, swarms, DHT, dwapps — V2+) │
                  └───────────────────────────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────────┐
   Layer 2        │         peerd-runtime             │   r  (green)
   orchestration  │  (loop, tools, sessions, ...)     │
                  └───────────────────────────────────┘
                       │            │            │
              ┌────────┘            │            └────────┐
              ▼                     ▼                     ▼
   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
   │  peerd-provider  │  │   peerd-egress   │  │   peerd-engine   │
   │   (model API)    │  │   (security)     │  │     (WebVM)      │
   └──────────────────┘  └──────────────────┘  └──────────────────┘
        p (cyan)              e (red)                e (amber)

   Layer 1 — capabilities (no cross-deps between these three)
   Layer 2 — orchestration (composes Layer 1 to drive a session)
   Layer 3 — dweb (composes Layer 2 across browsers, peers, swarms)
```

### Rules

- **Layer 1 modules (`peerd-provider`, `peerd-egress`, `peerd-engine`)
  do not depend on each other.** They are independent capabilities.
- **Layer 2 (`peerd-runtime`) depends on all three Layer 1 modules** and
  composes them into the agent loop, tool execution, sessions, skills,
  and memory.
- **Layer 3 (`peerd-distributed`) composes Layer 2 across instances.**
  It operates *between* peerds (different browsers, different machines,
  different users) — not inside any single one. Phase 0 (identity,
  codec, content addressing, signed bundle transfer scaffolding) ships
  in the preview channel; the store package prunes the module entirely;
  by V2.3 it owns peer transport, by V3 it owns the dwapp runtime.
- **Cross-layer imports are explicit and unidirectional.** A Layer 1
  module never imports from Layer 2 or 3. Enforced by ESLint
  `no-restricted-imports`.
- **Shared utility code** (typed messaging, error classes, deep-equality,
  UUIDs, base64 helpers) lives in `/shared/`. Importable by any module.
  Cannot import from any `peerd-*` module — it's lower than Layer 1.

### Why this shape

- `peerd-runtime` is the orchestrator. The agent loop is where everything
  meets. Tools dispatch through here. Skills load through here. Sessions
  and profiles live here because they're orchestration containers — a
  session contains a running agent, a profile contains a set of
  sessions. Anything the model can *do*, and any context the model
  operates *in*, passes through this module.
- `peerd-egress` is the security boundary. Every outbound network call,
  every secret read, every tool that touches sensitive state passes
  through it. Putting it at Layer 1 means it's never bypassed by another
  Layer 1 module accidentally.
- `peerd-provider` and `peerd-engine` are intentionally peers (Layer 1)
  because they're both *capability providers* the runtime composes —
  neither outranks the other.
- `peerd-distributed` is its own layer because it operates on something
  qualitatively different: not a single session, not a single profile,
  but the *boundary between independent peerd instances*. It's the
  forward-looking surface — empty today, the canvas for V2's peer
  transport, V2.5's DHT discovery, V3's decentralized agent apps.

---

## 2. Per-module breakdown

> **File trees below are illustrative, not exhaustive.** They date from
> the V1 design and lag the directories (the V1-buildout subsystems —
> permissions/, edit/, cost/, composer/, ralph/, review/, runner/,
> clock/, tools/hooks/ and friends — live under `peerd-runtime/` today).
> Treat each module's PROSE as the contract and the directory itself as
> the truth; `CLAUDE.md` carries the current per-module one-liners.

Each subsection follows the same shape: purpose, contents, public API,
dependencies, V1.x roadmap fit, tests.

### 2.1 peerd-provider (p / cyan)

**Purpose.** Talk to model APIs. Translate between the internal
conversation/tool format and each provider's wire format. Stream responses
when supported. Manage the list of available providers and the user's
current selection.

**Contents.**

```
peerd-provider/
├── index.js                 # public API: callModel, listProviders, etc.
├── registry.js              # in-memory registry of provider adapters
├── system-prompt.txt        # the agent system prompt (provider-agnostic shape)
├── adapters/
│   ├── anthropic.js         # streaming tool_use, caching, retry
│   ├── openrouter.js        # OpenAI-compatible gateway
│   └── ollama.js            # keyless local inference (OpenAI format layer)
│                            # (openai.js: future; local-webgpu: DEFERRED —
│                            #  docs/LOCAL-INFERENCE.md; ollama-recommend.js
│                            #  at module root does the GPU-fit probe)
├── format/
│   ├── to-anthropic.js      # internal messages → Anthropic shape
│   ├── from-anthropic.js    # Anthropic response → internal shape
│   └── ...                  # per-provider format helpers
└── errors.js                # ProviderError, ProviderKeyMissingError, etc.
```

**Public API (importable from peerd-runtime):**

```js
import { callModel, listProviders, getCurrentProvider } from 'peerd-provider';

// Provider config is data; adapters expose a uniform call shape.
const response = await callModel({
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  messages: [...],
  tools: [...],
  getSecret: vault.getSecret,   // injected from peerd-egress
  fetch: safeFetch,             // injected from peerd-egress
});
```

**Dependencies.**

- `shared/` for messaging types, error classes.
- **None** of the other `peerd-*` modules. Provider takes its `fetch` and
  `getSecret` as injected functions; it doesn't import egress directly.
  This makes the module independently testable (pass mock fetch and mock
  getSecret in tests).

**Roadmap fit.**

- V1.1: OpenAI and Ollama adapters land here.
- V2.4: `local-webgpu.js` adapter for in-browser inference via
  Transformers.js. Same `callModel` interface, different implementation.
- V3.0: User-fine-tuned LoRA loaded via the local-webgpu adapter.

**Tests.** `tests/unit/peerd-provider/` — adapter format round-trips (a
canned internal message → adapter format → back, equality check), error
handling, fake-fetch integration tests.

---

### 2.2 peerd-egress (e / red)

**Purpose.** The security layer. Every defense and storage primitive the
extension relies on lives here: the vault (encrypted secrets), the
egress allowlist (`safeFetch`), the denylist matcher, the trust-mode
policy, the confirmation gate protocol, and the audit log.

Named "egress" because the load-bearing security primitive is the egress
allowlist (`safeFetch`) — for the **credentialed provider path**, that's
the boundary nothing crosses, even if everything else fails. Scope it
honestly: the open-web tools (`read_api`/`read_article`/`web_search`/
`vm_import`) use the allowlist-FREE `webFetch` path (SSRF block + denylist
+ audit, but no per-host allowlist), so this is not a complete seal against
exfil to arbitrary public hosts — see `peerd-egress/fetch/safe-fetch.js`.
The other primitives compose around it.

**Contents.**

```
peerd-egress/
├── index.js                 # public API surface
├── vault/
│   ├── vault.js             # createVault factory, lock/unlock state machine
│   ├── blob-migration.js    # pure chrome.storage.local→IDB migration table
│   ├── keys.js              # WebCrypto helpers — deriveKEK, generateDK, etc.
│   └── errors.js            # VaultLockedError, WrongPassphraseError, etc.
├── fetch/
│   ├── safe-fetch.js        # the egress-allowlisted fetch wrapper
│   ├── allowlist.js         # the hardcoded provider endpoint list
│   └── errors.js            # EgressDeniedError
├── denylist/
│   ├── denylist.js          # matchesDenylist, addEntry, removeEntry
│   └── default.json         # the seeded default denylist (banks, etc.)
├── confirm/
│   └── protocol.js          # confirmation prompt request/response shape
├── audit/
│   ├── log.js               # append-only audit log over IndexedDB
│   ├── retention.js         # pure capped-retention policy (20k default)
│   └── types.js             # AuditEntry shape, event type union
└── storage/
    ├── kv.js                # chrome.storage.local wrapper (THE only place)
    └── idb.js               # IndexedDB wrapper (THE only place)
```

**Public API:**

```js
import {
  // vault
  createVault,
  // fetch
  safeFetch,
  // denylist
  matchesDenylist, loadDenylist,
  // confirm
  requestConfirmation,
  // audit
  appendAudit,
  // storage primitives (importable but discouraged outside egress —
  // feature code should go through one of the above instead)
  kv, idb,
} from 'peerd-egress';
```

**Dependencies.**

- `shared/` only.
- **No** dependency on `peerd-provider`, `peerd-engine`, or anything in
  Layer 2/3. Egress is the security foundation; it can't depend on
  anything above it.

**Roadmap fit.**

- V1.1: WebAuthn unlock as an additional vault factor.
- V1.2: Per-profile vault keying (profiles → separate vault namespaces).
- V1.3: Per-skill egress allowlist extensions (when skills load, they can
  declare additional allowed origins that get admitted to the allowlist
  for the skill's session scope).

**Tests.** `tests/unit/peerd-egress/` — denylist matcher edge cases
(`protonmail.com` must NOT match `*.proton.me`), vault round-trips,
safeFetch allowlist enforcement, plaintext-secret-doesn't-land-in-storage
defense-in-depth checks.

---

### 2.3 peerd-engine (e / amber)

**Purpose.** Where the agent's code actually runs. Sandboxes: four
execution kinds (full taxonomy in DESIGN.md §8.5). Three are discrete,
persistent browser tabs the user can see, focus, and close; the fourth,
the headless worker, runs offscreen with no tab:

| Kind | Substrate / host | Disk | When to reach for it |
|------|------------------|------|----------------------|
| **WebVM** (`vm_*`) | CheerpX WASM Linux, visible tab | IDB block-device overlay | POSIX, binaries, multi-language stacks. The heavy hitter. |
| **Notebook** (`js_notebook`) | sealed JS worker, visible tab | OPFS file tree | Vanilla JS the agent owns — parsing, transforms, numerical work. ~hundreds of ms boot. |
| **Headless worker** (`js_run`) | the **same** sealed JS worker, offscreen, **no tab** | ephemeral scratch | The agent's own quick compute / code mode (one script vs many tool calls), when there's nothing to watch. A distinct kind, not a Notebook variant. |
| **App** (`app_*`) | opaque-origin iframe, visible tab | none (state in the body) | User-facing artifacts built FOR the user (calculators, charts, tools); the dweb-shareable artifact (a dwapp). |

Named "engine" both for the obvious mechanical/compute meaning and as a
nod to "x86 virtualization engine" — the thing CheerpX calls itself.
The name still fits now that the module hosts several runtimes instead of
one: engine is the *substrate* where execution kinds live.

**Contents.**

```
peerd-engine/
├── index.js                 # public surface — exports per kind
├── errors.js                # VMNotReadyError, VMBootFailedError, etc.
│
├── vm-registry.js           # WebVM catalog + per-session current pointer
├── host.js                  # WebVM run/marker/timeout logic (test scaffolding)
├── overlay.js               # WebVM IDB block-device overlay (test scaffolding)
│
├── notebook-registry.js     # Notebook catalog
│
├── app-registry.js          # App metadata catalog (chrome.storage.local)
└── app-store.js             # App body store (IndexedDB) + substring search
```

The pattern is the same for every kind: a **registry** in `peerd-engine`
owns persistent metadata + a per-session "current" pointer. The actual
**runtime** lives in a tab page under `extension/<kind>-tab/` (see §3),
because each runtime needs a real DOM / worker / iframe context that
the SW can't provide. SW-side **tab tracking** + **RPC** for each kind
live in `extension/background/<kind>-tab-tracker.js` and
`extension/background/<kind>-client.js`.

Apps' bodies are large enough (typically tens to hundreds of KB of
generated HTML) that they don't belong in `chrome.storage.local`'s 10MB
shared cap, so `app-store.js` owns a small IDB layer (`peerd-app-bodies`
DB) just for those.

**Public API (per kind):**

```js
import {
  createVmRegistry,        VM_TAB_PATH,
  createNotebookRegistry,  NOTEBOOK_TAB_PATH,
  createAppRegistry,       APP_TAB_PATH,
  getAppBody, putAppBody, deleteAppBody, searchBodies,
} from 'peerd-engine';

// Each registry: load() list() get() create() update() delete()
//                getDefaultForSession() setDefaultForSession() snapshot()
const vmRegistry = createVmRegistry({ storage });
```

The SW-side clients (`background/<kind>-client.js`) wrap each registry
with a `resolveId({sessionId, id?})` shortcut + RPC to the tab — that's
what the agent tools dispatch through.

**Dependencies.**

- `shared/` only.
- **No** dependency on other `peerd-*` modules at Layer 1.
- VM/Notebook/App network egress flows BACK through `peerd-egress`'s
  `webFetch` via the SW's `sw/web-fetch` route. That wiring lives at
  the chassis layer (the SW is in `background/`), not inside engine.

**Roadmap fit.**

- V1.1: pre-baked VM image with common deps (python, pandas, git, jq);
  npm-style `import()` shim for Notebooks; export/import of Apps.
- V1.4: Skills can declare VM setup commands or pre-seed a Notebook/App.
- V2.0: long-running instances across browser restarts; instance
  templates (peerd-distributed).
- V2.5: hardware passthrough — WebUSB/WebSerial proxied into VM
  processes (speculative).

**Tests.** `tests/integration/peerd-engine/` — each runtime needs a
real browser context (CheerpX is WASM-heavy; Notebook needs Worker;
App needs an iframe with srcdoc), so its tests run as integration tests
in the extension's test page, not as unit tests.
Round-trip `run('echo hello')` and assert stdout.

---

### 2.4 peerd-runtime (r / green)

**Purpose.** The orchestrator. Where everything meets. The agent loop,
the tool registry, the tool dispatcher, the skill system, the memory
system. The thing the side panel UI is a view over.

This is the largest module by code volume. It's where features land
when they're not specifically about *talking to a model*, *defending
state*, or *running code* — i.e., when they're about *making the agent
go*.

**Contents.**

```
peerd-runtime/
├── index.js                 # public API: startAgent, sendMessage, getState
├── loop/
│   ├── agent-loop.js        # the async generator that drives turns
│   ├── reducer.js           # pure session-state reducer
│   ├── system-prompt.js     # prompt assembly (incorporates memory, skill ctx, temporal block)
│   └── undo.js              # V1.1 — turn-level rollback (/undo, /redo)
├── clock/                   # V1 — temporal grounding (see DESIGN.md §10.5)
│   ├── now.js               # primitives: now, since, formatDelta
│   ├── events.js            # background event recorder + classification
│   ├── context.js           # temporal block formatter (~15-token default)
│   └── tools.js             # now(), time_since(), wait_until() tool defs
├── personas/                # V1.1 — Read vs Act, orthogonal to trust modes
│   ├── modes.js             # Read | Act definitions and policies
│   └── policy.js            # decideAction — pure function: persona + tool → allow|deny
├── tools/
│   ├── registry.js          # tool registration (Layer 1 of §2.3)
│   ├── exposure.js          # tool exposure manifest per session (V1.3)
│   ├── dispatcher.js        # the security middleware composition
│   ├── prompt-wrap.js       # <untrusted_web_content> wrapping for web tools
│   ├── web/                 # V1 — web tool policy (see DESIGN.md §9.5)
│   │   ├── POLICY.md        # in-tree policy doc for tool authors
│   │   ├── primitives.js    # safeFetch, open_tab, offscreen_render
│   │   ├── search.js        # web_search → always tab
│   │   ├── read.js          # read_article → safeFetch with tab fallback
│   │   ├── api.js           # read_api → always safeFetch
│   │   ├── form.js          # submit_form → always tab
│   │   └── screenshot.js    # capture → always tab
│   └── defs/
│       ├── read-page.js
│       ├── click.js
│       ├── type.js
│       ├── navigate.js
│       ├── screenshot.js
│       ├── open-tab.js
│       ├── list-tabs.js
│       └── vm-run.js        # the tool wrapper around peerd-engine's run()
├── sessions/
│   ├── store.js             # session lifecycle: create, suspend, resume, archive
│   ├── reducer.js           # session-level state reducer (separate from agent-loop's)
│   └── types.js             # Session, SessionId, ...
├── profiles/                # V1.2 — isolated agent roots
│   ├── manager.js           # profile creation, switching, isolation
│   ├── migration.js         # V1.1 → V1.2 default-profile migration
│   └── export.js            # encrypted profile import/export
├── skills/                  # V1.4 — markdown skill files (AGENTS.md-equivalent + Hermes-style)
│   ├── loader.js
│   ├── parser.js            # markdown + front-matter parsing
│   └── activator.js
├── memory/                  # V1.5
│   ├── store.js
│   └── extractor.js         # V2.0 — auto-extraction at session end
└── errors.js                # ToolBlockedError, ToolNotFoundError, ...
```

Sessions and profiles live here, not in distributed. Reason: both are
*containers for orchestration state*. A session contains a running
agent's conversation, tool grants, audit slice, trust mode, and persona.
A profile contains sessions, vault namespace, denylist, skills, and
memory. Both are higher-order orchestration concerns — distributed
operates a layer above, on the boundary *between* peerd instances, not
inside one.

Personas (`personas/`) are a second security axis alongside trust modes.
Trust mode controls *how much confirmation* a tool requires; persona
controls *whether the agent can act at all*. Read persona means the
agent can observe (read pages, take screenshots, query the DOM) but
cannot click, type, submit, navigate, download, or run VM commands that
modify state. Act persona means the agent can do those things, subject
to trust-mode confirmation. The two axes compose: Read+Paranoid is "look
around, ask before anything" (effectively meaningless since Read denies
state changes anyway); Act+Open is "do whatever, minimal asks". This is
the OpenCode build/plan pattern adapted for the browser.

`undo.js` lives in `loop/` because rollback is a turn-level concern.
Each turn produces a journal of effects (DOM mutations attributable to
the agent, tab state changes, form fills); `/undo` walks the journal in
reverse to restore prior state. Out of scope: external state changes
(network requests sent, files downloaded) — those are confirmation-gated
and can't be undone after the fact.

`clock/` is the temporal-grounding submodule. The agent loop calls into
it on every turn to assemble a ~15-token temporal context block injected
into the prompt (spartan by default; expands conditionally for notable
events). `events.js` runs in the service worker and maintains a rolling
buffer of browser events (tab focus, idle state, system sleep, network
state) which `context.js` classifies and summarizes. The full design is
in DESIGN.md §10.5. This is a peerd-specific differentiator: terminal
harnesses can only fake this by injecting a static timestamp, because
they don't observe a running browser. Peerd does.

`tools/web/` holds the explicit policy for choosing between `safeFetch`
and a tab when reaching a web resource. The default is wrapper tools
(`web_search`, `read_article`, `read_api`, `submit_form`, `screenshot`)
that encode the right choice per use case. Primitives (`safeFetch`,
`open_tab`, `offscreen_render`) are exposed underneath for cases the
wrappers don't cover. The escalation default is "safeFetch first, tab
fallback when the response looks like an SPA shell or returns a
challenge." The full policy lives at `POLICY.md` in this directory
(in-tree so plugin authors writing their own web tools find it) and
is documented in DESIGN.md §9.5.

**Public API:**

```js
import { runAgent, dispatchToolCall, registerTool } from 'peerd-runtime';

const events = runAgent({
  provider: providerConfig,
  session: { mode: 'open', profileId: 'work', ... },
  // dependencies injected:
  callModel: providerModule.callModel,
  vault: egressModule.vault,
  safeFetch: egressModule.safeFetch,
  vmRun: engineModule.run,
  appendAudit: egressModule.appendAudit,
  requestConfirmation: egressModule.requestConfirmation,
});
for await (const ev of events) {
  // yield to UI: state updates, tool requests, confirmations
}
```

**Dependencies.**

- All three Layer 1 modules (`peerd-provider`, `peerd-egress`,
  `peerd-engine`) — but only via dependency injection at startup.
  Runtime never *imports* concrete adapter functions from Layer 1; it
  imports types/schemas and accepts the implementations as parameters.
  This makes runtime independently testable with mocks for all three.
- `shared/`.

**Roadmap fit.**

- V1: Sessions ship as part of the initial runtime. The agent loop runs
  inside a session; the session store tracks lifecycle (create, suspend,
  resume, archive).
- V1.2: Profiles. The `profiles/` directory becomes real; vault keying,
  denylist, skills, and memory all become per-profile. Sessions become
  profile-scoped.
- V1.3: Tool registration vs. exposure split lands here. `tools/exposure.js`
  is new; `tools/registry.js` becomes pure registration.
- V1.4: Skills system lands here. The `skills/` directory is the home
  for skill loading, parsing, activation, and the per-skill tool-exposure
  declarations.
- V1.5: Memory lands here. `memory/store.js` is the persistent distilled
  state. The system prompt assembly in `loop/system-prompt.js` reads
  from memory to surface relevant entries.
- V2.0: Long-running sessions, lineage compression, subagents — all in
  `loop/`. The reducer grows; the agent-loop generator gets context-window
  management.

**Tests.** `tests/unit/peerd-runtime/` — the reducer is pure and is
heavily unit-tested. Tool dispatcher policy steps are pure functions and
get a test apiece. The agent loop's async generator gets integration
tests with mock provider/egress/engine.

---

### 2.5 peerd-distributed (d / magenta)

**Purpose.** The dweb. Everything that lets a peerd talk to *another*
peerd. Peer transport, cryptographic identity, peer discovery, content
distributed across swarms, eventual decentralized agent applications
running across a dweb mesh.

This module is *the forward-looking surface*. Phase 0 is real code
(identity / codec / content / transport scaffolding, preview-channel
only — see `docs/distributed/ROADMAP.md`); everything beyond it is
V2+.
That's the point. V1 is a single-browser harness; no dweb yet.
The module exists in the architecture from day one for two reasons:

1. The wordmark commits to five modules. The brand is the architecture.
2. The roadmap from V2.2 onward needs a clearly delineated home.
   Reserving the namespace prevents dweb features from accreting
   into runtime where they don't belong.

The magenta color was chosen for this letter from the start to telegraph
*forward-looking, scaling-out*. The module's job is to make the magenta
make sense.

**Contents.** (Almost entirely V2+.)

```
peerd-distributed/
├── index.js                 # public API (stub in V1)
├── identity/                # V2.3 — cryptographic peer identity
│   ├── keypair.js           # ECDSA keypair derived from vault
│   └── did.js               # DID-style identity over the keypair
├── transport/               # V2.3 — peer-to-peer comms
│   ├── pairing.js           # QR / paste-code pairing flow
│   ├── webrtc.js            # peer connection management
│   └── protocols/
│       ├── share-memory.js
│       ├── delegate-task.js
│       ├── share-session.js # OpenCode-style: shareable session link, view/fork
│       ├── relay-message.js
│       └── ...
├── discovery/               # V2.5+ — peer discovery without a directory
│   ├── dht.js               # Kademlia-style DHT over WebRTC mesh
│   └── peer-cache.js
├── swarm/                   # V3.x — multi-peer coordination
│   ├── content.js           # WebTorrent-style chunked content distribution
│   ├── coordinate.js        # multi-agent task coordination across peers
│   └── consensus.js         # if/when needed: lightweight agreement protocols
├── dwapp/                   # V3.x — decentralized agent apps
│   ├── runtime.js           # dwapp loader and lifecycle
│   ├── manifest.js          # dwapp manifest format
│   └── examples/            # reference dwapps shipped with peerd
└── gateway/                 # V2.2 — external messaging surfaces
    └── relay.js             # user's self-hosted gateway client
```

**Public API.** Stub in V1; grows on a strict per-phase basis:

```js
// V1
import { VERSION } from 'peerd-distributed';
// → 'unimplemented — dweb surface reserved for V2+'

// V2.2
import { connectGateway, sendViaGateway } from 'peerd-distributed';

// V2.3
import { getMyIdentity, pairWithPeer, sendToPeer } from 'peerd-distributed';

// V2.5
import { joinDht, discoverPeers, advertiseService } from 'peerd-distributed';

// V3.0
import { broadcastToSwarm, fetchFromSwarm } from 'peerd-distributed';

// V3.x
import { loadDwapp, listDwapps, publishDwapp } from 'peerd-distributed';
```

**Dependencies (eventual).**

- `peerd-egress` — vault is the source of cryptographic identity material;
  secure storage for peer caches and DHT routing tables uses egress's
  IDB wrapper; audit entries route through egress.
- `peerd-runtime` — distributed can delegate tasks to local sessions
  (a peer asks us to run a sub-task; we spawn a subagent via runtime).
- `shared/`.

**Roadmap fit.**

- **V2.2 — Gateway.** External messaging surfaces. User self-hosts (or
  uses a free service for) a tiny relay that forwards messages from
  Signal/Telegram/Discord/email into the user's peerd. The browser is
  the workshop; the gateway is the notification surface.
- **V2.3 — Pairing.** WebRTC peer connections. Cryptographic identity
  (ECDSA keypair per profile). Pairing flow (QR code, paste, short
  code). Two peerds — your own across devices, or you and someone
  else's — can negotiate and trade messages, memory entries, skills,
  delegated tasks.
- **V2.5 — Discovery.** Kademlia-style DHT over the WebRTC mesh.
  Discover peers without a central directory. Advertise services.
  Solve the "two strangers find each other without a server" problem.
- **V3.0 — Swarm.** WebTorrent-style chunked content distribution for
  skills, training data, and dwapp resources. Multi-agent task
  coordination across peers. Subagents that span instances.
- **V3.x — Dwapps.** *Decentralized agent applications* — applications
  hosted across a dweb mesh of peerds, agent-native by design.
  A dwapp is a manifest + skills + content + coordination protocol,
  loaded into a local peerd and partly executed across the swarm. No
  central server. No platform. The agent is the runtime; the swarm is
  the platform.

**Why the empty-in-V1 framing matters.** Modules that ship with hand-wavy
"future hooks" tend to accrue cruft that becomes load-bearing before
the actual feature lands, then has to be torn out. `peerd-distributed`
ships as a stub. Each phase adds a complete subdirectory. The phases
are independent enough that landing them in roadmap order doesn't
require predicting the design of later phases. The empty module is the
*honest* version of "we're going to do this later" — better than a
half-built one would be.

**Tests.** None in V1 (no code). Each subsequent phase ships tests
following the same patterns as other modules.

---

## 3. Extension chassis — what's NOT in a peerd-* module

The five peerd-* modules are the *content*. The extension also needs a
*chassis* — the entry points, the offscreen document, the side panel,
the content scripts, the manifest. These are infrastructure, not
modules; they live at the top level of the extension repo.

```
extension/
├── manifest.json
├── peerd-provider/          # module
├── peerd-egress/            # module
├── peerd-engine/            # module
├── peerd-runtime/           # module
├── peerd-distributed/      # module
├── background/
│   └── service-worker.js    # SW entry point. Imports from peerd-* modules
│                            #   and wires them together with dependency
│                            #   injection. Owns no business logic itself.
├── offscreen/
│   ├── offscreen.html
│   ├── offscreen.js         # SW keepalive port; hosts peerd-engine
│   └── webvm-loader.js      # loads peerd-engine/host.js into the doc
├── sidepanel/
│   ├── sidepanel.html
│   ├── sidepanel.js         # Mithril mount, port wiring
│   ├── styles.css
│   └── components/          # UI components (chat, settings, audit, etc.)
├── content/
│   ├── content-script.js    # injected per-page on demand
│   └── dom-bridge.js        # DOM tool primitives (used by peerd-runtime/tools)
├── shared/
│   ├── messaging.js         # typed cross-context message router
│   ├── errors.js            # base Error subclasses
│   ├── util.js
│   └── uuid.js              # UUIDv7 (time-sortable)
├── tests/
│   ├── runner.html          # the extension's test page (see DESIGN.md §16.3)
│   ├── runner.js
│   ├── framework.js
│   ├── index.js             # test manifest
│   ├── unit/
│   │   ├── peerd-provider/
│   │   ├── peerd-egress/
│   │   ├── peerd-runtime/
│   │   └── peerd-distributed/
│   ├── integration/
│   │   ├── peerd-engine/    # browser-required tests
│   │   └── agent-loop.test.js
│   └── mocks/
├── vendor/
│   ├── mithril/
│   ├── browser-polyfill.js
│   └── cheerpx/
└── assets/
    ├── denylist-default.json
    ├── icons/
    └── webvm/
```

### Why this split

- A module is a *capability*. It can be lifted out, tested in isolation,
  potentially even published as a standalone library someday. Modules
  must not assume they're running inside an extension.
- Chassis code is *extension-specific*. It uses `chrome.*` APIs,
  `browser.*` polyfill, manifest-declared resources, the side panel
  framework. Chassis depends on modules; modules don't depend on chassis.

If a piece of code is calling `chrome.runtime.connect` or
`chrome.scripting.executeScript`, it belongs in chassis. If it's the
business logic that gets *parameterized by* those calls, it belongs in
a module (and accepts the chassis-provided functions as DI parameters).

### Parallel to OpenCode's client-server split

OpenCode runs the agent as a local server process and connects multiple
clients (TUI, desktop app, IDE extension) to it. We follow the same
architectural shape, mapped to the browser-extension context:

- **The service worker is the "server"** — it owns the agent loop,
  module instances, message routing, and SW-keepalive port.
- **The side panel is one "client"** — Mithril UI driving the SW via
  typed messages.
- **Content scripts are a second "client"** — page-injected when needed,
  reporting back via the same messaging surface.
- **The offscreen document is the engine host** — analogous to a
  spawned-subprocess in OpenCode's model.

The benefit is the same one OpenCode talks about: you can build new
clients without touching the server. A V1.x CLI for `peerd` could
connect to the SW via the existing messaging surface; an external
Electron app could speak the same protocol. The agent isn't tied to one
UI.

---

## 4. Naming conventions

- **Module dirs:** `peerd-<name>/` — lowercase, hyphenated, prefixed.
- **Files:** lowercase, hyphenated (`safe-fetch.js`, not `safeFetch.js`
  or `SafeFetch.js`).
- **Exports:** camelCase for functions and instances; PascalCase for
  classes and type union members; SCREAMING_SNAKE for constants.
- **Test files:** `<file-being-tested>.test.js` (e.g.,
  `denylist.test.js` tests `denylist.js`).
- **Public API:** every module has an `index.js` that re-exports the
  public surface. Imports from outside the module must go through
  `peerd-<name>` (resolving to `peerd-<name>/index.js`), never deep
  paths like `peerd-egress/vault/vault.js`.

The deep-path rule is enforced by ESLint
`no-restricted-imports` with the pattern `peerd-*/**/!(index)`. Within
a module, deep imports are fine.

---

## 5. Mapping from V1 design doc

The V1 doc's `/background/*` and `/offscreen/*` paths get remapped. This
is the migration table:

| V1 design doc path | New module path |
|---|---|
| `/background/providers/` | `peerd-provider/adapters/` |
| `/background/providers/registry.js` | `peerd-provider/registry.js` |
| `/background/crypto/keys.js` | `peerd-egress/vault/keys.js` |
| `/background/crypto/vault.js` | `peerd-egress/vault/vault.js` |
| `/background/security/denylist.js` | `peerd-egress/denylist/denylist.js` |
| `/background/security/egress.js` | `peerd-egress/fetch/safe-fetch.js` |
| `/background/security/trust-modes.js` | `peerd-egress/trust/modes.js` |
| `/background/security/confirm.js` | `peerd-egress/confirm/protocol.js` |
| `/background/storage/kv.js` | `peerd-egress/storage/kv.js` |
| `/background/storage/idb.js` | `peerd-egress/storage/idb.js` |
| `/background/tools/` | `peerd-runtime/tools/defs/` |
| `/background/tool-dispatcher.js` | `peerd-runtime/tools/dispatcher.js` |
| `/background/agent-loop.js` | `peerd-runtime/loop/agent-loop.js` |
| `/background/system-prompt.txt` | `peerd-provider/system-prompt.txt` |
| `/offscreen/webvm-host.js` | `peerd-engine/host.js` |
| `/offscreen/dom-sanitize.js` | `peerd-engine/dom-sanitize.js` |
| `/offscreen/offscreen.js` | `offscreen/offscreen.js` (chassis) |
| `/background/service-worker.js` | `background/service-worker.js` (chassis) |

Audit log moves from `/shared/audit.js` to `peerd-egress/audit/log.js`
because it's a security primitive — write paths are tightly controlled
and the storage backing it sits inside the egress module.

---

## 6. The service worker as wiring

Per §3, `background/service-worker.js` owns no business logic. Its job
is to import the modules, wire their dependencies, and route messages.
Shape:

```js
// background/service-worker.js
//
// Pure wiring. The SW imports each peerd-* module, creates concrete
// instances (vault, audit log, session store), injects dependencies
// downstream (provider gets safeFetch + getSecret from egress; runtime
// gets callModel from provider, run from engine, vault/safeFetch/audit
// from egress; distributed gets storage from egress).
//
// If this file grows past ~150 lines, the wiring is getting too clever.
// Push logic INTO modules; keep this file as a flat dependency graph.

import * as egress from 'peerd-egress';
import * as provider from 'peerd-provider';
import * as engine from 'peerd-engine';   // imported here only for type references
import * as runtime from 'peerd-runtime';
import * as distributed from 'peerd-distributed';

import { makeDispatcher } from '../shared/messaging.js';

// 1. Initialize Layer 1 modules.
const vault = egress.createVault({
  kv: egress.kv,
  now: Date.now,
});

const auditLog = egress.audit.createLog({ idb: egress.idb });

// `peerd-engine` runs in the offscreen doc, not the SW. The SW
// communicates with it via the keepalive port. We treat it as a
// remote-procedure surface here.
const engineProxy = makeEngineProxy();

// 2. Layer 2 — runtime composes Layer 1.
const runtimeContext = {
  callModel: provider.callModel,
  vault,
  safeFetch: egress.safeFetch,
  vmRun: engineProxy.run,
  appendAudit: auditLog.append,
  requestConfirmation: makeConfirmationBridge(),  // bridges to side panel
};

// 3. Layer 3 — distributed composes runtime + egress.
const sessions = runtime.createSessionStore({ idb: egress.idb });

// 4. Message routing — side panel ↔ SW, offscreen ↔ SW.
chrome.runtime.onMessage.addListener(makeDispatcher({
  'agent/start':        (msg) => runtime.runAgent({ session: msg.session, ...runtimeContext }),
  'vault/unlock':       (msg) => vault.unlock(msg.passphrase),
  'session/list':       ()    => sessions.list(),
  // ... etc.
}));
```

That's the entire SW. ~50 lines of real code plus comments. The modules
do the work.

---

## 7. Module independence — the test

A module is properly factored if you can answer "yes" to:

1. **Can it be unit-tested without spinning up the rest?** Pass mocks
   for its DI parameters; the module's pure functions and pure-data
   reducers run in isolation.
2. **Can a future contributor read its `index.js` and understand the
   surface?** If `index.js` is over ~50 lines or re-exports more than
   ~10 names, the module is doing too much.
3. **Would removing it break only what it specifically owns?** If
   removing `peerd-engine` breaks the agent loop's ability to use
   `vm_run`, that's correct. If it also breaks the side panel's
   ability to render messages, the boundary is wrong.

When in doubt, the smaller module is the right call. Push functionality
DOWN the dependency graph, not across it.

---

## 8. Style and constraints — unchanged from V1

The V1 design doc's style rules still apply within each module:

- Vanilla JS, ES modules, no build step, no npm runtime.
- Functional core (pure reducers, pure policy steps, DI for IO).
- Mithril for the UI (chassis-level, in `sidepanel/`).
- Vendor third-party code under `/vendor/` with `SOURCE.txt`.
- Tests run as an extension page (the harness in `tests/runner.html`).
- Every architectural choice gets a comment explaining the *why*.

Module-level rules added by this doc:

- Each module has `index.js` as its public API. No deep imports from
  outside the module.
- Each module's IO dependencies are injected, not imported. Provider
  doesn't import safeFetch; it takes a fetch function. Runtime doesn't
  import callModel; it takes a callModel function. This makes every
  module independently testable.
- Cross-module imports respect the dependency graph (Layer 1 ↔ Layer 1
  not allowed; Layer 1 → Layer 2/3 not allowed; etc.). ESLint
  enforced.

---

## 9. What this enables

- **The wordmark is the architecture.** A new contributor reads the
  homepage, sees five colored letters, opens the repo, and sees five
  top-level module directories with names that start with those letters.
  Onboarding takes minutes.
- **Modules can be published independently.** When (if) it makes sense,
  `peerd-engine` could ship as a standalone npm package that wraps
  CheerpX with our specific lifecycle and persistence shape. Same for
  `peerd-provider` as a model-adapter library, `peerd-egress` as a
  general browser-extension security toolkit.
- **The roadmap maps to modules cleanly.** V1.2 profiles → runtime.
  V1.3 tool exposure → runtime. V1.4 skills → runtime. V1.5 memory →
  runtime. V2.0 long-running → runtime + distributed. V2.3 P2P →
  distributed. V2.4 local inference → provider. Each phase has an
  obvious home.
- **The brand never goes stale.** As the codebase grows, the wordmark's
  meaning grows with it. The five colors come to *mean* something
  beyond decoration — they're the system's organizing principle.
