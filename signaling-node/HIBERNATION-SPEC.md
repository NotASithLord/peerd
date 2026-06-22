# Spec — WebSocket Hibernation for the signaling Durable Object

> Status: **IMPLEMENTED** in `signaling-node/worker.js` (roster-from-sockets,
> §4). The reliability upgrade for the dweb rendezvous node. Removes the
> cold-start / eviction resets that surface in the client as `websocket error
> connecting` and `closed before join confirm`. Deploys with `wrangler deploy`
> (BYOC, code-only — the manual `bootstrap.peerd.ai` route is left untouched).

---

## 1. Problem

The rendezvous Durable Object (`SignalingRoom`) holds each room's WebSockets in
**plain instance memory** (`this.conns`, `this.meta`, `this.state`). That memory
lives only as long as the DO is *active*. Cloudflare **evicts an idle DO** (and
can recycle one under memory pressure or a deploy), which means:

- **Idle-eviction reset.** A lobby that goes quiet (no messages for a while) can
  have its DO evicted even while members believe they're connected. Their sockets
  are dropped; the roster is gone. The base network's `rooms.js` reconnects with
  backoff — but every member re-handshakes, and any in-flight signaling is lost.
- **Cold-start races.** A connection that lands while the DO is spinning up (or
  down) can get reset before the `room` confirm — exactly the
  `websocket error connecting to wss://bootstrap.peerd.ai/rendezvous` and
  `closed before join confirm` lines in the client log.

The client already mitigates this (reconnect-with-backoff, and now
transient-quiet logging — `rooms.js` / `signaling-client.js`). Hibernation fixes
it **at the source**: the DO survives eviction *with its WebSockets attached*.

