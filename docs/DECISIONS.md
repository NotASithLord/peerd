# V1 decisions

Original §1-§6 answered the V1 design doc's open questions. §7+ are
decisions made as V1 was built — recorded here so they don't drift
out of memory and quietly get re-litigated.

Reopen by editing this file and the relevant code, not by changing
behavior silently.

## 1. Extension name

**peerd** (always lowercase, short for "peer daemon"). It lives in the
browser as a peer to the user's existing tooling rather than a top-down
"AI browser". Renamed from the placeholder "Lattice" before V0.1 shipped.
Internal module names do not use the product name.

## 2. Default trust mode on install

**Open.** A first-run agent that constantly prompts feels broken; users
will tune out or revert to a chat tool. Open is the productive default;
Scoped and Paranoid are *opt-in for known risky work* (filing taxes,
poking at infra, anything where blast radius matters). The denylist
(§4.2) is always-on regardless of mode, so even Open never touches
banks/health/identity.

## 3. Does the vault require a passphrase?

**Yes — passphrase required.** The alternative (DK in
`chrome.storage.session`, dies on browser close, no at-rest encryption)
trades a meaningful security property for a small UX win. The product is
"sovereign by construction"; shipping with no at-rest secret encryption
undermines that.

WebAuthn-as-second-factor (Touch ID / Windows Hello) is the V1.1 UX
improvement; the vault module already exposes a KDF-extra-input arg as
the migration hook.

## 4. Default `max_steps` for the agent loop

**100** (raised from 25 in commit `54fd969`). Real agentic browser
tasks routinely want 30+ steps (read_page → think → click → read_page
→ ...). 25 false-positived a real Gmail task. 100 catches genuine
infinite loops without affecting normal work. Cap-hit no longer emits
a synthetic error — the last assistant message gets
`stopReason: 'max_steps'` and the conversation continues naturally.

## 5. Confirmation UI placement

**Inline in the message list.** Reads naturally and keeps the model's
reasoning + the gate + the user's answer adjacent in the transcript.
Risk: a confirm that the user has scrolled past is invisible — to
mitigate, the input bar is disabled while a confirm is pending and a
small "pending confirm" banner appears at the top of the panel with a
"scroll to" affordance.

## 6. VM network access default

**Off by default.** Per-session enable via a one-click confirm; when
enabled, an egress allowlist for common dev origins applies
(`pypi.org`, `pythonhosted.org`, `github.com`, `raw.githubusercontent.com`,
`registry.npmjs.org`, `repo.maven.apache.org`, `crates.io`).
The agent can request additions; user confirms each.

This is the conservative-by-default version. If we get user feedback
that the `pip install` friction is constant, revisit with a "trusted
sources only" mode that auto-enables the curated allowlist without a
prompt per session.

---

# Decisions added during V1 build

## 7. DK persists in `chrome.storage.session` across SW restarts

The vault's data key gets written to `chrome.storage.session` (RAM-only,
cleared on browser close) after every unlock/initialize. SW boot
attempts `attemptResume()` — if the bytes are there, the unlocked
state restores silently without re-prompting the user. *(commit
`63d18bc`)*

**Why.** Without it, MV3's 30-second SW idle timer fires several times
per session, locking the vault each time. The user re-types the
passphrase every minute, which is unusable. With it, unlock prompts
fire exactly once per browser session.

**Why this isn't a security regression.** Anyone with code execution in
the extension already has access to SW memory and the DK. Persisting to
session storage exposes it to the same set of attackers, no new
surface. Session storage never lands on disk; it's gone the moment
the browser closes.

## 8. `autoLockMs: 0` — idle auto-lock disabled by default

The SW passes `autoLockMs: 0` to `createVault`. The vault treats `≤0`
or non-finite as "no idle timer." *(commit `a771a6d`)*

**Why.** For a V1 single-user-local extension, a 15min idle re-lock
created significant daily friction without adding meaningful security.
The SW dying or browser closing still locks the vault (DK lives only in
SW memory + session storage; both clear on browser close).

