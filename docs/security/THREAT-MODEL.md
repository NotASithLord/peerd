# peerd threat model

> Status: 0.x experimental beta. This document describes the security
> architecture as it exists in the code. Where this document and the code
> disagree, the code is correct. Every claim below cites the source file that
> enforces it, and the invariants in section 6 are checked by a runnable
> [red-team suite](../../tests/red-team/) so they can be re-verified against the
> current tree.
>
> For how to report a vulnerability and the support policy, see
> [`SECURITY.md`](../../SECURITY.md). This document is the formal companion to it.

---

## 1. Summary

peerd is a browser-native AI agent shipped as a Chrome and Firefox extension. The
agent loop runs in the user's browser. It holds the user's model-provider API key
(bring your own key) in an encrypted vault, drives the user's logged-in tabs and
DOM, runs code in sandboxes (a WebAssembly Linux VM, sealed JS workers, opaque
origin App iframes), and on the preview channel reaches a peer-to-peer mesh. There
is no backend, no telemetry, and no account.

Because there is no server, the browser is the trust boundary. Every capability
the agent has is a capability that an attacker who subverts the agent would
inherit. The design goal is to make that subversion not grant the attacker
anything useful.

The core assumption is that an AI agent that reads attacker-controlled content
will eventually be prompt-injected, and that no content filter reliably prevents
this. peerd does not rely on filtering. Instead it separates untrusted reasoning
from dangerous capability in three ways:

1. Memory. Reasoning that reads a page runs in a separate dedicated worker heap.
   Chrome hosts it from an offscreen document. Firefox hosts it from the
   extension background page. Actor work fails closed if the boundary cannot be
   proved.
2. Policy. Every tool call is checked at dispatch against a fixed set of gates.
3. Chokepoints. All outbound network traffic and all signing pass through a single
   audited path.

Injected text can influence a reasoning context, but the actor loop does not
receive live vault or provider-egress functions. Tool and model calls still pass
through service-worker policy. An isolated host also keeps the reasoning out of
the service-worker heap.

---

## 2. System surfaces

peerd runs across several browser execution contexts. Trust boundaries fall
between them.

| Surface | What runs there | Holds the key |
|---|---|---|
| Privileged background (`background/`) | Orchestrator agent loop, tool dispatch and gates, vault, egress wrappers, and actor relays. Firefox also starts actor workers here | Yes. Actor loops run in separate dedicated worker heaps |
| Offscreen document (`offscreen/`, Chrome) | Hosts isolated actor workers, headless `script`, voice, and the dweb base network | No. Actor worker heaps are keyless |
| Side panel (`sidepanel/`) | The chat UI, confirm prompts, settings | No |
| Sandbox tabs (`engine-tabs/vm-tab/`, `engine-tabs/notebook-tab/`, `engine-tabs/app-tab/`) | WebVM (CheerpX), Notebook (sealed worker), App (opaque origin iframe) | No |
| The mesh (`peerd-distributed/`, preview only) | WebRTC mesh, DHT, gossip, signed direct channels, A2A | No |

The module map (`p`rovider, `e`gress, `e`ngine, `r`untime, `d`istributed) is in
[`CLAUDE.md`](../../CLAUDE.md). Security-relevant code is concentrated in
`peerd-egress/` (vault, egress, denylist, audit) and in the
`peerd-runtime/actor/` and `peerd-runtime/tools/` layers (the heap split and
the gate stack).

---

## 3. Actors and trust boundaries

### 3.1 Actors

peerd splits "the agent" into separate roles so that no single reasoning context
holds both untrusted input and dangerous capability. Enforcement lives in
`peerd-runtime/tools/exposure.js`, `peerd-runtime/tools/gates.js`, and
`peerd-runtime/actor/`.

| Actor | Trusted with | Not permitted to |
|---|---|---|
| The user | Everything: unlocking the vault, approving confirms, installing skills and imports | (the root of trust) |
| The orchestrator (main agent loop, in the service worker) | The conversation, planning, and delegating a plain-language goal to an actor | Hold an environment's low-level tools, read raw page bytes, or run untrusted code directly |
| A bound actor (web, webvm, notebook, app) | Driving one tab, VM, notebook, or app. It holds only that instance's tools, keyless, in its own worker heap | Touch another instance or kind, hold the key, or return anything to the orchestrator except a `wrapUntrusted`-fenced summary |
| An actor | A short-lived actor spawned to break down a task. Keyless, with a narrowed toolset and its own heap | Escalate past its grant or hold the key. Every tool call is re-checked in the privileged background |
| The dweb actor (preview, opt-in) | Monitoring inbound mesh traffic and A2A over the mesh. Keyless, with its own heap | Delegate on an inbound (untrusted) turn, or sign as the user without consent |
| The egress chokepoint (`safeFetch` and `webFetch`) | Every outbound byte: the allowlist for credentialed calls, or the SSRF and denylist checks for open-web calls | Be bypassed. A bare `fetch` is forbidden by lint across the project |

### 3.2 Trust boundaries

- B1. Untrusted content and the orchestrator's heap. Page text, command output,
  file contents, and peer bytes are read in a separate keyless actor worker and
  return only as `wrapUntrusted`-fenced data
  (`peerd-runtime/actor/actor-worker-core.js`,
  `background/offscreen-actor-client.js`). A versioned readiness and realm probe
  must pass before work starts. Missing or failed isolation refuses the actor
  turn before any target action.
- B2. An actor loop and the network or the key. Model and tool calls leave the
  worker only through privileged, gated relays. The host adds live provider
  functions only at the model-call boundary and re-checks every tool call. On
  Chrome, the service worker transfers a standard MessageChannel endpoint to the
  exact offscreen WindowClient. The job and relays never use extension-wide
  runtime messaging. Firefox binds the same relays to its private in-process host.
- B3. The extension and the open web. All outbound bytes pass through
  `peerd-egress/fetch/`: `safeFetch` (exact-origin provider allowlist, carries the
  key) or `webFetch` (SSRF and private-network block plus denylist, keyless).
- B4. Sandboxed code and the host. The WebVM, Notebook worker, and App iframe each
  run confined to a realm whose only outward edge is an audited postMessage bridge,
  or, for the App, an opaque origin with no privileges.
- B5. The mesh and the local agent (preview). Peer bytes are content-addressed,
  signed, `wrapUntrusted`-fenced, rate-capped, and delivered as inbound (untrusted)
  turns that the sender gate forbids from delegating.
- B6. The browser and the extension. The install-time permission set and CSP are
  the outer boundary the browser enforces. Everything inside is bounded by it
  (`manifests/`, generated `extension/manifest.json`).
- B7. The user and the agent. Side-effecting actions pass through a confirm gate.
  The vault requires an explicit unlock. Skills and imports require a click.
  Backup and restore plaintext uses an exact options-page transport. Chrome
  transfers a MessageChannel to one WindowClient. Firefox accepts a private
  background Port only from the exact options sender. The ordinary runtime
  message dispatcher never carries passphrases or backup payloads
  (`background/private-transfer-port.js`, `options/private-transfer-session.js`).

Out of the model entirely (see section 7): a compromised OS or browser, a
malicious separate extension, and physical device access.

---

## 4. Assets

| Asset | Where it lives | Primary protection |
|---|---|---|
| Model-provider API key | Encrypted in the vault, decrypted only in the service worker at request time | Vault crypto (Argon2id or WebAuthn-PRF, AES-GCM), never handed to an actor loop, egress allowlist |
| Origin-bound API keys (per integration) | Vault, injected at the egress boundary only | `origin-credentials.js`. Sent only to the exact owned https origin |
| Proof-of-possession key (DPoP, per origin — opt-in per integration) | A non-extractable `CryptoKey` handle in IndexedDB — the key material never leaves the browser's crypto implementation and peerd never holds it as bytes | Non-extractable by construction, checked at generate and on every load (`usableDpopPrivateKey`; `exportKey` rejects for every caller, including us); usable only at the audited egress boundary, which mints a fresh per-request proof and never exposes one to the agent. Minted when the user saves a DPoP credential, retired when they remove it (INV-15) |
| The user's session cookies (logged-in tabs) | The browser's cookie jar. peerd never reads cookies | Sensitive-origin denylist, Plan and Act mode, confirm gate |
| User authentication factor (login) | Never held by the agent — a passkey stays on the user's device; an SSO session stays with the provider; a password is never read or filled | The agent never holds it; a login is initiated only through a gated, origin-verified, always-confirmed, affordance-verified action (`tools/defs/login.js`, Tier 0). The factor stays with the user |
| Page content the agent reads | Transiently, inside an actor loop | Credential custody, actor tool gates, the untrusted-content fence, and the B1 memory boundary where an isolated host is available |
| Durable memory (notes loaded into every future prompt) | `peerd-runtime/memory/` | User-approved writes. The digest excludes tool results (see residual risk R2) |
| Local files (WebVM filesystem, Notebook and App OPFS) | Sandbox-local storage | Per-instance OPFS root, path-traversal collapse, realm seal |
| Peer bundles (dwapps, data, agent cards) | Received over the mesh | Content addressing, Ed25519 signatures, size and shape caps |
| The agent's own authority (its tools, its delegation) | The orchestrator | Exposure and actor-tier gates, the sender gate, Plan and Act mode |
| The audit log (record of security events) | IndexedDB, extension origin | Append-only, hash-chained for tamper evidence (residual risk R4: evident, not proof) |

