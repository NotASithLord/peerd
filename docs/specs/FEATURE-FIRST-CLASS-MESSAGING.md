# FEATURE — First-Class Messaging

> **Status:** SPEC, build-ready (2026-06-22). Expose the **already-shipped**
> room/direct messaging layer — today reachable only by a human, only inside a
> dwapp sandbox — to two new callers: the **agent loop** and a **native
> Contacts-rooted chat UI**. Detail-spec for the `## A2A` section of
> `docs/distributed/ROADMAP.md` ("expose messaging & dwapps to the agent — the
> missing last mile"); it carries that section's three scope bullets forward into
> concrete, file-anchored work. Sits beside `FEATURE-SCHEDULED-TASKS.md`: that
> spec's fail-closed unattended posture (`ctx.unattended`) is itself **proposed,
> not yet built** (`FEATURE-SCHEDULED-TASKS.md §7.1` — zero `ctx.unattended` hits
> in code today), so this spec does not "reuse" a shipped flag. It defines the
> *sibling* origin `ctx.inbound` (a turn fired by a remote sender with nobody
> watching) and **reconciles the two** explicitly in §7.1 — they must clamp the
> same gates, and inbound is the strictly more hostile of the two. Honors
> `THREAT-MODEL.md`'s Tier 0/1/2 topology (§7.0), `NORTH-STAR.md` D-5 (no TURN)
> and D-9 (the room is the consent boundary); the offline tension is named
> honestly in §10.
>
> **Module placement.** No new top-level module. The transport is
> `peerd-distributed/` (sealed dweb boundary, pruned on the store build). The new
> surfaces are: agent tools in `peerd-runtime/tools/defs/`, a native chat store +
> reducer in `peerd-runtime/conversations/` and `sidepanel/`/`home/`, and SW
> routes in `background/routes/`. Everything inert on the store build (the dweb
> boundary already gates all of it).

---

## 0. Summary — one foundation, three callers

The dweb's messaging layer is **built and shipping**. The offscreen base host
already implements join / leave / publish / subscribe / retain / history /
presence / **dm** as room ops (`offscreen/dweb-base.js:216-268`,
`handleRoomOp`), routed from the SW by `background/routes/dweb.js:306` (the
`dweb/base/room` route → `dweb/base-host/room`). Direct 1:1 is real and private
*at the routing layer*: `messaging/direct.js` signs on `ch=3`, a channel
`transport/mesh.js:244` refuses to relay (it enforces `msg.from === link.did`
for every channel except the `ch=4` gossip flood), so a direct frame is
**structurally un-relayable** — no third peer ever sees the bytes, and it rides
the recipient's DTLS-encrypted WebRTC channel (`direct.js:17-23`). The
**commons** dwapp (the `NORTH-STAR.md §2` demo app) is the reference *human* chat
client: it drives `dm-send` and renders a full propose / accept / decline
handshake with pending-buffer-before-accept consent
(`apps/commons/index.html:252-314`).

What is **missing** is surface area. Only one consumer can reach this layer
today — the dwapp bridge, via postMessage from inside an app-tab sandbox. The
**agent** has seven dweb tools (`tools/defs/dweb-*.js`) and zero of them can
send or receive a message; `ctx.dweb` (`service-worker.js:995-1014`) exposes only
`share` / `discover` / `install` / `peers` / `block` / `setDiscovery`. And there
is **no native chat surface** — to chat a peer 1:1 a user must open the commons
dwapp.

The unifying idea: **the offscreen room/direct layer is a service with three
callers** — the dwapp bridge (exists), the agent's `ctx.dweb` (workstream B), and
native chat routes (workstream C). B and C are not two features; they are two
clients of the same transport. The single hard problem both share — and the
crux of this whole spec — is **inbound event → secure unattended action** (§7).
Solve it once; both inherit it.

Sequencing falls out of that: A is done (recap, §A). B.1 (agent *send*) is thin.
C's store + channel + routes come next. Then B.2+B.3 (inbound wake + unattended
security) is built **once, shared**. Then C's native UI + handshake, then the
agent's chat tool, then the deferred tranche (sealing → dedup/ordering →
store-and-forward, §10).

---

## 1. Non-goals / scope

- **No new transport, no new protocol.** Rooms, signed envelopes, the mesh,
  `ch=3` direct, gossip, presence, sync — all shipped. This spec is tool surface,
  a native UI, SW routes, and policy. If a workstream needs a new wire format, it
  is out of scope (it belongs in `PROTOCOL.md` and the roadmap, not here).
- **No store-channel dweb** (`NORTH-STAR.md §6`). Preview-channel only; every
  surface here is dweb-boundary-gated and ships inert in the store package.
- **No TURN, ever** (D-5). Direct send to an offline peer **fails honestly**
  (`direct.js:49` throws `no direct link`); we surface that, we do not relay
  around it. Store-and-forward is the deferred tranche (§10) and carries its own
  D-5 tension.
- **No E2E sealing in v1.** Direct bodies are signed-but-plaintext post-DTLS
  (`direct.js:17-23`). That is private for online 1:1 (the bytes never leave the
  two endpoints) and is exactly what commons ships today — an acceptable v1
  floor. Sealing is **mandatory before any store-and-forward**, is already a
  structural requirement of `THREAT-MODEL.md §2/§8` (relayed messages must be
  sealed), and is the first deferred item (§10.1).
- **No cross-device sync of conversations.** Same reasoning as
  `FEATURE-SCHEDULED-TASKS.md §9`: peerd has no account, no backend. History is
  local-only (and lives only with online room peers for the room feed) until
  store-and-forward earns its slot.
