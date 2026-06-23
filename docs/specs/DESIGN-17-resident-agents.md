# DESIGN-17 — resident tab agents: the tab IS the agent (loop in the host page, key in the SW)

> Status: DESIGN. Nothing here is implemented. Feature number 17.
> Major refactor — built on the `experimental/resident-tab-agents` branch.
> Read first, in order: `docs/SUBAGENTS.md` (this OVERTURNS its §"The two
> surfaces" claim that "the agent loop runs [in the SW], same heap as any
> subagent" and its §"Isolation is a SESSION boundary, not a RESOURCE
> boundary"); `docs/specs/DESIGN-11-async-subagents.md` (the wake/mailbox
> substrate reused for `tell_instance`); `DESIGN.md` §8.5 + `docs/DECISIONS.md`
> #25 (the sandbox taxonomy — which instances are in scope) and #24 (Notebook
> durable-state-to-OPFS, the model the App loop must follow); the existing
> tab→SW proxy (`vm-tab.js swFetch` → `routes/engine.js` `sw/web-fetch`;
> `notebook-tab.js`'s `subagent/spawn` relay) is the precedent the model-call
> proxy generalizes.
>
> The one-line thesis: **a tab-hosted engine instance runs its own agent loop,
> in its own host page, and the only agent that may drive that instance IS that
> loop — structurally, because the loop lives where the instance lives.** No
> ownership pointer to track (the binding is the tab-tracker entry); the
> provider key never enters the tab (the loop proxies model calls + egress to
> the SW); the parent reaches a tab only by message. This is the do/get/check
> browser-runner trust model, generalized from one disposable browser tab to
> every stateful tab — and made persistent.

## Motivation

The owner's three observations (DESIGN-17 conversation), now the three goals:

1. *"Tabs as global objects any session can mutate bothers my functional
   sensibilities."* → **Functional purity of instance access.**
2. *"Context bloat from all these tool calls and instructions."* → **A lean
   parent context that doesn't re-bloat as instances accumulate.**
3. *"We already split a narrow browser runner for isolation — generalize it …
   code could pull things (git repos, API endpoints, dweb-delivered code) that
   may not be trusted."* → **Isolation: a per-tab, secret-less, egress-proxied
   agent, extending the runner's untrusted-input trust model to every tab.**

### Why not the ownership gate (the rejected v1 of this spec)

The first draft of DESIGN-17 proposed an `ownerSessionId` mutation gate: stamp
an owner on each instance record, refuse cross-session mutation. The owner
rejected it, correctly: **that is imperative ownership-bookkeeping** — a mutable
field you stamp, read, and reconcile, with a tail of failure modes
(transfer-on-settle, brick-the-instance-on-subagent-exit, stale pointers) that
exist *only because the agent and the instance are two things joined by a
pointer that can go stale.* Make the binding **structural** — the agent lives
*in* the tab, 1:1, born and dying with it — and that entire category of bug
stops being expressible. There is no pointer to dangle. This is the better
architecture, and the grounding confirmed the binding substrate already exists
(`tab-tracker.js`, below).

This spec is therefore **Model B**: the loop runs in the tab's host page. It was
chosen over the ownership gate (above) and over **Model A** (loop stays on the
SW heap, merely bound 1:1 to the tab lifecycle). Model A is a serious, cheaper
alternative; it is given a fair hearing in "Why the loop lives in the tab," and
the open question of whether B's extra cost is worth it is flagged for the
adversarial review.

## Scope: the three tab-hosted kinds. js_run is out.

Per `DESIGN.md` §8.5, the candidates are the **three tab-hosted, persistent**
kinds — **WebVM, Notebook, App**. The **headless `js_run` worker** has no tab,
is ephemeral-per-job, and is the agent's *own throwaway compute* (`primitive:
'notebook'` but no instance, no lifecycle). It **stays on the parent**, a
stateless tool, unchanged. Anything in this spec about "the tab loop" excludes
`js_run`.

## The core decision

Three moves, each landing on existing code:

1. **The binding is structural — the tab-tracker entry.** `tab-tracker.js`
   already maps `byId: Map<instanceId, {tabId, ready, …}>`, born on
   `onTabReady(id, sender.tab.id)` (wired at `service-worker.js` ~2007) and
   evicted on `tabs.onRemoved → onTabRemoved(tabId)` (~2031). *That map is the
   resident binding.* The agent's lifecycle hangs off those exact events — no
   `ownerSessionId`, no resident registry, no orphan reconciliation. "Born on
   tab create, dies on tab close" is already the tracker's contract.

2. **The loop runs in the tab's HOST PAGE** (`vm-tab.js` / `notebook-tab.js` /
   `app-tab.js` — all `chrome-extension://` origin module scripts). It does
   **not** run in the SW, and it does **not** run in the untrusted isolate (the
   CheerpX guest, the sealed Notebook worker, or the App's opaque-origin
   iframe). The isolate is keyless by design; the host page drives it (it
   already does — `vm-tab.js runViaShell`, `app-tab.js` posting `app-body` into
   the iframe). Optionally the loop runs in a **dedicated Worker the host page
   owns** (off the UI thread; see "The worker option").

3. **The SW is demoted to an on-demand key/egress service.** The loop never
   holds the provider key (vault DK). It proxies the model call + all egress +
   audit + confirm to the SW, which is the *only* holder of `vault.getSecret`
   and `safeFetch`. The SW is woken by the tab's message (MV3 restarts it on
   demand); it does not need to be alive between calls.

