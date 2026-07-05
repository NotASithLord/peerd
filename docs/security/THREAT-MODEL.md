# peerd threat model

> **Status: 0.x experimental beta.** This is a living document. It describes the
> security architecture peerd is *built around*; where prose and code disagree,
> **the code wins** — every claim below cites the source file that enforces it, and
> the invariants are wired to an executable [red-team suite](../../tests/red-team/)
> so they can be re-checked against the current tree, not taken on faith.
>
> For how to report a vulnerability and the support policy, see
> [`SECURITY.md`](../../SECURITY.md). This document is the formal companion to it:
> actors, assets, adversaries, invariants, scope, and residual risks.

---

## 1. What peerd is, in one paragraph

peerd is a browser-native AI agent, shipped as a Chrome/Firefox extension. The
agent loop runs entirely in the user's browser. It holds the user's model-provider
API key (BYOK) in an encrypted vault, drives the user's logged-in tabs and DOM,
runs code in sandboxes (a WebAssembly Linux VM, sealed JS workers, opaque-origin
App iframes), and — on the preview channel — reaches a peer-to-peer mesh. There is
**no backend, no telemetry, no account**. That means the browser *is* the trust
boundary, and every capability the agent has is a capability an attacker who
subverts the agent would inherit. The whole security design exists to make that
subversion not matter.

The central bet: **an AI agent that reads attacker-controlled content will
eventually be prompt-injected, and no filter reliably prevents it — so the fix is
to never let the injected reasoning hold the dangerous capability in the first
place.** peerd enforces this by *memory* (the reasoning that reads a page runs in a
separate heap with no key and no egress), by *policy* (every tool call is gated at
dispatch), and by *chokepoints* (all egress and all signing funnel through a single
audited path). Injected text can steer a reasoning context all it wants; the design
goal is that it finds no lever to pull.

---

## 2. System surfaces

peerd runs across several browser execution contexts, which matters because trust
boundaries fall *between* them:

| Surface | What runs there | Holds the key? |
|---|---|---|
| **Service worker** (`background/`) | Orchestrator agent loop, tool dispatch + gates, vault, egress wrappers, all relays | **Yes** — the vault DK and API key live only here |
| **Offscreen document** (`offscreen/`) | Per-actor / per-subagent Worker heaps, headless `js_run`, voice, the dweb base network | **No** — keyless worker heaps |
| **Side panel** (`sidepanel/`) | The chat UI, confirm prompts, settings | No |
| **Sandbox tabs** (`vm-tab/`, `notebook-tab/`, `app-tab/`) | WebVM (CheerpX), Notebook (sealed worker), App (opaque-origin iframe) | No |
| **The mesh** (`peerd-distributed/`, preview only) | WebRTC mesh, DHT, gossip, signed direct channels, A2A | No |

The module map (`p`rovider / `e`gress / `e`ngine / `r`untime / `d`istributed) is in
[`CLAUDE.md`](../../CLAUDE.md). Security-relevant code concentrates in
`peerd-egress/` (vault, egress, denylist, audit) and the `peerd-runtime/subagent/`
+ `tools/` layer (the heap split and the gate stack).

---

## 3. Actors and trust boundaries

### 3.1 Actors (who acts, and what they are trusted with)

peerd deliberately splits "the agent" into roles so that no single reasoning
context holds both untrusted input and dangerous authority. This mirrors the table
in [`README.md`](../../README.md); the enforcement lives in
`peerd-runtime/tools/exposure.js` + `gates.js` and `peerd-runtime/subagent/`.

