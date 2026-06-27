# DESIGN-18 — origin actors: tabs and APIs are the same thing

> Status: DESIGN (forward record — not yet built). Feature 18, the 0.2-defining
> change. Builds directly on DESIGN-17 (`DESIGN-17-actor-agents.md` +
> `DESIGN-17-DEV-NOTES.md`) — read those first; this generalizes the web actor
> landed there. Owner decisions (2026-06-27): **unify** (one origin actor, a tab
> is an optional backing — NOT a sibling `actorType:'api'`); **boundary-injected
> keyless** credentials; **auto-form from use + explicit key grant**.

## The thesis

A browser tab and an API integration are the same thing: **an endpoint to one
origin.** A tab additionally renders a DOM; an API endpoint does not. That is the
*only* difference. Today (DESIGN-17) the web actor already owns 0-or-1 tab and
already reaches origins two ways — a sessionless/`session-scoped` `fetch_url` and a
driven tab. DESIGN-18 finishes the thought: the web actor owns an **origin**, the
tab is one optional way to back that origin with a DOM, and an **API integration**
is simply an origin actor that has no tab — a first-class, addressable,
memory-accumulating citizen, tracked exactly like a tab.

No new actor type. The `web` actor IS the origin actor. "API integration" is a
*state* of it (origin-backed, tabless), not a new kind.

## Goals

1. **One abstraction.** An origin actor owns one origin. It always holds
   `fetch_url`. It holds the DOM toolset *only when* it has a tab backing. APIs
   and web pages stop being different machinery.
2. **Addressable like a tab.** The orchestrator reaches an API integration the
   same way it reaches a tab — `message_actor`, by a stable handle. Origin IS the
   handle (and the security lock).
3. **Memory that accumulates.** An origin actor learns its origin — endpoints,
   auth shape, pagination, rate limits, quirks — and carries that forward across
   messages, the same self-fenced rolling summary the web actor already uses, but
   tuned to "what I learned about this API."
4. **Authenticated, still keyless.** An origin actor can call a keyed API
   (Stripe, GitHub) without ever holding the key. The vault binds a secret to the
   origin; the **egress boundary** injects it, same-origin only. A
   prompt-injected actor can't exfiltrate a key it never sees.
5. **No churn to the security invariants.** Origin-lock, fail-closed, the
   untrusted-content fence, and the `web:write` confirm all carry over unchanged —
   they generalize for free, because they were already origin-shaped.

## The unified model

### An origin actor owns a *current origin*

The web actor's credential rule today is already the whole design: cookies ride a
request **only when same-origin to the actor's owned origin**, decided at the
egress boundary (`withSessionScopedCredentials`, reading `activeTab.origin`). The
generalization is one line of conceptual change:

> The actor's **owned origin** is whatever its backing says it is.
> - **Tab backing** → the owned origin is the tab's *live* origin (mutable: it
>   changes as the tab navigates; credentials follow).
> - **API binding** → the owned origin is a *fixed* origin (immutable: no tab, no
>   navigation; the key/cookies are scoped to that one origin for the actor's
>   life).

The boundary doesn't care which. It asks one question — "is this request
same-origin to the owned origin?" — and the answer comes from a `getOwnedOrigin()`
closure that reads `activeTab.origin` for a tab actor or the bound origin for an
API actor. **Same boundary, different origin source.** That is the entire unify.

### Backings, not types

| Backing | Owned origin | `fetch_url` | DOM tools | Identity |
|---|---|---|---|---|
| **Unpinned** (`to:'web'`) | none yet | yes (sessionless) | no | the chat's web actor |
| **Tab** | tab's live origin | yes (session-scoped) | yes | tabId → origin |
| **API binding** | fixed origin | yes (session-scoped + key) | **no** | the origin |

An origin actor moves between backings over its life: `to:'web'` starts unpinned;
its first `fetch_url` pins nothing (sessionless), its first `navigate` adopts a
*tab* backing (DESIGN-17 lazy adoption), and an API integration is *born* with a
fixed-origin backing. DOM tools are gated on "do I have a tab right now"; the gate
already refuses them for the wrong ctx — it just learns one more reason (no tab →
no DOM).

### Why no `actorType:'api'`

The recon showed ~90% of the web-actor machinery is already generic
(mint/resolve/registry/memory/redrain/egress) or cleanly gated on
`actorType === 'web'`. A sibling type would duplicate all of it and create two
things to keep in sync. Unifying keeps one type (`web`), one mint path, one
memory path, one egress path — the backing is a property of the binding, read
where it matters (DOM-tool gate; `getOwnedOrigin`; the orchestrator's display
label). This is the owner's "they're effectively the same, one just has a DOM
option" made literal.

