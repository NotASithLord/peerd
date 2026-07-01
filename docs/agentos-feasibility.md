# AgentOS — feasibility assessment

> **Status: DRAFT for ratification.** A facts-based read of the bet *"we have
> almost everything we need for a headless, self-hosted, secure, enterprise
> AgentOS"* against what peerd has actually built and against the non-negotiable
> invariant (no backend, no account, no telemetry, BYOK, runs in-browser,
> sandboxed-by-default). **@NotASithLord's call** — nothing here is decided.
> Companion to the "AgentOS bet" section in [ROADMAP.md](../ROADMAP.md).

## Verdict: half true — the *runtime* is ~85% there, the *OS layer* ~20%

"We have almost everything" is true about the **runtime** and false about the
**operating system around it.** Roughly 60–65% of an enterprise AgentOS is
genuine substrate; the split is lopsided by layer:

- **The agent execution engine is enterprise-grade and largely done** (~85%).
  The loop is fully IO-decoupled (no UI port required), goal mode is a real
  run-to-completion autonomous loop (SW-restart-resumable), per-session turn
  slots give genuine multi-session concurrency, all four sandbox kinds exist,
  the security spine is strong, and **the whole thing already boots headless and
  runs against a live model under CDP today** — a zero-click provision-and-run
  path exists (it just lives in test code, not a product surface). That's the
  hard part, and it's real.
- **The fleet layer barely exists** (~20%). What makes it an OS for a *fleet*
  rather than a runtime for *one seat* is absent or partial: no external control
  surface (first-party-only by design; zero `externally_connectable`), no central
  provisioning (no `chrome.storage.managed` anywhere), no multi-tenancy (every
  store is a single global keyspace — `profileId` threads into nothing), no
  unattended unlock (the vault is interactive-only and fails *closed* with no UI),
  no audit export, no aggregation.

An OS *is* precisely that fleet layer — so the claim overreaches on the word
"OS," not on the runtime.

## The fault line: runtime (in-extension) vs control plane (separate, self-hosted)

The bet splits cleanly along one line, and **this is the decisive call**:

- **The runtime** (agent loop, sandboxes, gates, vault, goal mode) is fully
  invariant-compatible and can become a headless enterprise runner **with no
  backend.**
- **The control plane** (fleet provisioning, central policy enforcement,
  cross-instance audit aggregation, org identity) is a backend *by definition*
  and **cannot live inside the in-browser extension.**

The honest model that keeps every invariant: **peerd EMITS and EXECUTES; the
customer's own infrastructure PROVISIONS and COLLECTS.** The customer's MDM
pushes policy; the customer's SIEM ingests the audit. Central control lives in a
**separate, customer-self-hosted artifact in its own repo** — the
[`signaling-node/`](../signaling-node) precedent already proves peerd ships
customer-runnable server shells without breaking the in-browser-runtime invariant.

Done this way, **it is not a pivot.** The pivot happens only if peerd/Anthropic
ever *hosts* the control plane or audit collector — that single decision flips it
from invariant-keeping extension to SaaS.

### Three invariant ceilings that are permanent (not just unbuilt work)

1. **Hard per-task isolation tops out at Chrome's own primitives.** The
   opaque-origin App iframe is the strongest boundary available; there's no
   microVM without a host process the invariant forbids. "Untrusted-code-safe"
   tops out at what Chrome site isolation gives.
2. **No per-worker/per-WASM CPU/RAM quota exists for extensions.** Resource caps
   can only be watchdog-*approximated* + terminated, never truly enforced.
3. **Org SSO/OIDC + org KMS need an external identity service** — a frontal
   collision with no-account/no-backend. A local profile / `did:key` bound to
   MDM-pushed config is the invariant-safe substitute, but it is **not** corp SSO.

## What's already substrate (build on this)

- **Execution engine (~85%):** IO-decoupled agent loop (`peerd-runtime/loop/agent-loop.js`);
  resumable autonomous goal mode (`loop/goal-runner.js`); per-session turn slots
  (`loop/turn-slots.js`).
- **Headless boot is proven, not theoretical:** `scripts/cdp/e2e-harness.mjs`
  launches Chrome for Testing `--headless=new --load-extension`, discovers the SW
  over CDP; `run-eval-bench.mjs` provisions vault + provider key + settings
  entirely over `chrome.runtime.sendMessage` from ENV. A zero-click
  provision-and-run path exists — it just isn't a product surface yet.
- **Security spine, enforced at dispatch:** the multi-gate stack
  (`peerd-runtime/tools/gates.js`); per-session tool manifests that only ever
  *narrow* and are never widened by subagents/runner (`tools/manifests.js`) — the
  real authority-isolation primitive to build per-environment authority on; the
  vault (Argon2id KEK + WebAuthn PRF, DK in session RAM only); the SSRF/private-
  network guard; the denylist matcher.