When WebAuthn unlock lands (V1.1 / now V1 critical-path), we re-enable
a shorter idle timer because re-unlock will be a Touch ID tap, not a
passphrase entry.

**Addendum (2026-06-12).** Reopened and reversed by the store-readiness
merge: idle auto-lock is ON by default again (45 min,
`DEFAULT_AUTO_LOCK_MS`), user-tunable via the `vaultAutoLockMs` setting
(0 = never). What changed since this entry: WebAuthn PRF shipped, so
re-unlock is a single Touch ID tap — the friction argument above no
longer holds, and bounding how long the unwrapped DK sits live won.

## 9. `host_permissions: ["<all_urls>"]` is mandatory, not optional

Moved from `optional_host_permissions` to mandatory `host_permissions`
in `manifest.json`. Chrome shows the install warning. *(commit
`8258049`)*

**Why.** `chrome.scripting.executeScript` needs host permission for the
target URL. `activeTab` covers the user-invoked case but loses the
grant on navigation. For an agent that drives the browser across pages,
the host permission is the honest version of what peerd does.

The denylist is the meaningful floor; arbitrary host access is the
user's whole reason for installing.

Provider-specific endpoints (`api.anthropic.com`, `api.openai.com`,
local Ollama) are also in `host_permissions` to bypass CORS.

## 10. Anthropic prompt caching on system + tools

The Anthropic adapter sends `system` as a single-block array and the
last tool entry with `cache_control: { type: 'ephemeral' }`. *(commit
`8c5dd5e`)*

**Why.** Anthropic charges cached input tokens at 10% against the
per-minute rate limit AND ~10% of the dollar cost. The system prompt
and tool definitions are stable across all turns of a conversation;
re-billing them on every turn was the biggest contributor to hitting
the 30k-input-tokens-per-minute tier limit during real agentic work.

Three of four allowed cache breakpoints used (system prompt, tool
definitions, and the message-history pin). The fourth is reserved for a
deeper sliding-window anchor if we add it.

## 11. `anthropic-dangerous-direct-browser-access: true` header

The Anthropic adapter always sends this header. *(commit `688e59c`)*

**Why.** Anthropic blocks browser-origin requests by default and
requires the explicit ack header. peerd is exactly the use case —
key encrypted in vault, SW handles requests, user owns their
credentials and understands the model. We acknowledge.

## 12. `read_page` payload sized at 4000 chars / 100 interactables

`peerd-runtime/tools/defs/read-page.js` caps body text at 4000 chars
and interactable elements at 100. *(commit `8c5dd5e`)*

**Why.** ~4000 chars ≈ 1000 tokens. After multiple read_page calls in
a long task, the conversation persists each as a tool-result block.
Larger caps fed the 30k input-tokens-per-minute pressure faster than
caching could relieve. Interactables are more useful per byte than raw
text (the agent uses selectors directly), so text was the right thing
to trim first. Agent can re-call read_page after scrolling or
navigating to a more focused view if it needs more.

## 13. The "consumer auth redirect" domains came off the denylist

`accounts.google.com`, `myaccount.google.com`, `login.microsoftonline.com`,
`login.live.com` removed from the `identity` category. Kept
`appleid.apple.com` and `*.okta.com` / `*.auth0.com` / similar
enterprise SSO. *(commit `8c5dd5e`)*

**Why.** Every Google service routes through `accounts.google.com` for
auth. Every Microsoft consumer service routes through
`login.microsoftonline.com` or `login.live.com`. Leaving those on the
denylist blocked normal Gmail / Drive / Outlook / OneDrive use by the
agent. The blast radius from an agent navigating to the Google account
settings is lower than blocking ~all Google use entirely.

Enterprise SSO providers stay because they're less commonly hit on
personal browsing AND because compromising an Okta tenant has much
bigger blast radius (the IdP controls many downstream apps).

## 14. The keepalive port uses an active heartbeat, not just open ports

