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
the repository's **Security** tab → **Report a vulnerability**
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

## Trust model (what peerd already defends)

Understanding the boundaries helps you scope a report:

- **BYOK, no backend, no telemetry.** Your API key is held locally in an
  encrypted **vault** (`peerd-egress/vault/`, Argon2id / WebAuthn-PRF).
  Nothing is sent anywhere except your chosen model endpoint.
- **Egress chokepoint.** All network calls route through
  `peerd-egress/fetch/`: `safeFetch` (a hardcoded provider allowlist for
  model calls) and `webFetch` (SSRF guard + a denylist of sensitive
  origins, no redirects). There is no other egress path. The denylist also
  has a network-level backstop (`peerd-egress/denylist/dnr-rules.js` +
  `background/denylist-net-guard.js`): a `declarativeNetRequest` rule that
  blocks denylisted domains inside the tabs peerd is currently driving —
  and only those, never your own browsing — so a page that navigates
  ITSELF onto a sensitive site is refused below the page, where no
  decision-time gate can see it.
- **Untrusted-content boundary (the heap split).** The main agent never
  sees raw page content: page/DOM work is delegated to a per-tab **web
  actor** — a separate agent loop that, on Chrome, runs in its OWN Worker
  heap, holds no key, no `chrome.*`, and no egress, and reaches the model,
  the network, or the page only by asking the service worker, which holds
  the key and re-checks every request. Untrusted content (page text,
  command output, file contents) stays inside that heap and returns to the
  orchestrator only as a `wrapUntrusted`-fenced summary. Actors run the
  same way — keyless, in their own heap, with a narrowed toolset. This is
  the core prompt-injection / "lethal trifecta" defense: a memory boundary,
  not a prompt one. (Firefox lacks the offscreen API, so there the actor
  runs keyless in the shared loop until it lands.)
- **Policy-gated tool dispatch** with a local, append-only audit log. The
  current policy checks and hooks live in `peerd-runtime/tools/`.
- **What the model reads is what you could have seen.** Bytes that are
  invisible to a person but legible to a model — zero-width runs, bidi
  overrides, Unicode tag characters, HTML comments — are stripped before
  page text reaches the model, at both read boundaries and inside the
  untrusted-content fence itself. Text in every script survives, including
  the zero-width non-joiner Persian, Urdu and the Indic scripts need
  (`peerd-runtime/dom/cdr.js`).
- **Acting as you, on a page strangers wrote, takes you.** On sites where
  third parties author the content — issue trackers, shared docs, social
  feeds — an authenticated write asks you first, **even if you turned
  confirmations off**. Reading is exempt; so is navigating away
  (`peerd-runtime/actor/ugc-registry.js`).
- **An exfil-shaped navigation is blocked.** A tab tool sending a long,
  scraped-looking blob to another origin in the URL is refused. Best
  effort: it catches the obvious shape, not everything, and it deliberately
  does not scan query strings, because that is where legitimate login
  tokens live (`peerd-runtime/tools/egress-heuristics.js`).

- **A helper that browses the web can't walk into your accounts.** Every web
  helper is either *roaming* — it browses freely and holds no authority — or
  *bound* to exactly one site it may not leave. A roaming helper that reaches a
  site you have an account on stops instead of continuing, and peerd checks
  where the tab actually ENDED UP rather than where something asked it to go, so
  a redirect can't smuggle it in. Which sites count grows as you use peerd: a
  sign-in page it walks, or a write you approve, teaches it
  (`peerd-runtime/actor/landing-rule.js`).

Two things this list does **not** claim. Knowing which sites you have an account
on is a list, and lists are incomplete — the first visit to a site peerd has
never seen a login page for is unprotected (R15). And the strict structural
reply format for web actors ships **off** by default (R14). The threat model
states both plainly rather than counting them as defenses.
- **Sandboxed execution.** WebVM (CheerpX, network only via the egress
  wrappers), JS Sandbox (realm-sealed Web Worker), App (opaque-origin
  sandboxed iframe).

## In scope

- Exfiltration of the vault / API key / conversation off-device.
- Prompt injection that bypasses the actor boundary (the keyless
  per-environment heap) and reaches the orchestrator's tools or memory.
- Sandbox escape (WebVM / JS Sandbox / App iframe) reaching the host,
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