---

## 5. Adversaries

Each adversary lists what it can do, peerd's primary defenses with the enforcing
file, and the [red-team scenario](../../tests/red-team/) that exercises the
defense.

### 5.1 Malicious webpage
Can: serve arbitrary HTML, JS, and text, plant prompt-injection payloads in content
the agent reads, try to induce fetches, and run script in its own origin.
Cannot: reach the vault key, run in a privileged context, or make the agent's
authority act outside its gates.
Defenses: the memory boundary keeps page bytes out of the orchestrator's heap
(B1). Every web actor loop is keyless and receives stubs in
`actor-worker-core.js`. The credentialed egress path is an
exact-origin allowlist (`safeFetch`). Open-web fetches are gated by the SSRF block
and the denylist (`webFetch`). Page text is `wrapUntrusted`-fenced with a delimiter
the page cannot forge (`tools/prompt-wrap.js`).
Proven by: scenarios 01, 02, 03, 07, 08.

### 5.2 Malicious MCP server (mapped)
peerd ships no MCP client. The only `mcp` occurrence in `extension/` is a substring
inside vendored `moonshine.js`. The named vector is not a live surface. Its threat,
which is untrusted external tool metadata or instructions that make the agent act on
an attacker's behalf, maps onto peerd's real analog: the A2A and inbound-mesh surface
(agent-cards and peer messages).
Defenses (the analogs of MCP tool-description sanitization): the sender gate
(`actor/delegation-lineage.js` `mayMessageActor`) makes an inbound turn unable to
delegate, and taints any actor spawned from an injected turn. The A2A translation
core (`actor/a2a-api.js` `meshCallToOp`) rejects unknown methods and malformed
args. Signing ops require per-target consent (`meshMethodSigns`).
Proven by: scenario 05.

### 5.3 Malicious peer (mesh, preview only)
Can: join the mesh, advertise agent-cards, serve content bundles, send direct
messages, and attempt denial of service.
Cannot: forge a bundle under an honest address, re-attribute a signed bundle,
amplify memory past the fetch-time cap, or wake the local agent into delegating.
Defenses: content addressing (a bundle's address is the hash of its canonical
manifest, which commits to every chunk, in `content/manifest.js`). Ed25519 publisher
signatures over domain-tagged bytes (`identity/keypair.js` `verifySignature`).
`assertBundleWithinLimits` rejects an oversized or amplified manifest before any
chunk is fetched. Agent-cards are coerced and capped (`agent-card.js`). Inbound rate
caps (`background/dweb-inbound-rate-cap.js`). The sender gate.
Proven by: scenarios 04, 05.

### 5.4 Malicious model output
Can: the model itself, whether compromised, jailbroken, or steered by content it
read, emits arbitrary tool calls and arguments.
Cannot: call a tool it is not exposed to, target an instance it is not bound to, act
in Plan mode, or exfiltrate over the credentialed path.
Defenses: the gate stack (`tools/gates.js`). The exposure gate hides low-level DOM
and page tools from the main turn. The actor-tier gate pins each actor to its kind's
toolset and instance and refuses actor-only tools on non-actor contexts. Plan and Act
mode blocks writes (`permissions/policy.js`). The origin gate applies the denylist.
Every tool call carries an append-only audit entry. In the actor worker,
`actor-worker-core.js` strips every function before the model request crosses the
relay. The privileged provider wrapper overwrites worker-controlled provider,
model, host, and credential fields at the call boundary.
Proven by: scenarios 03, 08 (and 05 for delegation).

### 5.5 Malicious extension (out of scope, see section 7)
A second extension installed alongside peerd, or a compromise of peerd's own
extension origin, is out of scope. Such code already runs in-origin and can reach
service worker memory, including the live key, directly. This is stated as an
accepted limitation (R7), not defended against. Store hardening (no `debugger`
permission in the store Chrome build, a strict CSP) reduces peerd's own attack
surface but does not defend against a separate malicious extension.

### 5.6 Compromised dependency (supply chain)
Can: a subverted vendored library, a remote asset, or an agent-selected HTTPS
JavaScript module could inject code.
Defenses (partial): there is no npm runtime inside the extension. Third-party code is
vendored in `vendor/` with a `SOURCE.txt`. The Moonshine voice model is SHA-384
SRI-verified and refuses to load on a null SRI
(`peerd-runtime/voice/model-store.js`). Store and web builds refuse direct
remote JavaScript imports without requesting the module source. On package
targets where Preview enables literal static remote modules, they cross the
audited web-fetch path, have source and graph
caps, and may carry an optional SHA-256 pin. Any remote module marks the whole
resolved graph as untrusted compute. Runtime network and file access, agents,
model calls, browser and site clients, and dweb are disabled for that run.
Generated worker shims and independent host relay checks enforce the same
profile. Firefox links the
authorized graph and realm seal in a disposable compiler Worker, then runs the
result through a sandboxed opaque-origin host with no extension APIs, string
compilation, or network. Stop terminates the compiler or code Worker and
cancels the host fetch operation. Returned values, console output, and errors
are fenced as untrusted.
Pins verify exact bytes and improve reproducibility. They do not grant trust or
authority. Dynamic imports are refused in every package. Remote modules run
inside a sealed worker. The store build strips
the `debugger` permission and the dweb module, and CI verifies zero dweb traces.
Accepted residuals: the CheerpX WebVM streams its root filesystem image from a
third-party host over WSS, which cannot be SRI-pinned. In Preview, an unpinned
HTTPS module can change at its publisher's discretion.
The separate Store risk where code is fetched as data and then executed through
a local JavaScript or WebAssembly surface is tracked on the issue board.
Proven by: scenario 06.

---

## 6. Security invariants

These are the load-bearing guarantees. Each is stated as a testable assertion, cites
the enforcing code, and links to the red-team scenario that exercises it. The
anchors (`INV-N`) are the link targets from
[`RED-TEAM-RESULTS.md`](./RED-TEAM-RESULTS.md).

<a id="inv-1"></a>
### INV-1. The credentialed egress path cannot be pointed at an attacker
A request carrying the vault key (`safeFetch`) reaches only an exact-origin member
of the provider allowlist, and fails closed on any 3xx redirect. Lookalikes,
substrings, scheme downgrades, and off-origin ports are refused, and the underlying
`fetch` never fires on a denied origin.
Code: `peerd-egress/fetch/safe-fetch.js` (`makeSafeFetch`, `isAllowed`, `originOf`),
`fetch/allowlist.js` (frozen `HARDCODED_ALLOWLIST`). Red-team: scenario 01.

<a id="inv-2"></a>
### INV-2. Sensitive origins and cross-origin credentials are gated
Open-web fetches are refused when the host matches the sensitive-origin denylist,
using a boundary-safe matcher (`*.bank` matches subdomains only, never the apex or a
substring sibling, and port and trailing-dot are canonicalized away). An
origin-bound credential authenticates only when the request's `URL.origin` exactly
equals the actor's owned origin over https. Cross-origin, http, and spoofed URLs send
anonymously.
Code: `peerd-egress/denylist/denylist.js`, `fetch/web-fetch.js`,
`fetch/origin-credentials.js` (`authOriginForRequestUrl`). Red-team: scenario 02.