A resident agent is still the **r** letter — an agent loop — bound to an **e**
instance. It is **not** a new engine kind and not a `subagent-tab/` page. The
§8.5 taxonomy is untouched; this is a *host-lifecycle* feature.

## What already exists (the owner was half-right)

The owner said "we already have `peerd.runAgent` / `spawn_subagent` for exactly
this." Half true, and the half that's true is load-bearing:

- **The request bridge ships.** `peerd.runtime.runAgent` (in the Notebook
  worker, `worker-source.js:150`) posts `{type:'subagent-request', rid, args}`
  to its host page; the host page (`notebook-tab.js:206-234`) relays
  `browser.runtime.sendMessage({type:'subagent/spawn', …})` to the SW route
  (`routes/sessions.js:261`), which runs the loop and posts the result back.
  `offscreen/job-runner.js:112` does the identical relay. **But today the loop
  runs in the SW** — the host page is a *pure relay*. `docs/SUBAGENTS.md` states
  it flatly: "the agent loop runs there, same heap as any subagent." **Model B
  inverts exactly this sentence.** The plumbing (request relay, key-in-SW,
  result-back) is reusable; the loop-in-the-tab is net-new.
- **The egress proxy ships, verbatim reusable.** `vm-tab.js swFetch` →
  `routes/engine.js` `sw/web-fetch` → `webFetch`/`vmHttpFetch` (denylist + SSRF
  + audit). A tab loop proxying `webFetch` is a *solved problem* — copy it.
- **The loop is fully DI'd.** `agent-loop.js runUserTurn`'s `REQUIRED_CTX =
  ['callModel','getSecret','safeFetch','sessions','getSystemPrompt',
  'appendAudit']` — every IO surface injected, nothing imported. And `callModel`
  (`registry.js:172`) is a *pure router* that takes `getSecret`+`safeFetch` as
  call args (the adapter reads the key only inside `callAnthropic`,
  `anthropic.js:114`). **So the loop body needs zero changes** — the tab injects
  SW-proxied `callModel`/`getSecret`; the DK never has to leave the SW.
- **The keyless-loop posture is codebase-native.** `restrictCtxCapabilities` +
  `CAPABILITY_CONSUMERS` (`spawn.js:102`) already strip `getSecret`/`safeFetch`
  (empty consumer lists → always removed) from a narrowed child's tool context —
  the do/get/check runner already reasons over untrusted pages with no key/egress
  closure in scope. Model B generalizes that from "the child's tool ctx" to "the
  whole loop, including the model call."

## Why the loop lives in the TAB, not the SW (Model A) — honest

