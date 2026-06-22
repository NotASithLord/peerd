# Security Policy

peerd is a high-trust artifact: it holds your model-provider API key, it
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

This is a solo-maintained alpha — expect a best-effort acknowledgement
within a few days, not an enterprise SLA. We'll keep you updated as we
triage and fix, and we're happy to credit you in the advisory (opt-in).

## Supported versions

peerd is `0.x`; only the **latest commit on `main`** (and the most recent
preview/store build) is supported. There are no backported fixes — fixes
land on `main`.

## Trust model (what peerd already defends)

Understanding the boundaries helps you scope a report:

- **BYOK, no backend, no telemetry.** Your API key is held locally in an
  encrypted **vault** (`peerd-egress/vault/`, Argon2id / WebAuthn-PRF).
  Nothing is sent anywhere except your chosen model endpoint.
- **Egress chokepoint.** All network calls route through
  `peerd-egress/fetch/` — `safeFetch` (a hardcoded provider allowlist for
  model calls) and `webFetch` (SSRF guard + a denylist of sensitive
  origins, no redirects). There is no other egress path.
- **Untrusted-content boundary.** The main agent never sees raw page
  content: `do`/`get`/`check` dispatch to a disposable **browser-runner**
  subagent that holds no key, no memory, and no egress tools, and wraps
  page text as untrusted data. This is the core prompt-injection /
  "lethal trifecta" defense.
- **Six-gate tool dispatch** (persona → exposure → origin → confirmation
  → egress → audit) with a local, append-only audit log.
- **Sandboxed execution.** WebVM (CheerpX, network only via the egress
  wrappers), JS Sandbox (realm-sealed Web Worker), App (opaque-origin
  sandboxed iframe).

## In scope

- Exfiltration of the vault / API key / conversation off-device.
- Prompt injection that bypasses the runner boundary and reaches the
  main agent's tools or memory.
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
  and ships only in the preview channel — see
  `docs/distribution/THREAT-MODEL.md`. Report issues, but understand the
  protocol is pre-hardening.
- Self-inflicted config (e.g. removing your own denylist entries).
- Social engineering, spam, missing best-practice headers without a
  demonstrated impact.

## Safe harbor

We will not pursue or support action against researchers who, in good
faith, follow this policy: test only against your own installs, avoid
privacy violations and data destruction, and give us reasonable time to
fix before public disclosure. There is no paid bounty during the alpha.
