# Security Policy

peerd is high-trust software: it holds your model-provider API key, it
drives your logged-in browser tabs, and it executes code in sandboxes.
We take security seriously and welcome good-faith research.

> **Status: 0.x experimental beta.** Treat peerd as you would any
> early-stage tool that can act on your behalf. See the trust model
> below before relying on it.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately via **GitHub Private Vulnerability Reporting**:
open the repository's **Security** tab and choose **Report a vulnerability**
(`https://github.com/NotASithLord/peerd/security/advisories/new`). This
opens a private advisory only the maintainers can see.

Please include: what you found, the impact, a minimal reproduction
(steps / a tiny repro extension build or page), affected version/commit,
and the channel (store or preview).

This is a solo-maintained alpha, so expect a best-effort acknowledgement
within a few days, not an enterprise SLA. We'll keep you updated as we
triage and fix, and we're happy to credit you in the advisory (opt-in).

## Supported versions

peerd is `0.x`; only the **latest commit on `main`** (and the most recent
preview/store build) is supported. There are no backported fixes; they
land on `main`.

## Formal threat model and red-team suite

For the full formal document, covering actors, trust boundaries, assets,
adversaries, numbered security invariants, explicit scope, and known residual
risks, see [`docs/security/THREAT-MODEL.md`](docs/security/THREAT-MODEL.md). Its
invariants are wired to a runnable [red-team suite](tests/red-team/) (`bun test
./tests/red-team`) whose results are published in
[`docs/security/RED-TEAM-RESULTS.md`](docs/security/RED-TEAM-RESULTS.md), so the
security claims can be re-checked against the code rather than taken on faith.
The [`lifecycle and recovery contract`](docs/security/LIFECYCLE-CONTRACT.md)
states what happens to operations, tabs, sandboxes, and stored data when a
worker or browser session stops unexpectedly.

## Supply-chain security

Dependency updates are treated as untrusted code, including updates labeled as
security fixes. The canonical policy, automation boundary, coverage, and
explicit exclusions live in
[`docs/security/DEPENDENCY-AUTOMATION.md`](docs/security/DEPENDENCY-AUTOMATION.md).
Its enforcement is kept close to the mechanism: `.github/dependabot.yml` and
`bunfig.toml` season new releases; `.github/workflows/security.yml` and
`.github/workflows/dependabot-security-release.yml` gate changes; and
`extension/vendor/vendor.lock.json` pins every checked-in third-party byte.

## Trust model (what peerd already defends)

Understanding the boundaries helps you scope a report:

- **BYOK, no peerd backend, no telemetry.** Provider secrets are held locally
  in an encrypted vault (`peerd-egress/vault/`). Model requests go directly to
  the selected provider.
- **Scoped network paths.** Provider calls use a provider allowlist. Open-web
  reads use SSRF and denylist checks. WebVM and Notebook network operations use
  host-mediated routes. Browser navigation is checked separately. App tabs
  have no ambient network and use a tab-scoped network rule as a backstop.
  Preview dweb builds also use signaling and peer-to-peer WebRTC. The current
  implementations live in `peerd-egress/`, `peerd-engine/`,
  `peerd-distributed/`, and the service-worker wiring.
- **Untrusted-content boundary (the heap split).** The main agent never
  sees raw page content: page/DOM work is delegated to a per-tab **web
  actor**, a separate agent loop that runs in its own Worker heap on Chrome
  and Firefox, holds no key and no extension APIs. Model calls and agent tool
  operations go through the service worker, which holds the key and re-checks
  every request. This is a memory boundary, not a general code sandbox. The
  worker still has standard Worker web APIs, but model output is not evaluated
  as code in that realm. Untrusted content (page text,
  command output, file contents) stays inside that heap and returns to the
  orchestrator only as a `wrapUntrusted`-fenced summary. Actors run the
  same way: keyless, in their own heap, with a narrowed toolset. This is
  the main prompt-injection defense. It is a memory boundary, not a prompt
  convention. Chrome hosts the worker from its offscreen document. Firefox
  hosts it from the extension background page. A versioned startup probe must
  prove a separate worker realm before any model or tool request can run. While
  a Firefox actor turn is active, a run-scoped `storage.session` heartbeat keeps
  the MV3 event page alive. Firefox must acknowledge the first heartbeat before
  actor work starts. The heartbeat stops when the last active actor turn ends.
  A heartbeat failure pauses actor work until a manual retry proves the host.
  Durable recovery never repeats an actor request after a background restart.
  Requests known not to have started are reported as Not run. Ambiguous requests
  are reported as Outcome unknown and require inspection before retry.
