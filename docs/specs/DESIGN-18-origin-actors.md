# DESIGN-18 — origin actors: tabs and APIs are the same thing

> Status: DESIGN (forward record — not yet built). Feature 18, the 0.2-defining
> change. Builds directly on DESIGN-17 (`DESIGN-17-actor-agents.md` +
> `DESIGN-17-DEV-NOTES.md`) — read those first; this generalizes the web actor
> landed there. Owner decisions (2026-06-27): **unify at the orchestrator
> surface** (one mental model, one `actorType:'web'`, addressed the same way — NOT
> a sibling `actorType:'api'`); **boundary-injected keyless** credentials;
> **auto-form from use + explicit key grant**.
>
> This spec was hardened by two adversarial reviews (security + architecture)
> before a line was written. Their findings are folded in as NORMATIVE rules and
> an honest scope. The single biggest correction: **the binding is two stores, not
> one** — tab actors stay tabId-keyed (a tab's origin is mutable as it navigates),
> API actors are origin-keyed; they unify at the *addressing surface*, not the
> binding layer.

## The thesis

A browser tab and an API integration are the same thing: **an endpoint to one
origin.** A tab additionally renders a DOM; an API endpoint does not. That is the
*only* difference the orchestrator should have to think about. Today (DESIGN-17)
the web actor already owns 0-or-1 tab and already reaches origins two ways — a
sessionless/session-scoped `fetch_url` and a driven tab. DESIGN-18 finishes the
thought: an **API integration is a web actor that has no tab** — a first-class,
addressable, memory-accumulating citizen, reached through `message_actor` exactly
like a tab.

No new actor type. `actorType` stays `'web'`. "API integration" is a *backing* of a
web actor (origin-backed, tabless), distinguished by a `backing` discriminator
that matters in exactly two places — the DOM-tool gate and the display label —
not a new kind with its own prompt/toolset/mint duplication.

## What "unify" means (and doesn't)

**Unify at the surface — real.** The orchestrator addresses every origin actor
through one channel, `message_actor(to:…)`, by a handle. Tabs and APIs look like
one kind of thing (a web/origin endpoint) and are tracked the same way. This is
the whole of the owner's thesis and it holds completely.

**Unify the binding store — NOT done, by design.** A tab actor's owned origin is
**mutable**: it changes every time the tab navigates (shop.com → checkout.com), so
its binding is keyed by the stable **tabId** and the origin is a *derived field
read live, per request*. An API actor's owned origin is **fixed for its whole
life**, so its binding is keyed by the **origin**. Forcing both into one
origin-keyed store would re-key a tab actor on every navigation and orphan its
accumulated memory — so we don't. Two parallel stores, unified only where the
orchestrator looks.

This keeps the DESIGN-17 tab machinery **untouched** (it just landed and is
correct) and makes the API actor purely **additive** — a second store, a second
mint path, a second resolve branch.

## The model

### An origin actor owns a *current origin*; the boundary scopes to it

The web actor's credential rule today is already the design: cookies ride a
request **only when same-origin to the actor's owned origin**, decided at the
egress boundary (`withSessionScopedCredentials`, reading the owned origin via a
`getOwnedOrigin()` closure). The generalization is one line:

> `getOwnedOrigin()` reads the tab's **live** origin for a tab actor, or the
> **fixed** bound origin for an API actor. Same boundary question ("is this
> request same-origin to the owned origin?"), different origin source.

### Backings, addressing, identity

| Backing | Handle (`to:`) | Owned origin | Binding key | `instanceId` | `fetch_url` | DOM tools |
|---|---|---|---|---|---|---|
| **Unpinned** | `'web'` | none yet | (chat → session) | `'web'` (literal) | yes, sessionless | only after it adopts a tab |
| **Tab** | `'<tabId>'` | tab's **live** origin | **tabId** | `String(tabId)` | yes, session-scoped | yes |
| **API** | `'<origin>'` | **fixed** origin | **origin** | the origin | yes, session-scoped (+key, P1) | **never** |

The three handle shapes are disjoint by construction — the literal `'web'`, a
numeric tabId, an origin string — so `resolveActor` dispatches with no ambiguity.
The unpinned `'web'` actor and a tab actor are the **same DESIGN-17 machinery,
unchanged**; the API actor is the new, parallel, origin-keyed path.

### No collision between the chat actor and an API actor

A subtlety the architecture review surfaced: the chat `to:'web'` actor can
`fetch_url` an API origin sessionlessly *without* that forming an integration —
and that's correct. **An API integration forms only when first addressed by its
origin handle** (`to:'<origin>'`), the same lazy-mint shape as `to:'web'`. A
one-off `fetch_url` from the chat actor is ephemeral and forms nothing; reaching
for `to:'<origin>'` is the deliberate "use" that auto-forms the durable,
memory-bearing, (P1) keyed integration. The two never compete for one handle, and
no incidental fetch mints a parallel session.

### instanceId stays distinct per backing

The unpinned chat actor keeps `instanceId:'web'` (load-bearing: the `deliver()`
namer special-cases it, and it must stay a non-origin literal so the trusted turn
lead never carries a derived string). A tab actor keeps `String(tabId)`. An API
actor's `instanceId` is its origin — and since the orchestrator *chose* that
origin (it's not page-controlled, unlike a tab title), it's safe in the lead, but
it is normalized through `new URL(x).origin` before it ever reaches the namer (no
raw agent string in the trusted lead).

## Credentials: boundary-injected, origin-scoped, keyless (P1)

The actor stays **keyless** — the capability strip leaves it no `getSecret`. A
keyed API works without breaking that, by **copying the already-shipped
`git:<host>` precedent verbatim** (`peerd-engine/vm-net/git-credentials.js` +
`makeInjectGitAuth` in `vm-http-fetch.js`). That precedent is battle-tested and
implements this exact shape correctly; DESIGN-18 builds its `origin:<origin>`
analog. The security review confirmed the design **holds** *provided these become
NORMATIVE rules* (each is where a naive implementation would regress vs. the git
precedent):

1. **Origin-bound vault secret.** Stored under `origin:<origin>` carrying
   `{ header, scheme, value }` — default `Authorization: Bearer <value>`;
   `X-API-Key`/custom supported.
2. **https-only — a RULE at both grant and send.** Reject storing an
   `origin:<origin>` secret unless the origin is `https:` (grant time). At the
   boundary, inject **only** when the *resolved request URL* is `https:` (send
   time), independent of the stored origin. A key never rides cleartext. (Mirrors
   `authHostForRequestUrl`'s `protocol !== 'https:'` → null.)
3. **Same-origin via `URL.origin`, never a synthesized form.** The owned origin
   for an API actor is `new URL(x).origin` of an https URL — never the
   `originOfTabUrl` chrome:/about: synthesized string. The comparison is
   origin-equality, immune to `api.stripe.com.evil.com` / userinfo / port tricks.
4. **Single-shot, pre-fetch injection; redirects refused.** Inject once against
   the original same-origin URL *before* `webFetch`; `webFetch` already forces
   `redirect:'manual'` and throws `redirect_blocked` on any 3xx, so a same-origin
   request that 302s to an attacker never carries the header off-origin. Never add
   a "follow + re-inject" path.
5. **Strip set is computed, merge is last-wins.** The header strip must include
   the *configured* header name for the owned origin (not just the fixed
   Cookie/Authorization/Proxy-Authorization set) so the actor can't pre-seed an
   `X-API-Key` slot; injection overwrites last (`{ ...actorHeaders,
   ...injectedAuth }`) so an actor-supplied value can never win or suppress.
6. **Value only on the wire.** The injected secret appears in exactly one place —
   the outbound request. It is NEVER logged, audited, error-messaged, or returned.
   The injection audits the header **NAME** and origin only (`{ type:
   'origin_auth_attached', details: { origin, header } }`), exactly as
   `git_auth_attached` logs `{ host }`.
7. **Fail closed, silently.** Locked or missing vault → no header, no thrown
   error; the request proceeds **unauthenticated** (and likely 401s). Copy the
   `catch { /* anonymous */ }; if (!token) return headers` shape verbatim — never
   surface the lock state as a value-bearing failure.
8. **Write confirm unchanged, value-free.** A non-GET to the owned origin still
   hits the shared `web:write` confirm (it fires on *method*, before injection),
   and the confirm summary stays value-free — never "keyed ⇒ safe."

**Accepted residual (named honestly):** a key is only as contained as its owned
origin. An open-redirect or SSRF *on the owned origin itself* can launder it — this
is inherent to bearer auth and out of the boundary's scope, the same exposure
cookies and `git:<host>` already accept. The `web:write` confirm still gates the
non-GET exfil channel.

### The grant is the user's, never the agent's

Because the actor is keyless, the key comes from the **user**. The agent may
*request* a connection (surface a "connect <origin>" card on a 401/403 or when
asked to work a keyed API); the user supplies the key through a confirmed vault
write; Settings → API Integrations is the management surface (list, add, revoke).
Thereafter the actor authenticates transparently and the model never touches the
key.

## Lifecycle & memory

- **Auto-form.** An API integration is lazily minted the first time it's addressed
  by `to:'<origin>'` (the DESIGN-17 `mintOnce` / let-it-crash / boot-redrain
  machinery, generic, carries origin handles verbatim).
- **Per-origin memory — free for API actors.** An API actor has exactly one origin
  for its whole life, so per-session memory *is* per-origin: it gets the rolling
  self-fenced summary "what I learned about this API" with no cardinality change.
  This is the honest subset that ships.
- **Deferred: per-origin memory for the cross-origin chat actor.** The `to:'web'`
  chat actor spans origins on one session (one memory blob today). True per-origin
  memory for it would require one session per (chat, origin) — a session-cardinality
  rework, explicitly **out of P0/P1** (rides Profiles, "still ahead"). The chat
  actor keeps its single cross-origin summary; only the fixed-origin API actor gets
  the per-origin one for now.
- **Memory scope.** v1 API-actor memory is chat-scoped (re-learned per chat); the
  vaulted **key** is global (the vault isn't chat-scoped), so auth is durable from
  the first grant. Profile-scoped learned memory is the forward "first-class
  citizen" end state.

## The seams — what actually changes

Honest scope (the architecture review corrected the spec's first draft here):
adding the API actor is **additive** because it's a parallel path, but it is **not
"just branches"** — it adds a store, a mint path, a resolve branch, a session
discriminator, and one piece of genuine gate plumbing. The DESIGN-17 tab path is
**not modified**.

1. **New origin-keyed store** (`subagent/web-actor.js`). A new
   `makeApiActorOriginBindings()` — `Map<origin, sessionId>` with bind/resolve/
   drop/load + reverse lookup; persisted to `chrome.storage.session` like the tab
   store. Eviction is NOT `tabs.onRemoved` (no tab) — an API actor lives until its
   chat ends or the integration is revoked.
2. **New mint + resolve** (`background/service-worker.js`). `mintApiActor(ownerChat,
   origin)` (reuses `mintWebSession`'s inheritance) + a resolve branch in
   `resolveActor`: an origin-shaped `to` → resolve/lazy-mint the origin actor.
   New persisted store rehydrated on boot.
3. **Session discriminator** (`sessions/types.js`). Add `backing: 'tab' | 'api'`
   (or derive "has a live tab"); `instanceId` for an API actor = its origin.
   `actorType` stays `'web'`.
4. **DOM-tool gate plumbing** (`tools/gates.js`, `background/service-worker.js`).
   The gate is a pure function reading `ctx` — it has **no tab-presence signal
   today**. Add a `backing`/`hasTab` field to the gate ctx (supplied by
   `buildToolContext`) so DOM tools refuse for an API backing *at the gate* (today
   a tabless web actor only fails at execute-time via `no_target_tab`). This is the
   one real new input to a pure function; small but not a predicate tweak.
5. **`getOwnedOrigin` + key injection** (`peerd-egress/fetch/web-fetch.js`,
   `background/service-worker.js`). The session-scoped wrapper reads a fixed origin
   for an API actor; P1 adds the same-origin vault-key injection step (the
   `origin:<origin>` analog of `makeInjectGitAuth`). New pure module
   `peerd-egress/.../origin-credentials.js` mirroring `git-credentials.js`.
6. **Memory** (`subagent/web-actor.js`). A second summary prompt + fence tuned to
   "what I learned about this API," selected for the API backing. State shape reused.
7. **Addressing surface** (`tools/defs/message-actor.js`). `to` accepts an origin;
   `deliver()` names it "The <origin> integration."
8. **Discovery + UI** (`tools/defs/list-integrations.js` new; home cards). Enumerate
   durable integrations alongside agent-tab cards.
9. **The grant flow** (a connect tool + Settings → API Integrations + vault writes).
   User-owned, confirmed.

## Phasing

- **P0 — the API actor (keyless).** New origin-keyed store + mint + resolve branch;
  origin addressing + lazy auto-form; the `backing` discriminator + the
  DOM-tools-need-a-tab gate; `getOwnedOrigin` for fixed-origin actors; the
  per-origin "what I learned" memory (free for the API backing). Ships first-class
  API integrations for **public + same-origin-cookie** APIs. No vault changes. The
  DESIGN-17 tab path is untouched. Gateable end-to-end (bun + in-browser + e2e).
- **P1 — credentials.** The `origin:<origin>` vault secret + the pure
  `origin-credentials.js` (https-only gate, header shape) + the boundary injection
  step (normative rules 1–8) + the connect/grant flow + Settings surface. Ships
  **authenticated** APIs.
- **P2 — surface & polish.** `list_integrations`, home cards, per-integration cost,
  orchestrator prompt lore ("address an API by its origin"), docs.
- **Forward (not 0.2).** Profile-scoped integration memory (cross-chat learning) +
  the cross-origin chat actor's per-origin memory (the session-cardinality rework);
  schema/endpoint discovery tools; an alias layer (`to:'stripe'` → origin).

## Open questions

1. **Origin normalization.** Accept a bare host and normalize to `https://`; reject
   non-https for any keyed integration (rule 2 above). Lean: yes to both.
2. **Key header variety.** Default `Authorization: Bearer`; support `X-API-Key`
   (rule 5 covers the strip). Query-param auth deferred — it leaks into URLs/logs
   and wants more care.
3. **Tab actor + vaulted key.** Rendering `github.com` does NOT auto-inject an
   `api.github.com` key — different origins, strict same-origin rule, correct and
   safe. Cross-subdomain key sharing is an explicit non-goal.
4. **Per-origin memory cardinality** (deferred): the cross-origin chat actor's
   per-origin memory rides the Profiles session-cardinality rework, not 0.2.