- **No global / stranger inbox.** Direct messaging is to dids you already have a
  **Tier 0/1** link with — peers in a shared room or the lobby (D-9: the room is
  the consent boundary; `THREAT-MODEL.md` Tier 2 strangers are blocked by
  default). Stranger discovery is the DHT chapter (Phase 3), not this.
- **No agent that messages without a human handshake.** The agent can *propose*
  and, once a human peer accepts, *send* — but it never opens an unsolicited
  channel that bypasses the same accept gate a human goes through (§7.4), and it
  can only target a did the user already links (Tier 0/1, §7.0).

---

## 2. Network lifecycle — turning it on, and a real off (the kill switch)

The dweb base network is **opt-in and user-controlled**, and shutting it down
must be as deliberate and complete as turning it on. The *on* half is built; the
*off* half is half-built — closing that gap is a prerequisite for everything
here. A user who lets the agent act on inbound messages (§7) **must be able to
pull the plug on all of it at once.**

**On (shipped).** A persisted setting `dwebEnabled` is the single source of truth
(`background/settings-patch.js:29,184`). The dweb routes and the agent's dweb
tools are already inert unless it is true (`routes/dweb.js:5`; `exposure.js:128`
`isDwebTool`). When on, the base network auto-starts on each vault unlock
(`maybeStartBaseNetwork('unlock')`, `routes/vault.js:54`) and the Network section
offers an explicit **"Start the network"** button (`home/network-section.js:431`
→ `dweb/base/start`).

**Off (the gap).** The teardown *primitive* exists — `dweb/base-host/stop`
(`offscreen/dweb-base.js:388-394`) calls `handle.close()` = `base.close();
room.leave()` (`client.js:103`), leaving the lobby and tearing down the mesh —
but **nothing reaches it**: no SW route forwards to it, no UI exposes it, and
flipping `dwebEnabled` off only suppresses the *next* auto-start. A network
already live keeps running — mesh links open, presence beaconing, the offscreen
host up. So a user can start the dweb but cannot cleanly stop it.

**The kill switch** — a symmetric, persistent, complete off:

- **New SW route `dweb/base/stop`** (mirror `dweb/base/start`, `routes/dweb.js`):
  `ensureOffscreen()` *only if the offscreen already exists* (never spawn it just
  to stop) → forward to `dweb/base-host/stop`.
- **Persist `dwebEnabled = false`** in the same call (`settings-patch.js:184`) so
  the next unlock's `maybeStartBaseNetwork` is a no-op — **no silent
  auto-restart.** The setting stays the single source of truth; the route both
  flips it and acts on the transition.
- **Complete teardown**, not just the lobby: `handle.close()` drops the base mesh
  + lobby + presence; additionally **close every open dwapp/commons room** (the
  ref-counted hosts, `dweb-base.js:204-211`) and **unregister every inbound
  monitor + agent subscription** (B.2 — no further wakes). Native conversations
  go offline (sends fail honestly, `direct.js:49`, like any offline peer). The
  offscreen doc itself is **not** force-closed (voice / VM / local-model may share
  it); only the dweb host is stopped.