## Credentials: boundary-injected, origin-scoped, keyless

The actor stays **keyless** — the capability strip leaves it no `getSecret`. A
keyed API works without breaking that:

1. **The vault gains origin-bound secrets.** A secret stored under
   `origin:<origin>` (mirroring the existing `git:<host>` scoping the WebVM
   already uses), carrying `{ header, scheme, value }` — default
   `Authorization: Bearer <value>`, but `X-API-Key`/custom supported because real
   APIs differ.
2. **The boundary injects it, same-origin only.** The session-scoped `webFetch`
   wrapper gains an injection step: for a request **same-origin to the owned
   origin**, if a vault `origin:<origin>` secret exists, it adds the configured
   auth header. The injection reads the vault *inside the boundary closure* (the
   SW has vault access); the actor's ctx never holds the secret. Cross-origin
   requests get nothing — same wall as cookies.
3. **The actor cannot launder it.** It has no `getSecret`, can't set the auth
   header itself (the same header-strip that blocks a forged `Cookie` blocks a
   forged `Authorization`), and the boundary refuses to inject cross-origin — so
   even a fully prompt-injected actor can neither read the key nor send it
   anywhere but its own origin. Non-GET writes still hit the `web:write` confirm.

The unification pays off again: this is the *same* same-origin rule as cookies,
extended from "the browser's cookie jar" to "the vault's key for this origin." A
tab actor benefits identically — render `github.com`, and `fetch_url` to
`api.github.com`'s endpoints carries the GitHub key if one is vaulted, no special
case.

### The grant is the user's, never the agent's

Because the actor is keyless, the key must come from the **user**, not the model.
The flow:

- The agent can *request* a connection — surface a "connect <origin>" card when it
  hits a 401/403 or is asked to work a keyed API.
- The user supplies the key through a secure gesture (a vault write, confirmed
  like any secret). Settings → API Integrations is the management surface (list,
  add, revoke).
- Thereafter the origin actor authenticates transparently and the model never
  touches the key.

This is "explicit key grant": the *credential* is always an explicit, confirmed,
user-owned act; only the *addressing + memory* auto-form (below).

## Lifecycle: auto-form from use, persist when it matters

- **Auto-form.** The first time the orchestrator does origin work — a `fetch_url`
  or a `navigate` to origin X — an origin actor for X is tracked. Address it again
  by origin and you reach the *same* actor, with its accumulated memory. No
  ceremony; integrations form from use.
- **Promote to durable.** An origin actor becomes a first-class, persisted
  integration when it has something worth keeping: accumulated memory and/or a
  vaulted key. (Ephemeral, memory-less touches don't clutter the integration
  list.)
- **Supervisor restart.** Lost session + live binding → re-mint on next message
  (the DESIGN-17 let-it-crash pattern, unchanged). The durable mailbox + boot
  redrain are already generic and carry origin handles verbatim.

### Memory scope (v1 vs forward)

