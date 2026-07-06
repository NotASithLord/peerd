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
| Offscreen document (`offscreen/`) | Per-actor and per-subagent worker heaps, headless `script`, voice, the dweb base network | No. Worker heaps are keyless |
| Side panel (`sidepanel/`) | The chat UI, confirm prompts, settings | No |
| Sandbox tabs (`vm-tab/`, `notebook-tab/`, `app-tab/`) | WebVM (CheerpX), Notebook (sealed worker), App (opaque origin iframe) | No |
| The mesh (`peerd-distributed/`, preview only) | WebRTC mesh, DHT, gossip, signed direct channels, A2A | No |

The module map (`p`rovider, `e`gress, `e`ngine, `r`untime, `d`istributed) is in
[`CLAUDE.md`](../../CLAUDE.md). Security-relevant code is concentrated in
`peerd-egress/` (vault, egress, denylist, audit) and in the
`peerd-runtime/subagent/` and `peerd-runtime/tools/` layers (the heap split and
the gate stack).

---

## 3. Actors and trust boundaries

### 3.1 Actors

peerd splits "the agent" into separate roles so that no single reasoning context
holds both untrusted input and dangerous capability. Enforcement lives in
`peerd-runtime/tools/exposure.js`, `peerd-runtime/tools/gates.js`, and
`peerd-runtime/subagent/`.

| Actor | Trusted with | Not permitted to |
|---|---|---|
| The user | Everything: unlocking the vault, approving confirms, installing skills and imports | (the root of trust) |
| The orchestrator (main agent loop, in the service worker) | The conversation, planning, and delegating a plain-language goal to an actor | Hold an environment's low-level tools, read raw page bytes, or run untrusted code directly |
| A bound actor (web, webvm, notebook, app) | Driving one tab, VM, notebook, or app. It holds only that instance's tools, keyless, in its own worker heap on Chrome | Touch another instance or kind, hold the key, or return anything to the orchestrator except a `wrapUntrusted`-fenced summary |
| A subagent | A short-lived actor spawned to break down a task. Keyless, own heap, a narrowed toolset | Escalate past its grant, hold the key, or reach another heap. Every tool call is re-checked in the service worker |
| The dweb actor (preview, opt-in) | Monitoring inbound mesh traffic and A2A over the mesh. Keyless, own heap | Delegate on an inbound (untrusted) turn, or sign as the user without consent |
| The egress chokepoint (`safeFetch` and `webFetch`) | Every outbound byte: the allowlist for credentialed calls, or the SSRF and denylist checks for open-web calls | Be bypassed. A bare `fetch` is forbidden by lint across the project |

### 3.2 Trust boundaries

