# peerd-distributed — Migration & Integration

> How `peerd-distributed` slots into the existing module structure: what
> changes in `peerd-egress`, `peerd-engine`, `peerd-runtime`, and the
> chassis (`background/`, `offscreen/`), and where the `chrome.runtime`
> boundaries fall between modules.

The guiding constraint: **distributed composes existing capabilities; it
re-implements none of them.** Identity reuses the vault. Apps reuse the
engine App runtime. The network host reuses the offscreen keepalive.
Audit reuses the egress log. The migrations below are mostly *additive*
and *injective* (new deps passed in), matching "functional core,
imperative shell."

---

## 1. Module dependency changes

```
Before:  distributed = stub
After:   distributed ──depends on──► peerd-egress   (vault, audit, idb, safeFetch)
                       ──depends on──► peerd-runtime  (session ctx, untrusted-wrap, tool grants)
                       ──hosted in───► offscreen doc  (network host)
                       ──feeds───────► peerd-engine   (installs app bundles into App runtime)
```

No new top-level `peerd-*` module (the brand commits to five). No Layer-1
module gains a dependency on distributed. ESLint `no-restricted-imports`
gets `peerd-distributed` added to the allowed-from-runtime/chassis set,
and distributed's own deep paths stay private behind its `index.js`.

---

## 2. `peerd-egress` changes (Layer 1) — small, additive

`peerd-egress` is where identity, audit, and durable storage live. Changes:

1. **Vault — no API change, new secret names.** Distributed stores its
   keys as ordinary vault secrets:
   - `distributed/identity/seed` (Ed25519 seed)
   - `distributed/enc/x25519` (X25519 private subkey)
   - per-agent subkey secrets.
   These use the existing `setSecret`/`getSecret`. **The PRF path already
   exists** (`enrollWithPrf`, `getPrfOutput`, `vault/webauthn.js`) — the
   identity seed is HKDF'd from that PRF output (ARCHITECTURE §3.1). No new
   crypto in the vault.
   - *One small addition:* expose a thin `vault.derivePrfSeed(info)` helper
     (HKDF over the already-available PRF output with a domain-separated
     `info`) so distributed doesn't reach into vault internals. ≤15 lines,
     lives in `vault/`, re-exported from `peerd-egress/index.js`.

2. **Audit — new event types only.** Append the distributed event names
   (PROTOCOL §8) to `audit/types.js`. No change to `createAuditLog`,
   storage, or the append API. Distributed calls `auditLog.append(...)`
   exactly as the rest of the system does.

3. **IDB — one version bump, new stores.** Add object stores `peers`,
   `dht`, `content`, `relay`, `curation` (ARCHITECTURE §9) to
   `storage/idb.js` (`DB_VERSION` 1→2, additive `onupgradeneeded`).
   Existing stores (`sessions`, `audit_log`, `tool_grants`, `vm_state`)
   untouched. Distributed uses the existing `read`/`write`/`put`/`get`/
   `getAll` helpers — no bespoke IDB code.

