# Phone → Browser Remote Control

> Driving the browser agent from a phone: a remote view of the live
> session plus a command inlet, carried over a single direct sealed
> channel. Written 2026-06-19. Forward-looking spec — not yet built.
> Sits beside `docs/distributed/ARCHITECTURE.md` (reuses its identity +
> pairing + transport) and `docs/distributed/THREAT-MODEL.md` (the
> remote inlet is the new surface). Touches `peerd-runtime` (the
> agent-loop inlet) as well as `peerd-distributed` (the transport).

---

## 1. Summary

You want to drive your browser agent from your phone — send it a task,
watch it work, approve a side effect — without a backend, an account,
or a native app.

The one idea that makes this simple: **the phone is not a peer, it is a
remote `uiPort`.** Only one side runs the agent. The desktop owns the
session store (IDB), the agent loop (SW + offscreen worker), and every
canonical fact about a turn. It is the **single authoritative writer**.
The phone *follows* that authoritative event log and *appends commands*
to it. It never forks state, so there is nothing to merge.

This is not a new sync model. It is the relationship the desktop side
panel already has with the service worker — the SW broadcasts turn
events (`state` / `delta` / `tool-use` / `tool-result` / `stop` /
`usage`) via `uiPorts.broadcast()`, and the panel is a stateless view
that can close, reopen, and rehydrate from `sessionCache`. The phone is
that same subscriber, stretched over a WebRTC data channel instead of
`chrome.runtime`, with one addition: a `since` cursor so it can replay
what it missed across a dropped link.

Because the relationship is asymmetric (one primary, one follower),
"both devices online" is a UX preference, not a correctness
requirement, and reconnection is a tail-replay, not a distributed
merge.

---

## 2. Non-goals / scope

What this is **not**:

- **Not a native app.** Mobile browsers do WebRTC data channels and
  `getUserMedia`; a web page is sufficient. A native shell would only
  buy background push when the page is closed (see §4, Tier 2) and is
  not worth it for the first cut.
- **Not a Hermes-style messaging-bridge gateway.** Routing commands
  through iMessage / WhatsApp / Telegram requires an always-on server
  process that custodies those sessions — the exact backend + account +
  third-party-trust surface peerd refuses (T1/T2 in
  `distributed/NORTH-STAR.md`). If it ever ships it is an optional,
  self-hosted, preview-channel bridge, never the default path.
- **Not a CRDT / merge problem.** The asymmetry removes the need. No
  `Yjs`, no platform CRDT (consistent with D-7).
- **Not async store-and-forward.** This is a live, both-online channel.
  The dweb `messaging/` inbox, `gossip/`, `dht/`, and `curation/` are
  **out of scope** — none are touched. The only dweb surface needed is
  **did:key identity + pairing + direct WebRTC over the signaling
  node**. Two peers, one channel, one authoritative log.

---

## 3. Model: single-primary replicated log

```
Phone (web page)                Desktop (extension)
  remote uiPort                   authoritative writer
       │                                 │
       │  command {id, text}             │   runAgentTurn()
       ├────────────────────────────────►│   agent loop (SW + offscreen)
       │                                 │   sessions/store.js  ← canonical
       │  event {seq, …}                 │   uiPorts.broadcast()
       │◄────────────────────────────────┤
       │  (reconnect) since=N            │   replay tail N+1…
       ├────────────────────────────────►│
                  sealed WebRTC data channel
            (did:key paired, X25519, via signaling-node)
```

The desktop already persists session messages append-mostly in
`peerd-runtime/sessions/store.js`. That append-only message log, plus
the in-flight turn state, **is** the shared state. The phone holds a
high-water mark into it.

### 3.1 What "clean and careful" actually requires

A short, finite list — get these right and there are no other sharp
edges:

1. **Per-session monotonic `seq` + follower high-water mark.** Every
   broadcast event carries a sequence number. The phone tracks the last
   `seq` it saw; on reconnect it sends `since=N` and the desktop replays
   the tail. New work, not a new store: the messages already persist.

2. **Replay *committed* state, not token deltas.** Do not re-stream
   every `delta`. On reconnect, replay finalized messages since `N`; if
   a turn is mid-flight, re-subscribe to the current assistant stub and
   stream forward from there. Deltas are ephemeral; the finalized
   message is the durable fact.

3. **Command idempotency via client id.** Each phone command carries a
   client-generated `uuidv7`. The desktop dedupes on it. This is the
   one place a missed ack genuinely bites — a flaky reconnect that
   resends "post the tweet" must not post twice. The id kills it.

4. **The agent runs regardless of phone presence.** The loop lives in
   the SW / offscreen worker, not on the phone. A dropped link never
   pauses a turn — the agent keeps going, the phone rejoins and catches
   up. This falls out for free and is *why* the design tolerates a
   flaky mobile link.

### 3.2 The one subtle part: confirmation across a dropped link

A remote-initiated turn can hit a Plan/Act confirmation gate while the
phone is the only approver and the link is down. The
`confirmCoordinator` (the `confirm/answer` route) already blocks async
for the side panel; the fix is to treat **a pending confirmation as
durable, replayable log state**, not an ephemeral modal. "Awaiting your
approval on X" is an event in the log. The phone reconnects, sees it in
the replayed tail, and approves or denies — with a timeout fallback
policy (default: expire to *denied*, never auto-approve). Get this one
right and remote confirmation is just another log entry.

