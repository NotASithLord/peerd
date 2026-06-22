# TOOL INVENTORY — BrowserOS vs peerd

> **Purpose:** find peerd's real capability gaps, not mirror a competitor.
> The comparison is grounded in BrowserOS's **actual** tool surface
> (verified against public docs **and** source for accuracy — see
> `RESEARCH-NOTES.md` for the methodology and the no-code-copied posture).
> peerd's surface is its shipped registry (`peerd-runtime/tools/`).
>
> **Framing the two products differ at the root:** BrowserOS is a **forked
> Chromium + a bundled/cloud agent server** that drives the browser over
> CDP (with custom `Browser.*` domains) and reaches apps through a **hosted
> cloud MCP gateway**. peerd is an **unprivileged extension** running the
> whole agent **in-browser, BYOK, no backend**, driving pages via
> `chrome.scripting` (CDP optional, preview-only), reaching apps by
> **driving the real web apps** with `do`/`get`/`check`. Many "gaps" below
> are deliberate consequences of that thesis, not omissions.

---

## 0. The two surfaces at a glance

**BrowserOS** exposes, to one agent:
- **56 browser tools** in its registry — Navigation (8), Observation (8),
  Input (14), Page-actions (3), Windows (5), Bookmarks (6), History (4),
  Tab-groups (5), Info (1), Nudges (2).
- **7 Cowork filesystem tools** (read/write/edit/bash/grep/find/ls) —
  unsandboxed host access.
- **~6 memory/soul tools** (core + daily memory, SOUL.md).
- **47 app integrations** via the **Klavis "Strata" cloud MCP gateway**
  (one streamable-HTTP endpoint; OAuth handled by Klavis), plus custom MCP.
- **Skills** (SKILL.md) and **Workflows/Graph Mode** (NL→codegen→TS).

**peerd** exposes its tool inventory through `peerd-runtime/tools/defs/`,
with channel/exposure filtering in `tools/exposure.js`:
- **Main browser surface:** `do`, `get`, `check`, `list_tabs`,
  `open_tab`, `capture`. (The low-level DOM tools — `snapshot`,
  `read_page`, `click`, `type`, `navigate`, `page_eval`/`page_exec`, etc.
  — are **runner-only**, hidden from the main agent.)
- **Web/egress:** `read_article`, `call_api`, `web_search`.
- **Introspection:** `inspect_audit_log`, `inspect_denylist`,
  `inspect_provider_config`, `inspect_session_access`, `inspect_storage`.
- **Sandboxed execution (each its own tab):** WebVM (`vm_*` — real
  Debian/bash), JS Sandbox (`js_*` — Worker+OPFS), App (`app_*` — HTML in
  a sandboxed iframe), plus `edit_file`.
- **Memory:** `remember`, `read_memory` (file-based AGENTS.md).
- **Orchestration:** `spawn_subagent`, `request_review`.
- **Skills:** `load_skill`. **Clock:** `now`, `wait_until`.
- **(landing)** `schedule_*` + `wait_for` (`FEATURE-SCHEDULED-TASKS.md`),
  `suggest_*` (`FEATURE-SMART-NUDGES.md`).

---

## 1. Category-by-category map

Coverage key: **✅ covered** · **🟡 partial** · **❌ not covered** ·
**⭐ peerd ahead**.