- **Real isolation primitives:** the App opaque-origin iframe (the one hard
  origin boundary); the Notebook/headless-worker realm seal (neutralizes all
  network primitives off the prototype chain pre-agent-code); CheerpX WebVM with
  no raw sockets; `js_run`'s ephemeral per-job OPFS subtree.
- **Complete local audit + lineage:** append-only audit over IDB (40+ event types
  incl. `egress_denied`/`prompt_injection_suspected`/`tool_blocked`, callers can't
  forge id/timestamp); per-tool-call lineage on every result.
- **Config + packaging seams** that make an "enterprise channel" a config change,
  not new infra: per-(channel,browser) manifests via `gen-manifest.ts` deepMerge;
  settable knobs in `default-settings.mjs`; live `settings/update`.
- **Self-hosted server precedent in-repo:** `signaling-node/` — the template for a
  control plane in its own repo.

## The plan: three waves, ordered invariant-safe-first

### Wave 1 — the moat-safe enterprise wedge (S/M, ships in *this* repo, zero invariant collision)

The enterprise table stakes — central provisioning, an enforceable floor,
compliance evidence — for near-zero invariant cost:

- **Tamper-evident local audit:** hash-chain each entry to the previous; local
  export (Blob/download). *(M; the one enterprise need with **no** invariant tension.)*
- **`chrome.storage.managed` managed-policy:** an MDM-pushed, non-overridable
  policy *floor* (provider endpoint, strict denylist, spend cap). *(M; the OS/admin
  control surface, zero collision — highest leverage.)*
- **An "enterprise/headless" packaging channel** via the existing gen-manifest
  patch mechanism. *(S.)*
- **Local policy-violation notifications.** *(S.)*

### Wave 2 — runtime → runner (L, invariant-safe but punctures the security *model* → must be profile-scoped)

- **The headless operability triad:** a documented provisioning RPC surface +
  unattended vault unlock sourced from the host's secrets manager + sanctioned
  no-UI autonomy. (This is the literal precondition for "headless self-hosted
  runner" — without it there's a test harness, not a product.)
- **Within-instance multi-tenancy:** namespace every persisted store by
  `profileId` and thread it through.

### Wave 3 — the net-new product (only if demand proves out)

- A **separate, customer-self-hosted** policy/audit plane (own repo,
  `signaling-node/` template) + an **opt-in, default-off** audit forwarder that
  points only at a *customer-owned* endpoint, routed through `safeFetch`/denylist.

## First milestone (proves the whole thesis, breaks no invariant)

A single demoable **"enterprise headless seat"**: boot the existing CDP-headless
path as a packaged "enterprise" channel, provision it entirely from
`chrome.storage.managed` (provider endpoint, strict denylist, spend cap) with
**no Settings clicks**, run a goal-mode job to completion, and produce a
**hash-chained, locally-exported audit file** the customer can ingest into their
own SIEM. Touches only Wave 1; breaks no invariant; proves the entire
"customer-provisioned, customer-observed, peerd-executed" model end to end.

## Decisions for @NotASithLord (the forks)

1. **Hosted vs customer-self-hosted control plane — THE call.** Will peerd ever
   *host* the policy/audit collector, or is it permanently a customer-self-hosted
   artifact in its own repo? Hosting it flips the product to a SaaS pivot;
   everything else depends on this answer.
2. **Is corp SSO a hard requirement,** or is a local/`did:key` identity bound to
   MDM-pushed config sufficient? SSO is the one need that *cannot* be met without
   conceding no-account/no-backend — drop it, or accept it as an explicit
   invariant fork for enterprise SKUs only.
3. **Unattended vault unlock** from the host's secrets manager — an acceptable
   weakening of the interactive-unlock model, scoped to a dedicated runner profile
   so interactive seats keep the gestured-unlock guarantee?
4. **No-telemetry definition:** confirm it means "nothing flows to *peerd*" (a
   customer-owned SIEM forwarder is permissible) rather than "no egress ever."
5. **Resource-cap honesty:** are watchdog-*approximated* CPU/RAM caps acceptable to
   position to enterprise buyers, given the in-browser model can never enforce hard
   caps? Set the trust-model claims before the security story is written.
6. **Which enterprise persona is the wedge** — a security/platform team wanting
   central policy + SIEM (favours Wave 1 + the Wave 3 plane), or a dev team wanting
   a fleet of headless runners (favours the Wave 2 triad first)? Pick the design
   partner before the L-effort work.

---

_DRAFT — pending ratification. Forward direction only; the code stays the spec._