| Actor | Trusted with | Never |
|---|---|---|
| **The user** | Everything — unlocking the vault, approving confirms, installing skills/imports | (the root of trust) |
| **The orchestrator** (main agent loop, in the SW) | The conversation, planning, delegating a plain-language goal to an actor | Holding an environment's low-level tools, reading raw page bytes, or running untrusted code directly |
| **A bound actor** (web / webvm / notebook / app) | Driving *one* tab/VM/notebook/app — it exclusively holds that instance's tools, **keyless**, in its own Worker heap (Chrome) | Touching another instance or kind, holding the key, or returning anything to the orchestrator except a `wrapUntrusted`-fenced summary |
| **A subagent** | A disposable ephemeral actor spawned to decompose a task — keyless, own heap, a *narrowed* toolset | Escalating past its grant, holding the key, reaching another heap; every tool call is re-checked SW-side |
| **The dweb actor** (preview, opt-in) | Monitoring inbound mesh traffic, A2A over the mesh — keyless, own heap | Delegating on an inbound (untrusted) turn; signing as the user without consent |
| **The egress chokepoint** (`safeFetch` / `webFetch`) | Every outbound byte — allowlist (credentialed) or SSRF+denylist (open-web) | Being bypassed; a bare `fetch` is lint-forbidden project-wide |

### 3.2 Trust boundaries (where trust changes hands)

- **B1 — Untrusted content ↔ the orchestrator's heap (the memory boundary).** The
  single most important boundary. Page text, command output, file contents, and
  peer bytes are read *only* inside a keyless actor/subagent Worker heap and return
  to the orchestrator only as `wrapUntrusted`-fenced data. Enforced by the heap
  split (`peerd-runtime/subagent/actor-worker-core.js`,
  `background/offscreen-actor-client.js`).
- **B2 — Any agent heap ↔ the network / the key.** Model calls and tool calls
  leave a worker only through two SW-gated relays; the SW adds `getSecret` +
  `safeFetch` and re-checks the call, never trusting the worker's arguments.
- **B3 — The extension ↔ the open web (egress chokepoint).** All outbound bytes go
  through `peerd-egress/fetch/`: `safeFetch` (exact-origin provider allowlist,
  credentialed) or `webFetch` (SSRF/private-network block + denylist, keyless).
- **B4 — Sandboxed code ↔ the host.** WebVM / Notebook worker / App iframe each run
  untrusted-or-agent-authored code confined to a realm whose only outward edge is an
  audited postMessage bridge (or, for the App, an opaque origin with no privileges).
- **B5 — The mesh ↔ the local agent (preview).** Peer bytes are content-addressed,
  signed, `wrapUntrusted`-fenced, rate-capped, and delivered as *inbound* (untrusted)
  turns that the sender gate forbids from delegating.
- **B6 — The browser ↔ the extension (the manifest).** The install-time permission
  set + CSP is the outer boundary the browser enforces; everything inside is bounded
  by it (`manifests/`, generated `extension/manifest.json`).
- **B7 — The user ↔ the agent (consent).** Side-effecting actions pass through a
  confirm gate; the vault requires explicit unlock; skills/imports require a click.

Out of the model entirely (see §7): a compromised OS or browser, a malicious *other*
extension, and the physical device.

---

## 4. Assets (what an attacker wants)

| Asset | Where it lives | Primary protection |
|---|---|---|
| **Model-provider API key** | Encrypted in the vault; decrypted only in the SW at request time | Vault crypto (Argon2id / WebAuthn-PRF, AES-GCM); never enters a keyless heap; egress allowlist |
| **Origin-bound API keys** (per-integration) | Vault, injected at the egress boundary only | `origin-credentials.js` — sent only to the exact owned https origin |
| **The user's session cookies** (logged-in tabs) | The browser's cookie jar (peerd never reads cookies) | Sensitive-origin denylist; Plan/Act; confirm gate |
| **Page content the agent reads** | Transiently, inside an actor heap | The memory boundary (B1) + untrusted-content fence |
| **Durable memory** (notes loaded into every future prompt) | `peerd-runtime/memory/` | User-approved writes; digest excludes tool results (see residual risk R2) |
| **Local files** (WebVM FS, Notebook/App OPFS) | Sandbox-local storage | Per-instance OPFS root; path-traversal collapse; realm seal |
| **Peer bundles** (dwapps, data, agent cards) | Received over the mesh | Content addressing + Ed25519 signatures + size/shape caps |
| **The agent's authority itself** (its tools, its delegation) | The orchestrator | Exposure + actor-tier gates; the sender gate; Plan/Act |
| **The audit log** (record of security events) | IndexedDB, extension origin | Append-by-convention (see residual risk R4 — no tamper-resistance) |

