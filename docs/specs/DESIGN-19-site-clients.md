# DESIGN-19 — Site clients: per-origin derived API clients

> Status: SPEC (approved direction, pre-implementation). Owner call
> 2026-07-19: both phases go, and capture must have a path that survives
> the Chrome store and Firefox submissions — the feature is NOT
> preview-only.

## The idea

An agent that browser-drives a site is doing expensive, slow, fragile
work to reach what is almost always an HTTP API one layer down. The
trick (h/t dax/@thdxr, jlongster): watch the network traffic while
driving the site once, derive a reusable client for that site's API,
and let every later interaction call the API directly instead of
re-driving the DOM.

peerd's version: the web actor derives, per origin, a **site client** —
a small JS module plus a prose dossier describing the origin's API as
actually observed (endpoints, auth posture, pagination, quirks). Both
persist per origin and are handed to every future web/API actor minted
for that origin. The actor uses the client as a *cache of derived
knowledge*: verified on use, repaired on failure, never blindly trusted.

Why this is worth building (and not just a toy):

- **Cost + latency.** One sealed-worker client run replaces a multi-turn
  DOM-driving loop (snapshot → click → snapshot …). The API actor lore
  already claims this win ("hit that SAME origin's endpoints instead of
  re-scraping" — `tools/defs/fetch-url.js`); today the knowledge that
  makes it possible evaporates with the chat.
- **Reliability.** APIs drift far slower than DOM. A recorded endpoint
  with exact params beats a re-derived selector path — and beats prose
  re-interpreted by the model each session.
- **Zero stored credentials.** Unlike the HAR→CLI version of this trick
  (which must embed captured cookies), peerd's client stores NO secrets:
  the session rides the browser's cookie jar via the egress boundary's
  session-scoping (DESIGN-18, `peerd-egress/fetch/origin-credentials.js`).
  The client is pure shape — paths, params, parsing — which is exactly
  the part that is safe to persist.

## What already exists (build on, don't re-implement)

| Piece | Where | Role here |
|---|---|---|
| API actor (DESIGN-18) | `peerd-runtime/actor/web-actor.js` | The consumer: a tab-less web actor pinned to one origin, fetch_url-only. Its `API_ACTOR_SUMMARY_PROMPT` already accumulates exactly the knowledge a site client freezes. |
| Session-scoped fetch | `peerd-egress/fetch/` (DESIGN-18) | The auth story: cookies ride only same-origin-to-owned-context, decided at the boundary, never by the tool or the client. |
| Sealed keyless worker + capability profiles | `offscreen/job-runner.js` | The execution host: per-job caps enforced at the host relay (deny-by-default), the `a2a_run` precedent for a single-capability run surface. |
| Two-tier meta/body store | `peerd-runtime/skills/store.js` | The storage template: cheap always-loadable meta, expensive on-demand body. |
| Confirm-gated durable writes | `peerd-runtime/memory/memory.js` (`buildWriteProposal`) | The trifecta defense template: agent-proposed persistence renders a diff; only an explicit user yes commits. |
| Untrusted fencing | `peerd-runtime/tools/prompt-wrap.js` | Everything the actor learns is untrusted-provenance; the client's text and output re-enter context only fenced. |
| Dual-backend automation | CDP pool (`background/debugger-pool.js`) vs `chrome.scripting` walk (`peerd-runtime/dom/walk-injected.js`) | The capture posture to mirror: one digest pipeline, a high-fidelity CDP tap where `debugger` ships, a scripting-injected tap everywhere else. |
| Code-as-surface | PR #119 (`page_code`), `a2a_run` | The house bet this extends: agent knowledge compiles to code run under a narrowed host, not to prose re-interpreted per turn. |

## The invariant

Format is not the boundary; **authority** is. The rule that keeps a
persisted, untrusted-provenance artifact safe:

> A site client may never gain authority beyond what the live actor
> already has for that origin, and its bytes never enter model context
> unfenced. Making it durable always crosses a user confirmation.

Three consequences:

1. **Execution is capability-scoped, not code-scoped.** The client runs
   in the sealed keyless worker with exactly ONE outward edge: a fetch
   pinned to its own origin, riding the same scheme/SSRF/denylist/audit
   chain and the same boundary-side session scoping as `fetch_url`.
   Non-GET still crosses the shared `web:write` confirm. Everything
   else — cross-origin fetch, page bridge, actor spawn, secrets — is
   denied at the host relay. A malicious or corrupted client's worst
   case is a wrong result or a bad request to an origin that was
   already the counterparty: the live actor's existing worst case.
2. **Fenced re-entry.** The dossier at mint time, the client source when
   read or edited, and every run's output are `wrapUntrusted`-fenced.
   The model never ingests any of it as instructions.
3. **The client is a cache, not a contract.** It carries staleness
   metadata and is presented as *"latest known — may be stale, wrong,
   or misleading; verify on use."* Failure feeds a self-heal loop whose
   ground truth is the paths the actor already owns (probe with
   fetch_url; render and DOM-drive).

## Architecture

### The site-client store

A new per-origin IDB store in `peerd-egress` storage territory, shaped
like the skills store's two tiers:

- **meta / dossier** (small, loadable at mint): origin, a prose summary
  of what the site is and what the client covers, the endpoint
  inventory in one-line form, quirks (auth posture, pagination, rate
  limits), and staleness metadata — `derivedAt`, `lastVerifiedAt`,
  `recentFailures`, `deriver` (probe | capture-cdp | capture-tap).
- **body / client module** (loaded on demand): one JS module exposing
  named operations over a `site` client object injected by the host
  (`site.fetch(path, opts)` — the pinned-origin fetch; nothing else).
  Size-capped like a skill body.

Keyed by normalized origin (`normalizeApiOrigin` /
`normalizeWorkspace` conventions — lowercased host, canonical
`scheme://host[:port]`). One client per origin; versions overwrite
under confirmation, prior body retained for the proposal diff.

**Writes are confirm-gated** through a proposal shaped like memory's
`buildWriteProposal`: the user reviews the DOSSIER text and a
summarized delta (ops added/changed/removed, size), with the code
diff expandable — a raw-JS diff is not glanceable, so the dossier is
the primary consent surface. Agent-proposed writes always confirm;
a user-initiated edit (options page) does not.

### Mint-time injection

When the SW mints a web actor (tab or API backing) whose origin has a
stored client, the actor's first turn carries the DOSSIER,
`wrapUntrusted`-fenced (origin-tagged like `fenceApiActorSummary`),
prefixed by a TOOL-AUTHORED header (outside the fence, like the
fetch_url paging footer) stating: this is derived knowledge from
<derivedAt>, last verified <lastVerifiedAt>, <recentFailures> recent
failures — treat as possibly stale or misleading; verify on use. The
body is NOT injected; the actor calls the run surface or reads the
source on demand.

The tab-backed web actor's origin is mutable (it navigates), so
injection keys off the origin it is *addressed toward* (task target /
adopted tab origin) and may re-inject on cross-origin navigation —
same trigger discipline as the egress boundary's own origin checks.

### The run surface: `site_client_run`

A web-actor-only tool (added to the web actor's positive allow-set in
`tools/exposure.js`; refused for every other ctx by the same tier
gate that guards fetch_url):

- Dispatches to the offscreen job-runner with a new capability profile:
  `{ siteFetch: <origin> }` and everything else off. The host relay
  enforces the pin — every `site.fetch` request is resolved SW-side
  against the pinned origin (path-only inputs; an absolute URL to
  another origin is refused at the relay, not by the worker), then
  rides the session-scoped webFetch chain. The a2a_run host-denial
  pattern (`offscreen/job-runner.js`) is the template.
- Args: operation name + params (the client module's exported ops), or
  an inline expression against the loaded module for one-off
  composition. Timeout + output cap like `script`.
- Non-GET inside a run crosses the shared `web:write` confirm at the
  SW relay — same key, same UX as fetch_url/call_api, one approval
  governs all.
- The result re-enters the actor's turn fenced, tagged
  `site-client(<origin>)`.

### Self-heal loop

A failed run (HTTP error class, schema mismatch, timeout) increments
`recentFailures` on the meta and returns the failure fenced. The
actor's guidance (tool description + dossier header) directs it to
fall back to probe/DOM, and — once it has working knowledge again —
propose a patched client. The patch is a normal confirm-gated write.
`lastVerifiedAt` bumps on a successful run whose result the actor
accepted. No automatic deletion; a chronically failing client just
looks increasingly stale in its header until repaired or removed by
the user.

## Capture: two taps, one digester (Phase 2)

Derivation works without capture (the API actor learns by probing —
that is Phase 1's floor), but watching the page's OWN traffic while
the actor drives is far higher signal. Capture mirrors the existing
CDP-vs-scripting dual-backend posture: **one digest pipeline, two
taps**, chosen by the same availability checks the DOM tools use
(`advancedAutomationOn()`).

### Tap A — CDP Network domain (preview/dev channels)

Extend the debugger pool with `Network.enable` +
`requestWillBeSent` / `responseReceived` / `getResponseBody` on the
actor's owned tab, recording during driving. Full fidelity: all
requests (including workers/iframes and pre-existing listeners),
response bodies, timing. Ships exactly where `chrome.debugger` ships;
stripped with it from the initial store-Chrome package and all Firefox
packages (`packaging/gen-manifest.ts` posture, unchanged).

### Tap B — MAIN-world fetch/XHR tap (ALL channels — the store path)

A `chrome.scripting`-injected classic-script wrapper in the page's
MAIN world (a sibling of `dom/walk-injected.js` /
`framework-state.js`: deliberately ES5, `'use strict'`, exempt from
modernization lint) that wraps `window.fetch` and
`XMLHttpRequest.prototype.open/send`, logging method, URL, request
params shape, status, content-type, and a size-capped response-body
sample (cloned, never consumed) into a page-side ring buffer the
extension drains via the existing injected-function channel.

- **No new permissions**: rides `scripting` + `<all_urls>`, both
  already held and justified (`docs/store/PERMISSION-JUSTIFICATIONS.md`
  covers the pattern — same mechanism as the DOM walk). This is what
  makes the feature submittable to the Chrome store and Firefox as-is.
- **Known blind spots, documented in the digest**: requests fired
  before injection, requests from the page's own workers/service
  worker, and pages that captured a fetch reference pre-wrap. The
  digest marks its tap so the dossier records fidelity honestly.
- Injection only on the actor's owned tab, only while a capture is
  active, removed after; the denylist's sensitive-origin refusals
  apply upstream as they do for every DOM tool.

### The digester (pure, shared)

`peerd-runtime` pure module: raw capture events → an endpoint
inventory (method, path template with parameterized segments, query/
body param shapes, response shape sketch, auth *posture* — "cookie
session", "bearer present" — never values). Rules:

- **Redaction before anything else.** `Cookie`, `Set-Cookie`,
  `Authorization`, `Proxy-Authorization`, and token-shaped
  query/body values are stripped at the tap boundary — credentials
  never enter model context, the digest, or the store (the
  session-header strip in `fetch-url.js` is the outbound twin).
- Response bodies contribute a SHAPE sketch (keys, types, sampled
  values truncated), not verbatim payloads.
- Third-party/analytics noise filtered by origin: only same-origin
  (and explicitly related API-subdomain) traffic feeds the inventory.

The digest is handed to the actor fenced; the actor writes the client
from it; persistence crosses the confirm gate as always.

## Channel matrix

The FEATURE ships on every channel. Only Tap A is channel-dependent,
resolved by the existing advanced-automation availability check —
never a channel probe, never exposed to the agent as "channel":

| Capability | store-Chrome | Firefox | preview/dev |
|---|---|---|---|
| Site-client store + injection + `site_client_run` + self-heal (Phase 1) | ✓ | ✓ | ✓ |
| Derivation by probing (API actor, fetch_url) | ✓ | ✓ | ✓ |
| Capture Tap B (scripting fetch/XHR wrap) | ✓ | ✓ | ✓ |
| Capture Tap A (CDP Network) | ✗ (until `debugger` re-added post-approval) | ✗ | ✓ |

Note for `docs/store/` when Phase 2 lands: Tap B introduces no new
permission but IS new page-world instrumentation — REVIEWER-NOTES and
PRIVACY should describe it (what is wrapped, that capture runs only on
the agent-driven tab during an active derivation, credential redaction
at the boundary, nothing leaves the device).

## Security analysis

Threats and their standing mitigations:

- **Laundered injection → durable code.** A hostile page steers the
  actor into deriving a client that "does something bad later." The
  client's later authority is the pinned-origin fetch under the same
  egress chain — no secrets, no cross-origin, non-GET confirmed. The
  durable write itself crossed a user confirmation with the dossier as
  the consent surface. Residual: subtle bad behavior *within* the
  origin (e.g., a GET encoding in-context data into query params) —
  accepted: the origin is already the counterparty to everything the
  actor does there, and cross-origin exfil is dead at the capability.
- **Durable cross-chat injection via the dossier.** Instructions
  planted in page content that survive digestion and resurface in
  every future session on that origin. Mitigations: dossier re-enters
  ONLY fenced; the summary prompts' standing rule (note that a page
  tried to instruct, never carry the instruction) applies to
  derivation; the confirm diff makes a prompt-shaped dossier visible
  to the user.
- **Credential leakage from capture.** Raw traffic contains live
  session tokens. Redaction is at the TAP boundary (before digest,
  before model context, before store) and the store schema has no
  field where a credential belongs. The client never needs one: the
  boundary supplies the session.
- **Escalation via the run surface.** The worker is sealed and
  keyless; the host relay resolves and enforces the origin pin
  SW-side (never trusting worker args — the same posture as the
  actor-worker tool relay); the tool is web-actor-only under the
  existing tier gate.
- **Consent fatigue.** One client per origin, writes only at
  derivation/repair moments, dossier-first diff. If this still proves
  chatty, batch-review UI is a follow-up — not weakening the gate.

## Phasing

**Phase 1 — persistence + execution (all channels).** The site-client
store (meta/body, confirm-gated writes); mint-time fenced dossier
injection; `site_client_run` + the `siteFetch` capability profile in
the job-runner; self-heal metadata + guidance; options-page surface to
view/edit/delete stored clients (DESIGN-18's api-integrations section
is the natural home). Derivation in this phase is probe-based — the
API actor already does the learning; Phase 1 makes it durable. Also:
widen `fetch_url`'s method enum beyond GET/POST (PUT/PATCH/DELETE),
which the existing `web:write` confirm already governs.

**Phase 2 — capture-assisted derivation.** The pure digester + both
taps (B first — it ships everywhere and needs no manifest change; A
as the preview-fidelity upgrade on the debugger pool); a derivation
flow where the orchestrator asks the web actor to "derive a client
for <origin>" and the actor drives representative flows with capture
on, receives the digest fenced, writes the client, and proposes the
persist.

Non-goals (now): sharing clients between profiles or over the dweb
(a dwapp/skill-shaped follow-up with its own trust story); automatic
background re-verification (schedule tools exist, but silent
re-derivation without a user in the loop weakens the confirm gate);
capture outside an active, user-visible derivation.

## Open questions

1. Store location: a new `peerd-egress`-adjacent store vs folding into
   the skills store with a reserved namespace. Leaning NEW (different
   trust class and lifecycle than user-installed skills; a site client
   must never be loadable as a skill).
2. Does the ORCHESTRATOR see dossier summaries (an `actor_list`-style
   "integrations formed" line already exists for DESIGN-18) so it can
   route "use the site client" intent, or is that purely the actor's
   decision? Leaning: metadata-only line to the orchestrator, knowledge
   stays behind the actor heap.
3. Tab-backed actor + client for a DIFFERENT origin than the current
   tab: allowed (client fetch is sessionless cross-origin by the
   boundary) or refused for simplicity? Leaning refuse in v1 — one
   origin per actor keeps the pin story clean.
4. How Tap B coexists with pages that themselves wrap fetch (Sentry,
   analytics): wrap-order is last-wins for interception but the tap
   must call through faithfully — needs live validation on
   instrumented sites during implementation.
