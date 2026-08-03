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

1. Memory. The reasoning that reads a page runs in a separate worker heap that
   holds no key and no network access.
2. Policy. Every tool call is checked at dispatch against a fixed set of gates.
3. Chokepoints. All outbound network traffic and all signing pass through a single
   audited path.

Injected text can influence a reasoning context, but the context that reads
untrusted content does not hold the key or the network capability.

---

## 2. System surfaces

peerd runs across several browser execution contexts. Trust boundaries fall
between them.

| Surface | What runs there | Holds the key |
|---|---|---|
| Service worker (`background/`) | Orchestrator agent loop, tool dispatch and gates, vault, egress wrappers, all relays | Yes. The vault key and API key live only here |
| Offscreen document (`offscreen/`) | Per-actor and per-actor worker heaps, headless `script`, voice, the dweb base network | No. Worker heaps are keyless |
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
| A bound actor (web, webvm, notebook, app) | Driving one tab, VM, notebook, or app. It holds only that instance's tools, keyless, in its own worker heap on Chrome | Touch another instance or kind, hold the key, or return anything to the orchestrator except a `wrapUntrusted`-fenced summary |
| An actor | A short-lived actor spawned to break down a task. Keyless, own heap, a narrowed toolset | Escalate past its grant, hold the key, or reach another heap. Every tool call is re-checked in the service worker |
| The dweb actor (preview, opt-in) | Monitoring inbound mesh traffic and A2A over the mesh. Keyless, own heap | Delegate on an inbound (untrusted) turn, or sign as the user without consent |
| The egress chokepoint (`safeFetch` and `webFetch`) | Every outbound byte: the allowlist for credentialed calls, or the SSRF and denylist checks for open-web calls | Be bypassed. A bare `fetch` is forbidden by lint across the project |

### 3.2 Trust boundaries

- B1. Untrusted content and the orchestrator's heap. This is the most important
  boundary. Page text, command output, file contents, and peer bytes are read only
  inside a keyless actor or actor worker heap, and return to the orchestrator
  only as `wrapUntrusted`-fenced data. Enforced by the heap split
  (`peerd-runtime/actor/actor-worker-core.js`,
  `background/offscreen-actor-client.js`).
- B2. An agent heap and the network or the key. Model calls and tool calls leave a
  worker only through two service-worker-gated relays. The service worker adds
  `getSecret` and `safeFetch` and re-checks the call. It does not trust the
  worker's arguments.
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

Out of the model entirely (see section 7): a compromised OS or browser, a
malicious separate extension, and physical device access.

---

## 4. Assets

| Asset | Where it lives | Primary protection |
|---|---|---|
| Model-provider API key | Encrypted in the vault, decrypted only in the service worker at request time | Vault crypto (Argon2id or WebAuthn-PRF, AES-GCM), never enters a keyless heap, egress allowlist |
| Origin-bound API keys (per integration) | Vault, injected at the egress boundary only | `origin-credentials.js`. Sent only to the exact owned https origin |
| The user's session cookies (logged-in tabs) | The browser's cookie jar. peerd never reads cookies | Sensitive-origin denylist, Plan and Act mode, confirm gate |
| Page content the agent reads | Transiently, inside an actor heap | The memory boundary (B1) and the untrusted-content fence |
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
Defenses: the memory boundary keeps page bytes out of the orchestrator's heap (B1).
The web actor that reads the page is keyless (`actor/spawn.js`
`restrictCtxCapabilities` strips `getSecret` and `safeFetch`). The credentialed
egress path is an exact-origin allowlist (`safeFetch`). Open-web fetches are gated
by the SSRF block and the denylist (`webFetch`). Page text is `wrapUntrusted`-fenced
with a delimiter the page cannot forge (`tools/prompt-wrap.js`).
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
Every tool call carries an append-only audit entry. The heap split means a model call
cannot smuggle the key across the postMessage boundary (`actor-worker-core.js`
`makeRelayedCallModel` strips every function).
Proven by: scenarios 03, 08 (and 05 for delegation).

### 5.5 Malicious extension (out of scope, see section 7)
A second extension installed alongside peerd, or a compromise of peerd's own
extension origin, is out of scope. Such code already runs in-origin and can reach
service worker memory, including the live key, directly. This is stated as an
accepted limitation (R7), not defended against. Store hardening (no `debugger`
permission in the store Chrome build, a strict CSP) reduces peerd's own attack
surface but does not defend against a separate malicious extension.

### 5.6 Compromised dependency (supply chain)
Can: a subverted vendored library or a remote asset peerd loads could inject code.
Defenses (partial): there is no npm runtime inside the extension. Third-party code is
vendored in `vendor/` with a `SOURCE.txt`. The Moonshine voice model is SHA-384
SRI-verified and refuses to load on a null SRI
(`peerd-runtime/voice/model-store.js`). The store build strips the `debugger`
permission and the dweb module, and CI verifies zero dweb traces.
Accepted residual (R8): the CheerpX WebVM streams its root filesystem image from a
third-party host over WSS, which cannot be SRI-pinned. This is a live trust
dependency for the VM's filesystem. It is named, not defended.
Proven by (partial): scenario 06 for sandbox confinement of whatever the VM runs.

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
### INV-3. The heap that reads a page holds no secret and returns only fenced data
The web, actor, and actor worker heap has `getSecret` and `safeFetch`
unconditionally stripped (`restrictCtxCapabilities`), cannot pass a function or key
across the model-call boundary (`makeRelayedCallModel` drops every function), and its
untrusted summary re-enters the orchestrator wrapped as data (`makeActorSummaryFence`
and `wrapUntrusted`) with a delimiter the content cannot forge (`neutralizeFence`).
Code: `peerd-runtime/actor/spawn.js`, `peerd-runtime/actor/actor-worker-core.js`,
`tools/prompt-wrap.js`. Red-team: scenario 03.

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
`script` tool's `actors.send`/`actors.ask` surface reaches the same `messageActor`, so
it is refused mint on an inbound turn (`tools/defs/script.js` gates `actorsOn` on
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
field, and confirms body-bearing verbs.
Code: `engine-tabs/notebook-tab/notebook-neutralizers.js` (`applyRealmSeal`),
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
redirect refusal is applied by `read_pdf`'s byte fetch (`offscreen/pdf-extract.js`,
`redirect:'manual'`), which previously validated only the pre-redirect host.
Code: `peerd-egress/fetch/private-network.js`, `fetch/web-fetch.js`,
`offscreen/pdf-extract.js`. Red-team: scenario 07.