<a id="inv-3"></a>
### INV-3. Actor loops receive no live credential functions and return fenced data
Every actor loop receives throwing `getSecret` and `safeFetch` stubs. This is
enforced in `actor-worker-core.js`. Privileged wrappers add the live functions
only at the model provider boundary. A worker cannot pass functions across its
relay because `makeRelayedCallModel` drops them. Every untrusted summary re-enters the
orchestrator wrapped as data (`makeActorSummaryFence` and `wrapUntrusted`) with a
delimiter the content cannot forge (`neutralizeFence`).
Code: `peerd-runtime/actor/actor-worker-core.js`,
`background/offscreen-actor-client.js`, `background/offscreen-actor-channel-client.js`,
`background/direct-actor-host.js`, `offscreen/actor-channel-host.js`,
`offscreen/actor-runner.js`, `offscreen/actor-worker-protocol.js`, and
`tools/prompt-wrap.js`. The browser custody test proves an actor cannot enter the
privileged turn driver. The installed-XPI Firefox smoke proves the packaged extension
starts a dedicated Worker, verifies its realm, attaches credentials only in the host,
keeps one background heap alive past the event-page idle window, and returns one
fenced result without replay. Red-team: scenario 03.

<a id="inv-4"></a>
### INV-4. A tampered or re-attributed peer bundle is detectable and rejected
A bundle's content address commits to its manifest, which commits to every chunk.
Tampering any signed field breaks `verifyManifest` and changes the address, so it
cannot reuse an honest one. Re-attributing to a different publisher breaks the
signature. An oversized, amplified, or size-lying manifest is refused before any
chunk is fetched, and a peer agent-card is coerced within hard caps.
Code: `peerd-distributed/content/manifest.js`, `identity/keypair.js`,
`agent-card.js`. Red-team: scenario 04.

<a id="inv-5"></a>
### INV-5. An untrusted party cannot hijack the agent's authority
An inbound (peer-originated) turn can never make the agent delegate, and an actor
spawned by an inbound or injected turn is tainted for its whole subtree. Forged,
severed, foreign-rooted, and cyclic lineages fail closed. A poisoned mesh op (bad
method or args) is rejected, and signing as the user requires per-target consent. The
wall covers EVERY door to delegation, not only the direct `message_actor` tool: the
`script` tool's awaited `actors.ask` surface reaches the same `messageActor`
(while `actors.list` only reads the roster), so delegation is refused mint on
an inbound turn (`tools/defs/script.js` gates `actorsOn` on
`ctx.inbound !== true` — the trusted turn signal folded SW-side; the untrusted worker
never echoes it).
Code: `peerd-runtime/actor/delegation-lineage.js` (`mayMessageActor`,
`buildAncestry`), `tools/defs/script.js`, `actor/a2a-api.js`. Red-team: scenario 05.

<a id="inv-6"></a>
### INV-6. Sandboxed code is confined to an audited bridge
In a Notebook or headless worker realm, every raw network channel throws, the native
`fetch` is deleted off the prototype chain, and the bridge is pinned non-writable and
non-configurable so in-realm sabotage cannot unseat it. Same-origin durable stores are
sealed too — `indexedDB` (the sealed worker runs at the extension origin, so an unsealed
IDBFactory would reach the `peerd` database: the vault blob, always-loaded memory,
sessions, grants, and audit) and the Cache API are both replaced with throwing stubs and
deleted off the prototype chain, so the audited postMessage bridge and the per-instance
OPFS root remain the only outward edges. No fresh un-sealed realm can
be created, and OPFS import paths collapse `..` inside the instance root. A wasm32-wasi
module run in that realm via the `peerd:wasi` builtin holds strictly less than the realm
itself: its only imports are the vendored shim's WASI preview1 syscalls, and every
descriptor behind them is wrapper-built (stdin bytes, size-capped output collectors, an
in-memory file table from the call) — no network channel exists for the seal to even
block. The App runs
at an opaque origin (the manifest sandbox omits `allow-same-origin` and
`allow-top-navigation`) with all `chrome.*` stripped, and its inlined worker source is
escaped against a `</script>` breakout. The WebVM's only network path is an HTTP bridge
that refuses non-http(s) schemes, scrubs CRLF header injection, drops any smuggled auth
field, and confirms body-bearing verbs. If a resolved Notebook or Script graph
includes remote code, the entire run uses the compute-only profile. The worker
and host both refuse every authority-bearing relay, and the tool boundary fences all remote-controlled
output.
Code: `engine-tabs/notebook-tab/notebook-neutralizers.js` (`applyRealmSeal`),
`engine-tabs/notebook-tab/worker-source.js`,
`engine-tabs/notebook-tab/notebook-tab.js`, `offscreen/job-runner.js`,
`peerd-runtime/tools/defs/js-notebook.js`, `peerd-runtime/tools/defs/script.js`,
`peerd-engine/app-compose.js`, `peerd-engine/vm-net/http-bridge.js`,
`peerd-engine/module-resolver.js`, and the manifest sandbox CSP. Red-team: scenario 06,
with the real-realm proof in
`extension/tests/unit/engine-tabs/notebook-tab/notebook-seal.test.js`,
`extension/tests/unit/offscreen/job-runner.test.js`, and
`extension/tests/unit/red-team/sandbox-escape.test.js`.

<a id="inv-7"></a>
### INV-7. No egress to private, loopback, link-local, or metadata hosts
`webFetch` refuses a host classified as private, loopback, link-local, `.local`, or
metadata by `isPrivateOrLocalHost`, across decimal, hex, octal, and short-form IPv4 and
IPv4-mapped and NAT64 IPv6 encodings — plus the RFC 6598 shared/CGNAT (`100.64.0.0/10`),
benchmarking (`198.18.0.0/15`), and reserved/broadcast (`240.0.0.0/4`) ranges that are
internal-use on real deployments — before any network call, ahead of the denylist,
and fails closed on redirects so a public host cannot pivot to an internal one. The same
redirect refusal is applied by `read_doc`'s byte fetch (`offscreen/doc-extract.js`,
`redirect:'manual'`), before content detection selects the PDF or document engine.
Browser automation applies the same lexical classifier before navigation and
to the committed document. Driven tabs also receive tab-scoped DNR rules for
private hosts and address ranges, covering redirects, forms, frames, and
tab-associated requests at the browser network layer. While a public HTTP or
HTTPS page is under peerd custody, a second private-network rule set covers
requests that the browser attributes to no tab when their initiator domain
matches a public domain visited by the driven tab. This covers page service-worker fetches and
Firefox worker WebSockets without applying a browser-wide rule. Chrome DNR does
not intercept WebSockets created inside a page service worker, even with a
matching unscoped block rule. The live regression test keeps that residual
visible. The scope follows browser DNR
domain matching, so it ignores scheme and port and can include subdomains. A
user-owned tab with the same matching domain can therefore lose private-network
service-worker fetch access while peerd drives that domain. peerd does not prompt, unregister
the worker, or take exclusive control of the origin. Visited domains persist in
browser-session storage and remain covered until that tab's custody ends.

A page-created child is
blanked and guarded only when `webNavigation` reports that its exact source tab
is already under peerd custody. Firefox also synchronously cancels private,
local, metadata, or denylisted HTTP and WebSocket requests from that exact child
while its tab-scoped DNR rules are being installed, then releases the temporary
listener state for that child. It does not read request bodies or act on children
from user-owned tabs. If actor custody restores before denylist hydration, that
exact child waits instead of treating an empty policy as permission. A protected
child is closed after the network guard takes custody. A missing or malformed
bundled denylist pauses tool dispatch instead of authorizing an empty policy for
browser or open-web work. The tab rules never apply to tabs peerd is not driving.
The no-tab companion is limited to domains visited by current driven tabs and
private-network targets. During a service-worker restart, early adoption requires two positive
signals for the exact source: restored durable custody or a restored web-actor
binding, plus the complete surviving private-network DNR rule set.
`background/startup-popup-network-guard.js` copies only those known block rules
to the exact child, then hands it to the restored custody set. If either signal
is absent, peerd leaves the child unchanged until its registries finish loading.
This avoids interfering with a user popup, but leaves a short cold-start window
for an autonomous child if the browser lost its session rules while peerd's
later registry restore still identifies the source as driven. A page-initiated
cross-origin redirect can also begin before the browser reports the new committed
URL and adds its no-tab domain scope. DNS resolution and rebinding remain
outside this client-side lexical boundary. With native local-network checks
disabled, Chrome can also start an inherited about:blank child's immediate
private request before the extension receives enough child identity to close it.
Code: `shared/private-network.js`, `peerd-egress/fetch/web-fetch.js`,
`peerd-egress/denylist/dnr-rules.js`, `background/denylist-net-guard.js`,
`background/browser-origin-custody.js`,
`background/driven-child-request-guard.js`, `background/startup-popup-network-guard.js`,
`peerd-runtime/tools/browser-automation-policy.js`, and
`offscreen/pdf-extract.js`. Red-team: scenario 07.