---

## 5. Adversaries

Each adversary below lists its capabilities, peerd's primary defenses (with the
enforcing file), and the [red-team scenario](../../tests/red-team/) that proves the
defense empirically.

### 5.1 Malicious webpage
**Can:** serve arbitrary HTML/JS/text; plant prompt-injection payloads in content
the agent reads; try to induce fetches; run script in its own origin.
**Cannot (by design):** reach the vault key, run in a privileged context, or make
the agent's *authority* act outside its gates.
**Defenses:** the memory boundary keeps page bytes out of the orchestrator's heap
(B1); the web actor that reads the page is **keyless** (`subagent/spawn.js`
`restrictCtxCapabilities` strips `getSecret`/`safeFetch`); the credentialed egress
path is an exact-origin allowlist (`safeFetch`); open-web fetches are gated by the
SSRF block + denylist (`webFetch`); page-sourced text is `wrapUntrusted`-fenced with
a structurally un-forgeable delimiter (`tools/prompt-wrap.js`).
**Proven by:** scenarios 01, 02, 03, 07, 08.

### 5.2 Malicious MCP server (mapped)
peerd ships **no MCP client** — verified: the only `mcp` occurrence in `extension/`
is a coincidental substring inside vendored `moonshine.js`. The named vector is
therefore **not a live surface**. Its threat — *untrusted external tool metadata /
instructions that make the agent act on an attacker's behalf* — maps onto peerd's
real analog: the **A2A / inbound-mesh** surface (agent-cards + peer messages).
**Defenses (the analogs of MCP tool-description sanitization):** the sender gate
(`subagent/delegation-lineage.js` `mayMessageActor`) makes an inbound turn unable to
delegate and taints any subagent spawned from an injected turn; the A2A translation
core (`subagent/a2a-api.js` `meshCallToOp`) rejects unknown methods and malformed
args; signing ops require per-target consent (`meshMethodSigns`).
**Proven by:** scenario 05.

### 5.3 Malicious peer (mesh, preview only)
**Can:** join the mesh, advertise agent-cards, serve content bundles, send direct
messages, attempt DoS.
**Cannot:** forge a bundle under an honest address, re-attribute a signed bundle,
amplify memory past the fetch-time cap, or wake the local agent into delegating.
**Defenses:** content addressing (a bundle's address is the hash of its canonical
manifest, which commits to every chunk — `content/manifest.js`), Ed25519 publisher
signatures over domain-tagged bytes (`identity/keypair.js` `verifySignature`),
`assertBundleWithinLimits` (amplification/size-lie guard *before* any chunk is
fetched), agent-card coerce-and-cap (`agent-card.js`), inbound rate caps
(`background/dweb-inbound-rate-cap.js`), and the sender gate.
**Proven by:** scenarios 04, 05.

### 5.4 Malicious model output
**Can:** the model itself (compromised, jailbroken, or steered by injected content
it read) emits arbitrary tool calls and arguments.
**Cannot:** call a tool it isn't exposed to, target an instance it isn't bound to,
act in Plan mode, or exfiltrate over the credentialed path.
**Defenses:** the gate stack (`tools/gates.js`) — the exposure gate hides low-level
DOM/page tools from the main turn, the actor-tier gate positively pins each actor to
its kind's toolset + instance and refuses actor-only tools on non-actor contexts,
Plan/Act blocks writes (`permissions/policy.js`), the origin gate applies the
denylist, and every tool call carries an append-only audit entry. The heap split
means a model call cannot smuggle the key across the postMessage boundary
(`actor-worker-core.js` `makeRelayedCallModel` strips every function).
**Proven by:** scenarios 03, 08 (and 05 for delegation).