Model A (loop on the SW heap, bound 1:1 to the tab-tracker entry) delivers goals
**#1 and #2 for free** and most of #3, at a fraction of the cost: it needs no
streaming proxy, no cross-boundary abort, no vault-lock deferral re-plumbing —
the loop keeps direct `callModel`. The structural binding (move #1) and the
parent tool-shed (goal #2) are *independent of where the loop runs.* So why pay
for B?

B earns its cost on the parts of goal #3 that A cannot reach:

- **True realm isolation, not stripped closures on a shared heap.** A's
  capability stripping is real but the loop still executes on the SW heap
  alongside every other session's data and the live instance graph; safety rests
  on `restrictCtxCapabilities` being complete. B's loop is in a *different
  renderer*, with no SW heap in scope at all — for the **untrusted-input future
  the owner named** (a VM cloning an attacker's git repo, an App running
  dweb-delivered code), that's the difference between "stripped closures" and "a
  process boundary." This is the strongest argument and the reason B exists.
- **No shared SW heap; true parallelism.** A puts N residents on the *one*
  single-threaded SW heap — N concurrent resident turns serialize, and "N agents
  mutating one heap" is the very shared-mutable-state smell goal #1 is escaping.
  B gives each resident its own realm/process: real parallelism, real isolation.
- **Instance-op locality.** B's loop calls `runViaShell` *in-process* (the VM is
  in the same tab) — no SW round-trip per shell command, where A drives each
  `vm/run` over a message. B trades that for a round-trip per *model* call; for an
  instance-heavy resident (the common case) it's a net win.
- **Resumability for free.** B's loop state lives in the durable tab, so an SW
  restart pauses-and-resumes rather than losing the turn. (A can get this too via
  explicit persist/resume — `goal-runner.js` already does — so it's a modest
  edge, not decisive.)

**Rejected — the offscreen document as the loop home.** It's the *most* durable
context (no 30 s death) and has network, but it is a *single shared context*:
N residents there means a `map<instanceId → agent>` you maintain and check — the
exact ownership-bookkeeping move #1 rejects. The offscreen doc fails goal #1.
Only a *per-tab* home makes the binding structural.

## The key/egress proxy — what crosses, what stays local

The loop's only key/egress-bearing dependencies are **`callModel`** (the sole
vault-toucher) and **`safeFetch`/`webFetch`** (egress). The split:

| Proxy to the SW (never in the tab) | Local to the tab loop |
|---|---|
| **`callModel`** — SW injects `getSecret`+`safeFetch`, runs the adapter, streams events back. The DK never leaves the SW. | The loop body (`runUserTurn` reducer), `getSystemPrompt` (string assembly — the resident's specialized prompt) |
| **`webFetch`/`safeFetch`** — reuse `sw/web-fetch` verbatim (denylist + SSRF + audit) | **Instance ops** — `runViaShell` (VM), `runEval` (Notebook), OPFS-write+reload (App). The instance is co-located; no hop. |
| **`appendAudit`** — fire-and-forget, one-shot | The tool-dispatch *policy* for instance-only ops (Plan/Act) — the host page is trusted extension code |
| **`confirm`** — request/response, one-shot | session reducer state in memory (persisted via proxied/coordinated writes — see Lifecycle) |

`getSecret` is **never** in the tab loop's context — it isn't needed there (it's
only a `callModel` dep, and `callModel` is now proxied).

## The hard part (where the engineering actually is)

Be honest: the key-proxy is the *easy*, precedented half. The real new build is
three things, none of which exist today:

1. **A STREAMING `callModel` SW proxy.** `callModel` returns
   `AsyncGenerator<ProviderEvent>` (`text-delta`, `tool-use-*`, `reasoning-*`,
   `usage`, `message-stop`, `rate-limit-pause`). The existing `sw/web-fetch`
   route returns a *single buffered base64 body* — **it is not a streaming
   template.** Model B needs a long-lived `chrome.runtime.connect` **Port** that
   chunks provider events from the SW back to the tab loop. This is the
   principal new surface and the riskiest part of the spike.
2. **A cross-boundary `AbortSignal`.** The loop's Stop / spend-limit / steer
   contract depends on `ctx.signal` reaching the provider `fetch` to cut the SSE
   socket. A tab-host loop's local `AbortController` cannot reach the SW's fetch
   — Model B needs an explicit abort message (tab→SW) that aborts the SW-side
   provider stream. Without it, Stop cannot cut a live model stream.
3. **Vault-lock deferral in the tab loop.** The DK is gone at 45-min idle
   (`vault.js` `DEFAULT_AUTO_LOCK_MS`); `getSecret` throws `VaultLockedError`. A
   tab outlives the 30 s SW death but **not** the vault lock. The loop must adopt
   async-subagents' pattern (`async-subagents.js`: hold, subscribe to vault
   `'unlocked'`, resume) rather than throw mid-turn.

