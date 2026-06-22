# FEATURE — Gated HTTPS egress for Apps

> **Status:** SPEC — design agreed, not yet implemented. Owner-initiated
> (2026-06-22): "expose apps to HTTPS through peerd-egress just like the
> VM." This doc records the agreed shape so it can be reviewed before any
> code lands. No `peerd.egress.fetch` wiring for Apps exists yet.
>
> **Modules touched:** `app-tab/` (the iframe runtime + bridge),
> `background/app-client.js` + `background/app-tab-tracker.js` (the host
> relay), `peerd-egress/fetch/web-fetch.js` (the egress core — reused, not
> changed), and a new per-app grant/quota/allowlist policy that rides the
> existing confirmation machinery (`peerd-runtime/permissions/`). **CORE
> only** — no `peerd-distributed` import (dweb-delivered Apps are the
> *threat model* this hardens against, but the egress hole itself ships in
> the store channel behind its gate).

---

## 0. The premise, corrected

The starting framing was "apps can't reach the network; give them egress
just like VMs." Two corrections shape the work:

1. **"Just like the VM" means `webFetch`, not `safeFetch`.** `peerd-egress`
   has two doors. `safeFetch` is the *credentialed provider* allowlist
   (`api.anthropic.com`, `openrouter.ai`, Ollama loopback) — fail-closed on
   redirects, for talking to model APIs with the user's key. `webFetch`
   (`peerd-egress/fetch/web-fetch.js`) is the *open-web* path: scheme check
   + SSRF/private-network block (`private-network.js`) + sensitive-site
   denylist + redirect fail-close + audit, but **no per-host allowlist**.
   The VM and the Notebook both route through `webFetch` — `safeFetch` is
   never in their path. So app egress = a bridge to `webFetch`, gated.