### 5.5 Malicious extension (out of scope — see §7)
A second extension installed alongside peerd, or a compromise of peerd's own
extension origin, is **out of scope**: it already runs in-origin and can reach SW
memory (including the live DK) directly. This is stated honestly as an accepted
limitation (R7), not defended against. Store hardening (no `debugger` in the store
Chrome build, strict CSP) *reduces* peerd's own attack surface but does not defend
against a separate malicious extension.

### 5.6 Compromised dependency (supply chain)
**Can:** a subverted vendored library or a remote asset peerd loads could inject
code.
**Defenses (partial):** no npm runtime inside the extension (third-party code is
vendored in `vendor/` with a `SOURCE.txt`); the Moonshine voice model is
SHA-384 SRI-verified with a fail-closed refusal on a null SRI
(`peerd-runtime/voice/model-store.js`); the store build strips the `debugger`
permission and the dweb module and CI verifies zero dweb traces.
**Accepted residual (R8):** the CheerpX WebVM streams its root filesystem image from
a third-party host over WSS, which cannot be SRI-pinned — a live trust dependency for
the VM's filesystem. Named, not defended.
**Proven by:** (partial) scenario 06 for sandbox confinement of whatever the VM runs.

---

## 6. Security invariants

These are the load-bearing guarantees. Each is stated as a testable assertion, cites
the enforcing code, and links to the red-team scenario that exercises it. The
anchors (`INV-N`) are the link targets from
[`RED-TEAM-RESULTS.md`](./RED-TEAM-RESULTS.md).

<a id="inv-1"></a>
### INV-1 — The credentialed egress path cannot be pointed at an attacker
A request carrying the vault key (`safeFetch`) reaches only an **exact-origin**
member of the provider allowlist and **fails closed on any 3xx redirect**;
lookalikes, substrings, scheme downgrades, and off-origin ports are refused, and the
underlying `fetch` never fires on a denied origin.
*Code:* `peerd-egress/fetch/safe-fetch.js` (`makeSafeFetch`, `isAllowed`, `originOf`),
`fetch/allowlist.js` (frozen `HARDCODED_ALLOWLIST`). *Red-team:* scenario 01.

<a id="inv-2"></a>
### INV-2 — Sensitive origins and cross-origin credentials are gated
Open-web fetches are refused when the host matches the sensitive-origin denylist,
using a boundary-safe matcher (`*.bank` matches subdomains only, never the apex or a
substring sibling; port/trailing-dot are canonicalized away). An origin-bound
credential authenticates **only** when the request's `URL.origin` exactly equals the
actor's owned origin over https — cross-origin, http, and spoofed URLs send
anonymously.
*Code:* `peerd-egress/denylist/denylist.js`, `fetch/web-fetch.js`,
`fetch/origin-credentials.js` (`authOriginForRequestUrl`). *Red-team:* scenario 02.

<a id="inv-3"></a>
### INV-3 — The heap that reads a page holds no secret and returns only fenced data
The web/actor/subagent Worker heap has `getSecret` and `safeFetch` unconditionally
stripped (`restrictCtxCapabilities`), cannot smuggle a function/key across the
model-call boundary (`makeRelayedCallModel` drops every function), and its
untrusted-provenance summary re-enters the orchestrator wrapped as data
(`makeActorSummaryFence` + `wrapUntrusted`) with a structurally un-forgeable
delimiter (`neutralizeFence`). This is the anti-lethal-trifecta guarantee.
*Code:* `peerd-runtime/subagent/{spawn.js,actor-worker-core.js}`,
`tools/prompt-wrap.js`. *Red-team:* scenario 03.