<a id="inv-8"></a>
### INV-8. Injected instructions cannot reach a capability
For a corpus of injection payloads, the authority each one seeks is denied by a real
mechanism: exfil is denied by keyless loop custody, tool gates, and the allowlist,
navigation to a
sensitive site by the denylist, SSRF by the private-network guard, a low-level DOM tool
on the main turn by the exposure gate, an actor-only tool via an actor by the tier
gate, a cross-instance call by the instance pin, a write in Plan mode by Plan and Act
mode, and a fence break-out by `neutralizeFence`. This is the difference from a
single-context agent (a "browser-use"-style agent) that runs the model, the tools, the
key, and the page's text in one reasoning context, where the injected instruction sits
in the same context that holds the authority.
Code: the gate stack and heap split cited above. Red-team: scenario 08, which includes
the side-by-side comparison.

### INV-12. What the model reads is what a human could have seen
Page bytes that are invisible to a person but legible to a model — zero-width and
soft-hyphen runs, bidi overrides, the Unicode Tags block, variation-selector
sequences, the combining grapheme joiner (`U+034F`, a `gc=Mn` invisible the `\p{Cf}`
sweep cannot reach), HTML comments — are removed before the text reaches the model. The
strip runs at both read boundaries and inside the untrusted-data fence itself, so a new
web-sourced tool cannot forget it, and it also runs at the two boundaries where
page-derived text becomes DURABLE trusted context rather than a transient tool result:
the `/init` active-tab probe that seeds always-loaded project memory
(`memory/init-orchestrator.js`) and the skill descriptions rendered into the system
prompt at startup (`skills/registry.js`) — a covert channel there would persist,
invisible at the approval gate, and it runs TWICE around HTML extraction, because
extraction parses the document and turns `&#8203;` — seven ordinary ASCII characters
on the way in — into a real zero-width byte on the way out. Legitimate content is
LARGELY not collateral: the LETTERS of every script survive, including the ZWNJ that
Persian, Urdu and the Indic scripts require orthographically. A handful of
General_Category=Cf ORTHOGRAPHIC marks are accepted collateral and named in
`cdr.js` — they are invisible by construction, so each is exactly the covert channel
this invariant exists to close. Text hidden with CSS is out of scope entirely: those
are ordinary visible characters. The comment-removal pass is applied
only where a comment is genuinely a comment (markup), never to JSON or plain text
where `<!--` is visible content.
Code: `peerd-runtime/dom/cdr.js`, wired at `tools/prompt-wrap.js`,
`tools/defs/fetch-url.js`, `tools/defs/read-page.js`, `memory/init-orchestrator.js`,
`skills/registry.js`. Red-team: scenario 09.

### INV-13. Borrowing the user's identity on a page strangers wrote takes the user
An authenticated write on an origin where third parties author the content (issue
trackers, shared docs, social feeds) requires the user to confirm, **even when
confirmations are disabled** — which is the product default, and therefore the only
posture in which the rule means anything. Reads are exempt (reading is the point of
sending an actor there) and so is navigation (leaving is how it finishes). The zone is
classified from the tab's live URL rather than a turn-start pin, because an in-page
hop moves the page with no tool call to observe.
Code: `peerd-runtime/actor/ugc-registry.js`, enforced in `tools/dispatcher.js`.
Red-team: scenario 09.

<a id="inv-14"></a>
### INV-14. Login orchestration holds no credential
The `login` tool INITIATES a user-gesture sign-in (passkey/WebAuthn or "Sign in with
a recognized identity provider") and holds nothing: it never fills a password field,
stores no token, and returns no secret. The ground-truth reader reads ATTRIBUTES and
structure only — it NEVER folds a field VALUE into the affordance name (it reads an
input `value` only where the value is the CONTROL LABEL: a submit/button/reset input, a
`<button>`, an `<option>`), so a bare `<input type=password>` cannot leak the typed
secret. It confirms on a SYSTEM-DERIVED https origin taken from the LIVE resolved tab
(`originOfUrl(tab.url)`, never a model-supplied string; fail-closed on a non-secure or
unknown origin), and the confirm is UNCONDITIONAL — it prompts **even when
confirmations are disabled**, the product default. Before it confirms or clicks it
reads GROUND TRUTH off the page and runs a pure, deterministic classifier, so the
method and provider the confirm names come from the page rather than a model argument
that could spoof the consent; the provider shown is a CANONICAL single-word title-cased
label, never the raw captured phrase. SSO for a provider outside the identity-provider
registry is refused without a click or actor stop. A password affordance is refused
because Tier 0 holds no credentials.

**The auto-click rule.** peerd AUTO-CLICKS a login only when it has (a) VERIFIED the
destination is a known IdP (an href/formAction host that passes `isKnownIdp`), (b)
pinned a STABLE `walkId` (a snapshot registry node the page cannot re-point; a raw
selector or a CDP-only backend ref is not stable across confirmation), and
(c) RE-VERIFIED, AFTER the consent, that the live origin is unchanged and a re-read via
the SAME walkId re-classifies to the identical verdict (method/provider/verified) —
aborting on any change (`login_origin_changed` / `login_affordance_changed` /
`login_target_gone`). Everything else is ASSISTED-MANUAL: peerd verified the origin and
took consent, then hands the gesture to the user. A recognized provider NAME with an
unverified (or unverifiable) destination is supported-but-unverified — never an
auto-click under the "peerd never sees your password" reassurance; the confirm carries
`verified:false` and the card softens its copy and does not vouch for the destination.
A passkey is ALWAYS assisted-manual at Tier 0: WebAuthn needs transient user activation,
which only a TRUSTED (CDP) click grants, and that channel resolves the node by a
different key than the ground-truth read, so an auto-fire could be a confused deputy.
No synthetic gesture is ever faked. A trusted passkey auto-click via a CDP same-node
read is a documented Tier-0.1 follow-up. The tool is web-actor-only (hidden from the
orchestrator, allowed only for a `kind:'web'` actor), and an inbound (untrusted) turn
cannot reach it — the sender gate is the real control (an inbound turn never wakes the
web actor); a defense-in-depth refusal inside the tool is inert belt-and-braces for any
future path that folds `ctx.inbound`. This is **Tier 0** of the credential roadmap: the
agent holds NOTHING. Tier 1 (scoped OAuth tokens) and passwords/keychain remain future
work and out of scope here. Residual, stated plainly: destination verification is
BEST-EFFORT — it proves the element's declared navigation target (its href, or, for a
SUBMIT control only, its form action) is a known IdP, but a script `onclick` can still do
something other than that declared target. So an auto-click carries the residual that a
verified-looking button runs a different handler. This is bounded by the exact-origin
grant and landing wait, and by the fact that peerd only auto-clicks and never fills a
credential. The worst case is a same-origin action on the origin the user already
consented to interact with, not a credential leak.

**The identity-provider grant.** Confirmation alone does not give the actor general
sign-in authority. Only confirmed SSO with a verified destination can stamp a durable,
one-shot grant for that exact IdP origin. Unverified SSO and passkey flows do not stamp
one. The grant is consumed when the tab first lands on that exact known IdP. The actor
then waits and has no tool or credential authority there. It can continue on a
later request only after the same tab returns to the exact relying-site origin. A wrong provider, third origin,
expired or replayed authorization, malformed state, or legacy excursion state stops the
actor. The grant and active excursion survive a service-worker restart without widening
their authority.
Code: `peerd-runtime/tools/defs/login.js`, `peerd-runtime/tools/login-affordance.js`,
`peerd-runtime/tools/exposure.js`, `peerd-runtime/actor/idp-registry.js`,
`peerd-runtime/actor/origin-lock.js`, and `peerd-runtime/actor/landing-rule.js`.
Red-team: scenarios 10 and 11.

<a id="inv-15"></a>
### INV-15. A proof-of-possession credential cannot be exfiltrated
**Status: opt-in and reachable.** A user turns this on per integration in Settings →
API integrations by saving a credential with the **DPoP** auth style; peerd mints
that origin's keypair at that moment and shows the public `jkt` thumbprint to
register with the authorization server. Bearer remains the default and the fallback.
What follows is the guarantee for an origin that has it on.

peerd holds a HANDLE to a key it cannot read. A DPoP (RFC 9449) private key is
generated with `extractable: false`, so no in-origin code — not the agent, not a
prompt-injected or outright compromised service worker, not a co-extension that
somehow reached our IndexedDB — can ever export it: `crypto.subtle.exportKey` on it
REJECTS, for every format and every caller including us. That is enforced, not
asserted in prose: `usableDpopPrivateKey` is checked when a key is generated (a
runtime that ignored `extractable:false` THROWS) and again on every load (a record
that fails it is treated as absent, never used). The key can only be USED, on-device,
while resident. It is persisted as a structured-clone handle so it survives a
service-worker eviction without ever becoming bytes we hold, and there is one key per
owned origin, so two integrations cannot be correlated by their `jkt`.