| BrowserOS category (their tools) | peerd coverage | Where in peerd |
|---|---|---|
| **Page navigation** (navigate_page, new_page, new_hidden_page, get_active_page, list_pages, show_page, move_page, close_page) | 🟡 | `open_tab`, `list_tabs`, `do("go to …")`, runner `navigate`. Background tabs replace "hidden page" (never steal focus). **Gaps:** no `close_tab`, no tab-reorder/`move`, no explicit `show/activate`. |
| **Content & observation** (get_page_content, get_page_links, get_dom, search_dom, take_snapshot, take_enhanced_snapshot, take_screenshot, evaluate_script) | ⭐ | `get`, plus runner `snapshot`/`read_page`/`read_state`/`query_dom`; `capture` (screenshot, redacted from model); `page_eval`/`page_exec` (CDP, preview). **peerd ahead on security:** this content stays in the disposable runner and never enters the main context. |
| **DOM interaction** (click, click_at, hover, focus, clear, fill, check, uncheck, upload_file, press_key, drag, handle_dialog, scroll, select_option) | 🟡 | `do(...)` → runner `click`/`type`/`page_keys`; select-by-label handled. **Gaps:** `upload_file` (no file attach — by design no host FS), `drag`, `handle_dialog` (native JS alert/confirm/prompt), `hover`. |
| **Screenshot / visual** (take_screenshot, save_screenshot) | 🟡 | `capture` shows the user a screenshot (bytes redacted from the model). **Gap:** no save-to-disk (intentional — no host FS). |
| **File & export** (save_pdf, save_screenshot, download_file) | ❌ (intentional) | No host filesystem. Sandboxed analogs: write into an **App**/**JS**/**VM** (OPFS), `vm_import`. See §3 "do NOT adopt." |
| **Window management** (list_windows, create_window, create_hidden_window, close_window, activate_window) | ❌ (intentional) | peerd uses **background tabs** + the offscreen doc; window choreography conflicts with never-steal-focus. Not a meaningful gap. |
| **Tab groups** (list_tab_groups, group_tabs, update_tab_group, ungroup_tabs, close_tab_group) | 🟡 | peerd already groups its own tabs into a "peerd" tab group at the UI layer, but exposes **no agent tools** to manage groups. Minor. |
| **Bookmarks** (get/create/remove/update/move/search) | ❌ | Not exposed. Thesis-neutral; moderate utility (esp. read/search). Candidate add (§2). |
| **History** (search_history, get_recent_history, delete_history_url, delete_history_range) | ❌ | Not exposed. **Read** side is useful ("find that article"); **delete** side is a hazard we will not adopt (§3). |
| **Cowork filesystem** (read/write/edit/bash/grep/find/ls) | ❌ (intentional, and a hard NO) | peerd's sandboxed substitutes: **WebVM** (real bash on an isolated disk), **JS Sandbox** (OPFS), **App** files, `edit_file`. peerd will **never** add unsandboxed host FS/bash. See §3. |
| **Memory** (memory_search/write/save_core/read_core) | ✅ | File-based AGENTS.md memory: `remember`/`read_memory`, `/init`, auto-memory extraction, hierarchical scopes, always-loaded block. **Difference:** peerd loads a budgeted always-on block rather than fuzzy-searching on demand (no `memory_search` equivalent — minor candidate). |
| **Personality** (SOUL.md, soul_read/update) | 🟡 | peerd has per-session `/system` (`<session_instructions>`) + a frugally-expanded USER memory doc + strong built-in voice rules. **peerd deliberately rejects a self-rewriting identity file** — see `SYSTEM-PROMPT-LESSONS.md` §personality. |
| **MCP app integrations** (47 apps via Klavis Strata cloud) | ❌ (thesis divergence) | peerd reaches the **same apps by driving their real web UIs** with `do`/`get`/`check`, plus `call_api` for public/JSON APIs. No MCP, no cloud gateway. Real trade-off discussed in §2/§3. |
| **Scheduling** | 🟡 planned | `FEATURE-SCHEDULED-TASKS.md` sketches the hardened version: durable IDB truth, single pinned waker, Firefox boot-scan, budgets, unattended clamps, dry-run. |
| **Proactive suggestions** | ✅ (landing) | `FEATURE-SMART-NUDGES.md` (reactive, opt-in, no surveillance). |
| **Network / console observation** | ⭐ / N/A | BrowserOS lists these "coming soon" (not shipped). peerd has `read_state` + `page_exec` (CDP preview). Not a gap. |
| **Sub-agents / multi-agent** | ⭐ | `spawn_subagent` (real parallel dispatch, depth-bounded, tool-narrowed, audit lineage) + `request_review`. Ahead of BrowserOS's "Agent Per Tab." |
| **Code execution** | ⭐ | **WebVM (real Linux), JS Sandbox, Apps** — sandboxed by construction. BrowserOS's "code execution" is host `bash` via Cowork (unsafe). peerd is both safer and more capable here. |
| **Workflows / Graph Mode** (NL→codegen→TS, viz graph) | 🟡 | Covered in spirit by **goal mode** (the Goal toggle) + **skills** + planned scheduled tasks. No visual graph or code-gen workflow builder. Low priority. |
| **Info** (browseros_info) | ✅ | `inspect_provider_config` / `inspect_*` cover "what am I / what can I see." |

---

## 2. Gap analysis — should peerd add it?

For each genuine gap: add or not, where it lives, security, thesis fit.

### 2.1 File upload (`upload_file`) — **ADD (sandboxed)**
- **Why:** a real capability hole for agentic web work — job applications,
  "attach this report," profile photos, document portals. Today `do()`
  cannot complete any flow with a file input.
- **Where:** a new runner-side action reachable through `do()` (the main
  agent stays at intent level: `do("upload the résumé to the file field")`).