2. **Apps are a strictly more hostile caller than the VM.** The VM is
   booted by the user and its network is **off by default, enabled
   per-session by a one-click confirm** (DECISIONS #6). An App, by
   contrast, runs HTML/JS that **peerd generated or that arrived over the
   dweb from another peer** (`app-tab/runner.html` `document.write`s a body
   it was handed). The capability surface already encodes this: wiring any
   `peerd.*` capability for Apps without a **per-app grant + quota** is
   called out as a vulnerability (DECISIONS #21; the SECURITY block atop
   `notebook-tab/worker-source.js`). So app egress needs everything the VM
   has **plus** containment for untrusted code.

The slot already exists: `peerd.egress.fetch` is wired for the **Notebook**
(`worker-source.js:133` — `fetch: (url, init) => fetch(url, init)`, bridged
to the host's `webFetch`) and the capability map explicitly reserves it for
"Apps later." This feature fills that reservation, with the gate.

---

## 1. Where Apps stand today

- **Runtime:** `app-tab/runner.html` is an opaque-origin sandboxed iframe
  (declared in `manifest.json` `sandbox.pages`; MV3 strips all `chrome.*`).
  It `postMessage`s `runner-ready`, receives an `app-body`, and
  `document.write`s the agent's HTML. Inline `<script>` runs under the
  sandbox CSP.
- **Network:** none. There is no `peerd.*` surface injected into the App
  realm, and the iframe's bare `fetch` is unusable from an opaque origin
  (cross-origin requests fail CORS, no credentials). A dweb **bridge**
  exists for the commons dwapp (the `runner.html` comment guards it against
  form-submit navigation), but it carries dweb messages, not egress.
- **VM, for contrast** (the model to mirror): VM bash emits a stdout
  sentinel → `vm-tab.js` → SW → `vm-http-fetch.js` →
  `webFetch`. `vm-http-fetch.js` adds a write-method confirm gate
  (`needsWebWriteConfirm`, `WEB_WRITE_CONFIRM_KEY = 'web:write'`),
  host-bound git-auth injection, and an IDB response cache. The body cap is
  `MAX_VM_FETCH_BODY = 50 MB`.

---

## 2. The design

**One sentence:** wire `peerd.egress.fetch` into the App iframe as a
`postMessage` bridge to the host, where the request passes a **per-app
allowlist + grant + quota** gate and then the *same* `webFetch` core the VM
uses.

### 2.1 The request path

```
App JS:  peerd.egress.fetch(url, { method, headers, body })
  → postMessage({ type: 'egress-fetch', reqId, url, init }) to parent
  → app-tab/index.html relays to SW (app-client route)
  → NEW: app-egress gate (per-app allowlist + grant + quota + write-confirm)
  → webFetch(url, init)        // SSRF + denylist + redirect + audit (UNCHANGED)
  → postMessage back { reqId, ok, status, headers, bodyB64 | error }
```

The App-realm `peerd.egress.fetch` shim mirrors the Notebook's: it returns a
`Promise<Response>`-shaped object reconstructed on the App side from the
relayed `{ status, headers, bodyB64 }`. The bridge is request/response by
`reqId`, same pattern as the existing dweb bridge.

### 2.2 The gate — three layers, in order

The gate is a **pure policy function** (functional core) over `(appId, url,
method, grantState, usage)`, IO injected. It runs host-side, before
`webFetch` is ever called, and refuses with an `AppEgressDeniedError`
carrying a reason.

1. **Permission (consent) — mirrors the VM's per-session enable.** Egress
   for an App is **off until granted**. First `egress.fetch` from an app
   (or first to a not-yet-approved host) raises the existing confirmation
   surface (`peerd-runtime/permissions/`), not a bespoke prompt. Grant is
   **per-app**, scoped to the session by default (revisit "remember for this
   app" once Profiles land). This is the "should this run at all" axis.

2. **Per-app allowlist (containment) — the chosen posture (not the VM's
   open `webFetch`).** A grant is for **specific hosts**, not "the web." The
   app declares the hosts it wants (in its bundle manifest) and/or requests
   them at runtime; the user approves the **set of hosts** at grant time and
   each later addition individually (the same "agent requests, user
   confirms each" loop DECISIONS #6 uses for the VM's dev origins). Only
   approved hosts reach `webFetch`. This is the "and where" axis, and it is
   what makes dweb-delivered code safe to give a network hole at all: the
   open-web path's honest gap (`web-fetch.js`: no host allowlist → arbitrary
   public-domain exfil/C2) is closed *here*, per app, instead of relied
   upon downstream.

3. **Quota (resource bound).** Per-app, per-session caps so untrusted code
   can't turn the hole into a firehose: a **request-rate cap**, a
   **cumulative-byte cap** (response bodies; reuse the VM's
   `MAX_VM_FETCH_BODY` per-response ceiling and add a running total), and
   **write-method confirmation** (reuse `needsWebWriteConfirm` /
   `WEB_WRITE_CONFIRM_KEY` from `http-bridge.js` — a `POST/PUT/PATCH/DELETE`
   from an app confirms just as it does from the VM). Exceeding a cap is an
   `AppEgressDeniedError`, audited.

### 2.3 What is reused vs. new

| Concern | Source | Status |
|---|---|---|
| SSRF / private-network block | `peerd-egress/fetch/private-network.js` | **reuse** (in `webFetch`) |
| Sensitive-site denylist | `webFetch` | **reuse** |
| Redirect fail-close, audit | `webFetch` | **reuse** |
| Write-method confirm | `http-bridge.js` `needsWebWriteConfirm` | **reuse** |
| Per-response body cap | `vm-http-fetch.js` `MAX_VM_FETCH_BODY` | **reuse** |
| Confirmation UI | `peerd-runtime/permissions/` | **reuse** |
| App-realm `egress.fetch` shim + reqId bridge | `app-tab/`, `app-client.js` | **new** |
| Per-app allowlist + grant + quota policy | new pure module | **new** |
| `AppEgressDeniedError` | `peerd-engine/errors.js` (or app-tab errors) | **new** |

Deliberately **not** touched: `webFetch` itself (no signature change — the
gate composes *in front of* it), and `safeFetch` (irrelevant to this path).

### 2.4 The `peerd.*` authority story

This is the **first** non-`self` capability wired for Apps, so it sets
precedent for DECISIONS #21's "grant + quota lands WITH the capability"
rule. `egress` is the right first module to wire because its blast radius is
the most contained of the five (`provider.call` spends credits,
`engine.spawn*` exhausts resources, `runtime.notifyParent` injects upward,
`distributed.*` signs as the user — all strictly worse). The grant/quota
machinery built here is the template the other modules inherit when their
time comes.

---

## 3. Open questions (resolve during implementation)

- **Manifest-declared vs. runtime-requested hosts.** Declaring hosts in the
  app bundle manifest lets the user approve the whole set at install/open
  time (cleaner consent); runtime requests handle apps that discover hosts
  dynamically. Likely support both: declared hosts pre-fill the grant
  prompt, runtime requests append (each confirmed).
- **Grant lifetime.** Session-scoped is the safe default. "Remember for this
  app" wants per-app persisted state, which rides the Profiles backlog item
  (per-profile denylist/permissions). Don't build persistence ahead of
  Profiles.
- **Quota numbers.** Pick conservative starting caps (rate + total bytes)
  and make them settings-tunable rather than hardcoding a guess into the
  policy.
- **dweb provenance signal.** A dweb-installed app is more suspect than one
  peerd just authored locally. The gate could surface provenance in the
  grant prompt (no behavior change, just informed consent) — cheap, worth
  doing.

---

## 4. Test surface

- **Bun (pure):** the gate policy function — allowlist match, quota
  accounting, write-confirm decision, denial reasons. Values in, decision
  out; no browser. Colocate as `<policy>.test.ts` under `tests/`.
- **In-browser:** the iframe ↔ host `reqId` bridge round-trip, the
  `egress.fetch` shim reconstructing a `Response`, and a denied request
  surfacing as a thrown error inside the App realm. These need the real
  sandboxed-iframe + `postMessage` lifecycle, so they belong in
  `extension/tests/runner.html`.