The same non-extractability makes the key DEVICE-BOUND, and that cuts both ways as a
containment property rather than only a limitation. It cannot sync, and a vault
export/transfer never carries it: `buildExport` gathers secrets, settings, memory,
hooks and skills — not the DPoP key store — and the private material could not be
serialized into the file even if it tried. So a stolen or shared vault backup yields
no usable proof-of-possession credential, and the honest cost is that a credential
provisioned on one device works only there and must be re-registered on another
(surfaced in Settings so a restored-vault `401` is not a surprise). Removing an
integration deletes the token AND the keypair (below), so the fingerprint never
outlives the credential on the device that held it either.

The key is HALF the credential, so its lifecycle is the credential's. It is minted
only when provisioning asks for one or when a load RESOLVES with no record — never
after a load FAILED, because "unreadable" is not "absent" and minting over a key we
could not read would retire the `jkt` a live token is bound to, permanently 401-ing
the integration with nothing to explain it; that path fails closed to an anonymous
request and self-heals on the next call. Every mint is audited (origin + public
`jkt`), so a re-key is never silent. Removing an integration deletes the token AND
the keypair, so the stable per-origin fingerprint does not outlive the credential the
user revoked and cannot re-link a later one to it.

Each request carries a FRESHLY minted proof binding the method (`htm`), the request
URI without query or fragment (`htu`), the current time (`iat`), a single-use `jti`,
and a hash of the access token (`ath`). So a stolen access token alone is unusable —
spending it requires signing with a key that cannot be stolen — and a captured proof
is bound to one request at one moment and cannot be replayed against another. Proofs
are minted ONLY at the service worker's egress chokepoint: they never reach the
agent, never enter an actor heap, and do not outlive the request. The binding rules
are the origin-credential rules unchanged — same-origin and https ONLY
(`authOriginForRequestUrl`), so peerd never signs a statement about a URL the actor
does not own and never over cleartext. Every failure mode is fail-closed and SILENT:
a locked vault, an absent key, or a failed signature sends the request ANONYMOUS with
no throw, and the token is never sent unsigned as a consolation prize (the bearer
wrapper `withApiCredentials` refuses a DPoP-scheme secret for exactly that reason).
The audit records the origin and the PUBLIC `jkt` thumbprint only — never the token,
never the proof, never any key material.

**Honest residuals.** Non-extractability prevents EXFILTRATION, not USE: while the
key is resident, in-origin code can still ask the service worker to sign. That is
bounded by the origin binding, by proofs existing only at the audited boundary, and
by the audit log — but it is not eliminated, and it is the reason this is a strict
upgrade over a bearer token rather than a complete answer. DPoP also requires SERVER
support, so bearer remains the fallback for providers that do not implement RFC 9449;
this raises the ceiling, it does not raise the floor. Server NONCES (RFC 9449 §8) are
now handled: the boundary caches the newest nonce per owned origin, rides it on
subsequent proofs, and re-signs ONCE on a `400`/`401` carrying a fresh `DPoP-Nonce`.
The retry is deliberately narrow, and each condition is a failure mode it exists to
prevent — a repeated nonce does not retry (no request storm against the user's
credential), a one-shot stream body does not retry (no duplicated write), a bearer
origin does not retry (it has no dance to run), and a second signing that fails
returns the server's own answer rather than an unsigned request. The cache is keyed
by the canonical owned origin and held in memory only, so a nonce is structurally
incapable of reaching another server and is never persisted. The remaining gap on our
side is key ROTATION, which is manual: a key lives until the integration is removed,
so rotating one means removing and re-adding the credential (and re-registering the
new thumbprint).
Code: `peerd-egress/dpop/proof.js` (pure canonicalization), `peerd-egress/dpop/keys.js`
(`generateDpopKeypair`'s non-negotiable `false`, `usableDpopPrivateKey`, the
mint/read/retire lifecycle), `peerd-egress/dpop/nonce.js` (the pure §8 retry
decisions + the bounded per-origin nonce cache),
`peerd-egress/fetch/web-fetch.js` (`withDpopCredentials`, which sequences them),
`peerd-egress/fetch/origin-credentials.js`,
`peerd-egress/fetch/origin-credential-routes.js` (provision / surface the `jkt` /
revoke), `extension/options/sections/api-integrations.js` (the user-facing choice).
Tested: `tests/peerd-egress/dpop.test.ts` (against real WebCrypto — the load-bearing
case is that `exportKey` on the private key rejects),
`tests/peerd-egress/dpop-nonce.test.ts` (the §8 dance — the load-bearing cases are
that the retry happens exactly ONCE and that the retried proof is a genuinely new
signature over the new claims, verified for real), and
`extension/tests/unit/peerd-egress/dpop-key-idb.test.js` (in-browser, real
IndexedDB — the handle survives a genuine structured-clone store→evict→load cycle
still non-extractable, still `exportKey`-rejecting, and still signing a proof that
verifies against its persisted public key; the Bun tier can only prove this over a
`Map`, which never crosses the clone boundary).

<a id="inv-16"></a>
### INV-16. Local Contributor Metrics cannot collect or transmit without consent
Contributor Metrics is a closed local accumulator, not an event bus. Before current
versioned consent, its turn and feedback recorders are inert and create no storage
record. Only the exact Options document may enable, disable, or clear consent. Only
the exact side panel and Home chat surfaces may submit binary feedback, and the
background re-derives the final human turn and cohort instead of accepting them from
the page.

The schema accepts reviewed enums, bounded counters, and named histogram buckets.
Unknown keys fail closed. Unknown provider and model strings collapse to `custom`, so
a caller cannot encode a URL, prompt, identifier, or other content in a cohort field.
Restart-safe operation and feedback tokens are consent-rotated, bounded, local-only,
and absent from the canonical payload bytes shown in Settings. Disabling commits a
newer revocation generation before cleanup, making every older consent snapshot and
pending receipt unavailable for processing or display. Each generation uses a durable
proposal followed by its commit marker, so an unseen timed-out write remains inert;
physical deletion is bounded and cannot delete a later acknowledged choice.

This stage has no uploader, endpoint, alarm, collector origin, or network primitive.
Store and web channels register no Contributor Metrics routes or UI. A later uploader
is a separate security boundary and cannot inherit consent if the disclosure version
changes.
Code: `peerd-runtime/observability/contributor-metrics.js`,
`peerd-runtime/observability/contributor-store.js`,
`background/kernel-contributor-owner.js`,
`background/kernel-contributor-feedback-guard.js`,
`offscreen/semantic-routes/contributor.js`, and
`options/sections/contributor-metrics.js`. Red-team: scenario 12.

<a id="inv-17"></a>
### INV-17. The model cannot call a facility the runtime cannot host
The privileged background resolves host support into a browser-neutral runtime
capability snapshot. The same snapshot removes unavailable tool descriptors,
corrects static prompt guidance, and drives a dispatch gate that refuses forged
hidden calls without performing work. Human controls may narrow their own
presentation from local API probes, but they cannot grant model or dispatch
authority. Unsupported voice setup is refused before a model download or
microphone prompt begins. OCR and local WebGPU controls refuse before downloads.
Artifacts without a dweb mesh host omit the dweb module, controls, defaults,
and model tools.

Code: `peerd-runtime/runtime-capabilities.js`, `peerd-runtime/tools/gates.js`,
`background/kernel-turn-authority-adapter.js`, `packaging/gen-channel-config.ts`.
Red-team: scenario 08.

<a id="inv-18"></a>
### INV-18. Durable site clients remain in their actor's origin custody
A stored site client is executable, origin-keyed knowledge, not a global actor
library. An API actor can read, run, or change only the client for its fixed
canonical origin. A bound tab actor can touch only the client for its durable
owned origin; after it has a tab, that tab must still be live at the owned
origin. A roaming actor owns no durable origin: it may touch only the exact
ordinary origin in its live tab, never an unrelated client, a no-tab client, or
an origin the sensitivity classifier says carries the user's identity. A
missing guard, unreadable tab, malformed custody state, or legacy session with
no persisted origin state fails closed.