- **Security (the crux):** BrowserOS's `upload_file` takes **absolute host
  paths** (`DOM.setFileInputFiles`) — peerd must **not** copy that. The
  file source must be one of: (a) a file the user just picked via an
  explicit `<input>`/file-picker **user gesture**, or (b) a file living in
  a peerd **sandbox** (an App/JS/VM OPFS path the agent itself produced).
  Never an arbitrary host path. This keeps "no unsandboxed FS access"
  intact while closing the flow.
- **Thesis fit:** good, with the sandboxed-source constraint.
- **Scope:** ~**1 week** (picker-gesture plumbing + sandbox-source path +
  runner action + denylist/gate wiring).

### 2.2 Bookmarks + history **read** — **ADD (read-first)**
- **Why:** high everyday utility — "find that article I read last
  Tuesday," "bookmark this," "what was that docs page." Cheap, broadly
  useful, thesis-neutral.
- **Where:** a small `inspect`-family or `browser_data` read tool on the
  main agent (it returns metadata, not page content, so it needs no
  runner). Bookmark **create** can be a separate confirm-gated write tool.
- **Security:** read is low-risk (it's the user's own data, local). Gate
  reads behind the audit log; gate bookmark writes behind confirmation.
  **History/bookmark data is user-private — never let it cross the egress
  boundary** (it's input to reasoning, not something to POST anywhere).
- **Thesis fit:** good. No backend, no new egress.
- **Scope:** ~**1 week** (Chrome `chrome.bookmarks`/`chrome.history` +
  Firefox parity via `webextension-polyfill`; read tools + optional
  bookmark-create).

### 2.3 Tab lifecycle: `close_tab` (+ light tab-group tidy) — **ADD (small)**
- **Why:** agentic sessions open background tabs and never clean up;
  `close_tab` lets the agent tidy after itself, and minimal tab-group ops
  let it keep work organized in the existing peerd group.
- **Where:** main-agent tab-management tools alongside `open_tab` /
  `list_tabs` (no page content, like the others).
- **Security:** trivial; closing a tab is reversible-ish and low-stakes
  (don't close non-peerd user tabs without confirmation — only tabs peerd
  opened, or confirm).
- **Scope:** ~**1–2 days** for `close_tab`; +2 days for group tidy.

### 2.4 Sandboxed "export / download a result" — **ADD (sandboxed)**
- **Why:** "save this as a PDF/CSV I can keep" is a common ask;
  BrowserOS's `save_pdf`/`download_file` cover it via host disk.
- **Where:** an action that either (a) writes agent-produced content into
  an **App** the user already sees, or (b) triggers a **browser
  download** of agent-generated bytes (the user's normal Downloads flow,
  visible and user-controlled) — **not** a model-chosen host path.
- **Security:** content originates from the agent/sandbox; the browser's
  own download UI is the consent surface; no targeting arbitrary host
  paths; no reading host files.
- **Scope:** ~**1 week**.

### 2.5 Memory fuzzy search — **MAYBE (defer)**
- peerd loads a budgeted always-on memory block instead of searching.
  If large memories outgrow the budget, add a `read_memory(search:…)`
  mode (lexical, local — no embeddings, matching the lightweight bar).
- **Scope:** ~**2–3 days**, but **defer** until the always-loaded model
  demonstrably strains.

### 2.6 MCP app integrations — **DO NOT ADD a gateway; close the gap with recipes**
- **The honest trade-off:** BrowserOS's 47 Klavis integrations give the
  agent **typed, reliable API actions** ("create a Linear issue") without
  fighting a DOM. peerd's `do/get/check` on the live web app is
  **universal** (works on any app, no connector to build, no third party)
  but **more brittle and slower** for structured operations, and it
  depends on the user being logged in.
- **Why not adopt the gateway:** Klavis Strata is a **hosted cloud MCP
  gateway** — adopting it (or any MCP gateway) would put a backend and a
  third party between the user and their data, violating peerd's
  **no-backend, no-MCP, egress-chokepoint, no-telemetry** thesis. The
  whole point of peerd is that nothing sits in the middle.
- **The peerd-native way to narrow the gap:** lean on **skills as API
  recipes** — a `SKILL.md` that teaches the agent the exact `call_api`
  shapes for a given service's *public* API (GitHub, calendar via CalDAV,
  RSS, etc.), all routed through the existing `webFetch` chokepoint. This
  gives much of the "typed reliability" benefit for the handful of
  high-value services, with zero connectors, zero cloud, and the user's
  own credentials. **Recommend a small set of first-party API skills**
  rather than a connector framework.