- **UI: a "Stop the network" control** in the Network section, symmetric to Start
  (`network-section.js:431`), confirm-gated ("Shut down all peer-to-peer
  networking?" — it drops live connections), status reflecting `stopped`.

**Fail-closed coupling (ties to §7).** "Off" must mean genuinely silent. Because
the dweb boundary already gates on `dwebEnabled`, flipping it off makes the agent
dweb/chat tools vanish from the descriptor set (`exposure.js`), the `dweb/*` and
`chat/*` routes refuse (`dwebOn()` guard), and — monitors torn down — **no inbound
message can wake the agent and no outbound send can leave.** The kill switch is
therefore the **master fail-closed** for the entire §7 unattended surface: one
user action and the network plus every messaging capability built on it goes dark
until the user turns it back on. It MUST exist before the inbound-wake surface
ships (§11). **Effort: S–M. Risk: 🟡** (idempotent stop, ref-counted room
teardown, monitor cleanup).

---

## A. Workstream A — commons as a *consumer* (shipped; recap)

A is done and on `main`. It is recapped here only to fix its **role**: commons
stops being the *only* chat path and becomes one *consumer* of the shared layer,
sitting beside the agent and the native UI.

- **The commons dwapp** (`apps/commons/index.html`) is the shipped reference
  implementation of human 1:1 chat over the bridge. Its handshake
  (`:252-272` propose/accept/decline, `:279-314` `handleDirect` with the
  pending-buffer-before-accept and mutual-invite auto-open, `:333-356` the single
  persistent composer) is the **canonical state machine** workstream C ports to
  native mithril (§6).
- It speaks the bridge ops the guide documents: `dm-send({to, data})` /
  `direct` events plus room `publish` / `subscribe` / `history` / `presence`
  (`tools/defs/dweb-guide.js:47-55`).

**The only A-residual work:** ensure the recap framing is true in the product —
commons is labeled and pinned as the seed app (already handled by
`dweb/ensure-seed-app`, `routes/dweb.js:160-193`), and the docs/index taxonomy
calls it a consumer, not the chat substrate. **Effort: S.** No code beyond a
doc/label pass.

---

## B. Workstream B — the agent in the loop (send + receive)

The agent gains the ability to send a direct message / participate in a room
(B.1, thin) and to **be woken by an inbound message as a turn** (B.2, net-new
plumbing) — under a fail-closed unattended posture (B.3, the crux, §7).

### B.1 — Send & participate (thin; reuse the offscreen layer)

Add room/direct ops to `ctx.dweb` (`service-worker.js:995-1014`), each one the
same shape as the shipped slots: `ensureOffscreen()` then
`browser.runtime.sendMessage({ type: 'dweb/base-host/room', op, … })` — the
offscreen `handleRoomOp` (`dweb-base.js:216-268`) already implements `join`,
`leave`, `publish`, `subscribe`, `presence`, `history`, `announce`, and `dm`.
No offscreen change for send.

- **`dweb_dm`** — a new tool, 1:1 send to a peer `did`. Structure it like
  `dweb-block.js` (narrow `ctx.dweb`, did validation) but **force-confirm like
  `dweb-share.js`**: sending a message to another person is outward-facing. Set
  `sideEffect: 'mutate_external'` (the declaration pattern at
  `dweb-share.js:50` / `dweb-install.js:51`) so `classifyAction`'s
  `mutate_external → EXTERNAL` branch (`permissions/policy.js:139-141`) lands it
  in `EXTERNAL` — confirmed under the normal toggle, blocked in Plan mode — and
  add the toggle-off force-confirm in `execute` (the `dweb-share.js:62-71`
  pattern). **Subject to §7.0 + §7.4:** the target must be a Tier-0/1 linked peer
  who has accepted (or the agent is replying inside an open conversation), and
  `dweb_dm` **writes through the `chat/*` routes** (C.4) so it inherits the
  conversation store's decline/grant checks — it must not call the offscreen `dm`
  op directly (§7.4, resolves old Open Q4). `wrapUntrusted` is not needed on
  *send* (we author it); it is the *receive* path that needs it (B.2). **Effort:
  S. Risk: 🟢.**
- **`dweb_room`** — participation tool(s): `join` / `publish` / `subscribe` /
  `history` on a room topic, so the agent is a *participant* in a shared app, not
  just its installer (the A2A roadmap's "agent dwapp participation" bullet). `join`
  is confirm-gated (mirrors the bridge's confirm-gated `join`, `NORTH-STAR.md §4`).
  Reuse the per-(app, permission)-grant posture; everything audited via the
  existing `dweb/audit` route (`routes/dweb.js:63`). **Effort: M. Risk: 🟡** — this
  is a new participation privilege; it gets the §7 review.
- **Registration.** Add the tools to `BUILTIN_TOOLS` and the exports map in
  `tools/defs/index.js:148-222` (the `// dweb` block), each with `dweb: true` so
  `exposure.js:128` (`isDwebTool`) hides them on the store build / dweb-off. Decide
  per tool whether it is an ENTRY tool (always on when dweb enabled, like
  `dweb_guide`) or a SECONDARY tool deferred until the session engages the dweb —
  if secondary, add to `DWEB_SECONDARY_TOOLS` (`exposure.js:161-163`). Lean:
  `dweb_dm` ENTRY (it is the point), `dweb_room` SECONDARY.
- **Prompt.** Update `dweb-guide.js`'s `BRIDGE_GUIDE` and the short dweb
  system-prompt block so the agent reaches for `dweb_dm` / `dweb_room` to talk to
  a peer **instead of building a dwapp to do it** (today the only documented path
  is "build a multiplayer App"). **Effort: S.**

### B.2 — Receive ("monitor for reply") — the real work

Today an inbound room/direct event flows **offscreen → app-tab directly**:
`pushRoomEvent` (`dweb-base.js:175-177`) does a `browser.runtime.sendMessage`
that the app-tab filters by `roomId`; the SW and the agent session never see it
(`routes/dweb.js:302-305` documents exactly this — "Events flow back to the
app-tab directly … so the SW only carries the request/response"). For the agent
to be woken, the inbound event must reach the **SW/session**, which it never does.

- **NET-NEW: offscreen → SW forwarder, with Tier-2 dropped at the source.** When
  the agent is subscribed (a room it joined, or its lobby direct channel — §C.2),
  the offscreen host emits a distinct runtime message **to the SW**, e.g.
  `dweb/base-room/agent-inbound { sessionId, from (did), roomId|topic, msgId, sig, body, ts }`.
  Before it emits, the forwarder **enforces the trust tier** (`THREAT-MODEL.md`
  §"Trust topology", §1): an inbound from a **Tier-2 stranger is dropped at the
  offscreen forwarder** — no SW wake, no `wrapUntrusted`, no model turn, no cost.
  This is the same "0 from strangers" default-deny the threat model calls the
  single biggest spam reducer; it must hold here, *upstream* of the §6 app-layer
  buffer (which would otherwise still cost a wake). The hooks already exist as
  unsub-returning subscriptions: room `direct` and `gossip.subscribe` are wired
  in `ensureRoom`/`handleRoomOp` (`dweb-base.js:193-195`, `:251-256`). The new
  forwarder is a second sink on the same callbacks, fired only when an *agent*
  (not a dwapp app-tab) registered interest and only for Tier-0/1 senders.
  **Effort: M.**
- **NET-NEW: SW inbox orchestrator** — `makeInboundMonitor`, modeled 1:1 on
  `makeAsyncSubagents` (`subagent/async-subagents.js`). It registers/unregisters
  per-(session, subscription); on an inbound event it **coalesces to one wake**
  and re-enters the target session via `turnSlots.runWhenIdle`
  (`loop/turn-slots.js:92-97`) so it **never aborts a live turn** (DECISIONS #20,
  the same anti-focus-theft contract async subagents use). Each inbound body is
  `wrapUntrusted`-fenced with `origin` = the sender did (the `drainReintegration`
  template, `async-subagents.js:134-161`: trusted one-line frame + untrusted
  fenced body). The wake re-enters carrying the new `ctx.inbound` origin (§7.1),
  **not** plain `ctx.synthetic` (which is trusted-internal, `agent-loop.js:160-164,
  276-277`). Wire it in the SW exactly like the orchestrator at
  `service-worker.js:1245-1265` (inject `turnSlots`, `reenter: runAgentTurn`,
  `getActiveSessionId`, `isVaultLocked`, `wrapUntrusted`, `notify`) and re-drain
  on unlock via `vault.subscribe` (`service-worker.js:1273`). **Effort: L. Risk: 🔴**
  — this is the integration surface that has the dedupe + lifecycle hazards below.
- **DURABLE dedupe + at-least-once.** The async-subagent orchestrator keeps its
  `reintegrated` flag **in memory** (`async-subagents.js:76` — "in-session
  durability only"), which is fine for a child that dies with the SW but **wrong
  for inbound messages**: the MV3 SW is reclaimed constantly, and gossip
  **re-delivers** (the offscreen re-subscribes every 12s, `dweb-base.js:144-146`,
  and `sync.history` replays retained topics). A purely in-memory seen-set would
  re-wake the agent on the same message after every SW restart. So the inbox
  orchestrator must persist a **seen-cache** to `chrome.storage` and check it
  before waking. **Key it on the envelope signature** (`H(sig)`), **not on
  `env.id`** — `THREAT-MODEL.md §12` makes this a load-bearing decision: an
  `id`-keyed cache lets a hostile peer pre-poison it (predict/replay an `id` so
  the honest frame with that id is silently suppressed), exactly the attack the
  gossip layer's signature-keyed seen-cache rejects. Delivery is
  **at-least-once**; the sig-keyed seen-cache makes re-entry **idempotent**
  without the poisoning class. **This is the highest-risk piece of B.** **Effort:
  M, inside the L above. Risk: 🔴.**
- **Subscription lifecycle.** An agent subscription must survive SW + offscreen
  restart (persisted as a small record keyed by session) and be **torn down when
  the session is deleted** (hook `session-mutations`' delete path) — a dangling
  subscription that wakes a dead session is a leak. **Effort: M.**

### B.3 — Security — see §7 (built once, shared with C's agent tool).

---

## C. Workstream C — first-class native messaging (no dwapp)

From the **Contacts** surface, a human (or the agent) proposes a direct chat that
renders **natively** in peerd — no dwapp, no app-tab. This is the same transport
as B, with a native store, channel, routes, and UI instead of the bridge.

### C.1 — What exists vs. the gaps

Exists: `createDirect` (`messaging/direct.js:30-56`); the contact model + store +
UI (`contacts/contact.js:19-29`, `contacts/store.js`, the `contacts` IDB store
`peerd-egress/storage/idb.js:132-138`, `home/contacts-section.js`); commons as
the reference handshake.

Gaps:
- **DM is room-scoped only.** The SW-exposed direct path is `handleRoomOp`'s `dm`
  op (`dweb-base.js:263`), which requires an open room (`rooms.get(roomId)`,
  `:242`, returns `not-in-room` at `:243`). A lobby-wide direct exists on the base
  node (`createDirect` is wired in `ensureRoom` per-room, and `room.direct` is
  what `dm` uses) but there is **no SW route that sends a direct outside a room.**
  C needs a contacts-scoped direct channel.
- **No conversation/message store.** The `contacts` store holds overlays, not
  messages (`contact.js:5-9` is explicit: "Activity history is NOT stored here").
- **The agent chat reducer is too agent-shaped to reuse.** `sidepanel/chat-reducer.js`
  models turns / toolUses / thinking / streaming / stopReason / synthetic /
  subagent sessions (`:20-44`) — a peer conversation is none of that. Do **not**
  overload the agent session.

### C.2 — The contacts-scoped direct channel

Two options; pick one at build:

- **(a) A reserved base sub-protocol `peerd/dm/1`**, joined on unlock (the
  always-on base network already joins on unlock, `dweb-base.js:100-152`), so a
  direct to any linked peer routes without first opening a shared app room. This
  reuses the room machinery (`openRoom` + `room.direct`) with a single
  well-known room id — the smallest change.
- **(b) Surface `node.direct` (the lobby-wide direct, `direct.js`) via two new
  base-host ops** `dm-send` / `dm-subscribe` in `handleRoomOp`/`onBaseHostMessage`
  (`dweb-base.js:216-268, 275-407`), so a direct doesn't need any room at all.

Lean **(a)**: it reuses the shipped, tested room path verbatim (presence + direct
+ the same `pushRoomEvent` plumbing) and the "room is the consent boundary" framing
(D-9) holds — `peerd/dm/1` is just the always-joined contacts room. **Effort: M.
Risk: 🟡** (lifecycle: joined-on-unlock, ref-counted like every other room).

### C.3 — The conversation store

New `peerd-runtime/conversations/{store,model}.js` (functional core / imperative
shell, mirroring `contacts/`). A new IDB object store `conversations` keyed by
peer `did` (and a `messages` tier, or one record-per-message keyed by msg id like
`session_messages`, `idb.js:145-151`). Bump `DB_VERSION` and add the store in the
upgrade path — the **guarded `createObjectStore` mirroring `idb.js:117-151`**
(the file already reserves the pattern at `:114-116`: "added with its first
writer"; current max is v9, so `conversations` is the next bump). Stores
conversation **status** (the §6 state machine, including a **persisted `declined`
flag checked before any wake** so a decline survives SW restart and the in-memory
commons state machine can't disagree with it), message log, and last-read.
**Effort: M. Risk: 🟢.**

### C.4 — SW routes

New `background/routes/chat.js` (mirror `routes/contacts.js` — deps injected,
imports none, **vault-gated** like `contacts/list` `routes/contacts.js:22-23`):

```
conversations/list           list peers I have a conversation with + status + unread
conversations/history        the message log for one peer did
chat/send                    send a {kind:'msg'} direct to a peer (open convo only)
chat/propose                 send {kind:'request'} — start the handshake
chat/accept                  send {kind:'accept'}, flush pending buffer
chat/decline                 send {kind:'decline'}, permanent
```

Each route: persist to the conversation store, relay over the C.2 channel
(`ensureOffscreen` + the `dweb/base/room` relay, `routes/dweb.js:306`), and
**broadcast the new state over `uiPorts`** so every open surface updates live
(the `uiPorts.broadcast` pattern, `service-worker.js:1237`). `chat/propose` /
`chat/send` enforce that the target is a Tier-0/1 linked peer (§7.0) **at this
route**, not just by the UI offering contact rows. Register in the SW routes
object beside `...makeSessionRoutes` / `...makeSessionMutationRoutes` /
`...makeContactsRoutes` / `...makeDwebRoutes` (`service-worker.js:2471-2515`).
**Effort: M. Risk: 🟡.**

### C.5 — Live inbound → a SEPARATE reducer slice

Inbound directs (the `direct` event, `dweb-base.js:195`) reach the SW via the same
B.2 forwarder, but for a *native conversation* (not an agent wake) they fold into a
**separate conversations reducer slice** — do **not** route them through the agent
session's `reduceChat`. The home/side-panel surfaces already connect a port and
fold pushed messages (`home/home.js:88-101`); add a `conversations/*` message
family the surface folds into its own conversation state, beside chat state.
**Effort: M.**

### C.6 — Native chat thread UI

New `home/contacts-chat-section.js`: port the commons chat (`index.html:234-356`)
to mithril, **reusing the existing layout/CSS, not the agent's ChatView /
MessageList / InputBar** (those render turns/tools, the wrong shape). Add a
**"Message" / "Propose chat"** action to contact rows (the action row at
`home/contacts-section.js:256-263`, beside Rename/Activity). Render the persistent
composer, the message list, and the handshake system-lines (§6). **Effort: L.
Risk: 🟡** (UI surface area).

### C.7 — The agent-facing chat tool

A `chat_message` tool that proposes / sends via the **same `chat/*` routes**
(C.4), so the agent and the human drive one store and one channel. Still gated by
the §7.4 human-accept handshake and the §7.0 tier check: the agent can propose to
a Tier-0/1 peer and reply inside an open conversation, but the peer's accept is
what opens it. **Effort: S** (it is a thin tool over C.4, after C.4 exists).
**Risk: 🟡** (§7).

---

## 6. The propose / accept handshake (shared by C's UI and the agent tool)

Port the commons state machine verbatim (`apps/commons/index.html:252-314`). It
is small, proven, and consent-correct. It is the **app-layer** consent gate; it
sits *below* the §7.0 transport-tier check, not in place of it.

States per peer did: `none → outgoing | incoming → open | declined`.

- **propose** (`chat/propose`): status `outgoing`, send `{kind:'request', name}`,
  system-line "chat request sent … waiting to accept" (`index.html:252-258`).
- **inbound `request`** (`handleDirect`, `index.html:286-294`): if already `open`,
  ignore; if we were `outgoing`, it's a **mutual invite → auto-open both sides**
  (send `accept`, `:288-291`); else status `incoming`.
- **accept** (`chat/accept`, `index.html:259-266`): status `open`, send `accept`,
  **flush the pending buffer** (messages received before accept were held, not
  shown — the consent gate, `index.html:263`).
- **decline** (`chat/decline`, `index.html:267-272`): status `declined`,
  **permanent** — a later message from a declined peer is dropped
  (`index.html:308`). C.3 persists this flag and checks it **before** waking.
- **pending-before-accept** (`index.html:300-311`): a `msg` from someone who never
  asked is treated as a request; its content is **buffered hidden** until accept.
  This is the spam/consent boundary at the app layer — no UI shows an
  un-consented stranger's text.

**The agent obeys the same gate** (§7.4): `chat_message`/`dweb_dm` to a peer that
hasn't accepted issues a `propose`, never a raw `msg`; replies are only allowed
into an `open` conversation.

---

## 7. Security model — the shared inbound → unattended-action boundary (the crux)

This is the one hard problem B and C share, and the reason to build receive
**once**. An inbound message can arrive while nobody is watching the screen — the
MV3 SW wakes, re-enters a session, and the agent acts. That is the **exact** risk
class `FEATURE-SCHEDULED-TASKS.md §7` designs for timers; messaging adds a
**hostile remote sender** to it.

**Honest baseline: neither origin exists in code today.** `ctx.inbound` is
net-new (zero hits). `ctx.unattended` is *also* net-new — it is a proposed
Phase-A flag in `FEATURE-SCHEDULED-TASKS.md §7.1`, not yet built. And
`decideAction` (`policy.js:195-229`) has signature `{ mode, confirmActions, tool }`
with **no origin/unattended/inbound parameter**. So §7.1 is a real
argument-threading change at two call sites, not a flag read at an existing seam.
The closest shipping autonomous-run machinery is goal mode
(`peerd-runtime/loop/goal-runner.js`), which just auto-flips the session to
Act + confirm-off for the run's duration rather than reading any
`unattended` flag — unrelated to this clamp. This is a genuine
**cross-spec dependency**: §7.1 and scheduled-tasks §7.1/§7.2 must converge on
one clamp; whichever lands first builds the threading, the second reuses it.

### 7.0 — Map onto the existing Tier 0/1/2 topology (THREAT-MODEL spine)

This feature does **not** invent a new consent axis. It maps onto
`THREAT-MODEL.md`'s trust topology, keyed on `did:key` and **enforced at the
offscreen network host** (with policy decided by pure SW functions):

- **Tier 2 (strangers): 0 inbound, dropped at the offscreen forwarder** (B.2)
  before any SW wake or model cost. This is the threat model's default-deny "0
  from strangers."
- **Tier 0 (paired) / Tier 1 (interacted): inbound allowed.** The §7.4 per-peer
  grant is **not** a new axis — it is the "agent may *act* unattended" property
  layered on a peer that is *already* Tier 0/1. A Tier-0/1 peer can reach you;
  only a grant lets the agent reply without you.
- **Rate cap = the Tier-1 cap, not a competing number.** The inbound/outbound
  cap (§7.3) **is** `THREAT-MODEL.md §1`'s **10 msgs/min from known peers**, not
  an independently invented "8/60s." (This resolves old Open Q5: the threat model
  already answers it.)

### 7.1 — A distinct inbound origin, fail-closed, clamped at two layers

The wake turn carries an origin **distinct from `ctx.synthetic`** —
`ctx.inbound = true`, with `from` = the sender did. `ctx.synthetic` means
"trusted internal continuation" (a subagent result we authored,
`agent-loop.js:160-164`); a remote message is **not** that. **An absent flag is
treated as inbound-hostile** (fail-closed).

Following `FEATURE-SCHEDULED-TASKS.md §7.2`, the clamp is **defense-in-depth, at
both layers** — not classifier-only:

- **(1) Exposure / descriptor filtering.** The inbound turn's tool list is
  filtered to a **read-only allow-list** — drop every side-effecting dweb / chat
  / shell / workspace-write tool from the descriptors the model ever sees (the
  `manifests.js` preset + `exposureGate`/`gates.js` mechanism scheduled-tasks
  reuses). A tool the model never sees can't be called.
- **(2) Dispatch / decision.** At the classifier seam — `agent-loop.js:719-728`
  calls `ctx.classifyToolCall` per tool and reads the resulting `actionClass`;
  `classifyToolCall` must be wired to `decideAction` with the new `ctx.inbound`
  argument threaded through. Anything classified `EXTERNAL` / `SHELL` /
  `WORKSPACE_WRITE` (`policy.js:85-100`) is **denied** under `ctx.inbound` (no
  human to confirm) unless a standing per-peer grant exists (§7.4). A tool that
  slips the filter is still denied here.
- **Relationship to `ctx.unattended`.** A remote-authored wake is *also*
  unattended (no human watching), so **`ctx.inbound ⇒ ctx.unattended`** and the
  inbound clamp is a **strict superset** of the unattended one — a remote-authored
  unattended turn is strictly more hostile than a self-scheduled one. Both flags
  flow into the same gate.
- **The agent cannot widen itself from an inbound turn.** `dweb_dm` / `dweb_room`
  join/publish, `chat/propose`, and any grant edit are **hard-denied** under
  `ctx.inbound` at layer (1) — dropped from descriptors — killing the injection
  pivot "a peer messages the agent, the agent messages everyone" (the p2p
  analogue of scheduled-tasks' "schedule a new acting task for me").

### 7.2 — Untrusted by construction

Every inbound body enters context only via `wrapUntrusted` with `origin` = the
sender did and the same fence-tag neutralization `read_article`/`call_api`/subagent
results use (`async-subagents.js:145`). The one-line wake frame ("Peer …<did8>
messaged you in <room>") is trusted; the message text is not. The bridge already
proves `from` is authentic (signed envelope, `mesh.js:235`, `direct.js:14-15`) —
authenticity is **not** trust. This is the first inbound *task-shaped* payload, so
`THREAT-MODEL.md §10` applies verbatim: **delegated tasks run under the
*receiver's* policy and confirmation gates, never the sender's.**

### 7.3 — Inbound rate cap (stop p2p ping-pong)

A **symmetric** circuit breaker analogous to the async-subagent runaway guard
(`async-subagents.js:53-58, 169-189`), reconciled to the Tier-1 cap (§7.0): cap
inbound *wakes* and outbound agent *sends* per peer per window at the threat
model's **10/min** (`THREAT-MODEL.md §1`). Two agents that auto-reply to each
other are the exact runaway the subagent guard was built for
(`async-subagents.js:16-21`), now across the network. Past the cap: stop waking /
refuse the send, notify generically. The cap must bound **cost, not just count** —
each inbound wake is a full model turn (battery, MV3 wake, provider spend), so the
cap is the DoS bound, not a convenience. **Mandatory, not optional.**

### 7.4 — Consent: the human handshake gates the agent

A standing per-peer **grant** governs whether the agent may *act* on inbound from
/ send to that did — layered on an already-Tier-0/1 peer (§7.0). Reuse the
bridge's per-(app, permission) grant model (`NORTH-STAR.md §4`) or the
`dweb-share.js:62-71` force-confirm. The default is **no grant**: an inbound
message wakes the agent only to *read + optionally propose a reply the user
confirms*; sending requires the §6 handshake (the peer accepted) **and** the
grant. A grant is per-did, persisted, and revocable.

**Outbound first contact is tier-gated too.** Even in an *attended* turn ("message
Bob"), the agent's `propose`/`dweb_dm` target must already be a Tier-0/1 link
(`THREAT-MODEL.md` Tier-2 default-deny) — enforced at the offscreen host and the
`chat/*` route (C.4, §7.0), not merely by the UI showing only contact rows. The
agent never opens a channel to a stranger did.

**Routing through `chat/*` is itself a security requirement.** `dweb_dm` /
`chat_message` **must** go through the `chat/*` routes so they inherit the
persisted decline check, the grant check, and the tier check; calling the
offscreen `dm` op directly would bypass all three (resolves old Open Q4).

### 7.5 — Lifecycle, egress, and the one new data path

The subscription that drives inbound wakes is **persisted across SW/offscreen
restart and torn down on session delete** (B.2). All *transport* stays on the
existing in-browser path — `ch=3` direct is un-relayable (`mesh.js:244`), gossip
is room-scoped and signed (D-9); there is **no agent-server, no new network
egress chokepoint**, the same property `FEATURE-SCHEDULED-TASKS.md §7.4` relies
on. **One honest caveat:** an inbound peer message now flows into a model call,
i.e. peer-authored content reaches a third party (the LLM provider) on an
unattended turn. That is the same provider data-flow web content already has, and
the `THREAT-MODEL.md §10` confused-deputy frame covers the injection risk — but
it is a new *path by which peer content reaches the provider*, named here rather
than hidden behind "no new egress."

### 7.6 — Vault-locked posture (a first-class state, not an open question)

Vault-lock has two distinct concerns, both decided here:

- **Agent wake while locked:** the model is key-gated and cannot run — **hold +
  generic-notify + re-drain on unlock**, exactly like `async-subagents.js:128,
  238-246` and the §B.2 `vault.subscribe` re-drain (`service-worker.js:1273`).
- **Native conversation store write while locked:** plaintext peer content is
  confidential, so the `conversations` store is **vault-gated like `contacts`**
  (`routes/contacts.js:22-23`) — inbound directs received while locked are
  **held in the seen-cache/buffer and written on unlock**, not persisted in
  plaintext while the vault is locked. This is a decided confidentiality posture,
  consistent with the threat model's machine-trust assumption, not a build detail.

### 7.7 — New threats this feature introduces (adversary / mitigation / residual)

This feature adds two new privilege boundaries — *the agent acting on remote
input* and *native inbound → SW wake* — so, per the dwapp-bridge precedent
(`THREAT-MODEL.md §13`), it gets its own threat entry. Plan to upstream this as
`THREAT-MODEL.md §15` (Agent messaging / inbound wake).

| Threat | Adversary wants | Mitigation | Residual |
|---|---|---|---|
| **Stranger wake** | a Tier-2 did to cost you a model turn | Tier-2 dropped at the offscreen forwarder before any wake (§7.0) | a Tier-0/1 peer you chose can still wake you, up to the cap |
| **Wake amplification / DoS** | force N unattended turns (cost, battery, wake storms) | symmetric 10/min cap bounds **cost** per peer (§7.3); generic notify, no per-message UI thrash | a peer can spend you up to the cap until you revoke/block |
| **Inbound→fanout pivot** | injected text makes the agent message others | side-effecting tools dropped from descriptors under `ctx.inbound` (§7.1 layer 1); grant/propose hard-denied | none for the inbound turn (the capability isn't exposed) |
| **Reply-oracle / exfiltration** | influence a reply the user rubber-stamps so a secret leaks | inbound sends hard-denied (§7.1); a *proposed* reply is itself `wrapUntrusted`-derived and shown **verbatim** for confirm, never auto-sent | a user who blindly confirms an attacker-shaped proposal |
| **Seen-cache poisoning** | pre-send a frame to suppress an honest message | seen-cache keyed on **signature**, not `env.id` (§B.2, `THREAT-MODEL.md §12`) | none (signatures are unforgeable) |
| **Decline bypass / state confusion** | re-wake after a decline across SW restart | decline persisted in the conversation store and checked **before** wake (§C.3, §6) | none once persisted |
| **Confidentiality at rest while locked** | read plaintext peer content from a locked device | `conversations` vault-gated; no plaintext write while locked (§7.6) | machine-trust assumption (out of scope, `THREAT-MODEL.md` §"assumptions") |

### 7.8 — Dedicated review

Per the A2A roadmap risk note and the Phase-1 bridge precedent
(`THREAT-MODEL.md §13`), the inbound-wake boundary gets its **own security
review** before it ships — it is a new privilege surface (the agent acting on
remote input, possibly unattended). §7.7 is the checklist that review must close.

---

## 8. State & storage

- **`conversations` IDB store** (C.3): keyed by peer did; status (incl. persisted
  `declined`) + message log + last-read. New store at the next `DB_VERSION` (v10),
  guarded `createObjectStore` (`idb.js:117-151`). **Vault-gated** (§7.6).
- **Inbound seen-cache** (B.2): persisted to `chrome.storage`, keyed on the
  envelope **signature** (`H(sig)`, not `env.id` — §B.2/§7.7), for idempotent
  at-least-once re-entry across SW restart.
- **Agent subscription records** (B.2): per-session, persisted, torn down on
  session delete.
- **Per-peer grants** (§7.4): persisted, revocable.
- **`dwebEnabled` on/off** (§2): the persisted single source of truth for whether
  the network runs; switching off tears down the live mesh + all inbound monitors
  and subscriptions, and blocks auto-restart on the next unlock.
- **No conversation export / cross-device sync** in v1 (§1).

---

## 9. UX

- **Contacts → "Message" / "Propose chat"** on each contact row
  (`home/contacts-section.js:256-263`), opening the native thread (C.6).
- **Native chat thread**: ported commons layout — left rail of conversations with
  unread badges, one persistent composer, handshake system-lines
  (`index.html:358-359, 333-356, 244-245`).
- **Inbound notification**: generic, content-free (mirror
  `notifyAsyncSubagent`, `service-worker.js:1259` and the scheduled-tasks "generic
  by rule" §5.6) — "Peer …<did8> messaged you", never the message text on a lock
  screen. Deep-link to the thread.
- **Agent surfacing**: an inbound message to the agent surfaces passively if its
  session isn't the active chat (the `getActiveSessionId` check,
  `async-subagents.js:156-157`), never stealing focus (#20).
- **Grant prompt**: "Let peerd's agent reply to <name> while you're away?" —
  off by default, per-did, revocable (§7.4).
- **Network on/off**: a **"Stop the network"** control beside "Start" in the
  Network section (§2), confirm-gated; status shows running vs stopped, so the
  user always has a one-click master off for all dweb networking.

---

## 10. Deferred tranche (decide together; shared by B + C)

These are real, sequenced *after* the online-only v1, and named honestly because
v1 is usable without them (online-only + local-history-only **matches commons
today**).

### 10.1 — E2E sealing (mandatory before store-and-forward)

Bodies are **signed but plaintext** post-DTLS (`direct.js:17-23`). Online 1:1 is
private because the bytes never leave the two endpoints — but the moment a relay
holds a body, it can read it. Sealing is therefore not optional polish: it is
**already a structural requirement** of `THREAT-MODEL.md §2` (illegal-content
liability — "relayed messages are sealed") and `§8` (a relay that can't read
can't selectively censor). So: derive an **X25519** keypair from the existing
Ed25519 identity, add `messaging/seal.js` (X25519 ECDH → HKDF → AES-256-GCM,
per-message ephemeral keys — the shape `ROADMAP.md` Phase 4 already names). This
is a **hard precondition** for §10.3.

### 10.2 — Dedup / ordering (once delivery is multi-path)

Online direct needs no dedup (`direct.js:22-23`: one link, one delivery). The
moment a message can arrive via more than one path (relay + direct, or sync
replay), generalize the B.2 **signature-keyed** seen-cache (the model is
`gossip/topic.js`'s sig-keyed cache, `THREAT-MODEL.md §12`) and add
**per-conversation lamport ordering**. The B.2 persisted seen-cache (§8) is the
seed of this.

### 10.3 — Store-and-forward / offline (the honest D-5 tension)

`direct.send` throws when the peer is offline (`direct.js:49`). Offline delivery
needs a third party to hold the ciphertext — in **direct tension with
NORTH-STAR D-5 (NO TURN EVER)** and T2 (peers do the work, servers only
introduce). The on-thesis answer is **peer-assisted relay drawn from the social
graph** (`ROADMAP.md` Phase 4, `NORTH-STAR.md` T3's "a peer, not
infrastructure"), **not** a relay server — already threat-modeled in
`THREAT-MODEL.md §7A` (relay metadata) and §8 (malicious relays: N=5 redundancy,
sealed, social-graph-eligible). State the cost plainly: even with sealed bodies
(§10.1), a relay learns **who talks to whom** (the §7A IP/timing/volume metadata
class) — a leak D-5/T2 would otherwise avoid entirely. This is a deliberate,
deferrable Phase-4 decision, not a v1 gap to paper over. Until it lands:
**online-only, fail honestly** (`direct.js:49`), exactly commons' behavior today.

---

## 11. Phased build sequence

1. **A — recap/label** (done; doc pass). **S.**
2. **Network kill switch (§2)** — `dweb/base/stop` route + persisted `dwebEnabled`
   off + complete teardown (mesh, rooms, monitors) + the "Stop the network" UI.
   The master off; lands with the foundation and **must precede step 5** so the
   plug exists before the agent can ever act on inbound. **S–M.**
3. **B.1 — agent send/participate**: `dweb_dm` (through `chat/*`) + `dweb_room`
   over `ctx.dweb`, register + prompt. **S–M.**
4. **C.2/C.3/C.4 — channel + store + routes**: the `peerd/dm/1` channel, the
   `conversations` store, the `chat/*` routes (with the §7.0 tier check). **M.**
5. **B.2 + B.3 / §7 — inbound wake + unattended security, built ONCE, shared**:
   Tier-2-dropping offscreen→SW forwarder, `makeInboundMonitor`, sig-keyed durable
   seen-cache, the `ctx.inbound` origin + two-layer clamp + `decideAction`
   threading + rate cap + grants + vault posture. (The §2 kill switch is its
   master off.) **L, 🔴.**
6. **C.5/C.6 — native UI + live slice + handshake**: separate reducer slice,
   `contacts-chat-section.js`, the ported state machine. **L.**
7. **C.7 — agent chat tool** over the `chat/*` routes (still §7.0/§7.4-gated). **S.**
8. **Deferred**: §10.1 sealing → §10.2 dedup/ordering → §10.3 store-and-forward.

Steps 1–4 ship a usable slice (the agent can send; a human can chat natively
online) **with a working off switch from the start**. Step 5 is the gate
everything unattended depends on — it gets the §7.8 review and resolves the
cross-spec `ctx.unattended`/`ctx.inbound` clamp with scheduled-tasks. Steps 6–8
layer on. The deferred tranche is its own track.

---

## 12. Open questions (resolve during build)

1. **C.2 channel: reserved sub-protocol `peerd/dm/1` (a) vs. lobby `node.direct`
   surfaced via new base-host ops (b)?** Lean (a) — reuses the tested room path
   and keeps the D-9 framing. Confirm `room.direct` to an arbitrary
   linked-but-not-in-this-room peer actually routes, or whether (b) is needed for
   true lobby-wide DM.
2. **Seen-cache eviction.** Keyed on signature, persisted — but unbounded growth
   is a leak. Cap + oldest-evict like the audit log's retention
   (`FEATURE-SCHEDULED-TASKS.md §6.5`)? Risk: evicting a sig that later
   re-delivers → a double-wake. Lean: large cap, time-windowed.
3. **Per-peer grant granularity.** One "agent may reply to this peer unattended"
   grant, or split read-wake vs. send? Lean: one grant for send; reads always
   wake (passively).
4. **Cross-spec clamp ownership.** §7.1 and `FEATURE-SCHEDULED-TASKS.md §7.1/§7.2`
   both need `ctx.unattended`/`ctx.inbound` threaded through `decideAction` +
   `classifyToolCall` and the `manifests.js`/`gates.js` exposure clamp. Decide
   which spec lands the threading first so the other reuses it rather than
   duplicating (they must produce one gate, not two).