<a id="inv-8"></a>
### INV-8. Injected instructions cannot reach a capability
For a corpus of injection payloads, the authority each one seeks is denied by a real
mechanism: exfil is denied by the keyless heap and the allowlist, navigation to a
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
- Prompt injection that bypasses the actor boundary (the keyless per-environment heap)
  and reaches the orchestrator's tools, memory, or the key.
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

- R1. The heap split is Chrome-only. It needs the offscreen API. On Firefox — and for
  a run that never started offscreen — the actor falls back to an in-service-worker
  loop where the boundary is a prompt boundary rather than a memory boundary, which
  is the pre-heap-split posture. The memory boundary is not universal.
  (`background/service-worker.js` offscreen fallback.)

  Scoped precisely, because the two fallback lanes differ:

  - A SPAWNED (ephemeral) child is keyless in the same sense the offscreen worker is.
    `restrictCtxCapabilities` strips `getSecret`/`safeFetch` from the tool context
    unconditionally, and the loop itself is handed throwing stubs while the real
    credentials are closed over by the SW-owned `callModel` wrapper and added at the
    call boundary (`actor/spawn.js`, `keylessCredentials`).
  - A BOUND actor (web, webvm, notebook, app, dweb) does NOT take that path. With no
    offscreen client, `runActorTurnOffscreen` returns null and the turn falls through
    to `runAgentTurn`, which comes from the turn driver and forwards the live
    `getSecret`/`safeFetch` into the loop. So on Firefox a web actor ingesting page
    content, and the dweb actor consuming peer bytes, still run with live credentials
    reachable from the loop frame.

  Neither lane has heap separation, which is the deeper point: the child's untrusted
  transcript shares a realm with the vault broker and the engine clients, so a
  memory-disclosure bug there is not fenced the way it is on Chrome. Extending the
  stub custody to the bound-actor lane, and retiring this branch in favor of an
  isolated Firefox host — or failing closed — is P0-1 in
  [`HARDENING-ROADMAP.md`](HARDENING-ROADMAP.md).
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
  defenses (the keyless heap, the gates) are the real story. The red-team benchmark
  (scenario 08) tests the gates, not the prompt text.
  (`peerd-provider/system-prompt.txt`, `peerd-runtime/loop/system-prompt.js`.)
- R11. Key extractability and open-web exfil. The key is generated `extractable:true`
  because `SubtleCrypto.wrapKey` requires it, so a bug holding the key reference could
  export it. The open-web `webFetch` path is allowlist-free, so exfil to an arbitrary
  public host is not prevented by the allowlist. It is mitigated only by the
  keyless-web-actor architecture (INV-3). (`peerd-egress/vault/keys.js`, and the header of
  `peerd-egress/fetch/safe-fetch.js`.)
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
  `read_web_cache` or `site_client_*` in the window before a DOM tool re-enters the
  chokepoint. (`peerd-runtime/actor/landing-rule.js`, `origin-lock.js`,
  `tools/defs/dom-helpers.js`; driven end to end by the `origin-lock` e2e state.)
  The #251 arc hardened the TAB actor's `site_client_*` path but left its API-actor
  sibling: the `site-fetch/call` relay's `backing:'api'` branch pinned credentials to the
  MODEL-supplied `origin` argument, so an API actor bound to one origin could name a
  DIFFERENT origin and spend that origin's stored key + cookies — a cross-origin
  credential escalation past the "an API actor owns one origin" containment (DESIGN-18).
  Closed: the branch now pins to the actor's own bound origin (`instanceId`) and refuses a
  cross-origin target, mirroring `fetch_url`'s API pin. (`background/service-worker.js`
  `siteFetchCallRoute`.)
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
  a signal fires. In practice the password-field signal fires on the first page walk of
  any sign-in surface, so the exposure is narrower than "until you configure something";
  but the FIRST landing on a site whose login the actor never sees is unprotected by
  construction, and nothing un-learns, so an origin stays classified until the profile
  is reset. Detecting credentials directly would need the `cookies` permission, which is
  not requested for the same reason `webNavigation` is not.
- R16. The identity-provider list is the one place a bound actor may leave its origin,
  and it is deliberately short — a host qualifies only if signing in is essentially all
  it does. github.com, gitlab.com and facebook.com are excluded despite speaking OAuth,
  because admitting them would hand a bound actor a budgeted corridor onto the whole
  site. The cost is a real one: a bound actor sent through "sign in with GitHub" ENDS.
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