`worker.js` already flags this as the deferred optimization ("WebSocket
Hibernation is the later optimization for idle rooms to survive DO eviction").

---

## 2. What Hibernation changes (CF API)

The WebSocket **Hibernation API** lets a DO keep WebSockets across eviction: the
runtime parks the sockets, evicts the JS heap, and **re-instantiates the DO on
the next event** (an inbound message, close, or error), replaying it through
handler methods instead of in-memory `addEventListener` closures.

Three required shifts:

1. **Accept via the runtime, not the DO heap.**
   - Today: `server.accept()` + `server.addEventListener('message'|'close'|'error', …)`.
   - Hibernation: `this.ctx.acceptWebSocket(server[, tags])`. The runtime now owns
     the socket; the DO can be evicted and the socket stays open.

2. **Handlers become DO methods, not closures.**
   - `webSocketMessage(ws, message)`
   - `webSocketClose(ws, code, reason, wasClean)`
   - `webSocketError(ws, error)`
   These are called on a (possibly freshly re-instantiated) DO, so **they cannot
   close over per-connection locals** (`connId`, `meta`, the `drop` closure). All
   per-connection state must be recoverable from the socket itself or from
   durable/derivable storage.

3. **Per-connection state must survive re-instantiation.** Two options:
   - **Socket tags + attachment:** `acceptWebSocket(server, [connId])` tags the
     socket; `ws.serializeAttachment({ connId, windowStart, msgCount })` stores a
     small per-socket blob the runtime persists and restores. On wake, recover via
     `this.ctx.getWebSockets()` + `ws.deserializeAttachment()`.
   - **Rebuild the roster from live sockets on wake** (preferred — see §4): the
     reducer state (`this.state`) is just "who is in the room", which is exactly
     `this.ctx.getWebSockets().map(attachment.connId)`. So we don't persist the
     reducer state; we **reconstruct** it from the surviving sockets on first use
     after a wake.

---

## 3. Invariants to preserve (do NOT regress)

- **One reducer, two shells.** `worker.js` and `bun-server.mjs` keep sharing
  `signalingStep` / `initialSignalingState`
  (`extension/peerd-distributed/transport/signaling.js`). Hibernation is a
  **worker-shell** change only; the reducer and the Bun shell are untouched.
- **ROOM_CAP = 16** (the reducer). Unchanged.
- **DoS guards.** `MAX_MSG_BYTES` (64 KB) and the per-connection rate limit
  (120 msg / 10 s) must still apply — but the rate-limit window (`windowStart`,
  `msgCount`) is per-connection mutable state, so it must ride
  `serializeAttachment` (or be accepted as best-effort, reset on wake — a wake is
  rare and resetting the window only *loosens* the limit briefly; acceptable).
- **Ghost reaping.** `#reapDead()` (sockets workerd considers CLOSING/CLOSED whose
  `close` never fired) still runs before each join — but now over
  `this.ctx.getWebSockets()` instead of `this.conns`.
- **Inline teardown on server-initiated close.** The reason `drop()` is called
  inline today (workerd fires `close` only for an *incoming* frame) still holds;
  in the hibernation model the kicked-peer cleanup happens in the STORE/close
  path the same way.

---

## 4. Proposed design (roster-from-sockets, no extra durable storage)

Keep it stateless-per-wake by deriving everything from the live socket set.

### Accept
```js
async fetch(req) {
  if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
  const { 0: client, 1: server } = new WebSocketPair();
  const connId = crypto.randomUUID().slice(0, 8);
  // hand the socket to the runtime (survives eviction); tag + attach per-conn state
  this.ctx.acceptWebSocket(server, [connId]);
  server.serializeAttachment({ connId, windowStart: Date.now(), msgCount: 0 });
  this.#reapDead();                       // over getWebSockets()
  const actions = this.#stepFromSockets({ t: 'join', connId, key: 'room' });
  // dispatch 'send'/'close' actions to sockets resolved via getWebSockets()
  return new Response(null, { status: 101, webSocket: client });
}
```

### Roster reconstruction
```js
#sockets() { return this.ctx.getWebSockets(); }                       // live, post-wake
#connIdOf(ws) { return ws.deserializeAttachment()?.connId; }
#roster()  { return this.#sockets().map((ws) => this.#connIdOf(ws)).filter(Boolean); }
// the reducer's state is rebuilt from the roster on first use after a wake,
// so `this.state` is derived, never the source of truth across hibernation.
```

### Message / close / error (DO methods)
```js
async webSocketMessage(ws, data) {
  const att = ws.deserializeAttachment();
  // size + rate-limit using att.windowStart/msgCount; write back with serializeAttachment
  // parse; if {t:'signal'} → reducer signal step → route to target socket
}
async webSocketClose(ws)  { /* reducer 'leave' for att.connId; runtime drops the socket */ }
async webSocketError(ws)  { /* same as close */ }
```

### Send / route helper
A `send(connId, msg)` resolves the target socket via `getWebSockets()` (match the
tag/attachment), then `ws.send(JSON.stringify(msg))`. A `close` action calls
`ws.close()` and lets `webSocketClose` clean up.

### Auto-response (optional, recommended)
Register a hibernatable **ping/pong auto-response** so the client keepalive
(`{t:'ping'}`, every 25 s — `signaling-client.js`) is answered **without waking
the DO**: `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'))`.
This keeps idle rooms cheap (the keepalive no longer forces a wake) — the main
cost saver hibernation unlocks. (Client already ignores unknown `pong`.)

> Note: the client keepalive currently sends `{t:'ping'}` and the reducer ignores
> it (default case). With auto-response the DO answers `{t:'pong'}` from the edge.
> No client change required; if we want the client to *verify* liveness it can
> start treating a missing pong as a drop — a follow-up, not part of this spec.

---

## 5. wrangler.jsonc

Hibernation needs the **new SQLite-backed DO storage** class migration (hibernation
is only on the new storage backend). Confirm `wrangler.jsonc` migrations declare
the class with `new_sqlite_classes` (or migrate an existing `new_classes` DO).
No new bindings; `SIGNAL_ROOM` stays. Document the migration tag bump in the PR.

---

## 6. Testing

- **Reducer unaffected** — existing `signaling.js` reducer tests stay green (we
  don't touch it).
- **Shell parity** — extend the rooms integration test
  (`tests/peerd-distributed/mesh-rooms.test.ts`, mock-WS) so a simulated
  **DO wake** (drop the in-heap closures, rebuild roster from the mock socket set)
  still routes a `signal` correctly and preserves the roster. This is the
  load-bearing test: it proves per-connection state survives a wake.
- **Manual / `wrangler dev`** — `wrangler dev` runs the DO locally; verify a join
  → idle past the eviction window → a late signal still routes (no reconnect
  storm). Cross-check the client logs go quiet (the transient-logging change means
  a clean hibernation shows nothing at warn level).
- **Load smoke** — N=16 members join, idle, then one publishes; confirm one wake,
  correct fan-out, no ghost accumulation across a wake (`#reapDead` over
  `getWebSockets()`).

---

## 7. Rollout

1. Land the worker change behind the same endpoint (`/rendezvous`) — the wire
   protocol is **unchanged** (same `join`/`room`/`signal`/`full`/`leave`
   messages), so old and new clients interoperate; no client deploy required.
2. `wrangler deploy` to a staging route; point one preview build at it; run the
   two-profile drill (join, idle long enough to evict, reconnect/late-signal).
3. Promote to `bootstrap.peerd.ai`. Because the protocol is unchanged, this is a
   drop-in; roll back by redeploying the current `worker.js` if needed.

---

## 8. Out of scope (explicitly)

- The **Bun shell** (`bun-server.mjs`) — long-lived process, no eviction, no
  hibernation needed. Stays as-is (the no-account local equivalent).
- Cross-DO / multi-region rooms, persistence of room *history* (the rendezvous is
  ephemeral by design — it relays handshakes and forgets).
- Any reducer change. If a future need (e.g., persisting `seq`/anti-replay across
  a wake) appears, it gets its own spec.

---

## 9. Effort

~0.5–1 day for the worker refactor + the wake-survival test, plus a staging deploy
+ the two-profile drill. Low risk: protocol-compatible, reducer untouched, Bun
shell untouched, rollback is a redeploy.