- **Verdict:** gap is real but adopting BrowserOS's answer is wrong for
  peerd. Mitigate with skills; accept the residual brittleness as the
  cost of the no-middleman thesis.

---

## 3. Tools BrowserOS has that peerd should **NOT** adopt

| Capability | Why not |
|---|---|
| **Cowork host filesystem + `bash`** (read/write/edit/bash/grep/find/ls) | The single sharpest divergence. BrowserOS's `bash` runs **arbitrary host shell commands with the server's full env, no path jail, following symlinks** — under prompt injection that is a host-level RCE surface. It breaks peerd's sandboxed-by-default model outright. peerd already has the **safe** answer: **WebVM** (real bash on an isolated CheerpX disk) and the **JS Sandbox** (Worker+OPFS). Run shell in the VM, not on the host. |
| **Absolute-host-path `upload_file`; host-disk `download_file`/`save_pdf`/`save_screenshot`** | Same root issue — they bridge the agent to the host filesystem. peerd's uploads must be sandbox-sourced or user-picked (§2.1); peerd's exports go to an App or the browser's own download flow (§2.4). Never a model-chosen host path. |
| **History deletion** (`delete_history_url`, `delete_history_range`) | Destructive and a privacy hazard: a prompt-injected page could erase browsing evidence. Read history (§2.2) yes; delete, never (or at most a heavily-confirmed, never-unattended action — not worth the surface). |
| **MCP / Klavis cloud gateway** (the 47 integrations) | Cloud dependency + third party in the data path; violates no-backend / no-MCP / egress-chokepoint / no-telemetry. Use web-app driving + API-recipe skills instead (§2.6). |
| **Hidden/visible window choreography** (`create_window`, `create_hidden_window`, `activate_window`) | Conflicts with the owner rule **never steal focus**. peerd uses background tabs + the offscreen doc; it does not open or raise windows on the user. |
| **Self-rewriting SOUL.md** | (See `SYSTEM-PROMPT-LESSONS.md` §personality.) An agent that silently rewrites its own persona file conflicts with peerd's confirm-gated memory and "never store inferences" rules. peerd offers user-chosen persona presets layered like `/system`, not autonomous self-evolution. |
| **NL→codegen→`eval` Workflows that strip imports and dynamic-import generated TS** | Generating code and dynamically importing it server-side is a code-exec pattern peerd doesn't need and shouldn't host outside its sandboxes. peerd's deterministic-repeat story is **skills + goal mode + planned scheduled tasks**; if visual workflows are ever wanted, build them on the sandboxes, not on host `eval`. |

---

## 4. Ranked recommendations — highest-value additions for 0.x

1. **File upload through `do()`, sandbox-sourced** — *~1 week.* Closes the
   biggest concrete agentic hole (any flow with a file input). Security
   hinges on **never accepting a host path** — only user-picked or
   sandbox-resident files. **Highest value.**
2. **Bookmarks + history *read* (+ confirm-gated bookmark create)** —
   *~1 week.* Cheap, broadly useful, thesis-neutral, no new egress. Skip
   all deletion.
3. **`close_tab` + light tab-group tidy** — *~1–2 days.* Small quality-of-
   life fix so agentic sessions don't litter the tab strip; uses the
   existing peerd tab group.
4. **Sandboxed result export (App / browser-download, not host path)** —
   *~1 week.* Satisfies "save this report" without host FS.
5. **First-party API-recipe skills for 3–5 high-value services** —
   *~1 week for the first few.* The peerd-native counter to BrowserOS's
   integrations: typed `call_api` recipes via skills, no connectors, no
   cloud. (Treat as ongoing, not a one-shot.)

Deferred / not recommended: memory fuzzy search (defer until needed),
visual Workflows (low priority), and everything in §3.

---

## 5. The bottom line

peerd is **not behind** BrowserOS on capability — it is **differently
shaped**. peerd is **ahead** on the things that matter to its thesis:
sandboxed code execution (real VM vs unsafe host bash), context-security
(page content quarantined in the disposable runner), true sub-agent
parallelism, an in-browser no-backend loop, and an actual eval harness
(BrowserOS ships none in its agent repo). The genuine, worth-filling gaps
are **narrow and concrete**: file upload, bookmarks/history read, tab
cleanup, and sandboxed export. The big-looking gaps — the 47 cloud
integrations and the Cowork filesystem — are gaps peerd should **keep**,
because closing them BrowserOS's way means importing a backend, a third
party, and an unsandboxed host-exec surface that the entire peerd
architecture exists to avoid.