<a id="inv-4"></a>
### INV-4 — A tampered or re-attributed peer bundle is detectable and rejected
A bundle's content address commits to its manifest, which transitively commits to
every chunk; tampering any signed field breaks `verifyManifest` and changes the
address (so it cannot reuse an honest one). Re-attributing to a different publisher
breaks the signature. An oversized/amplified/size-lying manifest is refused before
any chunk is fetched, and a peer agent-card is coerced within hard caps.
*Code:* `peerd-distributed/content/manifest.js`, `identity/keypair.js`,
`agent-card.js`. *Red-team:* scenario 04.

<a id="inv-5"></a>
### INV-5 — An untrusted party cannot hijack the agent's authority
An **inbound** (peer-originated) turn can never make the agent delegate, and a
subagent spawned by an inbound/injected turn is tainted for its whole subtree;
forged, severed, foreign-rooted, and cyclic lineages fail closed. A poisoned mesh op
(bad method or args) is rejected, and signing-as-the-user requires per-target
consent.
*Code:* `peerd-runtime/subagent/delegation-lineage.js` (`mayMessageActor`,
`buildAncestry`), `subagent/a2a-api.js`. *Red-team:* scenario 05.

<a id="inv-6"></a>
### INV-6 — Sandboxed code is confined to an audited bridge
In a Notebook/headless worker realm, every raw network channel throws, the native
`fetch` is deleted off the prototype chain, and the bridge is pinned
non-writable/non-configurable so in-realm sabotage can't unseat it; no fresh
un-sealed realm can be minted, and OPFS import paths collapse `..` inside the
instance root. The App runs at an **opaque origin** (manifest sandbox omits
`allow-same-origin`/`allow-top-navigation`) with all `chrome.*` stripped, and its
inlined-worker source is `<`-escaped against `</script>` breakout. The WebVM's only
network path is an HTTP bridge that refuses non-http(s) schemes, scrubs CRLF header
injection, drops any smuggled auth field, and confirms body-bearing verbs.
*Code:* `notebook-tab/notebook-neutralizers.js` (`applyRealmSeal`),
`peerd-engine/{app-compose.js,vm-net/http-bridge.js,module-resolver.js}`, manifest
sandbox CSP. *Red-team:* scenario 06 (+ real-realm proof in
`extension/tests/unit/{notebook-tab/notebook-seal,offscreen/job-runner,red-team/sandbox-escape}.test.js`).

<a id="inv-7"></a>
### INV-7 — No egress to private, loopback, link-local, or metadata hosts
`webFetch` refuses a host classified private/loopback/link-local/`.local`/metadata
by `isPrivateOrLocalHost` — across decimal/hex/octal/short-form IPv4 and
IPv4-mapped/NAT64 IPv6 encodings — *before* any network call, ahead of the denylist,
and fails closed on redirects so a public host can't pivot to an internal one.
*Code:* `peerd-egress/fetch/private-network.js`, `fetch/web-fetch.js`. *Red-team:*
scenario 07.

<a id="inv-8"></a>
### INV-8 — Injected instructions find no lever (the prompt-injection thesis)
For a corpus of injection payloads, the authority each one seeks is denied by a real
mechanism: exfil → keyless heap + allowlist; navigate-to-sensitive → denylist;
SSRF → private-network guard; low-level DOM tool on main → exposure gate; actor-only
tool via subagent → tier gate; cross-instance → instance pin; write in Plan mode →
Plan/Act; fence break-out → `neutralizeFence`. The injection can steer reasoning; it
cannot reach a capability. This is the architectural difference from a
single-context ("browser-use"-style) agent that runs the model, the tools, the key,
and the page's text in one reasoning context — where the injected sentence sits in
the same context that holds the authority. *Code:* the gate stack + heap split cited
above. *Red-team:* scenario 08 (with the side-by-side comparison).

### Additional invariants (not scenario-gated, enforced in code)