Plus an accepted cost, not a build: **the full prompt** (messages + system +
tool descriptors) crosses the tab↔SW boundary on *every* model step. For
untrusted-input tabs this is exactly the desired chokepoint; it is also a real
per-step serialization cost (`messages` can be large — attachments, snapshots).

## The spike — per kind, grounded

The loop is the same DI'd `runUserTurn` in all three; only the host page wiring
and the instance-op surface differ. **Notebook is the binding case** — write the
spike against it first (reasons below).

### Notebook (the binding case) — `notebook-tab.js`
`notebook-tab/index.html:22` sets page-level **`connect-src 'none'`**. So a loop
in the Notebook host page **physically cannot fetch the model API** — the
SW-key-proxy is not a trust preference here, it is a hard CSP requirement. If the
streaming model proxy works under `connect-src 'none'`, it works everywhere.
The loop lives in the *page* (the sealed worker is realm-sealed —
`notebook-neutralizers.js` deletes `fetch`/`WebSocket`/… — and cannot host it).
Insertion: the kickoff IIFE after `js/tab-ready` (~`notebook-tab.js:503`); the
loop drives code via the existing `runEval` and reuses the existing
`subagent/spawn`/`sw/web-fetch` relays for the proxied calls.

### WebVM — `vm-tab.js` (the spike sketch)
The host page already drives a WASM-confined CheerpX guest and proxies the
guest's egress (`swFetch` → `sw/web-fetch`). The loop inserts right after
`boot()` step 11 (`browser.runtime.sendMessage({type:'vm/tab-ready', vmId})`,
~`vm-tab.js:1402`), *replacing* the SW driving discrete `vm/run` calls with the
page running the loop and calling `runViaShell` in-process. Sketch:

```js
// vm-tab.js — after boot() reaches 'ready', stand up the resident loop.
// The provider key is NEVER in this page: callModel + egress proxy to the SW.
const sw = (type, payload) => browser.runtime.sendMessage({ type, ...payload });

// (1) The streaming model proxy — a Port, because callModel yields events.
const proxiedCallModel = (args) => {
  const port = browser.runtime.connect({ name: 'callModel' });   // NEW SW route
  return (async function* () {
    port.postMessage({ kind: 'start', args: stripIO(args) });    // no getSecret/safeFetch cross
    for await (const ev of portEvents(port)) {                   // text-delta / tool-use / usage / stop
      if (ev.kind === 'error') throw reviveError(ev.error);
      if (ev.kind === 'end') return;
      yield ev.event;
    }
  })();
  // abort: the loop's signal → port.postMessage({kind:'abort'}) → SW aborts the provider fetch
};

// (2) Instance ops run LOCALLY — no SW hop. The dispatcher for vm_* tools
//     calls runViaShell directly; only egress-bearing tools (vm_import) proxy.
const residentDispatch = makeResidentDispatch({
  webvm: { run: runViaShell, writeFile, import: (url) => sw('sw/web-fetch', { url }) },
  webFetch: (req) => sw('sw/web-fetch', req),
  appendAudit: (e) => sw('audit/append', e),       // proxied (NEW thin route)
  confirm: (q) => sw('confirm/ask', q),            // proxied (reuses confirmAction)
});

// (3) The loop body is unchanged runUserTurn — only its IO is the proxy.
const resident = makeResidentLoop({
  sessionId: residentSessionIdFor(vmId),           // its own persisted session
  systemPrompt: VM_RESIDENT_PROMPT,                // expanded, env-specialized, byte-stable
  callModel: proxiedCallModel,
  toolDispatch: residentDispatch,
  // getSecret / safeFetch are absent by construction — the key cannot be here.
});

// (4) Inbound wake — tell_instance lands as a targeted message; the local
//     turn-slot serializes it so it never interrupts in-flight work.
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'vm/tell' && msg.vmId === vmId) resident.enqueue(msg.message);
});
```