The actor-tier gate performs a synchronous preliminary custody check before
confirmation; a denial stops there. On an allow path, each tool checks the final
normalized target after yielding record reads, worker execution, consent, and
result-bookkeeping steps before it can expose bytes or admit a later effect.
Store mutations are authorized immediately before invocation; an already
admitted IndexedDB commit cannot be retroactively canceled if custody changes
while it settles. A tab-backed allow reads and judges the authoritative owned
tab when one exists; an exact-origin bound actor may deliberately use its client
before it opens a tab. These repeated checks cover both pre-tool argument
rewrites and self-retasking pages. The sealed worker's `site-fetch/call` relay
reauthorizes on every operation and again immediately before network IO. Capture
may observe a common `api.` sibling, but its digest retains exact-origin
attribution and calls it separate custody; only that origin's actor may verify
and persist its client.
Code: `peerd-runtime/actor/origin-lock.js` (`mayUseSiteClientOrigin`),
`tools/gates.js`, `tools/defs/site-client-{read,run,write}.js`, and
`tools/defs/site-capture.js`. Red-team:
scenario 13.

<a id="inv-19"></a>
### INV-19. Browser location does not grant site or identity-provider authority
A numeric tab handle may bind an actor only to an ordinary origin observed by
the browser after the durable sensitivity inputs are ready. If that tab is on a
known signed-in origin, numeric resolution refuses before session creation,
mailbox persistence, model work, or page access. The only route to a bound actor
for that origin is the explicit `site:<origin>` handle, used when the user's own
request already targets the site. A redirect chosen by a page therefore cannot
choose the origin that receives bound authority.

A dedicated identity-provider origin is a third category: transit-only. It is
sensitive for session and durable-client custody, but it cannot receive a
roaming, numeric-tab, or standalone `site:` actor. A bound relying-party actor
may enter it only after a confirmed verified SSO action creates a one-shot grant
for that exact known IdP origin. Landing consumes the grant and parks the actor.
While parked, the actor has no tool or credential authority at the IdP.
Returning to the exact relying-site origin clears the excursion so a later request can continue.
Any other origin or invalid durable state stops the actor. This keeps real sign-in
working without treating the user's identity provider as an ordinary destination.

The resolver classifies the same canonical origin it passes to the mint
function. The mint function does not read the tab again or replace that origin.
If the page moves later, the existing landing lock compares the live destination
to the ordinary origin already bound and stops the actor before page access.
Refusals expose only the canonical origin and a machine-authored recovery rule.
They never expose the path, query, title, or other page-authored text.

Code: `peerd-runtime/actor/numeric-tab-authority.js`,
`peerd-runtime/actor/idp-registry.js`, `peerd-runtime/actor/landing-rule.js`, and
`peerd-runtime/actor/actor-messaging.js`.
Red-team: scenario 10.

<a id="inv-20"></a>
### INV-20. Confirmation and uncertain-action authority do not cross chats or actors
A confirmation is human authority for one live prompt. Only the browser-owned
side panel or Home page may answer. The active root chat, exact execution
session, and tool dispatch must match the coordinator's pending record. Other
extension pages cannot answer, and an unrelated active chat is not sent the
prompt identifier. Switching back replays only that chat's queued prompt.
Stopping an execution session declines its own prompts without touching another
session's queue.

An actor heap is not an authority boundary that resets uncertainty. Operation
IDs remain scoped to the exact execution session, but unresolved action intent
is scoped to the owning root chat and normalized external target. Repeating the
same uncertain action through a sibling actor therefore requires a new exact
user confirmation. A different root chat or external target remains independent.

Code: `peerd-egress/confirm/protocol.js`, `background/routes/vault.js`,
`peerd-runtime/lifecycle/dispatch-tracking.js`,
and `peerd-runtime/tools/dispatcher.js`. Red-team: scenario 14.

### Additional invariants (not scenario-gated, enforced in code)

- INV-9. Vault fails closed. A secret read or write is refused with `VaultLockedError`
  unless the vault is unlocked. A wrong passphrase throws `WrongPassphraseError` with no
  wrong-versus-tampered side channel, and never rewrites the blob. The key is never
  returned to a caller. Both unlock factors (Argon2id and WebAuthn-PRF) recover the same
  key. A tampered or out-of-bounds KDF descriptor is rejected before any derive runs.
  Code: `peerd-egress/vault/`. Tested: `tests/peerd-egress/vault-*.test.ts`,
  `extension/tests/unit/peerd-egress/vault*.test.js`.
- INV-10. The store build is minimal. The store Chrome package never ships `debugger`.
  Every Firefox package drops Chrome-only permissions. The store artifact contains zero
  `peerd-distributed` traces. Code: `packaging/gen-manifest.ts`
  (`STORE_STRIPPED_PERMISSIONS`), `packaging/verify-store-artifact.ts`. Tested:
  `tests/store/`, CI.
- INV-11. There is exactly one egress path per class. A bare `fetch` is forbidden by
  lint. The credentialed path (`safeFetch`) and the open-web path (`webFetch`) are
  separate wrappers, so VM and app traffic can never reach the provider allowlist or
  the API key. Code: `eslint.config.js` (`no-restricted-globals`),
  `peerd-egress/fetch/`.

---

## 7. Scope

### In scope
- Exfiltration of the vault, API key, or conversation off-device.
- Prompt injection that bypasses actor credential custody, tool gates, the
  untrusted-content fence, or the isolated heap where available, and reaches the
  orchestrator's tools, memory, or key.
- Sandbox escape (WebVM, Notebook, App iframe) reaching the host, other origins, or
  privileged extension contexts.
- Denylist, egress-chokepoint, or SSRF-guard bypass.
- Vault or crypto weaknesses, and auth-bypass of the lock.
- Manifest, CSP, or permission misconfigurations that widen the attack surface.
- Mesh: bundle-integrity or signature bypass, sender-gate bypass, or unconsented
  signing. Preview channel, understood to be pre-hardening.

### Out of scope
- An already-compromised OS or browser, or a malicious extension installed alongside
  peerd. Both already have in-origin or in-process reach. See R7.
- Physical access to an unlocked device.
- Self-inflicted configuration, such as the user removing their own denylist entries,
  or importing a transfer file they know to be hostile. See R6 for the injection surface
  a shared import creates.
- Social engineering of the human, and missing best-practice headers without a
  demonstrated impact.
- The dweb and `peerd-distributed` preview is research-grade and ships only on the
  preview channel. Report issues, but understand the protocol is pre-hardening.

---

## 8. Known residual risks

These are stated plainly. Several are deliberate tradeoffs. All are things a reader
evaluating peerd should know. Each cites where it lives in the code.

- R1. Actor isolation depends on the browser's dedicated Worker implementation.
  Chrome starts the runner from its offscreen document. Firefox starts the same
  runner from the extension background page. A startup handshake checks the
  protocol, worker realm, host canary separation, and absence of extension APIs
  before any model or tool relay. Firefox uses a run-scoped, acknowledged
  `storage.session` heartbeat while the background page owns an active Worker.
  A failed heartbeat pauses actor work until a manual probe succeeds. The
  durable actor mailbox never replays stored work after a background
  restart: queued work becomes Not run, while started and legacy work becomes
  Outcome unknown until the target is checked. If the
  startup proof fails twice before work starts,
  the capability becomes visibly unavailable and actor tools fail closed. This
  guards against missing support and startup faults. It does not protect against
  a browser engine defect that breaks Worker isolation itself. The dedicated
  Worker also retains standard web APIs such as `fetch`; it is a memory boundary,
  not a sealed code sandbox. Model output is not evaluated as code in that realm,
  and model or tool requests use the privileged relay paths.
  (`offscreen/actor-runner.js`, `offscreen/actor-worker-protocol.js`,
  `background/direct-actor-host.js`, `peerd-runtime/actor/isolation.js`.)
- R2 (narrowed). Memory poisoning. The auto-memory digest excludes tool results and
  synthetic messages, but still includes raw assistant text, which can echo
  attacker-paraphrased content, and an approved note persists into every future prompt.
  Approval is the trust boundary. A user who approves a poisoned note owns the
  consequence. Narrowed: the `/init` seed of always-loaded project memory now
  CDR-strips its page-derived probe (`memory/init-orchestrator.js`, INV-12), so an
  INVISIBLE-Unicode instruction can no longer ride into durable memory beneath the
  approval gate — the note the user reviews is the note the model reads. The residual is
  the visible channel: content the model paraphrases into ordinary assistant text.
  (`peerd-runtime/memory/auto-memory.js`, `memory/init-orchestrator.js`.)