The offscreen doc sends `{ type: 'heartbeat' }` to the SW every 20s;
the SW responds with `heartbeat-ack`. *(commit `9c4827d`)*

**Why.** MV3 docs imply "open port = SW kept alive," but in practice
some Chrome versions/contexts treat an IDLE port as not keeping the SW
busy. The SW was dying at the 30s idle timer despite the port being
open. Active bidirectional traffic on the port flips that behavior
reliably. Tested against Chrome 148+; lower bounds unverified.

## 15. Tool dispatcher uses a fixed policy pipeline

The dispatcher composes named policy checks and records their results for
tool-call lineage. At the time of this decision, some checks were still
stubs; the live check list is defined in `peerd-runtime/tools/gates.js` and
the default tool hooks. *(commit `1e23b48`)*

**Why.** Two reasons:
1. The policy-result data is what the UI's tool-call lineage display
   reads. Wiring named checks from day one means the rendering doesn't
   have to differentiate between "real check" and "future check" — every
   check yields a `{ allowed, reason }` and the row renders.
**Addendum (2026-06-12).** Both stubs are now REAL, ahead of their
planned slots: feature 03 made `personaGate` live Plan/Act enforcement
(calls `decideAction`; Plan blocks non-read at the gate), and the
store-readiness merge made `exposureGate` enforce the runner-only tool
boundary at dispatch (`ctx.exposure === 'main'` refuses main-hidden
tools by name). The egress slot in the chain remains a deliberate
no-op — its real teeth are the egress-allowlist pre-tool-use hook plus
`safeFetch`. The numbered rationale below is kept as the original
record.

2. Subsequent features can turn stubs into active checks WITHOUT changing
   the dispatcher's composition. The architecture is in place; edit the
   policy function, not the docs, and treat code as definitive.

## 16. Plan mode permits pure URL loads — and nothing else non-read

Resolved 2026-06-12 (the open decision recorded in the legacy permission-mode
removal spec). The owner wanted Plan to support navigation, "including
clicking hyperlinks"; the spec's counter-argument stood: at the tool
layer `click` is `click` — "click a hyperlink" is indistinguishable
from "click Delete" — so any click carve-out quietly breaks Plan's
read-only guarantee.

**The middle path shipped:** `decideAction` allows exactly the two
tools whose ENTIRE effect is loading a URL — `navigate` (runner-side,
current tab) and `open_tab` (the main agent's surface, fresh tab) —
via `PLAN_NAVIGATION_TOOLS` in `peerd-runtime/permissions/policy.js`.
`click`/`type`/`do`/`submit_form` stay blocked in Plan. The denylist
origin gate still applies to carved-out loads, and the carve-out is
Plan-only — ACT tiers confirm navigation exactly as before.

**Why `open_tab` too, when the spec only blessed `navigate`:** the main
agent cannot call `navigate` (runner-only, and the runner's write path
`do` is blocked in Plan) — a navigate-only carve-out would have been
dead code for the user-visible feature. `open_tab` is the same pure
load with a smaller blast radius (it does not even disturb the page
the user is looking at). GET side effects exist for both, as they do
for every read tool that fetches.

**Owner review flag:** if "clicking hyperlinks in Plan" is still
wanted, the credible design is a dedicated `follow_link(ref)` tool
that resolves an anchor's href and NAVIGATES to it (a pure load) — not
a click carve-out. That can join PLAN_NAVIGATION_TOOLS later without
weakening anything.

## 17. Pre-release code carries no backwards compatibility

Decided 2026-06-12, prompted by the vault KDF work landing with a
"verify PBKDF2 forever + migrate lazily" path on the same day Argon2id
shipped. The owner's call: **peerd is 0.x with zero installs in the
wild — compat machinery is code for users who don't exist.** The
PBKDF2 unlock path, the lazy KDF migration, and `deriveKEK` were
deleted the same day they were written; Argon2id is the only
passphrase KDF, and a vault built without the argon2 dep is honestly
PRF-only (`KdfUnavailableError` on any passphrase operation).

**The general rule going forward:** until peerd has real installs,
storage-format changes REPLACE, they don't migrate. (Two exceptions,
both deliberate: the blob-home kv→IDB fallback stays because it is
RESILIENCE — a corrupt-IDB escape hatch, not version compat; and
settings-export files keep their own self-contained PBKDF2 because an
export is an ephemeral user-carried file with its own threat model.)
Once a store release exists, this entry flips: from that day, formats
version and migrate.

