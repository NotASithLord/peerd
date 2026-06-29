# Spec: the peerd.ai site as a demo / lite app

> Status: **forward-looking spec** (no code here yet). The build lands in the
> `peerd-site` repo, which vendors snapshots from this one. This file is the
> reuse plan + portability map, written from the extension side so the seams are
> documented where the code lives.

## Goal — two products

1. **Homepage feature demos.** Embedded, interactive widgets that show off the
   sandboxes without installing anything: a JS Notebook you can type into, a
   WebVM terminal, a client-side App. No agent, no key — just the runtimes.
2. **A "try it out" lite app** (a separate page). Paste a model key (stays
   client-side), and the **real agent loop** drives the **real sandboxes** in
   the page — minus browser control (no tabs/DOM/CDP). The "lite" peerd.

## Why it's feasible — the architecture is already shaped for it

peerd's rule is *functional core, imperative shell — IO is injected*. The agent
brains and the sandbox runtimes don't depend on the extension chassis; only the
**hosting** (tabs, the service worker, `chrome.*`) does. Measured couplings
(`grep` for `chrome.*` / `browser.<api>` / direct polyfill imports):

| Module | Files touching chrome/browser | Verdict |
|---|---|---|
| `peerd-provider` (adapters) | **0 / 13** | fully portable — injected `fetch` + a key |
| `peerd-runtime/loop` (agent loop) | **1 / 16** | portable — IO-injected; `agent-loop.js`/`turn-driver.js` import no chassis |
| `peerd-engine` (sandboxes) | **5 / 15** | runtimes portable; the registries/tab-trackers are the chassis-coupled part |
| `notebook-tab` (sealed worker) | **1 / 6** | the worker/seal/std are portable; only the host file relays to the SW |
| `peerd-egress` (vault, safeFetch, denylist, audit) | crypto portable; storage KV wraps `chrome.storage` | swap the KV backend to IDB |

### Most of the portability is *already proven* by existing tests
- **Provider**: `tests/peerd-provider/*` run the adapters under bun with an
  injected `fetch` — i.e. already outside any extension.
- **Sealed worker + realm seal**: `extension/tests/unit/notebook-tab/notebook-seal.test.js`
  spawns the production worker over **plain http** (the CDP harness, no
  extension) and plays the host side of the fetch bridge. The runtime already
  runs standalone.
- **Registries**: `tests/peerd-engine/*-registry.test.ts` run on an injected
  storage stub.
- **Vault crypto**: `tests/peerd-egress/vault*` run argon2 + WebCrypto under bun.
- **WebVM**: per `CLAUDE.md`, the site **already vendors a live VM-demo runtime** —
  CheerpX standalone is a shipped precedent.

So the lite app isn't a port — it's a **re-host**: supply the IO graph the loop
already expects, minus browser control.

## The host shims the lite app must provide

1. **Storage backend.** `peerd-egress/storage/kv.js` is the seam — it abstracts
   `chrome.storage.local`. On web, back it with the existing `storage/idb.js`
   (IndexedDB). Everything above it (vault, denylist, audit, sessions,
   registries) is unchanged.
2. **In-page sandbox hosting** (the one genuinely-new piece). Today each sandbox
   runs in an extension *tab*; the registries + tab-trackers manage those tabs.
   On web, host each runtime in an **in-page element** — the Notebook/`js_run`
   worker as a `Worker`, the App as an opaque `<iframe>`, the WebVM as the
   vendored CheerpX page/iframe. The registries' *catalog* logic is reusable;
   only the tab-host layer is replaced with an in-page-host layer.
3. **Replace the SW message bridges with in-page handlers.** The worker's
   postMessage bridges (`fetch-request`, `opfs-request`, `subagent-request`,
   `display`, `log`) are handled today by `notebook-tab.js` — and `opfs-request`
   is **already handled in-page** (not via the SW). Only `fetch-request` relays
   to the SW (`sw/web-fetch` → `safeFetch`); on web, handle it in the page with a
   direct `safeFetch`/`fetch`. Reuse `buildWorkerSource` (the production worker
   assembly) verbatim — it's `import.meta.url`-relative and host-agnostic by
   design (the offscreen job-runner already reuses it).
4. **A reduced tool manifest.** The machinery exists: `/tools` presets +
   `session.toolManifest` (`tools/manifests.js`), enforced in `gates.js`. Define
   a `lite` preset = the sandbox/compute/memory/web-read tools, **dropping**
   do/get/check, `page_*`, tabs, CDP — the browser-control surface. No new gating
   code; just a manifest.
5. **Paste-a-key vault flow.** The vault already stores secrets client-side
   (IDB + passphrase/WebAuthn). The lite app's "plug in a test key" *is* the
   vault's existing key path — store the model key client-side, unlock per
   session. (Demo nuance: a "session-only, never persisted" mode is a one-line
   policy on top.)

## Product 1 — homepage feature demos

Each is one runtime + a thin UI, no agent:
- **JS Notebook**: a code box → `buildWorkerSource` → in-page `Worker` →
  `output-render.js` renders the result. The fetch bridge is in-page. This is the
  smallest, most self-contained demo and the recommended first build.
- **WebVM terminal**: the already-vendored CheerpX runtime + the existing
  `vm-tab` terminal UI.
- **App**: an opaque `<iframe>` running a client-side app the agent could build.

## Product 2 — the "try it out" lite app

Wire `makeTurnDriver` (the agent loop) with the host-supplied IO graph:
- **Provide** (all portable): `vault`, `sessions`/`sessionState`/`sessionCache`,
  the provider stack (`callModel`, `resolveFailoverChain`, `costOf`, …),
  `memory`, `auditLog`, `safeFetch`, the tool dispatcher with the **lite**
  manifest, `settingsStore`, cost/temporal/system-prompt helpers.
- **Stub or drop**: `browser`, `originOfTabUrl`, `uiPorts`/`uiConnected` (replace
  with an in-page event sink), `currentAppScope`, the do/get/check runner, and
  the dweb deps (`DWEB_ENABLED=false`, the `filterByDweb*`).
- The streaming UI is the existing Mithril `sidepanel` components, re-mounted in
  the page (they're projections of state — already host-agnostic per DESIGN-12).

## Open questions / risks

- **Provider CORS.** Browser→API calls need permissive CORS. The extension sends
  `anthropic-dangerous-direct-browser-access`; the same applies on a web origin,
  and OpenRouter allows browser calls. **Validate early with a real key** — this
  is the likeliest surprise. (Can't be tested here without a key.)
- **CheerpX weight + COOP/COEP.** The WebVM needs cross-origin isolation headers;
  the site already serves the VM demo, so this is solved there — confirm the
  lite-app page inherits the same headers.
- **Key handling.** "Stays client-side" must be real: no key in any request to
  the site's own origin, only to the model API. A session-only (non-persisted)
  default is the safe demo posture.
- **What to cut.** Browser control (the whole point of the extension) is absent;
  the lite app should say so plainly so it reads as a *demo*, not a lesser app.

## First steps (in `peerd-site`)
1. Stand up the **JS Notebook homepage demo** — reuse `buildWorkerSource`, swap
   the fetch bridge to in-page. Smallest end-to-end proof of the re-host pattern.
2. Add the **IDB-backed KV** shim; bring up the vault + a paste-a-key flow.
3. Define the **`lite` tool manifest**.
4. Wire `makeTurnDriver` with the host IO graph on the **"try it out"** page;
   start with one provider + the Notebook/`js_run` tool, then add VM/App.