- R3 (narrowed). A skill body is trusted instructions by design. Skill install fetches
  through `webFetch` (denylist and caps), and the frontmatter parser refuses unknown
  keys, but the skill body loads into context as trusted instructions with no
  untrusted-content fence. A malicious shared skill is a direct instruction-injection
  vector. Installing a skill runs its author's prompt. Narrowed: the skill name and
  description rendered into the startup prompt — the one skill field shown before any
  `load_skill` — are now CDR-stripped (`skills/registry.js`, INV-12), so the description
  the user reviewed in the skills UI is the description the model reads; a covert
  invisible-Unicode channel in that field is closed. The BODY remains trusted-by-design.
  (`peerd-runtime/skills/`.)
- R4 (narrowed). The audit log is tamper-EVIDENT, not tamper-proof. Every entry
  extends a SHA-256 hash chain and a head record pins the newest link, so a rewritten
  entry, a deleted middle entry, a truncated tail, or an inserted record fails
  verification (`verify()`, surfaced in the debug bundle's provenance) — including
  the cheaper attack of deleting the tail AND the head record together, which fails
  closed on the surviving chained prefix. What remains out of reach: an attacker with
  in-origin code execution can recompute the whole chain and the head — no in-origin scheme can prevent that without a secret the
  origin does not hold. (`peerd-egress/audit/chain.js`, `audit/log.js`.)
- R5 (narrowed). Confirm grants are origin-BOUND: a session-scoped "Yes" is keyed by
  tool + the prompt's dispatcher-computed origin (the pinned tab for DOM tools, the
  target host for web writes), so approving `click` on one site no longer covers any
  other site; the origin line the user sees is system-derived. What remains: the
  DESCRIPTION text is agent-supplied, so a misleading summary could still induce a
  "yes" for the named origin. (`background/confirm-grant-key.js`,
  `peerd-egress/confirm/protocol.js`.)
- R6 (narrowed). Transfer import is a gated untrusted-deserialization surface.
  Provider endpoints are validated (https or local loopback only) and named in the
  summary the user approves; imported hooks land DISABLED and untrusted (a JS hook
  cannot compile without an explicit re-trust in Settings); a memory import states its
  prompt-injection consequence in the apply notices. What remains: an approved https
  endpoint is still an egress redirection the user chose to accept, and imported
  memory is trusted once the user proceeds. Import only files you trust.
  (`peerd-runtime/transfer/transfer.js`.)
- R7. A malicious co-installed extension or compromised origin is out of scope. The live
  key is reachable to any code running in the extension origin, and is mirrored into
  `chrome.storage.session` for service-worker-restart resume. The stated threat model is
  that anything with in-origin execution already has service worker memory.
  (`peerd-egress/vault/vault.js`.)
- R8. The CheerpX WebVM disk image is a live third-party dependency. The root filesystem
  streams from a third-party host over WSS and cannot be SRI-pinned. A compromise of that
  host feeds content into the VM the agent runs commands in. The Moonshine model, by
  contrast, is SRI-verified. (`extension/vendor/cheerpx/SOURCE.txt`.)
- R9. The `<all_urls>` host permission. The manifest grants the broadest host reach.
  Which hosts the extension may actually fetch or script is a runtime concern (the egress
  allowlist and denylist), so a bug that bypasses the runtime gate has full-web reach at
  the browser layer. (`manifests/base.json`.)
- R10. The soft-injection defense has limited regression coverage. The structural
  fence (`neutralizeFence`) is tested, and a regression test now asserts the
  system-prompt still carries the load-bearing untrusted-content framing
  (`tests/peerd-runtime/system-prompt-framing.test.ts`), so a template edit that
  strips that framing fails CI. What is still not covered: whether that framing is
  actually persuasive to the model. The framing is a soft defense; the structural
  defenses (keyless loop custody, the isolated heap where available, and the gates)
  are the real story. The red-team benchmark
  (scenario 08) tests the gates, not the prompt text.
  (`peerd-provider/system-prompt.txt`, `peerd-runtime/loop/system-prompt.js`.)
- R11. Open-web exfil, and what is left of key extractability. The extractability half is
  now narrowed rather than open. The data key the vault holds while unlocked is unwrapped
  NON-EXTRACTABLE, so `exportKey` on the handle the vault passes to its encrypt/decrypt
  primitives rejects, and a bug that leaks that reference can no longer turn it into
  bytes. Extractable handles still exist — transiently, inside the vault, on the paths
  that must feed the key to `wrapKey`, which refuses a non-extractable key: creation, and
  the two enrollment operations that seal the key under a NEW factor. Because neither
  enrollment is given the factor the stored blob is already sealed under, the vault keeps
  the key a second time as ciphertext under an ephemeral non-extractable AES-KW key, and
  those operations materialize an extractable handle from it, spend it on one wrap, and
  drop it. What this does NOT buy: non-extractability prevents EXPORT, not USE — anything
  running in the extension origin can still use the live key to decrypt every stored
  secret (R7) — and while the vault is unlocked its raw key bytes are still mirrored into
  `chrome.storage.session` so a service-worker restart resumes unlocked, readable by that
  same code. That mirror is BOUNDED, which it previously was not. `lock()` clears it
  whatever the state of service-worker memory (so a lock on a worker that never resumed,
  or a second lock, still erases bytes that instance never held), every mirror write is
  serialized behind the same chain and re-checked against a lock counter (so a persist
  in flight when the lock lands cannot resurrect it), and the record carries the unlock
  time plus the auto-lock policy in force — a resume past that deadline is refused and
  the mirror purged, a resume PRESERVES the original timestamp so it cannot extend the
  window, and a mirror with no timestamp fails closed. That deadline is an absolute cap
  from the last real unlock, not idle-refreshed: at or tighter than what the idle
  setting promises, never looser. Two things it still does not do: the bytes are not
  scrubbed AT the deadline (nothing runs while the worker is dead — they linger in
  RAM-only session storage until the next resume attempt refuses them, or the browser
  closes), and a user who set auto-lock to "never" keeps the unbounded mirror they asked
  for. Separately, the open-web `webFetch` path is allowlist-free, so exfil to an
  arbitrary public host is not prevented by the allowlist; that half is mitigated only by
  the keyless-web-actor architecture (INV-3). (`peerd-egress/vault/keys.js`,
  `peerd-egress/vault/vault.js`, and the header of `peerd-egress/fetch/safe-fetch.js`.)
- R12. CLOSED (issue #251), and what replaced it is worth stating precisely because the
  original wording was about a pin. A web actor is still pinned to a TAB rather than an
  origin, and `tools/defs/navigate.js` still re-stamps that pin to wherever the tab
  lands — deliberately, because that pin IS the session-credential scope, and freezing
  it would leave a retasked actor holding credentialed reach into the origin it just
  left while the confirm prompts, the origin gate and the audit log all named the wrong
  site. What changed is that the pin is no longer the only thing consulted. Every web
  actor now carries an ORIGIN STATE — roaming (browses, holds no authority, may not
  enter a site the user has an identity on) or bound (owns one origin, may not leave
  it) — and the LANDING is judged at the DOM chokepoint every tool funnels through, plus
  inside `navigate` itself, which is the one place that observes a landing as it is
  created. That collapses all three ways a tab's origin can change (a tool call, a 302
  with no tool call, a page redirecting itself) into one check no redirect chain walks
  around. The same policy is asked synchronously inside the credential-scope getter, so
  a self-redirect onto a credentialed origin cannot be spent by `fetch_url`,
  `read_result` or a site-client fetch in the window before a DOM tool re-enters
  the chokepoint. Durable client record custody is a separate invariant (INV-18).
  (`peerd-runtime/actor/landing-rule.js`, `origin-lock.js`,
  `browser-authority/dom-helpers.js`; driven end to end by the `origin-lock` e2e state.)
  The #251 arc hardened the TAB actor's site-client CREDENTIAL path but left its
  API-actor sibling: the `site-fetch/call` relay's `backing:'api'` branch pinned credentials to the
  MODEL-supplied `origin` argument, so an API actor bound to one origin could name a
  DIFFERENT origin and spend that origin's stored key + cookies — a cross-origin
  credential escalation past the "an API actor owns one origin" containment (DESIGN-18).
  Closed: the branch now pins to the actor's own bound origin (`instanceId`) and refuses a
  cross-origin target, mirroring `fetch_url`'s API pin.
- R13. The egress tripwire does not scan the query string or fragment, so the canonical
  exfil GET is uncovered. `attacker.test/?d=<blob>` is not inspected, because that is
  where legitimate long high-entropy values live — OIDC `id_token`s, SAML requests,
  presigned-URL signatures — and scanning them would false-block federated login, which
  is a worse failure for a browser agent than the leak it prevents. Navigation is also
  exempt from INV-13 by design. The INTERSECTION of those two individually-reasonable
  exemptions is an off-origin navigation carrying a payload in the query, which is the
  arc's stated target and is not closed. Not a regression — identical before the arc.
  (`peerd-runtime/tools/egress-heuristics.js`, KNOWN RESIDUALS.)