- **INV-9 — Vault fails closed.** A secret read/write is refused with
  `VaultLockedError` unless unlocked; a wrong passphrase throws `WrongPassphraseError`
  with no wrong-vs-tampered side channel and never rewrites the blob; the DK is never
  returned to a caller; both unlock factors (Argon2id, WebAuthn-PRF) recover the same
  DK; a tampered/out-of-bounds KDF descriptor is rejected before any derive runs.
  *Code:* `peerd-egress/vault/`. *Tested:* `tests/peerd-egress/vault-*.test.ts`,
  `extension/tests/unit/peerd-egress/vault*.test.js`.
- **INV-10 — The store build is minimal.** The store Chrome package never ships
  `debugger`; every Firefox package drops Chrome-only permissions; the store artifact
  contains zero `peerd-distributed` traces. *Code:* `packaging/gen-manifest.ts`
  (`STORE_STRIPPED_PERMISSIONS`), `packaging/verify-store-artifact.ts`. *Tested:*
  `tests/store/`, CI.
- **INV-11 — There is exactly one egress path per class.** A bare `fetch` is
  lint-forbidden; the credentialed path (`safeFetch`) and the open-web path
  (`webFetch`) are separate wrappers, so VM/app traffic can never reach the provider
  allowlist or launder the API key. *Code:* `eslint.config.js` (`no-restricted-globals`),
  `peerd-egress/fetch/`.

---

## 7. Scope

### In scope
- Exfiltration of the vault / API key / conversation off-device.
- Prompt injection that bypasses the actor boundary (the keyless per-environment
  heap) and reaches the orchestrator's tools, memory, or the key.
- Sandbox escape (WebVM / Notebook / App iframe) reaching the host, other origins, or
  privileged extension contexts.
- Denylist / egress-chokepoint / SSRF-guard bypass.
- Vault / crypto weaknesses; auth-bypass of the lock.
- Manifest / CSP / permission misconfigurations that widen the attack surface.
- Mesh: bundle-integrity / signature bypass, sender-gate bypass, unconsented signing
  (preview channel; understood to be pre-hardening).

### Out of scope
- An already-compromised OS or browser, or a **malicious extension** installed
  alongside peerd (both already have in-origin / in-process reach; see R7).
- Physical access to an unlocked device.
- Self-inflicted configuration (e.g. the user removing their own denylist entries, or
  importing a transfer file they know to be hostile — though see R6 for the
  injection surface a *shared* import creates).
- Social engineering of the human, and missing best-practice headers without a
  demonstrated impact.
- The **dweb / `peerd-distributed` preview** is research-grade and ships only on the
  preview channel; report issues, but understand the protocol is pre-hardening.

---

## 8. Known residual risks

Stated honestly. Several are deliberate design tradeoffs; all are things a reader
evaluating peerd should know. Each cites where it lives in the code.

- **R1 — The heap split is Chrome-only.** It needs the offscreen API; on Firefox the
  actor falls back to a keyless in-SW loop where the boundary reverts to a *prompt*
  boundary (one property access from the DK), the pre-heap-split posture. The memory
  boundary is not universal. *(`background/service-worker.js` offscreen fallback.)*
- **R2 — Memory poisoning.** The auto-memory digest excludes tool results and
  synthetic messages, but still includes raw *assistant* text (which can echo
  attacker-paraphrased content), and a single approved note persists into every future
  prompt. Approval is the trust boundary; a user who approves a poisoned note owns the
  consequence. *(`peerd-runtime/memory/auto-memory.js`.)*
- **R3 — A skill body is trusted instructions by design.** Skill install fetches
  through `webFetch` (denylist + caps) and the frontmatter parser refuses unknown
  keys, but the skill *body* loads into context as trusted instructions with no
  untrusted-content fence — a malicious *shared* skill is a direct instruction-injection
  vector. Treat installing a skill as running its author's prompt.
  *(`peerd-runtime/skills/`.)*