**Dogfood cost, accepted:** any pre-existing dev vault's passphrase
wrap stops verifying; Touch ID/PRF unlock still works, and re-setting
the recovery passphrase in Settings re-wraps under Argon2id.

## 18. Act tiers collapsed to one confirmActions boolean

Decided 2026-06-12 (owner: "idk what this full auto thing even is or
does, suspect its also doing overlapping work to plan/act"). The three
Codex-CLI-style Act tiers (suggest / auto-edit / full-auto) were
removed: full-auto duplicated work the Plan/Act axis already does, and
the auto-edit middle tier added a second axis nobody could explain.
Act now carries a single `confirmActions` boolean — ON is the old
suggest (every non-read action round-trips to the user), OFF is the
old full-auto (nothing confirms; the fresh-install default).
ACTION_CLASSES survive for lineage/prompt labeling; the Plan
navigation carve-out (#16) is unchanged. Legacy session records
carrying `actTier` are read forever and normalized at the edge
(`confirmActionsFromRecord`: full-auto→off; suggest AND auto-edit→on —
conservative: a migration must never widen authority, so auto-edit
users now confirm workspace writes they previously auto-ran); new
records only write `confirmActions`. The goal-mode autonomous-run gate
is unchanged in force, restated as Act + confirmations off. The
ModeSelector's tier picker became a confirm toggle wired to the same
state as the Settings confirm toggle — one source of truth.

## 19. Default reasoning effort is medium, dialed from the chat

Decided 2026-06-12 (owner: "lets set medium effort as our default, and
make it configurable in the chat somewhere"). peerd sends Anthropic
`output_config.effort: 'medium'` by default — deliberately BELOW the
platform default (high). Rationale: in a browser harness the user
watches the agent work; minutes of invisible deliberation before the
first tool call reads as a hang (field report: an entire app was
composed twice inside extended reasoning before anything appeared in
the App tab). Medium trades some up-front reasoning depth for earlier,
visible action; prompt steering alone (the BUILD ITERATIVELY rule)
demonstrably did not overcome the model's deliberate-first bias.
The dial lives in the chat mode row next to Plan/Act (EffortDial —
same global `settings.reasoningEffort` the Settings page edits; the SW
snapshots settings at turn start, so changes apply from the next
message). Raise it to high/xhigh for genuinely hard tasks; that is one
click, where the work happens. If field use shows medium degrading
multi-step agentic quality, the revert is this default plus this entry.

## 20. New tabs take focus; actions on existing tabs don't

Decided 2026-06-12, **refined 2026-06-14**. The original call (owner:
"never steal the *user's* focus. i could be trying to multi task and
just getting yanked into some random in progress thing its doing") made
EVERY agent-initiated tab open background. The refinement splits on
*new tab vs existing tab*: owner 2026-06-14 — "by default, new tabs
created by peerd DO get focus so the user immediately sees what peerd is
doing; but if an existing tab is being used or acted on, focus doesn't
get set, so the user can navigate away and multitask without being
dragged back."

Current policy:
- **A tab peerd OPENS takes focus.** `open_tab` defaults `active:true`;
  a new VM / Notebook / App tab is created `active:true` (the user
  sees the terminal/sandbox/app appear). The model may pass `open_tab
  active:false` to open quietly (prep work the user need not watch).
- **Acting on a tab that ALREADY exists never steals focus.** Navigate,
  click, type, run a command — the user stays where they are. The
  trackers' `ensureTab` early-returns for a live tab, so it only applies
  `active` on the create path; web `navigate` updates a tab's URL with
  no `active`.
- **Transient scrapes stay background.** `read_article` / `web_search`
  open a tab, read it, and close it immediately (via `openWebTab`);
  focusing a tab that's about to vanish would just flash the user.

The `backgroundTabsEnabled` toggle stays DELETED (#17: no shims) — focus
is policy, not a setting. The system prompt's `TAB_POLICY` text states
the rule for the model.

## 21. The `peerd.*` capability surface is organized by module

Decided 2026-06-14. Vision (owner): an artifact peerd builds — a JS
sandbox today, Apps later — can call back into peerd and *compose* it;
`runAgent` is the seed. So the in-realm `peerd.*` object (today
`globalThis.peerd` in `js-tab.js`) grows from a narrow fetch-bridge into
the programmable capability surface, **grouped by the five modules**:
`peerd.provider` / `peerd.egress` / `peerd.engine` / `peerd.runtime` /
`peerd.distributed`.

Why module-namespacing here (vs. the flat object it replaced): the module
boundary doubles as the **unit of authority**. The long-term model grants
an app whole modules (you get `peerd.egress` + `peerd.runtime`, not
`peerd.engine`), so the grouping is the future permission boundary, not
decoration — and it mirrors the internal DI graph (callModel, vault/
safeFetch, vmRun) the runtime already wires by module. Cross-module
composition is a first-class case (a dwapp asking `provider` for models,
`engine` for a parallel env, `runtime` to notify the parent loop).

`peerd.self` is the ONE non-module bucket: the realm's own plumbing — its
`id`, its module loader (`import`), its private OPFS scratch
(`readFile`/`writeFile`/`listFiles`). These don't "call peerd"; they're
local, so they're never granted or withheld. The rule: *anything that
crosses back into the peerd host goes through a module; realm-local
plumbing stays in `self`.*

Wired today: `egress.fetch`, `runtime.runAgent`, all of `self`. Everything
else is a **placeholder that throws** (the structure + per-method wiring
considerations live in the capability-map comment in `js-tab.js`). Hard
rule before wiring any placeholder for apps: a per-app **grant + quota**
must land WITH it — this object is reached from untrusted code (artifacts
peerd generated, and eventually Apps delivered over the dweb), so
`provider.call` (credits), `engine.spawn*` (resource exhaustion),
`runtime.notifyParent` (injects upward), and `distributed.*` (signs as the
user) are vulnerabilities without one. Expose a curated, versioned surface
per module — never reflect a module's internal `index.js` barrel. This is
a separate axis from the tool `primitive` tags (#nothing collapses those
to five — see the badge map in `message-list.js`).

## 22. Web Speech is the default voice engine; Moonshine is the opt-in upgrade

Decided 2026-06-14. The browser Web Speech API (SpeechRecognition) is the
DEFAULT transcription engine — instant, zero download, works on first
install. Moonshine (the ~250 MB local WASM model) is an OPT-IN PRIVACY
UPGRADE the user chooses in Settings, not the automatic pick even when it is
vendored and SRI-pinned.

Why: a developer evaluating peerd should get working voice immediately —
forcing a 250 MB download before the feature does anything is the wrong first
impression. But Web Speech typically streams audio to the browser vendor's
cloud (Chrome/Edge → cloud; Safari → on-device since ~2021), so the on-device
option must be one click away, with the privacy rationale and the download
cost shown BEFORE the download, not during.

Mechanics: a `voiceEngine` setting — `'auto'` (default) | `'web-speech'` |
`'moonshine'`. `'auto'` resolves to Web Speech when available, else Moonshine
(Firefox has no SpeechRecognition, so 'auto' is Moonshine there). The single
decision point is `resolveEngine(pref, webSpeech, moonshine)` in
`peerd-runtime/voice/engine-picker.js`; the manager passes the resolved engine
in the `voice/init` message so the offscreen doc builds exactly that engine —
no independent re-derivation, so no side-panel/offscreen split-brain. The
fragile Moonshine ORT/CSP loader is untouched — only the SELECTION changed.

This reverses an earlier drift where the picker auto-preferred Moonshine
whenever it was vendored (which forced the download on Chrome). The
`web-speech-transcriber.js` header already described this default-then-upgrade
posture; the picker had diverged from it.

## 23. Sandboxes are the umbrella; the JS kind is "Notebook"

Decided 2026-06-14. The browser tab IS the sandbox — so "Sandbox" is the
UMBRELLA noun for peerd's execution environments, and the kinds are
sub-types: **WebVM** (CheerpX Linux), **Notebook** (the JS Web Worker + OPFS
scratch), **App** (stored HTML in a sandboxed iframe). (Refined by #25: the
*isolate* is the sandbox and a tab is one way to host it, not the sandbox
itself; and a fourth kind — the headless worker `js_run`, the same Notebook
worker run offscreen with no tab — shipped 2026-06-15. Full taxonomy in
DESIGN.md §8.5.) The JS kind, formerly
"JS Sandbox" / "Sandbox", is renamed **Notebook** — "sandbox" was double-booked
(the JS kind AND the general isolation concept), and the run-code / see-output
/ persistent-scratch shape reads as a notebook.

What renamed: user-facing copy, the system prompt + docs, the tool `primitive`
value `'sandbox' → 'notebook'` (it shows in the lineage badge), the kind
discriminator `{webvm, notebook, app}`, the realm seal
(`notebook-neutralizers.js`, `NotebookEgressBlockedError`), the kind code
surfaces (`notebook-tab/`, `notebook-registry/client/tracker`, `notebookId`),
and — pre-release, no backward-compat — the persistence keys (`notebooks.v1`,
OPFS `peerd-notebooks`, IDB store `notebooks` via a DB v6 bump; the
`notebook-<n>` id prefix). Existing local JS instances are orphaned by design.

What did NOT rename: the `js_*` TOOL NAMES (`js_create`/`js_write_file`/…) and the
`tools/defs/js-*.js` files — that's the LANGUAGE (JavaScript), still true, and
the model has a prior on them; the `js` language glyph; the Chrome manifest
`"sandbox"` key (a fixed API); and the adjective "sandboxed" (a Notebook is
still a sandboxed Web Worker). The rule: the noun that named the JS KIND →
Notebook; "sandbox" as the umbrella or as isolation → stays.

**Exception (2026-06-15): `js_eval` → `js_notebook`** (tool name, export
`jsNotebookTool`, file `tools/defs/js-notebook.js`; the internal `js/eval` SW
message route stays). why: once the HEADLESS `js_run` tool shipped (DECISIONS
#25), the agent kept conflating "Web Worker" with "headless" and picking `js_eval`
for no-tab work. Naming the visible-Notebook tool `js_notebook` (vs `js_run`
headless) makes the choice legible. The other `js_*` names stay — `js_notebook`
is the deliberate odd-one-out because it's the tool the agent most needs to
distinguish from `js_run`.

## 24. The Notebook is fresh-run by design — reproducibility IS the point

Decided 2026-06-15. Every Notebook run spawns a FRESH sealed worker and
terminates; there is NO persistent ("warm"/kernel) state across runs. This is
intentional and load-bearing, not a limitation awaiting a fix: a run's output is
a pure function of the code + the files on disk, so a Notebook is **reproducible
by construction**. It sidesteps Jupyter's defining failure mode — hidden kernel
state and out-of-order execution ("it only works because I ran things in this
order").

We explicitly rejected a persistent/warm kernel AND a multi-cell UI (a multi-day
experiment, reverted 2026-06-15). Durable state that operations need across runs
goes in OPFS files (`peerd.self.writeFile`/`readFile`) — explicit and
inspectable, never a hidden module global. More execution contexts = more
Notebook tabs; structure = the file tree (split helpers into pure `.js` files).

**Do not** reintroduce a kernel, a warm session, accumulated globals, or cells.
If iterative-exploration ergonomics come up, the answer is OPFS (persist the
expensive result to a file), not in-memory state. Rich output (tables/JSON now;
sandboxed HTML/charts later) is added WITHOUT a kernel — it renders from the
returned value, which preserves reproducibility. The output pane is the
privileged extension origin, so it renders data we build ourselves (textContent
tables/JSON), never agent-authored markup; arbitrary HTML/SVG is the App's
sandboxed-iframe job. See `js_create`'s NOTEBOOK_NOTE.

## 25. A sandbox is a sealed isolate; the tab is its (visible) host

Decided 2026-06-15. A "sandbox" (WebVM / Notebook / App) is fundamentally a
**sealed execution context** — a V8 isolate (Notebook + App) or a WASM machine
in one (WebVM) — NOT a tab. Today each is *hosted* in its own visible browser
tab, and that's deliberate: visibility is peerd's trust posture (you see every
thing the agent runs), and the browser's tab process is itself a decades-hardened
OS sandbox we get for free. **The tab is the host and the observability surface;
the isolate is the unit of work.** Say "hosted in a tab," not "is a tab."

**The cost/observability axis.** A tab is a whole renderer process (tens of MB);
a Web Worker is a thread (cheap). Spinning up dozens of tabs for parallel agent
compute is wasteful — but a *background* tab (`active:false`) is still a full
renderer, so hiding a tab buys intrusion relief, not cost. The cheap path for
many parallel JS/WASM jobs is Web Workers hosted in the **offscreen document**
(one hidden renderer that persists and spawns threads — peerd already runs one
for voice; the web tools already use `chrome.offscreen` for headless parsing).
The MV3 service worker is the WRONG host: it's killed on idle (~30s), so it can't
babysit long work.

**v1 decision: keep visible tabs as the default; do NOT build a headless
substrate.** Visibility is the value; early users are unlikely to push tab counts
hard; and the first thing that bites at scale isn't memory but FOCUS (an opened
tab takes focus, #20) + tab-strip churn. The agent already parallelizes via
subagents (which reason, not open tabs); tabs proliferate only if the agent
spins many *compute* sandboxes, which v1 rarely does.

**The future option is pre-positioned.** The Notebook's compute is already a
sealed Worker fully decoupled from its tab (the realm seal, OPFS, the resolver,
`peerd:std` are all worker-side; the tab only mounts UI). So a "headless sandbox"
later = host that same worker in the offscreen document and skip the UI — a
contained addition, not a rewrite. The `peerd.engine.spawn*` placeholders reserve
the slot. When the need is real, reason on **observability vs cost**: a visible
tab when the user should *watch* it (browsing, an app they'll use); a headless
worker when it's the agent's own internal compute that yields a *result*. The
clean middle is **promote-on-demand** — start headless, mount a visible tab onto
the running worker when asked — plus keeping headless runs in the audit/lineage
trail so they stay inspectable. Arbitrary WASM "to do anything" rides the same
sealed-worker + egress model (the supply-chain story matters *more*, not less).

**Refinement (2026-06-15, after a hard audit).** Be precise: a Notebook's worker
is a **same-process thread / V8 realm** sharing the extension origin — NOT its
own process, and NOT a hardened isolate. Its only fences are **language-level**
(the realm seal + `connect-src 'none'` CSP); peerd has **no gVisor / MPK /
second-layer sandbox — and doesn't need them, because it is SINGLE-TENANT.**
Cloudflare hardens the isolate because it multi-tenants distrusting code on shared
machines (escape = cross-tenant compromise); peerd runs in one user's own browser,
so there is no tenant B and that threat class doesn't exist. peerd also inherits
the browser's own "run untrusted code safely" model (Site Isolation + sandbox +
V8 hardening — Google's job) and only adds the two things the browser doesn't give
free: egress auditing for prompt-influenced own-code (the seal) and denying
untrusted code the extension's privileges (the iframe). (For the record,
Cloudflare's post describes a *custom* second-layer sandbox + MPK + Spectre
research, **not** gVisor, and does **not** rely on Chrome-style per-process
isolation.) That language fence is the
right boundary for **the agent's own semi-trusted code** (threat = exfiltration,
contained by the audited egress) — but it is **not** a boundary for untrusted
code. Hence the **two-substrate rule**: own-code compute → a (headless) Worker;
**untrusted code → an opaque-origin iframe** (an "App without UI"), which has a
real origin/process boundary and no `chrome.*`. Don't conflate the cheap-compute
unit with the security boundary the way a single-sandbox platform can — peerd's
*strength is the spectrum* (Worker / opaque-origin iframe / WASM VM / visible
tab), each a different point on isolation × cost × visibility. The full taxonomy,
the per-kind security posture, and the **code-mode** direction (the egress bridge
is now full HTTP — `peerd.egress.fetch(url, { method, headers, body })` at parity
with `call_api`; read/compute → code, write/spend/sign → discrete gated tools)
live in `DESIGN.md` §8.5. **`runJob` shipped** (2026-06-15) as the `js_run` tool —
a headless sealed Worker hosted in the offscreen doc, sharing the Notebook's
worker source (`notebook-tab/worker-source.js`); ephemeral, non-default, for the
agent's OWN code (seal-only defense-in-depth there — no `connect-src 'none'`
backstop, since the offscreen doc needs network for voice). `runUntrusted` (the
opaque-origin iframe for untrusted code) stays deferred — no consumer yet.

## 26. The side panel is pulled in via the toolbar icon + a keyboard command — NOT an injected web-page button

Decided 2026-06-20. PR #56 shipped the engine-tab "pull in peerd" button
(`shared/pull-in-peerd.js`). The follow-up question — extend it to the regular
web pages peerd opens via `open_tab` — was investigated
(`docs/PULL-IN-PEERD-WEB-SCOPE.md`) and **declined as designed**. Two facts
killed the injected in-page button: (a) it works only on Chrome — Firefox does
not treat a background message handler as a user-action context, so the
content-script → SW → `sidebarAction.open()` relay is rejected there; and (b) it
would add the first-ever content-script-reachable SW route, a deliberate hole in
the fail-closed `messaging.js`/`sender-trust.js` boundary.

**What shipped instead** (this commit): the toolbar icon is **situational** —
peerd's front door. With no home open it opens the full-page home (the
first-party first impression, #-/DESIGN-12, owner direction: peerd should not
feel like a bolted-on sidebar). Once home IS up, the icon **complements** by
pulling the chat into the window-global side panel (Chrome) / sidebar (Firefox),
so it follows you onto any tab — including a plain web page peerd opened, the gap
the injected button was meant to fill. A dedicated **`Alt+Shift+P`** command
(`commands` manifest key, user-rebindable) **toggles** the panel — pulls it in,
or closes it if already open (the icon never closes; it's the front door, not a
switch). Both run in a **valid first-party user-gesture context on both
browsers**, so neither needs a content-script relay and the SW boundary stays
fail-closed and unbreached. Closing needs no gesture (Chrome:
`setOptions({enabled:false})` + re-arm; Firefox: `sidebarAction.close()`), so the
toggle decides open-vs-close synchronously — `uiPorts.hasNamed('sidepanel')` —
and only the open branch must stay in the gesture.

**The load-bearing constraint** (`background/panel-affordance.js` +
service-worker §7): `sidePanel.open()`/`sidebarAction.open()` drop their
activation if anything is awaited first, so the decision is a **pure synchronous
function** over inputs available without awaiting — the window id (from the
listener's `tab` arg, backstopped by a `windows.onFocusChanged`-tracked
`lastFocusedWindowId`) and "is home open?" from two sync signals (a
boot-bootstrapped `homeTabIds` set + a live `home` UI port). A detection miss is
benign: `openHome()` is focus-or-create, so the worst case is the first
post-SW-respawn click focusing home instead of opening the panel. Discoverability
rides a one-line shortcut hint on the prominent agent-tab card
(`chat-view.js`, fetched live via `commands.getAll()` so a rebind is reflected
and an unbound shortcut shows nothing).