4. **Egress fetch — signaling allowlist.** Bootstrap signaling is a
   WebSocket, not `fetch`, so it doesn't pass through `safeFetch`. But the
   *allowlist concept* is reused: distributed keeps a bootstrap-origin
   allowlist (`distributed.bootstrap.v1`) with the same "hardcoded +
   explicit user grant" shape as `HARDCODED_ALLOWLIST`, and the same audit
   on additions (`signaling_node_added`). HTTPS content fetches (e.g.
   fetching a manifest from a known-holder's HTTPS surface, if ever) go
   through `safeFetch`/`webFetch` unchanged.
   - *CSP note:* `manifest.json` already permits this — `connect-src` lists
     `wss:` (signaling WebSockets) and `https:` (content). WebRTC ICE/DTLS —
     **including STUN** — is not governed by `connect-src`, so **no manifest
     CSP change is required** (`ARCHITECTURE §6.5`, `PROTOCOL §3.5`). There
     is no TURN client and no TURN credential flow (D-5, `NORTH-STAR.md`).
     The RTCPeerConnection lives in the offscreen network host (§5), not
     the SW.

**Net egress change:** one tiny vault helper, a list of audit-type strings,
an additive IDB version bump, and a bootstrap allowlist object. No security
primitive is modified or weakened.

---

## 3. `peerd-engine` changes (Layer 1) — the app permission bridge

Today the App runtime is **one-way**: parent composes HTML → `document.write`
into the sandboxed `app-tab/runner.html`; the app cannot call back. A
`peerd://` `app` that wants distributed APIs (publish a post, send a
message, read its own social graph) needs a **return path** — and that path
is the one new privilege boundary in the module, so it must mirror egress.

Changes:

1. **`apps/loader.js` (in distributed) installs into the existing
   runtime.** A fetched, verified `app` bundle's bytes are written to OPFS
   under the existing `peerd-apps/<appId>/` layout and opened via the
   existing app-client/app-tab-tracker path. The engine's storage and
   sandboxing are reused verbatim. The only new field is provenance:
   `AppRecord` gains optional `source: { uri, publisher }` so the UI can
   show "installed from peerd://… by did:key:…". Additive to the
   `app-registry.js` record.

2. **`apps/bridge.js` (in distributed) + a postMessage handler in the app
   tab.** The runner gains the *ability* to `postMessage` a request to its
   parent (`app-tab/index.html`), which forwards it to the SW over the
   existing messaging surface. The protocol:

   ```
   app → parent → SW :  { type:'app-api', appUri, method, args, requestId }
   SW → parent → app :  { type:'app-api-result', requestId, ok, value|error }
   ```

   **Every `method` is permission-gated by the egress confirm model.** The
   SW checks a per-`(appUri, permission)` grant (stored in the existing
   `tool_grants` IDB store, session-scoped exactly like tool grants); if
   absent, it routes through `makeConfirmCoordinator` ("App *X* wants to:
   send a message as you · Yes once / Yes this session / No"). Denied →
   `app_permission_denied` audit; granted → `app_permission_granted`.

   The set of `method`s is a small, explicit allowlist (`publishPost`,
   `sendMessage`, `subscribe`, `readFeed`, …) — apps get *no* raw access to
   the vault, the DHT, or arbitrary egress. This is the egress model 1:1:
   capability is mediated, confirmed, audited, session-scoped, and
   default-deny.

3. **Sandbox unchanged.** Opaque origin, no `chrome.*`, postMessage-only
   (existing `runner.html` guarantees). The bridge does not widen the
   sandbox; it adds a *narrow, gated* request channel through the parent.

This is the highest-value security review item in the module (THREAT-MODEL
§10). It was originally slotted last (old ROADMAP Phase 4); the 2026-06-12
resequencing (D-6, `NORTH-STAR.md`) pulls a **minimal bridge v0** into
Phase 1 because the demo dwapp needs it — with the compensating controls
named there: the ~ten-call surface frozen for the phase, grants mirroring
the egress confirm model 1:1, D-8 domain-separated signing, and a
dedicated security review before the demo.

---

## 4. `peerd-runtime` changes (Layer 2) — context, not core

Distributed composes runtime; runtime gains small hooks, not logic.

1. **Untrusted-content wrapping is reused for peers.** Runtime already
   wraps web content `<untrusted_web_content …>` before it reaches the
   model. Distributed-delivered peer content (a message, an app's data, a
   delegated task description) is wrapped `<untrusted_peer did:key="…"
   received_at="…">` by the **same** runtime helper, generalized to take a
   source descriptor. One function signature widens; the policy is shared.

2. **Decentralized-web (dweb) trust on delegated tasks.** When a
   delegated task arrives from a peer (Phase 1+), runtime runs it under
   the **local** session's trust mode and confirmation policy. This is a
   new *entry point* into the agent loop (a task originating from
   distributed rather than the side panel), but it reuses the existing
   dispatcher, trust gates, and confirm coordinator — no parallel
   execution path.

3. **Session sharing (optional, later).** "View/fork a session" (the V1
   §2.5 `share-session` idea) is a content bundle of a session transcript
   published under the user's identity, opened read-only or forked. It
   reuses the content path; runtime exposes a session-serialize/deserialize
   it likely already needs for export. Not on the critical path for the
   "web 3.0" beat.

No change to the agent loop, tool dispatcher, or session store internals.

---

## 5. Chassis: the network host (`offscreen/` + `background/`)

This is the structurally most significant change and the one MV3 forces.

### 5.1 Where the network lives

```
Service Worker (background/)            Offscreen doc (offscreen/)
────────────────────────────           ──────────────────────────────
• orchestration & policy               • ALL RTCPeerConnections
• identity (via vault, in SW mem)       • data channels (5 logical, PROTOCOL §3.2)
• trust-tier decisions (pure fns)       • Kademlia node + routing table
• audit append                          • signaling WebSocket client
• message routing (ports)               • chunk transfer I/O
• signing-payload construction          • relay storage I/O (IDB)
• dies at 30s idle — holds no socket    • kept alive by existing keepalive
                                          port + 20s heartbeat (DECISIONS #14)
        │  ▲                                     │  ▲
        │  │  chrome.runtime port                │  │
        └──┴──  name: 'distributed'  ───────────┴──┘
```

- **Why the offscreen doc:** the SW cannot hold a socket — it dies at the
  30s idle timer (V1 `DECISIONS.md` #7/#14). The offscreen doc is already
  the long-lived network/compute host (it runs the WebVM engine) and is
  already kept alive by the keepalive port + heartbeat. WebRTC, the DHT,
  and sockets go there; the SW orchestrates.
- **The split honors "functional core, imperative shell":** trust
  decisions, signing-payload construction, record validation, and tier
  policy are **pure functions that live in the SW** (and are unit-testable
  with Bun, no browser); the impure socket/RTC/IDB I/O lives in the
  offscreen host. The SW asks "may this peer connect / is this record
  valid / what should I sign," gets a verdict, and tells the host to act.

### 5.2 New RPC surface

A new long-lived port `'distributed'` between SW and offscreen, routed
through the existing `shared/messaging.js` typed dispatcher. Representative
RPCs (SW→host) and events (host→SW):

```
SW → host:  dist/connect {did|pairingCode}, dist/send {did,msg},
            dist/dht-op {op,...}, dist/announce {hash},
            dist/install-app {uri}, dist/set-reachable {bool}
host → SW:  dist/peer-event {connected|disconnected|...},
            dist/inbound {did, channel, body},   // → trust check → maybe model
            dist/transfer-progress {...}, dist/audit {type, details}
```

The host never makes a *policy* decision: inbound frames are signature-
verified at the host (cheap, local), then handed to the SW for the
trust-tier/confirm verdict before anything reaches the agent loop.

### 5.3 Offscreen lifetime policy (OQ-1) — the real product call

V1 spawns the offscreen doc lazily per session and closes it after idle, to
save power. Being a useful **relay / discoverable peer** wants it alive
whenever Chrome is open. Proposed policy:

- **Default:** lazy, as today. Distributed is reachable only while a
  session/transfer is active. No background battery cost.
- **Opt-in "stay reachable" mode:** the user enables it; the offscreen doc
  stays alive whenever the browser is open, with a **visible indicator**
  (a status the side panel surfaces, respecting the a11y/reduced-motion
  patterns). Only then does the instance act as a relay / advertise
  presence / maintain the prewarm set (Q3).
- This keeps the power tradeoff a user choice, never a silent default, and
  keeps Phase 0/1 demos working without committing to always-on.

### 5.4 Firefox (OQ-4)

`chrome.offscreen` is Chrome-only. Firefox has no offscreen document. The
network host needs a Firefox home — a persistent background page or a
dedicated hidden extension tab. This is isolated to the *host placement*;
the protocol, identity, and policy code are engine-agnostic. Tracked on
the Firefox-parity track, out of scope for the Chrome-first phases.

---

## 6. Documentation edits to land alongside Phase 0

These reconcile the existing V1 docs with this plan (ROADMAP
"Reconciliation"). Mechanical, but do them so the repo stays coherent:

1. **`extension/peerd-distributed/index.js` stub comment:** change
   "ECDSA keypair derived from vault" → "Ed25519 keypair, seed derived via
   vault WebAuthn PRF (did:key)"; update the per-phase contents to match
   `ARCHITECTURE.md §2` here; drop the `gateway/` line (not a dweb
   concern); note "dwapps = `app`-type content, not a separate runtime."
2. **`ARCHITECTURE.md §2.5`:** ECDSA → Ed25519; update the directory tree
   and phasing to this plan; keep the Layer-3 placement and the
   inside-vs-between test (both correct).
3. **`ROADMAP.md` V2.3:** ECDSA → Ed25519; reflect the compressed phasing
   (content wedge at V1, DHT at V2.0) or cross-link this doc as the
   authoritative distributed roadmap.
4. **Marketing site:** no change required — its "WebRTC + browser-derived
   cryptographic identity + WebTorrent-style distributed → dweb
   swarms" copy is consistent with this plan (WebTorrent-*style* chunking,
   not the WebTorrent library; PROTOCOL §4.3).

---

## 7. Build-order summary (slots into the V1 "where to start" order)

The V1 build order ends at "wire it together in the SW." Distributed
appends after the V1.x foundation, in the ROADMAP phase order
(resequenced 2026-06-12 — `NORTH-STAR.md`, D-6):

1. Phase 0 wedge — transport + content + manual pairing. ✅ shipped
   (preview channel).
2. Phase 1 — rooms, gossip + sync, bridge v0, app loader, persistent
   identity, the commons demo app. **The demo beat.**
3. Phase 2 — field resilience: multi-bootstrap failover, peer cache,
   offscreen-lifetime policy, peer-assisted relay (if telemetry says so).
4. Phase 3 — the DHT + PRF identity maturity. Discovery at scale.
5. Phases 4–5 — async messaging, curation/social graph, abuse maturity.

Every phase is independently shippable and reversible; nothing in
distributed may introduce a non-exportable, server-only artifact
(constraint §6, ARCHITECTURE §11).