- **R4 — The audit log is not tamper-resistant.** It is append-only by *convention*
  in IndexedDB; any code in the extension origin can rewrite or delete entries. There
  is no hash chain or signing. It records events for an honest system; it cannot
  resist an attacker who already has in-origin code execution. *(`peerd-egress/audit/log.js`.)*
- **R5 — Confirm grants are origin-blind.** A session-scoped "Yes" is keyed by tool
  name only, so approving e.g. `click` once approves it for every origin in that chat;
  and the confirm prompt text is agent-supplied (a misleading description could induce
  a "yes"). An origin-scoped grant store is future work. *(`peerd-egress/confirm/protocol.js`.)*
- **R6 — Transfer import is an untrusted-deserialization surface.** A shared
  settings/session export can inject provider endpoints (redirecting egress), repopulate
  memory (poisoning), and reinstall skills from arbitrary origins. The secret crypto and
  unknown-key dropping are sound; the endpoint/hook/memory injection path is not
  otherwise gated. Import only files you trust. *(`peerd-runtime/transfer/transfer.js`.)*
- **R7 — A malicious co-installed extension / compromised origin is out of scope.**
  The live DK is reachable to any code running in the extension origin (and is mirrored
  into `chrome.storage.session` for SW-restart resume); the stated threat model is that
  anything with in-origin execution already has SW memory. *(`peerd-egress/vault/vault.js`.)*
- **R8 — The CheerpX WebVM disk image is a live third-party dependency.** The root
  filesystem streams from a third-party host over WSS and cannot be SRI-pinned; a
  compromise of that host feeds content into the VM the agent runs commands in. Contrast
  the Moonshine model, which *is* SRI-verified. *(`extension/vendor/cheerpx/SOURCE.txt`.)*
- **R9 — `<all_urls>` host permission.** The manifest grants the broadest host reach;
  which hosts the extension may actually fetch/script is a *runtime* concern (the egress
  allowlist/denylist), so a bug that bypasses the runtime gate has full-web reach at the
  browser layer. *(`manifests/base.json`.)*
- **R10 — The soft-injection defense has no regression harness.** The structural fence
  (`neutralizeFence`) is tested, but the "treat inside as data" framing lives in the
  system-prompt text; a template edit that weakens it would pass CI silently. The
  red-team benchmark (scenario 08) tests the *gates*, not the prompt text. *(`peerd-provider/system-prompt.txt`, `peerd-runtime/loop/system-prompt.js`.)*
- **R11 — DK extractability + open-web exfil.** The DK is generated `extractable:true`
  because `SubtleCrypto.wrapKey` requires it (a bug holding the DK reference *could*
  export it), and the open-web `webFetch` path is allowlist-free, so exfil to an
  arbitrary *public* host is not prevented by the allowlist — it is mitigated only by
  the keyless-web-actor architecture (INV-3). *(`peerd-egress/vault/keys.js`, `fetch/safe-fetch.js` header.)*

Candidates for future red-team scenarios (surfaces above that are only partially
defended): R2 memory poisoning, R3 skill-body smuggling, R6 transfer-import injection,
R5 origin-blind confirm grants.

---

## 9. Empirical testability — the red-team suite

Every INV-1..INV-8 above is wired to an executable probe in
[`tests/red-team/`](../../tests/red-team/). The suite casts each adversary as code
that drives the **real** defense function with hostile input and records whether the
defense held; it runs under `bun test ./tests/red-team` (a CI gate) and publishes a
result matrix to [`RED-TEAM-RESULTS.md`](./RED-TEAM-RESULTS.md) via
`bun run red-team:report`. Real-realm escapes (scenario 06) are additionally proven in
the in-browser CDP suite. A claim here that has no green probe there is a claim to
distrust — that is the point of publishing both.

---

## 10. Change policy

This document tracks `main`. When a security-relevant mechanism changes, update the
cited invariant here **and** its red-team probe in the same change; when a residual
risk is closed, move it from §8 into §6 with a scenario. Vulnerability reporting and
support policy live in [`SECURITY.md`](../../SECURITY.md).