---

## 4. Phone UX

The phone side is a **web page** served from `site/` (the peerd.ai
source), vanilla JS, sharing the `signalingStep` reducer + did:key +
pairing code from `peerd-distributed`. No app store, no review, no new
infra. PWA-install is optional polish on top of a plain page.

### 4.1 Acquisition (the QR is the onboarding)

The desktop side panel shows "Control from phone" and renders a QR. The
QR **encodes the page URL with a short-lived pairing secret in the
`#fragment`**. The user points their phone's normal system camera at
the laptop screen; the OS offers to open the URL; the page loads in the
default browser **already half-paired** — the secret rode in the
fragment, which never hits the network or any server log. No typed
code, no in-app camera permission, no install step.

### 4.2 Three UX tiers (ship in order)

| Tier | What | Where it works |
|---|---|---|
| **0 — Foreground page** | Open URL, pair, type a command, watch the turn stream live, close it. Ship this first; it is a complete product. | **Everywhere** — page is in the foreground, so no platform caveat applies. |
| **1 — Home-screen install** | "Add to Home Screen" → full-screen, icon, feels native. Costs nothing to support. | iOS: Safari only. Android: true installable PWA / WebAPK. |
| **2 — Closed-app push** | "Task finished" / "approve this action" while the page is closed. | Android + home-screen iOS **outside the EU** only. Elsewhere it degrades to catch-up-on-open (see below). |

### 4.3 Platform reality (verified 2026-06)

- **WebRTC data channels**: solid in every iOS browser (all WebKit, so
  identical to Safari) and on Android Chrome/Firefox. The sealed
  phone↔desktop channel runs in a plain tab.
- **Camera** (`getUserMedia`, if scanning QR in-app rather than via
  system camera): all iOS browsers since iOS 14.3; Android fine.
- **The one hard limit**: iOS suspends a backgrounded page and kills its
  connection; web push exists *only* for home-screen-installed PWAs and
  is **disabled in the EU** (iOS 17.4+). So "a live connection in your
  pocket while locked" is not achievable on iOS via the web. This is
  contained entirely to Tier 2 and is why §2 keeps async delivery out of
  scope: the foreground product (Tier 0) is unaffected, and the Tier-2
  "notify when closed" nicety degrades to a push that just says "open
  peerd to continue" plus a catch-up replay on open.

---

## 5. Security posture

The remote inlet is the highest-stakes surface in the product — it can
drive tabs, run shell in the WebVM, and spend the API budget. It
composes cleanly onto the existing policy-gated dispatcher, Plan/Act, and
spend cap:

- **Paired devices only.** The phone's did:key is on a "my devices"
  allowlist. Anything not on it is **refused by construction at the
  transport**, not confirm-gated — strangers never reach the inlet.
- **Sealed channel.** X25519 ECDH → HKDF → AES-GCM, free from the
  existing transport; DTLS provides hop security underneath.
- **Plan mode default for remote-initiated turns.** Side effects are
  confirm-gated (§3.2), with a hard `spendLimitUsd` cap and full audit
  lineage tagged `origin: remote-peer:<did>`.
- **Auto-execute is opt-in per paired device** (see §7).

---

## 6. The inlet (the one genuinely new piece of code)

Today the *only* thing that injects into the agent loop is `agent/send`
from the side panel (`background/service-worker.js`). This feature adds
**one new gated message source**:

- A SW route — `remote/command` — that the offscreen WebRTC host
  forwards a verified paired-peer command into.
- By default it lands in the composer (voice-style: fills the input,
  does not auto-send), so the desktop user — or the phone user, via the
  mirrored view — confirms before a turn starts. It then calls
  `runAgentTurn` exactly as the side panel does.
- The phone subscribes to the same `uiPorts.broadcast()` fan-out the
  side panel receives, with the `since` cursor from §3.1 added. The SW
  becomes an N-follower broadcaster, one follower of which happens to be
  remote.

No sixth top-level `peerd-*` module. Transport/identity/pairing live in
`peerd-distributed` (the `d`); the inlet + cursor are a thin addition to
`peerd-runtime` / `background`. The brand stays the architecture.

---

## 7. Open questions

- **Cross-device identity (OQ-2 in `distributed/ROADMAP.md`).** The
  minimal, peerd-shaped answer: pairing *itself* establishes the trust
  relationship — the phone gets its own did:key, added to the desktop's
  "my devices" allowlist (a Tier-0 trusted peer). No seed sharing. Full
  WebAuthn-PRF multi-device identity sync stays deferred.
- **Auto-execute opt-in.** Per-device toggle to skip the composer
  staging step (§6) for trusted devices. Default off.
- **Confirmation timeout policy** (§3.2). Default: expire to denied.
  Confirm this is the desired failure mode before building.
- **Phone surface home**: a page under `site/` (recommended) vs. a
  dwapp. `site/` keeps it independent of the dweb channel gating and
  reachable without the extension; revisit if it needs richer
  agent-side integration.