- **Policy-gated tool dispatch** with a local, append-only audit log. The
  current policy checks and hooks live in `peerd-runtime/tools/`.
- **What the model reads is what you could have seen.** Bytes that are
  invisible to a person but legible to a model, including zero-width runs, bidi
  overrides, Unicode tag characters, and HTML comments, are stripped before
  page text reaches the model, at both read boundaries and inside the
  untrusted-content fence itself. Text in every script survives, including
  the zero-width non-joiner Persian, Urdu and the Indic scripts need
  (`peerd-runtime/dom/cdr.js`).
- **Authenticated writes to user-generated content require confirmation.** On sites where
  third parties author the content, such as issue trackers, shared docs, and social
  feeds, an authenticated write asks you first, **even if you turned
  confirmations off**. Reading is exempt; so is navigating away
  (`peerd-runtime/actor/ugc-registry.js`).
- **Suspicious cross-origin navigation is blocked.** A tab tool sending a long,
  scraped-looking blob to another origin in the URL is refused. Best
  effort: it catches the obvious shape, not everything, and it deliberately
  does not scan query strings, because that is where legitimate login
  tokens live (`peerd-runtime/tools/egress-heuristics.js`).

- **Web helpers do not enter known account sites without authority.** Every web
  helper is either *roaming*, so it browses freely and holds no authority, or
  *bound* to exactly one site it may not leave. A roaming helper that reaches a
  site you have an account on stops instead of continuing, and peerd checks
  where the tab actually ENDED UP rather than where something asked it to go, so
  a redirect can't smuggle it in. Which sites count grows as you use peerd: a
  sign-in page it walks, or a write you approve, teaches it
  (`peerd-runtime/actor/landing-rule.js`).

Two things this list does **not** claim. Knowing which sites you have an account
on is a list, and lists are incomplete. The first visit to a site peerd has
never seen a login page for is unprotected (R15). And the strict structural
reply format for web actors ships **off** by default (R14). The threat model
states both plainly rather than counting them as defenses.

- **Sandboxed execution.** WebVM uses CheerpX. Notebook and headless script
  execution use sealed workers. Apps use opaque-origin sandboxed iframes and
  currently run only on Chrome. Store and web builds refuse direct remote
  JavaScript imports without requesting the module source. Preview targets may
  permit audited literal static remote imports where the browser loader supports
  them. Dynamic imports are refused in every package.
  Any remote module restricts the whole run to compute only. Runtime network
  and file access, agents, model calls, browser and site access, and dweb are
  disabled by both worker shims and host relay checks. A remote module cannot
  import a local workspace module. Returned values,
  console output, and errors are fenced as untrusted. Optional pins verify the
  bytes for reproducibility but do not make the code trusted. The
  sealed worker protects the extension process. It does not make remote code a
  trusted dependency. The broader network-derived code contract for Store is
  tracked separately.

## In scope

- Exfiltration of the vault / API key / conversation off-device.
- Prompt injection that bypasses actor credential custody, tool gates, the
  untrusted-content fence, or the isolated heap where one is available and
  reaches the orchestrator's tools, memory, or key.
- Sandbox escape (WebVM, Notebook, headless script, or App iframe) reaching the host,
  other origins, or the extension's privileged contexts.
- Denylist / egress-chokepoint / SSRF-guard bypass.
- Vault / crypto weaknesses; auth-bypass of the lock.
- Manifest, CSP, or extension-permission misconfigurations that widen the
  attack surface.

## Out of scope (for the alpha)

- Anything requiring an already-compromised OS/browser or a malicious
  extension installed alongside peerd.
- The **dweb / `peerd-distributed` preview** is explicitly research-grade
  and ships only in the preview channel. Report issues, but understand the
  protocol is pre-hardening.
- Self-inflicted config (e.g. removing your own denylist entries).
- Social engineering, spam, missing best-practice headers without a
  demonstrated impact.

## Safe harbor

We will not pursue or support action against researchers who, in good
faith, follow this policy: test only against your own installs, avoid
privacy violations and data destruction, and give us reasonable time to
fix before public disclosure. There is no paid bounty during the alpha.