- R14. INV-9's structural reply boundary ships OFF. The deterministic actor-reply
  envelope is default-off on both channels behind a Settings toggle, so for a default
  install the web actor's reply crosses on the prompt fence alone — a strong hint to the
  model, not a wall. The invariant is written as "when armed" and the red-team probe
  drives the validator directly for that reason. Turning it on by default waits on field
  evidence that the format holds. (`packaging/default-settings.mjs`
  `schemaValidatedReplies`.)
- R15. Sensitive-origin classification is a list, and lists are incomplete. #251 decides
  "is this a site the user has an identity on" from a curated registry (#242's UGC
  hosts, asked at origin level), origins with a stored credential, and two signals
  LEARNED from ordinary use — a password field seen on a page, and a write the user
  approved. It fails open, so an unlisted credentialed site is treated as ordinary until
  a signal fires. The signal is observed at the DOM chokepoint every DOM tool passes
  through, so which tool an actor reaches for no longer decides whether peerd learns
  (#267 — it used to fire only on `snapshot`, and tool choice belongs to whoever is
  driving the actor). The FIRST landing on a site whose login the actor never sees is
  unprotected by construction. An origin can now be un-learned: Settings → Learned
  sites lists what was inferred and removes it (#262), and the signal is credited to
  the origin the probe REPORTS rather than to the caller's tab record, so a page that
  navigates mid-call cannot spend it on someone else (#278). Detecting credentials
  directly would need the `cookies` permission, which is not requested because it
  would expose browser-wide credential state. Learned signals are keyed by hostname,
  not origin: scheme and port changes cannot route around a learned mark, and a mark
  on a parent host also covers its descendants (#264). A mark learned on a child host
  does not spread to its parent or siblings. Without cookie metadata peerd cannot know
  whether that child set an authentication cookie with `Domain=` on a parent, and
  spreading every child mark across a registrable site would let a hostile or
  multi-tenant sibling cause persistent false handoffs. Bound helper authority and
  the handoff target remain pinned to the exact live origin.
- R16. The identity-provider list is the one place a bound actor may leave its origin,
  and it is deliberately short — a host qualifies only if signing in is essentially all
  it does. github.com, gitlab.com and facebook.com are excluded despite speaking OAuth,
  because admitting them would make the whole product origin eligible for a sign-in
  grant. The cost is a real one: a bound actor sent through "sign in with GitHub" ENDS.
  That is the safe failure, but it is a failure, and whether it happens often enough to
  change the trade is a question for use rather than for this document.
  (`peerd-runtime/actor/idp-registry.js`.)
- R17. A handoff names a successor the orchestrator may address, and the origin in it is
  chosen by whatever moved the tab — which on a hostile page is the attacker. The
  successor is a BOUND TAB actor (`site:<origin>`), which holds no stored key, so it is
  not an authority upgrade over what user-directed work on that site would already have;
  and the report conditions the successor explicitly on the user's own request having
  been about that site. But the report is first-party text the orchestrator is meant to
  trust, so a hijacked page gets one attempt at persuading it to open a helper somewhere
  the user never asked about. (`peerd-runtime/actor/origin-lock-report.js`.)

- R20. Direct native cross-origin form actions are blocked before activation (#269).
  The URL tripwire cannot see a form destination or its live values in `click` or
  `type` arguments, so the injected click and type bodies resolve the native form action
  on the exact document and element immediately before the effect. A cross-origin action
  is refused before click activation, value mutation, or submit events. The fixed result
  says that nothing was submitted and directs the user to review and submit the form
  manually. Verified login is the narrow exception because its exact identity-provider
  destination already has fresh user consent and a one-shot excursion grant
  (`tools/defs/click.js`, `tools/defs/type.js`, `tools/browser-automation-policy.js`).

  The boundary is intentionally limited to the live native action that peerd can resolve
  before it fires page events. Page-script beacons remain outside the tool action path.
  A handler can change a same-origin action after an input or click event, submit through
  JavaScript, or send data without using the form action. A same-origin endpoint can also
  relay the body or redirect after it receives the request. Those page-driven channels
  remain residuals. Red-team: scenario 09.
- R21. `fetch_url` headers and body are structurally invisible to the same scanner
  (#270). The tripwire was widened to cover the web actor's own fetch, but it reads
  only the URL-shaped fields; header values and any request body are never examined,
  and the candidate collector only walks top-level strings, so an object argument could
  not be read even if it were listed. `fetch_url` strips the credential-bearing headers
  and passes the rest through verbatim. The scanner is already a pure function over
  strings, so the cheapest close is to run it over those values too — it is listed here
  because it is not done, not because it is hard.
- R23. The password probe follows attributable DOM boundaries (#277). It now walks
  open shadow roots and frames whose current origin exactly matches the top document,
  plus declared inherited `about:blank` and `srcdoc` documents. Closed shadow roots
  remain unobservable. Cross-origin frames are deliberately excluded: an embedded IdP
  or payment widget belongs to its own origin, and treating its password field as
  evidence about the relying party would recreate the false-positive cost from #257.
  The original full light-DOM query remains intact; only discovery of additional roots
  is bounded, and an exhausted negative stays unknown at the policy boundary. Fields
  beyond that budget can therefore still fail open.
  `autocomplete="new-password"` is matched as a token, including sectioned and WebAuthn
  forms (`dom/walk-injected.js`; `tests/unit/peerd-runtime/dom-walk.test.js`).
- R24. Chunked exfil defeats the minimum-blob threshold (#279). The tripwire is a pure
  per-call function over one call's slots, and the dispatcher hands it no history, so a
  payload split below the threshold passes as many times as an attacker cares to
  repeat it and reassembles server-side. Cross-call aggregation is the only real
  answer; the module header already lists fragmentation as accepted, and this records
  it as a decision rather than an oversight (`tools/egress-heuristics.js`).

Candidates for future red-team scenarios, from the partially-defended surfaces above:
R2 memory poisoning and R3 skill-body smuggling. (R4 chain tampering, R5 grant
scoping, and R6 import gating gained direct bun coverage when they were narrowed:
tests/peerd-egress/audit-chain.test.ts, tests/background/confirm-grant-key.test.ts,
and the R6 block in tests/peerd-runtime/transfer/transfer.test.ts.)

---

## 9. Testability: the red-team suite

Every SCENARIO-GATED invariant is checked by an executable probe in
[`tests/red-team/`](../../tests/red-team/) — the corpus declares which, and
`bun run red-team:report` regenerates the matrix, so the mapping lives in the
suite rather than in a range hard-coded here (CLAUDE.md: prose must not pin
dynamic facts). The invariants under "Additional invariants (not scenario-gated,
enforced in code)" are, as that heading says, enforced by lint, packaging checks
and unit tests instead — they have no red-team probe and are not claimed to.
Each scenario drives the real defense
function with hostile input and records whether the defense held. It runs under
`bun test ./tests/red-team`, which is a CI gate, and publishes a result matrix to
[`RED-TEAM-RESULTS.md`](./RED-TEAM-RESULTS.md) via `bun run red-team:report`. The
real-realm escapes (scenario 06) are verified in the in-browser CDP suite.

Scenario 09 is worth reading differently from the rest. Its corpus is not invented:
every case is either a documented channel or a bug an adversarial review of the
#241-#244 arc actually produced and we then fixed, so it is a regression net under
specific defects rather than a demonstration. It also carries two cases that assert a
defense does NOT fire — Persian text keeps the ZWNJ it needs, and a federated-login URL
full of high-entropy tokens is allowed through. A security check that breaks ordinary
use gets switched off, and then it defends nothing, so the false-positive guards are
part of the claim rather than an afterthought.

Read this as evidence, not proof. These are runnable probes for the core
invariants above, not a complete adversarial audit. Most run at the unit level
against the real defense functions; they show that a specific capability path is
denied. They do not show that arbitrary real-world injection workflows cannot
manipulate the user, poison memory, mislead a confirmation, or induce an action
that no gate blocks. Those gaps are named in section 8, not claimed closed. The
honest posture is: peerd has a formal threat model and CI-gated red-team probes
for its core security invariants, not that it is immune to prompt injection.

---

## 10. Change policy

This document tracks `main`. When a security-relevant mechanism changes, update the
cited invariant here and its red-team probe in the same change. When a residual risk is
closed, move it from section 8 into section 6 with a scenario. Vulnerability reporting
and support policy are in [`SECURITY.md`](../../SECURITY.md).