- B1. Untrusted content and the orchestrator's heap. This is the most important
  boundary. Page text, command output, file contents, and peer bytes are read only
  inside a keyless actor or subagent worker heap, and return to the orchestrator
  only as `wrapUntrusted`-fenced data. Enforced by the heap split
  (`peerd-runtime/subagent/actor-worker-core.js`,
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
The web actor that reads the page is keyless (`subagent/spawn.js`
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
(`subagent/delegation-lineage.js` `mayMessageActor`) makes an inbound turn unable to
delegate, and taints any subagent spawned from an injected turn. The A2A translation
core (`subagent/a2a-api.js` `meshCallToOp`) rejects unknown methods and malformed
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
The web, actor, and subagent worker heap has `getSecret` and `safeFetch`
unconditionally stripped (`restrictCtxCapabilities`), cannot pass a function or key
across the model-call boundary (`makeRelayedCallModel` drops every function), and its
untrusted summary re-enters the orchestrator wrapped as data (`makeActorSummaryFence`
and `wrapUntrusted`) with a delimiter the content cannot forge (`neutralizeFence`).
Code: `peerd-runtime/subagent/spawn.js`, `peerd-runtime/subagent/actor-worker-core.js`,
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
An inbound (peer-originated) turn can never make the agent delegate, and a subagent
spawned by an inbound or injected turn is tainted for its whole subtree. Forged,
severed, foreign-rooted, and cyclic lineages fail closed. A poisoned mesh op (bad
method or args) is rejected, and signing as the user requires per-target consent.
Code: `peerd-runtime/subagent/delegation-lineage.js` (`mayMessageActor`,
`buildAncestry`), `subagent/a2a-api.js`. Red-team: scenario 05.

<a id="inv-6"></a>
### INV-6. Sandboxed code is confined to an audited bridge
In a Notebook or headless worker realm, every raw network channel throws, the native
`fetch` is deleted off the prototype chain, and the bridge is pinned non-writable and
non-configurable so in-realm sabotage cannot unseat it. No fresh un-sealed realm can
be created, and OPFS import paths collapse `..` inside the instance root. The App runs
at an opaque origin (the manifest sandbox omits `allow-same-origin` and
`allow-top-navigation`) with all `chrome.*` stripped, and its inlined worker source is
escaped against a `</script>` breakout. The WebVM's only network path is an HTTP bridge
that refuses non-http(s) schemes, scrubs CRLF header injection, drops any smuggled auth
field, and confirms body-bearing verbs.
Code: `notebook-tab/notebook-neutralizers.js` (`applyRealmSeal`),
`peerd-engine/app-compose.js`, `peerd-engine/vm-net/http-bridge.js`,
`peerd-engine/module-resolver.js`, and the manifest sandbox CSP. Red-team: scenario 06,
with the real-realm proof in
`extension/tests/unit/notebook-tab/notebook-seal.test.js`,
`extension/tests/unit/offscreen/job-runner.test.js`, and
`extension/tests/unit/red-team/sandbox-escape.test.js`.

<a id="inv-7"></a>
### INV-7. No egress to private, loopback, link-local, or metadata hosts
`webFetch` refuses a host classified as private, loopback, link-local, `.local`, or
metadata by `isPrivateOrLocalHost`, across decimal, hex, octal, and short-form IPv4 and
IPv4-mapped and NAT64 IPv6 encodings, before any network call, ahead of the denylist,
and fails closed on redirects so a public host cannot pivot to an internal one.
Code: `peerd-egress/fetch/private-network.js`, `fetch/web-fetch.js`. Red-team:
scenario 07.

<a id="inv-8"></a>
### INV-8. Injected instructions cannot reach a capability
For a corpus of injection payloads, the authority each one seeks is denied by a real
mechanism: exfil is denied by the keyless heap and the allowlist, navigation to a
sensitive site by the denylist, SSRF by the private-network guard, a low-level DOM tool
on the main turn by the exposure gate, an actor-only tool via a subagent by the tier
gate, a cross-instance call by the instance pin, a write in Plan mode by Plan and Act
mode, and a fence break-out by `neutralizeFence`. This is the difference from a
single-context agent (a "browser-use"-style agent) that runs the model, the tools, the
key, and the page's text in one reasoning context, where the injected instruction sits
in the same context that holds the authority.
Code: the gate stack and heap split cited above. Red-team: scenario 08, which includes
the side-by-side comparison.

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

- R1. The heap split is Chrome-only. It needs the offscreen API. On Firefox the actor
  falls back to a keyless in-service-worker loop where the boundary is a prompt
  boundary rather than a memory boundary, which is the pre-heap-split posture. The
  memory boundary is not universal. (`background/service-worker.js` offscreen fallback.)
- R2. Memory poisoning. The auto-memory digest excludes tool results and synthetic
  messages, but still includes raw assistant text, which can echo attacker-paraphrased
  content, and an approved note persists into every future prompt. Approval is the trust
  boundary. A user who approves a poisoned note owns the consequence.
  (`peerd-runtime/memory/auto-memory.js`.)
- R3. A skill body is trusted instructions by design. Skill install fetches through
  `webFetch` (denylist and caps), and the frontmatter parser refuses unknown keys, but
  the skill body loads into context as trusted instructions with no untrusted-content
  fence. A malicious shared skill is a direct instruction-injection vector. Installing a
  skill runs its author's prompt. (`peerd-runtime/skills/`.)
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
- R10. The soft-injection defense has no regression harness. The structural fence
  (`neutralizeFence`) is tested, but the "treat inside as data" framing lives in the
  system-prompt text, so a template edit that weakens it would pass CI. The red-team
  benchmark (scenario 08) tests the gates, not the prompt text.
  (`peerd-provider/system-prompt.txt`, `peerd-runtime/loop/system-prompt.js`.)
- R11. Key extractability and open-web exfil. The key is generated `extractable:true`
  because `SubtleCrypto.wrapKey` requires it, so a bug holding the key reference could
  export it. The open-web `webFetch` path is allowlist-free, so exfil to an arbitrary
  public host is not prevented by the allowlist. It is mitigated only by the
  keyless-web-actor architecture (INV-3). (`peerd-egress/vault/keys.js`, and the header of
  `peerd-egress/fetch/safe-fetch.js`.)

Candidates for future red-team scenarios, from the partially-defended surfaces above:
R2 memory poisoning and R3 skill-body smuggling. (R4 chain tampering, R5 grant
scoping, and R6 import gating gained direct bun coverage when they were narrowed:
tests/peerd-egress/audit-chain.test.ts, tests/background/confirm-grant-key.test.ts,
and the R6 block in tests/peerd-runtime/transfer/transfer.test.ts.)

---

## 9. Testability: the red-team suite

Every invariant INV-1 through INV-8 is checked by an executable probe in
[`tests/red-team/`](../../tests/red-team/). Each scenario drives the real defense
function with hostile input and records whether the defense held. It runs under
`bun test ./tests/red-team`, which is a CI gate, and publishes a result matrix to
[`RED-TEAM-RESULTS.md`](./RED-TEAM-RESULTS.md) via `bun run red-team:report`. The
real-realm escapes (scenario 06) are also proven in the in-browser CDP suite.

---

## 10. Change policy

This document tracks `main`. When a security-relevant mechanism changes, update the
cited invariant here and its red-team probe in the same change. When a residual risk is
closed, move it from section 8 into section 6 with a scenario. Vulnerability reporting
and support policy are in [`SECURITY.md`](../../SECURITY.md).