v1: per-origin memory is **chat-scoped** (like today's web actor) — re-learned per
chat. The vaulted **key** is global (the vault isn't chat-scoped), so auth is
durable from the first grant. Forward (rides Profiles, "still ahead"): promote the
*learned memory* to profile-scoped so an integration carries its knowledge across
chats — the genuinely "first-class citizen" end state. Flagged, not built here.

## Addressing & the orchestrator surface

- **Origin is the handle.** `message_actor(to:'<origin>', goal)` — e.g.
  `to:'https://api.stripe.com'` (normalized; a bare host accepted and normalized to
  `https://`). The origin is identity *and* lock — one source of truth.
- **Back-compat handles stay.** `to:'web'` = the chat's unpinned origin actor (open
  web work; it picks origins). `to:'<tabId>'` = the tab-backed origin actor for
  that tab (resolves to its live origin). These are the same actor reached by
  different handles.
- **Discovery.** A `list_integrations` tool (sibling of `list_tabs` / `vm_list`)
  enumerates the origin actors the orchestrator can address — origin, label,
  whether keyed, last-used. Tabs stay in `list_tabs`; integrations (tabless origin
  actors) list here. The home UI surfaces durable integrations as cards alongside
  agent-tab cards.

## Security model (carried over, generalized)

- **Origin lock.** Credentials (cookies *and* the vaulted key) ride only
  same-origin to the owned origin — enforced at the egress boundary, not the tool.
  Cross-origin is sessionless and keyless. (Generalizes DESIGN-17 verbatim.)
- **Keyless actor.** No `getSecret`, no allowlist-locked `safeFetch`; only the
  origin-scoped `webFetch`. The key is injected at the boundary, never held.
- **Fail-closed.** An API actor has no tab, ever — DOM tools refuse at the gate
  (no foreground-tab fallback). A missing/locked vault → no injection, the request
  goes unauthenticated (and likely 401s) rather than leaking anything.
- **Untrusted fence.** Every byte of an API response is DATA, wrapped
  `<untrusted_web_content>`, never instructions — the same fence `fetch_url` already
  applies.
- **Write confirm.** Non-GET to any origin still routes through the shared
  `web:write` confirm — one approval governs `fetch_url`, the WebVM bridge, and
  keyed API writes alike.

## The seams — what changes (from the recon map)

Most of this is *additive branches*, not rewrites — the web-actor machinery is the
template.

1. **Binding store** (`subagent/web-actor.js`, SW ~2470). Generalize the tab→session
   binding to an **origin→session** binding that also keys tabless origins. One
   store, keyed by an origin handle; a tab actor's handle derives from its live
   origin, an API actor's from its fixed origin.
2. **Addressing** (`subagent/actor-messaging.js`, `tools/defs/message-actor.js`, SW
   `resolveActor`). New resolve branch: an origin-shaped `to` → resolve/lazy-mint
   the origin actor for that origin. Naming: "The <origin> integration".
3. **Session shape** (`sessions/types.js`). `instanceId` for an origin actor = its
   origin; a `backing: 'tab' | 'api'` discriminator (or derive from "has a live
   tab"). `actorType` stays `'web'`.
4. **Tool scoping** (`tools/exposure.js`, `tools/gates.js`). `ACTOR_TYPE_TOOLS.web`
   unchanged; the gate gains "DOM tools require a tab backing" so a tabless origin
   actor is `fetch_url`-only.
5. **Memory** (`subagent/web-actor.js`, `loop/rolling-summary.js`). A second
   summary prompt tuned to "what I learned about this API"; the fence + state shape
   reused as-is. Selected by backing.
6. **Origin-lock + key injection** (`peerd-egress/fetch/web-fetch.js`,
   `tools/defs/fetch-url.js`, SW `buildToolContext`). `getOwnedOrigin()` reads tab
   origin OR fixed origin; the wrapper gains the same-origin vault-key injection
   step. The vault gains `origin:<origin>` secrets.
7. **Orchestrator visibility** (`tools/defs/list-integrations.js` new; home UI
   cards). Enumerate durable integrations.
8. **Lifecycle** (SW `mintActor`/`mintOnce`/redrain). One more mint path
   (origin-backed); redrain already generic.
9. **The grant flow** (a connect tool + Settings → API Integrations + vault writes).
   User-owned, confirmed.

### Spots that assume "an actor has (or may get) a tab"

These need an explicit "API backing has no tab, ever" branch (the recon flagged
each): `buildToolContext` active-tab resolution; the DOM-tool gate; `adoptWebTab`
(already web-gated — must NOT be offered to an API backing); `fenceActorSummary`
injection (add the API summary); `noteAgentTab` tracking (add an integration card
path). `fetch_url` itself is already tab-agnostic.

## Phasing

- **P0 — the unify (keyless).** Generalize the web actor to own an origin; the
  origin→session binding; origin addressing + lazy auto-form; the DOM-tools-need-a-
  tab gate; per-origin memory prompt; `getOwnedOrigin` for fixed-origin actors.
  Ships first-class API integrations for **public + same-origin-cookie** APIs. No
  vault changes. Fully gateable end-to-end (bun + in-browser + e2e).
- **P1 — credentials.** Vault `origin:<origin>` secrets; the boundary key-injection
  step; the connect/grant flow + Settings surface. Ships **authenticated** APIs.
- **P2 — surface & polish.** `list_integrations`, home cards, cost per integration,
  the orchestrator prompt lore for "address an API by origin," docs.
- **Forward (not 0.2).** Profile-scoped integration memory (cross-chat learning);
  schema/endpoint discovery tools; an alias layer (`to:'stripe'` → origin).

## Open questions

1. **Origin normalization.** Accept bare host and normalize to `https://`? Reject
   non-https origins for keyed integrations (a key must never ride http)? (Lean:
   yes to both — https-only for any keyed origin.)
2. **One integration per origin per chat, or global?** v1 chat-scoped memory,
   global key (above). Revisit with Profiles.
3. **Key header variety.** Default `Authorization: Bearer`; support `X-API-Key` and
   query-param auth? (Lean: header-based v1; query-param auth deferred — it leaks
   into URLs/logs and wants more care.)
4. **Tab actor + vaulted key.** Should rendering `github.com` auto-inject a vaulted
   `api.github.com`-adjacent key? Origins differ (`github.com` ≠ `api.github.com`),
   so no by the strict same-origin rule — correct and safe. Cross-subdomain key
   sharing is explicitly out (a deliberate non-goal).