### App — `app-tab.js`
The loop lives in the host page (extension origin). The App's `runner.html`
iframe is opaque-origin and **chrome-stripped** ("MV3 strips ALL `chrome.*` APIs
from sandboxed pages") — keyless, no `runtime.sendMessage` — so the loop cannot
live there; the host mutates the app by `postMessage('app-body')` + OPFS write +
`chrome.tabs.reload`, which is the *existing* mechanism. **App-specific
constraint:** the agent-edit update path is `app-client.reloadTab` (a *full page
reload*), which nukes an in-memory loop. The App resident must persist its loop
state to OPFS and rehydrate on reload — exactly the Notebook DECISIONS #24
"durable state → OPFS, never a module global" model. Insertion: after
`app/tab-ready` (`app-tab.js:394`).

## The message channel — `tell_instance`

The parent (or any session, or the user) has **no direct path** into a tab —
message-only. That's the actor boundary, and it's structural: the parent doesn't
*have* the instance tools (goal #2), so its only verb is "tell."

- **Tool:** `tell_instance({ to, message, sync? })`. `to` is the instance id.
- **Delivery:** the SW resolves `tracker.getTabId(to)` and does a *targeted*
  `browser.tabs.sendMessage(tabId, {type:'<kind>/tell', id, message})` — targeted
  sends already work in every client. The tab's existing raw `onMessage` switch
  gets one new case (the sanctioned exception path; tabs don't use the
  dispatcher).
- **Mailbox:** the tab loop has its own local turn-slot; an inbound `tell`
  `enqueue`s and runs when idle, mirroring `turnSlots.runWhenIdle` so it **never
  interrupts in-flight work** (DECISIONS #20). N senders serialize behind one
  slot — the single-consumer actor mailbox, now *per tab* instead of per SW
  session.
- **Reply:** re-enters the *sender* as a `synthetic:true` wake turn (the
  DESIGN-11 path), `wrapUntrusted`-fenced. **Mandatory for App residents** (an App
  renders attacker content; its agent's report is model-authored over hostile
  bytes). Only the "resident `<id>` replied" framing is trusted.
- **`sync:true`:** a fresh read-only query, never a blocking wait on the
  resident's slot (deadlock / focus-theft). Same resolution as the runner. Or
  drop `sync` (open question).

## Context shedding (goal #2)

The parent sheds **all** vm/notebook/app instance tools — the hard structural
division, so the savings don't erode as instances accumulate (unlike
`INSTANCE_GATED_TOOLS`' progressive disclosure, which re-bloats once a chat has
one of each kind). The parent keeps a tiny stub: **create-a-tab**, **`tell_instance`**,
**list**. The heavy engine prose (the §Sandboxes + WebVM blocks in
`system-prompt.txt`, ~8.7 KB) moves into each resident's byte-stable
`*_RESIDENT_PROMPT`, where the per-env toolset can expand *aggressively* (verbose,
specialized) because it never touches the parent window. `js_run` stays on the
parent. Honest accounting: net positive for the parent, but a persistent resident
prompt re-incurs the specialized prose per resident — recompute if residents are
always-warm vs lazy.

## Lifecycle

- **Binding: structural** (the tab-tracker entry). No ownership map.
- **Execution: lazy.** The loop is the tab's, persistently (one resident session
  per tab, `kind:'resident'`), but it only *runs* when it has a message —
  idle/no-tokens between. Structural identity ≠ always-running loop.
- **Persistence:** the resident session persists in IDB; the instance persists
  via registries + OPFS + per-VM disks; on SW boot `registry.load()` +
  `tabTracker.bootstrap()` re-adopt live tabs (the tab loop re-announces on its
  next SW call — the SW remembers only `{id, tabId, ready}`). App residents
  rehydrate loop state from OPFS on `reloadTab`.
- **Death:** `tabs.onRemoved` → the resident sleeps (instance + session survive)
  or, on explicit `vm_delete`/`app_delete`, archives. Generalize
  `onTabClosed → queue.interrupt` (VM-only today, `service-worker.js:2031`) to all
  three kinds so a closing tab cancels the resident's in-flight SW proxy calls.
- **Orphans dissolve.** No pointer means no stale pointer: instance-without-tab is
  the normal dormant state; tab-closed-instance-alive reconstitutes via
  `ensureTab` on the next message; there is no "session owns a dead instance"
  case because the binding is the tab, not a field.

## Durability (corrected — a minor bounded benefit, not a primary reason)

The earlier "the SW dies every 30 s, so the tab is necessary" framing was
overstated. Corrected, from the code:

- **Tab outlives the SW: confirmed.** `service-worker.js:2737`: "Chrome kills
  the SW after 30 s idle but leaves tabs alone."
- **The keepalive already exists** (the owner's "messy tick that works"):
  `offscreen.js` holds a `sw-keepalive` Port + 20 s heartbeat. So the SW is held
  alive *during work* today.
- **The benefit is bounded.** The tab preserves the loop's *state* (resumable),
  but *forward progress* needs an alive **and unlocked** SW — the **vault lock**
  (45 min) is the real wall, and it binds regardless of where the loop runs (defer
  like async-subagents). Tabs are also discardable under memory pressure
  (`offscreen.js:49` notes the same for the offscreen doc). And Model A can
  resume via persistence too. So durability is a *modest* edge for B — real, but
  **not** why B is chosen (realm isolation + no-shared-heap + parallelism are).

## The worker option

The loop can run on the host page's main thread, or in a **dedicated Worker the
host page spawns**. The worker variant: dies with the tab (still structurally
bound), runs off the UI thread (doesn't compete with VM/app rendering), and —
because `chrome.*` isn't exposed in a dedicated worker — *physically cannot* reach
the vault, forcing the no-key discipline by construction (it proxies through the
host page → SW). Cost: an extra postMessage hop (worker → host → SW). Recommend
the worker variant for WebVM/App (heavy rendering) and bench it against
main-thread for Notebook. This is the literal reading of the owner's "its own
worker."

## Security / invariants

- **The DK never enters the tab.** `callModel` is proxied; `getSecret` is SW-only;
  the loop's ctx has no key/egress closure (the `restrictCtxCapabilities` posture,
  now structural).
- **`confirm` + `appendAudit` MUST stay SW-proxied.** If a keyless tab could
  self-approve egress or skip audit, the isolation thesis collapses — an
  untrusted-input tab could authorize its own exfil. Cheap (one-shot), so this is
  fine.
- **`webFetch` (open-web, allowlist-free) is the real exfil surface**, distinct
  from `safeFetch` (provider-credentialed). Both proxy to the SW; for an
  untrusted-input tab, deny open-web tools entirely (the runner already does —
  generalize it).
- **The isolate never hosts the loop** (CheerpX guest / sealed worker / opaque
  iframe are keyless by design; that's the point).
- **Capability re-admission:** a resident holding `vm_import`/`app_create`
  re-admits `webFetch`/`dweb` closures — but those are now *proxied to the SW*,
  which gates them; the closure in the tab is a relay, not the capability.
- **Cross-boundary abort** is a security control, not just UX: Stop / spend-limit
  must cut a live model stream.
- **Unchanged:** depth cap, trust-mode inheritance, the egress chokepoint as the
  one network boundary, per-action audit.

## Specifically NOT to do

- Run the loop in the isolate (guest/worker/iframe) — keyless by design; it's the
  untrusted thing.
- Run the loop in the offscreen doc — shared multiplexed context; reintroduces the
  ownership map (fails goal #1).
- Resurrect the `ownerSessionId` pointer — the binding is the tab-tracker entry.
- Rely on CSP to keep the vm/app tabs keyless — only the Notebook page has
  `connect-src 'none'`; for VM/App the key must be withheld **by construction**
  (never injected), not by CSP.
- Keep `vm/run` as the loop's driver — it becomes an in-process `runViaShell`
  call; the SW brokers only the model call + egress.
- Let App `reloadTab` nuke loop state — persist to OPFS + rehydrate (DECISIONS #24).
- Reuse `sw/web-fetch` for the model call — it's one-shot/buffered; the model call
  must stream over a Port.

## Open questions

- **Is B worth its cost over Model A?** The streaming proxy + abort + vault-defer +
  per-step serialization are B-only. A delivers goals #1/#2 and most of #3 far
  cheaper. B's case is realm isolation for the untrusted-input future + no shared
  SW heap + parallelism. *This is the question for the adversarial review.*
- **Streaming transport:** a `chrome.runtime.connect` Port (recommended) vs chunked
  `sendMessage`s vs `ReadableStream` transfer. The Port is the only one that cleanly
  preserves backpressure + abort.
- **Which kinds get residents by default?** The savings/isolation case is strongest
  for WebVM; Apps/Notebooks may not be worth the per-step proxy cost — per-kind,
  not all-or-nothing.
- **App OPFS-rehydrate model** — how much loop state survives a `reloadTab`, and
  does an agent-edit-mid-turn corrupt it?
- **One inbound clamp.** A resident woken by `tell_instance` is an inbound/unattended
  turn — the same shape `FEATURE-SCHEDULED-TASKS.md` and
  `FEATURE-FIRST-CLASS-MESSAGING.md` each contend with. There should be **one**
  `ctx.inbound` clamp across all three; defer to whichever lands it.
- **Per-step serialization ceiling** — at what prompt size does crossing the tab↔SW
  boundary every step become the bottleneck?
- **The user talking to a resident** in the side panel — `kind:'resident'` is a
  first-class session; does it appear in `/chats`, or only via the tab?

## Phasing

1. **P0 — the streaming `callModel` SW proxy + ONE tab-host loop (Notebook).**
   Notebook is the binding case (`connect-src 'none'` forces the proxy). Prove the
   Port-streamed model call + cross-boundary abort + vault-lock deferral end to
   end, behind a feature flag. *This is the riskiest, most load-bearing slice —
   nothing else matters if the streaming proxy doesn't hold.*
2. **P1 — WebVM + App loops, `tell_instance`, parent tool-shed.** Generalize the
   loop to the other two host pages (App with OPFS-rehydrate); ship the message
   channel; move vm/notebook/app tools off the parent.
3. **P2 — persistence + the conversational surface.** `kind:'resident'`,
   side-panel "talk to this instance," the worker variant.
4. **P3 — durable resume across vault unlock / browser restart** (DESIGN-08
   continuation). Maybe never; the in-session resident is already useful.

## Why not Model A / the gate (the honest counter-case)

The cheapest thing that delivers goals #1 and #2 is **Model A + a parent
tool-shed**: bind the loop 1:1 to the tab-tracker entry but keep it on the SW
heap, and move the engine tools off the parent. No streaming proxy, no abort
plumbing, no vault re-plumbing. It gets structural binding, the lean parent, and
— via `restrictCtxCapabilities` — a keyless tool context. For most of what the
owner wants, A is enough, and a reviewer should push hard on whether B's delta is
worth the streaming-proxy build.

B earns the difference only on the third goal taken seriously: when the instances
will host genuinely untrusted inputs (untrusted git repos, API responses,
dweb-delivered code — the future the owner named), the difference between
"stripped closures on the shared SW heap" and "the loop in its own renderer with
no key in scope" is the difference between a convention and a boundary. And N
residents on N renderers instead of N on one single-threaded SW heap is the
honest expression of "tabs shouldn't be global mutable objects." If that future
is real, build B. If it isn't yet, A is the lazier truth — and this spec should
lose to it.

**The tab is the agent. Make the binding structural, keep the key in the SW, and
prove the streaming proxy before anything else.**
